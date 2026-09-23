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
// Resolution is a port of common/netproxy v0.5.14 (what pilot-daemon's
// -proxy uses), so both halves of the install read the same environment the
// same way. test/netproxy.test.js carries common's resolver test vectors as a
// parity table.
//
// The proxy setting (PILOT_PROXY, or the daemon's config.json "proxy"):
//   unset, "auto"      the proxy environment, below
//   "off"              never proxy; "none", "no", "false" and "direct" are
//                      accepted as "off" too (any case)
//   http(s)://...      that proxy for every target (NO_PROXY does not apply)
// Anything else, including a host:port without a scheme, is not a usable
// setting: pilot-daemon and pilotctl reject it, so setup ignores it with a
// warning and never hands it to the daemon (see daemonProxySetting).
//
// The proxy environment (auto):
//   https: targets     the first usable of HTTPS_PROXY, https_proxy,
//                      ALL_PROXY, all_proxy. An unusable ALL_PROXY/all_proxy
//                      is skipped; an unusable HTTPS_PROXY/https_proxy means
//                      no proxy at all (Go fails the whole resolver, and the
//                      daemon then dials directly).
//   http: targets      the first usable of HTTP_PROXY, http_proxy (only
//                      http_proxy under CGI), otherwise the https: proxy.
//   NO_PROXY           the first non-empty of NO_PROXY/no_proxy exempts
//                      targets.
// A proxy URL's scheme is optional (http), and everything up to the LAST '@'
// is the userinfo, percent-decoded, so a token holding '/', '?' or '#' works
// unescaped. localhost and loopback addresses are never proxied.
//
// Resolution never throws: an unusable value costs the proxy (with a
// warning, see inspectProxy), never a direct install on a host that does not
// need one. No proxy selected means the request goes to globalThis.fetch
// unchanged. Proxy credentials never appear in errors, warnings or logs; use
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
// proxying off, compared case-insensitively. pilot-daemon accepts the same
// aliases; older builds know only "off", so setup always hands the daemon
// "off" (see daemonProxySetting).
export const PROXY_OFF_VALUES = Object.freeze(['off', 'none', 'no', 'false', 'direct']);

const SECURE_PROXY_VARS = ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy'];
// An unusable value in one of these names the TLS proxy explicitly, so Go
// fails the whole environment instead of skipping to the next variable.
const FATAL_PROXY_VARS = new Set(['HTTPS_PROXY', 'https_proxy']);

// parseProxySetting reads a proxy setting (PILOT_PROXY, config.json "proxy"):
//   { mode: 'auto' } | { mode: 'off' } | { mode: 'explicit', url }
//   | { mode: 'invalid', error }
// An explicit proxy needs an http:// or https:// scheme, as pilot-daemon and
// pilotctl require, so a typo never becomes a proxy host name. `error` never
// contains the value.
export function parseProxySetting(value) {
  const text = String(value ?? '').trim();
  const word = text.toLowerCase();
  if (!word || word === 'auto') return { mode: 'auto' };
  if (PROXY_OFF_VALUES.includes(word)) return { mode: 'off' };
  const cut = text.indexOf('://');
  if (cut < 0 || !validScheme(text.slice(0, cut))) {
    return { mode: 'invalid', error: 'not auto, off, or an http:// or https:// proxy URL' };
  }
  const parsed = parseProxyURL(text);
  return parsed.url ? { mode: 'explicit', url: parsed.url } : { mode: 'invalid', error: parsed.error };
}

// daemonProxySetting is the PILOT_PROXY value setup hands pilot-daemon for a
// raw $PILOT_PROXY, so the daemon reads it exactly as setup did: "auto" and
// "off" (for every off alias) spelled the way every daemon build accepts,
// an explicit URL unchanged, and '' (unset: the daemon's auto default) for a
// value setup ignores, which the daemon would otherwise refuse, or take as a
// proxy host name, on any transport.
export function daemonProxySetting(value) {
  const setting = parseProxySetting(value);
  if (setting.mode === 'explicit') return String(value).trim();
  if (setting.mode === 'off') return 'off';
  if (setting.mode === 'auto' && String(value ?? '').trim()) return 'auto';
  return '';
}

