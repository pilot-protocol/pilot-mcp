// netproxy.js — outbound HTTP(S) through the environment's egress proxy.
//
// Node's built-in fetch and https ignore HTTPS_PROXY (Node 24 only honours it
// behind the opt-in NODE_USE_ENV_PROXY). Hosted agent sandboxes such as Meta
// Muse allow no other way out: an authenticating HTTP proxy that only permits
// `CONNECT host:443`, with local DNS for the Pilot hostnames deliberately
// poisoned. Every request made here therefore asks the proxy to CONNECT by
// *hostname* (nothing is resolved locally) and keeps TLS end-to-end to the
// real server, so certificate verification is exactly what a direct request
// would do.
//
// Resolution mirrors the Go daemon's -proxy flag (common/netproxy) so both
// halves of the install read the same environment the same way:
//   PILOT_PROXY unset or "auto" → HTTPS_PROXY/https_proxy (HTTP_PROXY/http_proxy
//                                 for http: targets), falling back to
//                                 ALL_PROXY/all_proxy, honouring NO_PROXY/no_proxy
//   PILOT_PROXY=off             → never proxy
//   PILOT_PROXY=http(s)://...   → that proxy for every request
//
// No proxy configured means the request goes to globalThis.fetch unchanged.
// Proxy credentials never appear in errors or logs; use redactProxyURL().

import { Buffer } from 'node:buffer';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import process from 'node:process';
import tls from 'node:tls';
import { URL } from 'node:url';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);
const MAX_REDIRECTS = 20;

// configuredProxy reports the proxy the environment selects for HTTPS
// traffic, ignoring NO_PROXY: `{ url, source }` or null. Setup uses it to
// decide whether the daemon must run behind the proxy.
export function configuredProxy(env = process.env) {
  const mode = proxyMode(env);
  if (mode === 'off') return null;
  if (mode instanceof URL) return { url: mode, source: 'PILOT_PROXY' };
  return environmentProxy('https:', env);
}

// resolveProxy returns the proxy URL a request to `target` must use, or null
// for a direct connection.
export function resolveProxy(target, env = process.env) {
  const url = target instanceof URL ? target : new URL(String(target));
  const mode = proxyMode(env);
  if (mode === 'off') return null;
  if (mode instanceof URL) return mode;
  if (bypassesProxy(url, env)) return null;
  return environmentProxy(url.protocol, env)?.url ?? null;
}

// redactProxyURL renders a proxy URL safe for logs: scheme, host and port,
// with any userinfo replaced by ***.
export function redactProxyURL(proxy) {
  let url;
  try {
    url = proxy instanceof URL ? proxy : new URL(String(proxy));
  } catch {
    return '(invalid proxy URL)';
  }
  const auth = url.username || url.password ? '***@' : '';
  return `${url.protocol}//${auth}${url.host}`;
}

// createProxyAwareFetch returns a fetch-compatible function. It supports the
// subset setup uses: method, headers, string/byte body, redirect and signal.
// `tls` adds client TLS options (for example a test CA) to tunnelled
// connections; `directFetch` serves requests that need no proxy.
export function createProxyAwareFetch({ env = process.env, tls: tlsOptions = {}, directFetch } = {}) {
  return async function proxyAwareFetch(input, init = {}) {
    const direct = directFetch ?? globalThis.fetch;
    let url = new URL(String(input instanceof URL ? input.href : input));
    let proxy = resolveProxy(url, env);
    if (!proxy) return direct(input, init);

    let method = String(init.method ?? 'GET').toUpperCase();
    let body = init.body ?? null;
    const follow = (init.redirect ?? 'follow') === 'follow';
    for (let hop = 0; ; hop++) {
      const response = proxy
        ? await tunnelRequest(url, proxy, { method, headers: init.headers, body, signal: init.signal, tlsOptions })
        : await direct(url.href, { ...init, method, body, redirect: 'manual' });
      const location = response.headers.get('location');
      if (!follow || !REDIRECT_STATUSES.has(response.status) || !location) return response;
      if (hop >= MAX_REDIRECTS) throw new TypeError(`fetch ${url.origin}: too many redirects`);
      url = new URL(location, url);
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
        method = 'GET';
        body = null;
      }
      proxy = resolveProxy(url, env);
    }
  };
}

