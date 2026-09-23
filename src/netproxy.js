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
// Resolution follows the Go daemon's -proxy flag (common/netproxy), so both
// halves of the install read the same environment the same way:
//   PILOT_PROXY unset or "auto" → the first non-empty of HTTPS_PROXY,
//                                 https_proxy, ALL_PROXY, all_proxy; plain
//                                 http: targets prefer HTTP_PROXY/http_proxy.
//                                 The first non-empty of NO_PROXY/no_proxy
//                                 exempts targets.
//   PILOT_PROXY=off|none|false|direct → never proxy
//   PILOT_PROXY=[http(s)://]host:port → that proxy for every target (NO_PROXY
//                                 does not apply; a missing scheme means http)
// localhost and loopback addresses are never proxied, whatever the mode.
//
// Resolution never throws. A value that is not a usable http(s) proxy URL is
// ignored with a warning (inspectProxy reports it): a malformed setting can
// cost the proxy, but never a direct install on a host that does not need
// one. An ignored PILOT_PROXY falls back to "auto"; an ignored HTTPS_PROXY
// does not fall through to ALL_PROXY, because Go takes the first non-empty
// variable and the daemon must agree with setup about which one applies.
//
// No proxy selected means the request goes to globalThis.fetch unchanged.
// Proxy credentials never appear in errors, warnings or logs; use
// redactProxyURL().

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

// Setting values (PILOT_PROXY, the daemon's config.json "proxy") that turn
// proxying off.
export const PROXY_OFF_VALUES = Object.freeze(['off', 'none', 'false', 'direct']);

const SECURE_PROXY_VARS = ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy'];

// inspectProxy resolves the proxy settings once and never throws:
//   mode      'auto' | 'off' | 'explicit'
//   proxy     { url, source } used for https: targets (and the daemon's
//             registry/beacon traffic), or null
//   plain     { url, source } override for http: targets (auto mode), or null
//   noProxy   the parsed NO_PROXY/no_proxy list (auto mode)
//   warnings  log-safe notes about values that were ignored
// `spec` (named `specSource`) takes the place of PILOT_PROXY when it is
// non-empty; setup passes the daemon's config.json "proxy" key this way,
// because the daemon applies that key ahead of $PILOT_PROXY.
export function inspectProxy(env = process.env, { spec, specSource = 'PILOT_PROXY' } = {}) {
  const warnings = [];
  let setting = String(spec ?? '').trim();
  let settingSource = specSource;
  if (!setting) {
    setting = String(env.PILOT_PROXY ?? '').trim();
    settingSource = 'PILOT_PROXY';
  }
  const word = setting.toLowerCase();
  if (PROXY_OFF_VALUES.includes(word)) {
    return { mode: 'off', proxy: null, plain: null, noProxy: EMPTY_NO_PROXY, warnings };
  }
  if (setting && word !== 'auto') {
    const parsed = parseProxyURL(setting);
    if (parsed.url) {
      return { mode: 'explicit', proxy: { url: parsed.url, source: settingSource }, plain: null, noProxy: EMPTY_NO_PROXY, warnings };
    }
    warnings.push(`${settingSource} is not a usable proxy (${parsed.error}); setup ignores it and uses the proxy environment (auto)`);
  }

  let proxy = null;
  const [secureRaw, secureVar] = firstEnv(env, SECURE_PROXY_VARS);
  if (secureRaw) {
    const parsed = parseProxyURL(secureRaw);
    if (parsed.url) proxy = { url: parsed.url, source: secureVar };
    else warnings.push(`${secureVar} is not a usable proxy (${parsed.error}); not using a proxy for HTTPS`);
  }
  let plain = null;
  // Like net/http, HTTP_PROXY is ignored under CGI (REQUEST_METHOD set) so a
  // request header cannot inject a proxy.
  const plainVars = String(env.REQUEST_METHOD ?? '') ? ['http_proxy'] : ['HTTP_PROXY', 'http_proxy'];
  const [plainRaw, plainVar] = firstEnv(env, plainVars);
  if (plainRaw) {
    const parsed = parseProxyURL(plainRaw);
    if (parsed.url) plain = { url: parsed.url, source: plainVar };
    else warnings.push(`${plainVar} is not a usable proxy (${parsed.error}); http:// requests use ${proxy ? proxy.source : 'no proxy'}`);
  }
  const [noProxyRaw] = firstEnv(env, ['NO_PROXY', 'no_proxy']);
  return { mode: 'auto', proxy, plain, noProxy: parseNoProxy(noProxyRaw), warnings };
}

// configuredProxy reports the proxy selected for HTTPS traffic, ignoring
// NO_PROXY: `{ url, source }` or null. Setup uses it to decide whether the
// daemon must run behind the proxy. Options are those of inspectProxy.
export function configuredProxy(env = process.env, options = {}) {
  return inspectProxy(env, options).proxy;
}