// inspectProxy resolves the proxy settings once and never throws:
//   mode      'auto' | 'off' | 'explicit'
//   setting   where the mode came from ('PILOT_PROXY', `specSource`), or
//             null for auto by default
//   proxy     { url, source } used for https: targets (and the daemon's
//             registry/beacon traffic), or null
//   plain     { url, source } override for http: targets (auto mode), or null
//   noProxy   the parsed NO_PROXY/no_proxy list (auto mode)
//   warnings  log-safe notes about values that were ignored
// `spec` (named `specSource`) takes the place of PILOT_PROXY when it is
// non-empty; setup passes the daemon's config.json "proxy" key this way,
// because pilotctl hands that key to the daemon ahead of $PILOT_PROXY.
export function inspectProxy(env = process.env, { spec, specSource = 'PILOT_PROXY' } = {}) {
  const warnings = [];
  let raw = String(spec ?? '').trim();
  let source = specSource;
  if (!raw) {
    raw = String(env.PILOT_PROXY ?? '').trim();
    source = 'PILOT_PROXY';
  }
  const setting = parseProxySetting(raw);
  if (setting.mode === 'off') {
    return { mode: 'off', setting: source, proxy: null, plain: null, noProxy: EMPTY_NO_PROXY, warnings };
  }
  if (setting.mode === 'explicit') {
    return { mode: 'explicit', setting: source, proxy: { url: setting.url, source }, plain: null, noProxy: EMPTY_NO_PROXY, warnings };
  }
  if (setting.mode === 'invalid') {
    warnings.push(`${source} is not a usable proxy setting (${setting.error}); setup ignores it and uses the proxy environment (auto)`);
  }
  return { ...environmentProxy(env, warnings), setting: raw && setting.mode === 'auto' ? source : null };
}

// environmentProxy is common/netproxy's fromEnv: each variable is parsed on
// its own, so one bad value never disables another, except that an unusable
// HTTPS_PROXY/https_proxy (which names the TLS proxy) means no proxy at all.
function environmentProxy(env, warnings) {
  const none = { mode: 'auto', proxy: null, plain: null, noProxy: EMPTY_NO_PROXY, warnings };
  let proxy = null;
  for (const name of SECURE_PROXY_VARS) {
    const parsed = envProxy(env, name);
    if (parsed?.url) {
      proxy = { url: parsed.url, source: name };
      break;
    }
    if (!parsed) continue;
    if (FATAL_PROXY_VARS.has(name)) {
      warnings.push(`${name} is not a usable proxy (${parsed.error}); pilot-daemon then ignores the proxy environment and connects directly, and so does setup`);
      return none;
    }
    warnings.push(`${name} is not a usable proxy (${parsed.error}); skipped`);
  }
  let plain = null;
  // Like net/http, HTTP_PROXY is ignored under CGI (REQUEST_METHOD set) so a
  // request header cannot inject a proxy.
  const plainVars = String(env.REQUEST_METHOD ?? '') ? ['http_proxy'] : ['HTTP_PROXY', 'http_proxy'];
  for (const name of plainVars) {
    const parsed = envProxy(env, name);
    if (parsed?.url) {
      plain = { url: parsed.url, source: name };
      break;
    }
    if (parsed) warnings.push(`${name} is not a usable proxy (${parsed.error}); skipped`);
  }
  const [noProxyRaw] = firstEnv(env, ['NO_PROXY', 'no_proxy']);
  return { ...none, proxy, plain, noProxy: parseNoProxy(noProxyRaw) };
}

// envProxy parses one proxy variable: null when it is unset or blank.
function envProxy(env, name) {
  const raw = String(env[name] ?? '').trim();
  return raw ? parseProxyURL(raw) : null;
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

const WITHHELD = 'invalid proxy URL; value withheld because it contains credentials';

// Schemes that are safe to name in an error even when the value carries
// credentials (common/netproxy knownScheme).
const KNOWN_SCHEMES = new Set(['socks', 'socks4', 'socks4a', 'socks5', 'socks5h', 'ftp', 'ws', 'wss', 'quic', 'h2', 'file']);

// parseProxyURL is common/netproxy v0.5.14 parseProxyURL: the scheme is
// optional (http), only http and https proxies are supported, and the
// userinfo runs to the LAST '@' and is percent-decoded, so credentials may
// hold unescaped '/', '?', '#' or '@' (url parsers would take part of such
// a token as the proxy host). The URL returned carries the credentials
// re-encoded byte for byte; the error never contains the value.
function parseProxyURL(raw) {
  const text = String(raw).trim();
  let scheme = 'http';
  let rest = text;
  const cut = text.indexOf('://');
  if (cut >= 0 && validScheme(text.slice(0, cut))) {
    scheme = text.slice(0, cut);
    rest = text.slice(cut + 3);
  }
  scheme = scheme.toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') {
    // With '@' in the value the "scheme" could be a user name
    // ("user://pass@host"), so only a well-known scheme is named.
    if (rest.includes('@') && !KNOWN_SCHEMES.has(scheme)) return { error: 'unsupported scheme, want http or https' };
    return { error: `unsupported scheme "${scheme}", want http or https` };
  }
  let credentials = null;
  let hostPart = rest;
  const at = rest.lastIndexOf('@');
  if (at >= 0) {
    credentials = parseUserinfo(rest.slice(0, at));
    if (credentials === undefined) return { error: WITHHELD };
    hostPart = rest.slice(at + 1);
  }
  // hostPart holds no credentials: everything up to the last '@' is gone.
  let url;
  try {
    url = new URL(`${scheme}://${hostPart}`);
  } catch {
    return { error: credentials ? WITHHELD : 'malformed URL' };
  }
  if (!url.hostname) return { error: 'no proxy host' };
  if (credentials) {
    url.username = percentEncodeBytes(credentials.user);
    if (credentials.password) url.password = percentEncodeBytes(credentials.password);
  }
  return { url };
}