export const proxyAwareFetch = createProxyAwareFetch();

function proxyMode(env) {
  const raw = String(env.PILOT_PROXY ?? '').trim();
  if (!raw || raw.toLowerCase() === 'auto') return 'auto';
  if (raw.toLowerCase() === 'off') return 'off';
  const url = parseProxyURL(raw, { requireScheme: true });
  if (!url) throw new Error('PILOT_PROXY must be "auto", "off", or an http:// or https:// proxy URL');
  return url;
}

function environmentProxy(protocol, env) {
  const names = protocol === 'http:'
    ? ['HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']
    : ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy'];
  for (const name of names) {
    const raw = String(env[name] ?? '').trim();
    if (!raw) continue;
    // An unusable value (for example a socks5:// ALL_PROXY meant for other
    // tools) is skipped rather than fatal: before proxy support every request
    // went direct, and that must keep working where it already did.
    const url = parseProxyURL(raw, { requireScheme: false });
    if (url) return { url, source: name };
  }
  return null;
}

function parseProxyURL(raw, { requireScheme }) {
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  if (!hasScheme && requireScheme) return null;
  let url;
  try {
    url = new URL(hasScheme ? raw : `http://${raw}`);
  } catch {
    return null;
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) return null;
  return url;
}

// bypassesProxy applies NO_PROXY with the same rules as Go's httpproxy:
// "*" matches everything; "example.com" matches the host and its subdomains;
// ".example.com" (or "*.example.com") only subdomains; an optional ":port"
// must match; IPs and CIDR ranges match IP-literal targets. Loopback targets
// are never proxied.
function bypassesProxy(url, env) {
  const host = normalizeHost(url.hostname);
  if (host === 'localhost' || isLoopback(host)) return true;
  const raw = String(env.NO_PROXY ?? env.no_proxy ?? '').trim();
  if (!raw) return false;
  const port = url.port || (url.protocol === 'http:' ? '80' : '443');
  for (const item of raw.split(',')) {
    const entry = item.trim().toLowerCase();
    if (!entry) continue;
    if (entry === '*') return true;
    if (entry.includes('/')) {
      if (isIP(host) && cidrContains(entry, host)) return true;
      continue;
    }
    const [entryHost, entryPort] = splitHostPort(entry);
    if (entryPort && entryPort !== port) continue;
    if (isIP(entryHost)) {
      if (entryHost === host) return true;
      continue;
    }
    let suffix = entryHost.startsWith('*.') ? entryHost.slice(1) : entryHost;
    suffix = suffix.replace(/\.$/, '');
    if (suffix.startsWith('.')) {
      if (host.endsWith(suffix)) return true;
    } else if (host === suffix || host.endsWith(`.${suffix}`)) {
      return true;
    }
  }
  return false;
}

function normalizeHost(hostname) {
  return hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
}

function isLoopback(host) {
  if (isIP(host) === 4) return host.startsWith('127.');
  if (isIP(host) === 6) return host === '::1' || host === '0:0:0:0:0:0:0:1';
  return false;
}

function splitHostPort(entry) {
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(entry);
  if (bracketed) return [bracketed[1], bracketed[2] ?? ''];
  const colons = entry.split(':').length - 1;
  if (colons === 1) {
    const [host, port] = entry.split(':');
    return [host, /^\d+$/.test(port) ? port : ''];
  }
  return [entry, ''];
}

function cidrContains(cidr, host) {
  const [address, prefix] = cidr.split('/');
  const family = isIP(address);
  if (!family || family !== isIP(host) || !/^\d+$/.test(prefix)) return false;
  try {
    const list = new BlockList();
    list.addSubnet(address, Number(prefix), family === 6 ? 'ipv6' : 'ipv4');
    return list.check(host, family === 6 ? 'ipv6' : 'ipv4');
  } catch {
    return false;
  }
}