// resolveProxy returns the proxy URL a request to `target` must use, or null
// for a direct connection.
export function resolveProxy(target, env = process.env) {
  const url = target instanceof URL ? target : new URL(String(target));
  const settings = inspectProxy(env);
  if (settings.mode === 'off') return null;
  const host = normalizeHost(url.hostname);
  if (isLoopbackHost(host)) return null;
  if (settings.mode === 'explicit') return settings.proxy.url;
  const selected = url.protocol === 'http:' ? (settings.plain ?? settings.proxy) : settings.proxy;
  if (!selected) return null;
  const port = url.port || (url.protocol === 'http:' ? '80' : '443');
  return useProxy(settings.noProxy, host, port) ? selected.url : null;
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

function firstEnv(env, names) {
  for (const name of names) {
    const value = String(env[name] ?? '').trim();
    if (value) return [value, name];
  }
  return ['', ''];
}

// parseProxyURL mirrors common/netproxy: "host:port" without a scheme is an
// http proxy; only http and https proxies are supported. The returned error
// never contains the value, which may carry credentials.
function parseProxyURL(raw) {
  const value = raw.includes('://') ? raw : `http://${raw}`;
  let url;
  try {
    url = new URL(value);
  } catch {
    return { error: raw.includes('@') ? 'malformed URL; value withheld because it contains credentials' : 'malformed URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { error: `unsupported scheme "${url.protocol.replace(/:$/, '')}", want http or https` };
  }
  // An unescaped '/', '?' or '#' in the credentials ends the authority early:
  // part of the secret would become the proxy host and leak into DNS and
  // logs. A proxy URL never legitimately has '@' outside its userinfo.
  if (value.includes('@') && !url.username && !url.password) {
    return { error: 'credentials must be percent-encoded; value withheld' };
  }
  if (!url.hostname) return { error: 'no proxy host' };
  return { url };
}

// NO_PROXY, with the common/netproxy (Go httpproxy) rules: comma- or
// space-separated entries; "*" matches everything; "example.com" matches the
// host and its subdomains; ".example.com" or "*.example.com" only
// subdomains; IP addresses and CIDR ranges match IP-literal targets; an
// optional ":port" must match.
const EMPTY_NO_PROXY = Object.freeze({ all: false, cidrs: [], ips: [], domains: [] });

function parseNoProxy(raw) {
  const parsed = { all: false, cidrs: [], ips: [], domains: [] };
  for (const field of String(raw ?? '').split(/[,\s]+/)) {
    const entry = field.toLowerCase();
    if (!entry) continue;
    if (entry === '*') return { ...EMPTY_NO_PROXY, all: true };
    if (entry.includes('/')) {
      const cidr = parseCIDR(entry);
      if (cidr) parsed.cidrs.push(cidr);
      continue;
    }
    const split = splitHostPort(entry);
    let host = entry;
    let port = '';
    if (split) {
      [host, port] = split;
      if (!host) continue;
    }
    host = host.replace(/^\[/, '').replace(/\]$/, '');
    if (isIP(host)) {
      parsed.ips.push({ list: addressList(host), port });
      continue;
    }
    if (!host) continue;
    if (host.startsWith('*')) host = host.slice(1);
    const matchHost = !host.startsWith('.');
    if (matchHost) host = `.${host}`;
    if (host === '.') continue;
    parsed.domains.push({ suffix: host, port, matchHost });
  }
  return parsed;
}

// useProxy reports whether host:port goes through the proxy under noProxy.
function useProxy(noProxy, host, port) {
  if (!host) return true;
  if (isLoopbackHost(host)) return false;
  if (noProxy.all) return false;
  const family = isIP(host);
  if (family) {
    const type = family === 6 ? 'ipv6' : 'ipv4';
    if (noProxy.ips.some((entry) => (!entry.port || entry.port === port) && entry.list.check(host, type))) return false;
    if (noProxy.cidrs.some((list) => list.check(host, type))) return false;
    return true;
  }
  for (const entry of noProxy.domains) {
    if ((host.endsWith(entry.suffix) || (entry.matchHost && host === entry.suffix.slice(1)))
      && (!entry.port || entry.port === port)) return false;
  }
  return true;
}

// splitHostPort follows Go's net.SplitHostPort: null when the entry has no
// port (or too many colons, as a bare IPv6 address does).
function splitHostPort(entry) {
  if (entry.startsWith('[')) {
    const end = entry.indexOf(']');
    if (end < 0 || entry[end + 1] !== ':' || entry.slice(end + 2).includes(':')) return null;
    return [entry.slice(1, end), entry.slice(end + 2)];
  }
  const colon = entry.lastIndexOf(':');
  if (colon < 0 || entry.indexOf(':') !== colon) return null;
  return [entry.slice(0, colon), entry.slice(colon + 1)];
}

function parseCIDR(entry) {
  const [address, prefix, extra] = entry.split('/');
  const family = isIP(address);
  if (!family || extra !== undefined || !/^\d+$/.test(prefix ?? '')) return null;
  const bits = Number(prefix);
  if (bits > (family === 6 ? 128 : 32)) return null;
  const list = new BlockList();
  list.addSubnet(address, bits, family === 6 ? 'ipv6' : 'ipv4');
  return list;
}

function addressList(address) {
  const list = new BlockList();
  list.addAddress(address, isIP(address) === 6 ? 'ipv6' : 'ipv4');
  return list;
}

const LOOPBACK = new BlockList();
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4');
LOOPBACK.addAddress('::1', 'ipv6');

function isLoopbackHost(host) {
  if (host === 'localhost') return true;
  const family = isIP(host);
  return family !== 0 && LOOPBACK.check(host, family === 6 ? 'ipv6' : 'ipv4');
}

function normalizeHost(hostname) {
  return hostname.replace(/^\[|\]$/g, '').toLowerCase();
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