// parseUserinfo decodes "user[:password]" into byte strings: null for an
// empty userinfo (no credentials), undefined when it is unusable (a control
// character or a bad percent-escape).
function parseUserinfo(text) {
  if (!text) return null;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return undefined;
  }
  const colon = text.indexOf(':');
  const user = pathUnescape(colon < 0 ? text : text.slice(0, colon));
  const password = colon < 0 ? null : pathUnescape(text.slice(colon + 1));
  if (!user || (colon >= 0 && !password)) return undefined;
  return { user, password };
}

// pathUnescape is Go's url.PathUnescape on the UTF-8 bytes of `text`: '%XX'
// becomes the byte, '+' stays '+', and a malformed escape is an error (null).
function pathUnescape(text) {
  const bytes = Buffer.from(text, 'utf8');
  const out = [];
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== 0x25) {
      out.push(bytes[i]);
      continue;
    }
    const hex = bytes.subarray(i + 1, i + 3).toString('latin1');
    if (!/^[0-9A-Fa-f]{2}$/.test(hex)) return null;
    out.push(Number.parseInt(hex, 16));
    i += 2;
  }
  return Buffer.from(out);
}

// percentEncodeBytes escapes every byte outside RFC 3986 "unreserved", so the
// bytes survive the URL and decode back exactly (see proxyAuthorization).
function percentEncodeBytes(bytes) {
  let out = '';
  for (const byte of bytes) {
    const char = String.fromCharCode(byte);
    out += /[A-Za-z0-9\-._~]/.test(char) ? char : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

// validScheme reports whether text is a syntactically valid URL scheme
// (RFC 3986: ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )).
function validScheme(text) {
  return /^[A-Za-z][A-Za-z0-9+.-]*$/.test(text);
}

// NO_PROXY, with the common/netproxy (Go httpproxy) rules: comma- or
// space-separated entries; "*" matches everything; "example.com" matches the
// host and its subdomains; ".example.com" or "*.example.com" only
// subdomains; IP addresses and CIDR ranges match IP-literal targets; an
// optional ":port" must match.
const EMPTY_NO_PROXY = Object.freeze({ all: false, cidrs: [], ips: [], domains: [] });

function parseNoProxy(raw) {
  const parsed = { all: false, cidrs: [], ips: [], domains: [] };
  // Go splits on exactly these separators (strings.FieldsFunc).
  for (const field of String(raw ?? '').split(/[, \t\n\r]+/)) {
    const entry = field.toLowerCase();
    if (!entry) continue;
    if (entry === '*') return { ...EMPTY_NO_PROXY, all: true };
    const cidr = entry.includes('/') ? parseCIDR(entry) : null;
    if (cidr) {
      parsed.cidrs.push(cidr);
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

// proxyAuthorization is the Basic Proxy-Authorization for a proxy URL's
// credentials, decoded to their exact bytes as Go's net/http sends them.
function proxyAuthorization(proxy) {
  const decode = (text) => pathUnescape(text) ?? Buffer.from(text, 'utf8');
  const credentials = Buffer.concat([decode(proxy.username), Buffer.from(':'), decode(proxy.password)]);
  return `Basic ${credentials.toString('base64')}`;
}

// openTunnel asks the proxy to CONNECT to the target *by hostname* and
// resolves with the raw tunnelled socket.
function openTunnel(target, proxy, { signal, tlsOptions }) {
  const authority = `${target.hostname}:${target.port || defaultPort(target)}`;
  const headers = { host: authority };
  if (proxy.username || proxy.password) headers['proxy-authorization'] = proxyAuthorization(proxy);
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