function defaultPort(url) {
  return url.protocol === 'http:' ? 80 : 443;
}

// openTunnel asks the proxy to CONNECT to the target *by hostname* and
// resolves with the raw tunnelled socket.
function openTunnel(target, proxy, { signal, tlsOptions }) {
  const authority = `${target.hostname}:${target.port || defaultPort(target)}`;
  const headers = { host: authority };
  if (proxy.username || proxy.password) {
    const credentials = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
    headers['proxy-authorization'] = `Basic ${Buffer.from(credentials).toString('base64')}`;
  }
  const safeProxy = redactProxyURL(proxy);
  const transport = proxy.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.request({
      ...(proxy.protocol === 'https:' ? tlsOptions : {}),
      host: normalizeHost(proxy.hostname),
      port: proxy.port || defaultPort(proxy),
      method: 'CONNECT',
      path: authority,
      headers,
      agent: false,
      signal,
    });
    const refused = (status) => new Error(`proxy ${safeProxy} refused CONNECT ${authority}: HTTP ${status}`);
    request.once('connect', (response, socket, head) => {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        socket.destroy();
        reject(refused(response.statusCode));
        return;
      }
      if (head?.length) socket.unshift(head);
      resolve(socket);
    });
    request.once('response', (response) => {
      response.resume();
      reject(refused(response.statusCode));
    });
    request.once('error', (error) => {
      if (signal?.aborted) reject(signal.reason ?? error);
      else reject(new Error(`proxy ${safeProxy} CONNECT ${authority} failed: ${error.message}`));
    });
    request.end();
  });
}

async function tunnelRequest(target, proxy, { method, headers, body, signal, tlsOptions }) {
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    throw new TypeError(`unsupported URL scheme ${target.protocol}`);
  }
  signal?.throwIfAborted?.();
  const tunnel = await openTunnel(target, proxy, { signal, tlsOptions });
  let socket = tunnel;
  if (target.protocol === 'https:') {
    const host = normalizeHost(target.hostname);
    // TLS runs end-to-end inside the tunnel and verifies the certificate
    // against the target hostname, exactly like a direct connection.
    socket = tls.connect({
      ...tlsOptions,
      socket: tunnel,
      ...(isIP(host) ? { host } : { servername: host }),
      ALPNProtocols: ['http/1.1'],
    });
  }
  const requestHeaders = {};
  new globalThis.Headers(headers ?? {}).forEach((value, name) => { requestHeaders[name] = value; });
  requestHeaders['accept-encoding'] ??= 'identity';
  requestHeaders['user-agent'] ??= 'pilotprotocol-mcp';
  const transport = target.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const fail = (error) => {
      socket.destroy();
      reject(signal?.aborted ? (signal.reason ?? error) : error);
    };
    const request = transport.request(target, {
      method,
      headers: requestHeaders,
      // Without an agent Node assumes port 80 and would send Host: name:80.
      defaultPort: defaultPort(target),
      createConnection: () => socket,
      signal,
    });
    request.once('error', fail);
    request.once('response', (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.once('error', fail);
      response.once('close', () => {
        if (!response.complete) fail(new Error(`${target.origin} closed the response early`));
      });
      response.once('end', () => {
        const responseHeaders = new globalThis.Headers();
        for (let i = 0; i + 1 < response.rawHeaders.length; i += 2) {
          responseHeaders.append(response.rawHeaders[i], response.rawHeaders[i + 1]);
        }
        const status = response.statusCode;
        resolve(new globalThis.Response(NULL_BODY_STATUSES.has(status) ? null : Buffer.concat(chunks), {
          status,
          statusText: response.statusMessage,
          headers: responseHeaders,
        }));
      });
    });
    request.end(body ?? undefined);
  });
}
