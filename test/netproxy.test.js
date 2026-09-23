// Egress-proxy support for proxy-only sandboxes (Meta Muse): outbound traffic
// is only possible through an authenticating HTTP proxy that allows
// `CONNECT host:443`, and local DNS for the Pilot hostnames is poisoned. The
// local proxy below enforces the same rules and routes by the CONNECT
// hostname, so every test target is an address that never resolves locally.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  configuredProxy,
  createProxyAwareFetch,
  inspectProxy,
  redactProxyURL,
  resolveProxy,
} from '../src/netproxy.js';

const CREDENTIALS = 'muse-agent:s3cr3t/p@ss';
// Fake pilot-daemon scripts: Go's flag package prints -h usage on stderr.
const PROXY_DAEMON = '#!/bin/sh\necho "  -proxy string" >&2\n';
const LEGACY_DAEMON = '#!/bin/sh\necho "  -transport string" >&2\n';
const PROXY_USERINFO = 'muse-agent:s3cr3t%2Fp%40ss';

test('HTTPS targets use HTTPS_PROXY, then https_proxy, then ALL_PROXY', () => {
  const target = 'https://github.com/pilot-protocol';
  assert.equal(resolveProxy(target, { HTTPS_PROXY: 'http://a:1', https_proxy: 'http://b:2', ALL_PROXY: 'http://c:3' }).host, 'a:1');
  assert.equal(resolveProxy(target, { https_proxy: 'http://b:2', ALL_PROXY: 'http://c:3' }).host, 'b:2');
  assert.equal(resolveProxy(target, { all_proxy: 'http://c:3' }).host, 'c:3');
  assert.equal(resolveProxy(target, { HTTPS_PROXY: '  ', all_proxy: 'http://c:3' }).host, 'c:3');
  assert.equal(resolveProxy(target, { HTTP_PROXY: 'http://d:4' }), null);
  assert.equal(resolveProxy(target, {}), null);
});

test('plain http targets prefer HTTP_PROXY and otherwise use the HTTPS proxy, as common/netproxy does', () => {
  assert.equal(resolveProxy('http://example.com/', { HTTP_PROXY: 'http://d:4', HTTPS_PROXY: 'http://a:1' }).host, 'd:4');
  assert.equal(resolveProxy('http://example.com/', { http_proxy: 'http://e:5', HTTPS_PROXY: 'http://a:1' }).host, 'e:5');
  assert.equal(resolveProxy('http://example.com/', { HTTPS_PROXY: 'http://a:1' }).host, 'a:1');
  // Under CGI a request header could set HTTP_PROXY, so it is ignored.
  assert.equal(resolveProxy('http://example.com/', { HTTP_PROXY: 'http://d:4', HTTPS_PROXY: 'http://a:1', REQUEST_METHOD: 'GET' }).host, 'a:1');
  // An unusable HTTP_PROXY costs only itself, never the HTTPS proxy.
  const settings = inspectProxy({ HTTP_PROXY: 'socks5://d:4', HTTPS_PROXY: 'http://a:1' });
  assert.equal(settings.proxy.url.host, 'a:1');
  assert.equal(resolveProxy('http://example.com/', { HTTP_PROXY: 'socks5://d:4', HTTPS_PROXY: 'http://a:1' }).host, 'a:1');
  assert.match(settings.warnings.join('\n'), /HTTP_PROXY is not a usable proxy \(unsupported scheme "socks5"/);
});

test('the first non-empty proxy variable decides; an unusable one means no proxy, with a warning', () => {
  assert.equal(resolveProxy('https://github.com/', { HTTPS_PROXY: 'proxy.internal:3128' }).href, 'http://proxy.internal:3128/');
  assert.equal(resolveProxy('https://github.com/', { ALL_PROXY: 'socks5://127.0.0.1:1080' }), null);
  // Go's netproxy takes the first non-empty variable; skipping to ALL_PROXY
  // here would route setup through a proxy the daemon does not use.
  const env = { HTTPS_PROXY: 'socks5://user:s3cr3t@127.0.0.1:1080', ALL_PROXY: 'http://c:3' };
  assert.equal(resolveProxy('https://github.com/', env), null);
  assert.equal(configuredProxy(env), null);
  const { warnings } = inspectProxy(env);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^HTTPS_PROXY is not a usable proxy \(unsupported scheme "socks5", want http or https\)/);
  assert.doesNotMatch(warnings[0], /s3cr3t|user/);
});

test('credentials that are not percent-encoded are rejected instead of becoming the proxy host', () => {
  for (const value of [
    'http://abcDEF/ghi+jkl@proxy.muse:3128',
    'http://user:9876/zz@proxy:3128',
    'http://user:9876?zz@proxy:3128',
    'http://user:98#76@proxy:3128',
  ]) {
    const { proxy, warnings } = inspectProxy({ HTTPS_PROXY: value });
    assert.equal(proxy, null, value);
    assert.match(warnings.join('\n'), /percent-encoded|malformed/, value);
    assert.doesNotMatch(warnings.join('\n'), /abcDEF|ghi|9876|zz|user/, value);
  }
  assert.equal(configuredProxy({ HTTPS_PROXY: `http://${PROXY_USERINFO}@proxy:3128` }).url.hostname, 'proxy');
});

test('NO_PROXY follows the Go httpproxy matching rules', () => {
  const env = (value) => ({ HTTPS_PROXY: 'http://proxy:3128', NO_PROXY: value });
  const direct = (url, value) => resolveProxy(url, env(value)) === null;
  assert.equal(direct('https://registry.pilotprotocol.network/', '*'), true);
  assert.equal(direct('https://pilotprotocol.network/', 'pilotprotocol.network'), true);
  assert.equal(direct('https://registry.pilotprotocol.network/', 'pilotprotocol.network'), true);
  assert.equal(direct('https://pilotprotocol.network/', '.pilotprotocol.network'), false);
  assert.equal(direct('https://registry.pilotprotocol.network/', '.pilotprotocol.network'), true);
  assert.equal(direct('https://registry.pilotprotocol.network/', '*.pilotprotocol.network'), true);
  assert.equal(direct('https://notpilotprotocol.network/', 'pilotprotocol.network'), false);
  assert.equal(direct('https://github.com/', 'github.com:8443'), false);
  assert.equal(direct('https://github.com/', 'github.com:443'), true);
  assert.equal(direct('https://10.1.2.3/', '10.0.0.0/8'), true);
  assert.equal(direct('https://11.1.2.3/', '10.0.0.0/8'), false);
  assert.equal(direct('https://[2001:db8::1]/', '2001:db8::/32'), true);
  assert.equal(direct('https://[2001:db8::1]/', '2001:0db8:0:0:0:0:0:1'), true);
  assert.equal(direct('https://192.0.2.7/', '192.0.2.7'), true);
  assert.equal(direct('https://192.0.2.7/', '192.0.2.7:8443'), false);
  assert.equal(direct('https://192.0.2.7/', '192.0.2.7:443'), true);
  assert.equal(direct('https://github.com/', 'example.com, ,other.test'), false);
  assert.equal(direct('https://github.com/', 'example.com github.com'), true);
  assert.equal(resolveProxy('https://github.com/', { HTTPS_PROXY: 'http://proxy:3128', no_proxy: 'github.com' }), null);
  // The first non-empty of NO_PROXY/no_proxy applies, as in Go.
  assert.equal(resolveProxy('https://github.com/', { HTTPS_PROXY: 'http://proxy:3128', NO_PROXY: '', no_proxy: 'github.com' }), null);
  assert.notEqual(resolveProxy('https://github.com/', { HTTPS_PROXY: 'http://proxy:3128', NO_PROXY: 'other.test', no_proxy: 'github.com' }), null);
});

test('localhost and loopback addresses are never proxied, whatever the mode', () => {
  for (const env of [{ HTTPS_PROXY: 'http://proxy:3128' }, { PILOT_PROXY: 'http://explicit:2' }]) {
    for (const target of ['https://localhost:8443/', 'https://127.0.0.1/', 'https://127.8.9.10/', 'https://[::1]/', 'https://[::ffff:127.0.0.1]/']) {
      assert.equal(resolveProxy(target, env), null, `${target} ${JSON.stringify(env)}`);
    }
    assert.notEqual(resolveProxy('https://github.com/', env), null);
  }
});

test('PILOT_PROXY selects auto, off, or an explicit proxy', () => {
  const env = { HTTPS_PROXY: 'http://env:1', NO_PROXY: 'github.com' };
  assert.equal(resolveProxy('https://pilotprotocol.network/', { ...env, PILOT_PROXY: 'auto' }).host, 'env:1');
  assert.equal(resolveProxy('https://pilotprotocol.network/', { ...env, PILOT_PROXY: 'AUTO' }).host, 'env:1');
  for (const off of ['off', 'OFF', 'none', 'false', 'direct']) {
    assert.equal(resolveProxy('https://pilotprotocol.network/', { ...env, PILOT_PROXY: off }), null, off);
    assert.equal(inspectProxy({ ...env, PILOT_PROXY: off }).mode, 'off', off);
  }
  // An explicit proxy applies to every target; NO_PROXY does not exempt any.
  assert.equal(resolveProxy('https://github.com/', { ...env, PILOT_PROXY: 'https://u:p@explicit:2' }).host, 'explicit:2');
  // Like Go's netproxy.Explicit, a missing scheme means http.
  assert.equal(resolveProxy('https://github.com/', { PILOT_PROXY: 'proxy.corp:3128' }).href, 'http://proxy.corp:3128/');
});

test('an unusable PILOT_PROXY never throws: it is ignored with a warning and auto applies', () => {
  for (const value of ['socks5://explicit:2', 'http://', 'http://u:s3cr3t@:3128']) {
    assert.doesNotThrow(() => resolveProxy('https://github.com/', { PILOT_PROXY: value }));
    assert.equal(resolveProxy('https://github.com/', { PILOT_PROXY: value }), null, value);
    assert.equal(resolveProxy('https://github.com/', { PILOT_PROXY: value, HTTPS_PROXY: 'http://env:1' }).host, 'env:1', value);
    const { mode, warnings } = inspectProxy({ PILOT_PROXY: value });
    assert.equal(mode, 'auto', value);
    assert.match(warnings.join('\n'), /^PILOT_PROXY is not a usable proxy/, value);
    assert.doesNotMatch(warnings.join('\n'), /s3cr3t/);
  }
});

test('configuredProxy names the proxy setup must route the daemon through', () => {
  assert.equal(configuredProxy({}), null);
  assert.equal(configuredProxy({ HTTPS_PROXY: 'http://a:1', PILOT_PROXY: 'off' }), null);
  // NO_PROXY exempts individual hosts, not the daemon's need for a proxy.
  const selected = configuredProxy({ https_proxy: 'http://a:1', NO_PROXY: '*' });
  assert.equal(selected.source, 'https_proxy');
  assert.equal(selected.url.host, 'a:1');
  assert.equal(configuredProxy({ HTTPS_PROXY: 'http://a:1', PILOT_PROXY: 'http://b:2' }).source, 'PILOT_PROXY');
  // A daemon config.json "proxy" is applied ahead of $PILOT_PROXY.
  const fromConfig = configuredProxy({ HTTPS_PROXY: 'http://a:1', PILOT_PROXY: 'http://b:2' }, { spec: 'http://c:3', specSource: 'config.json proxy' });
  assert.equal(fromConfig.source, 'config.json proxy');
  assert.equal(fromConfig.url.host, 'c:3');
  assert.equal(configuredProxy({ HTTPS_PROXY: 'http://a:1' }, { spec: 'off' }), null);
  assert.equal(configuredProxy({ HTTPS_PROXY: 'http://a:1' }, { spec: 'auto' }).source, 'HTTPS_PROXY');
  assert.equal(configuredProxy({ HTTPS_PROXY: 'http://a:1', PILOT_PROXY: 'off' }, { spec: '' }), null);
});

test('proxy URLs are redacted before they reach logs', () => {
  assert.equal(redactProxyURL(`http://${PROXY_USERINFO}@proxy.muse.internal:3128/`), 'http://***@proxy.muse.internal:3128');
  assert.equal(redactProxyURL(new URL('https://user@proxy:443')), 'https://***@proxy');
  assert.equal(redactProxyURL('http://proxy:3128'), 'http://proxy:3128');
  assert.equal(redactProxyURL('::not a url::'), '(invalid proxy URL)');
});

test('requests without a proxy go to the direct fetch unchanged', async () => {
  const calls = [];
  const direct = async (...args) => { calls.push(args); return new Response('direct'); };
  const init = { redirect: 'follow' };
  const fetcher = createProxyAwareFetch({ env: { HTTPS_PROXY: 'http://proxy:3128', NO_PROXY: 'github.com' }, directFetch: direct });
  assert.equal(await (await fetcher('https://github.com/x', init)).text(), 'direct');
  assert.deepEqual(calls, [['https://github.com/x', init]]);
});

test('requests tunnel through an authenticating CONNECT proxy by hostname', { timeout: 20_000 }, async (t) => {
  const origin = await startServer(http.createServer((req, res) => {
    if (req.url === '/moved') {
      res.writeHead(302, { location: 'http://assets.pilot.invalid:443/manifest.json' });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json', 'x-served-host': req.headers.host });
    res.end(JSON.stringify({ path: req.url, ua: req.headers['user-agent'] }));
  }));
  t.after(() => origin.close());
  const proxy = await startConnectProxy({ 'releases.pilot.invalid': origin.port, 'assets.pilot.invalid': origin.port });
  t.after(() => proxy.close());

  const fetcher = createProxyAwareFetch({ env: { HTTP_PROXY: proxy.url }, directFetch: refuseDirect });
  const response = await fetcher('http://releases.pilot.invalid:443/moved');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-served-host'), 'assets.pilot.invalid:443');
  assert.deepEqual(await response.json(), { path: '/manifest.json', ua: 'pilotprotocol-mcp' });
  assert.deepEqual(proxy.log, [
    { authority: 'releases.pilot.invalid:443', authorized: true },
    { authority: 'assets.pilot.invalid:443', authorized: true },
  ]);
});

test('proxy refusals are reported without leaking credentials', { timeout: 20_000 }, async (t) => {
  const proxy = await startConnectProxy({});
  t.after(() => proxy.close());
  const wrong = proxy.url.replace('s3cr3t', 'wrong-secret');
  const fetcher = createProxyAwareFetch({ env: { HTTPS_PROXY: wrong }, directFetch: refuseDirect });
  await assert.rejects(fetcher('https://github.com/'), (error) => {
    assert.match(error.message, /proxy http:\/\/\*\*\*@127\.0\.0\.1:\d+ refused CONNECT github\.com:443: HTTP 407/);
    assert.doesNotMatch(error.message, /wrong-secret|muse-agent/);
    return true;
  });
  const allowed = createProxyAwareFetch({ env: { HTTPS_PROXY: proxy.url }, directFetch: refuseDirect });
  await assert.rejects(allowed('https://github.com:8443/'), /refused CONNECT github\.com:8443: HTTP 403/);
});

test('TLS runs end-to-end inside the tunnel and still verifies the hostname', { timeout: 20_000 }, async (t) => {
  const pki = makeCertificate(t, ['github.com', 'registry.pilot.invalid']);
  if (!pki) return;
  const origin = await startServer(https.createServer({ key: pki.key, cert: pki.cert }, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`tls:${req.headers.host}${req.url}`);
  }));
  t.after(() => origin.close());
  const proxy = await startConnectProxy({ 'registry.pilot.invalid': origin.port, 'wrong.pilot.invalid': origin.port });
  t.after(() => proxy.close());

  const fetcher = createProxyAwareFetch({ env: { HTTPS_PROXY: proxy.url }, tls: { ca: pki.cert }, directFetch: refuseDirect });
  assert.equal(await (await fetcher('https://registry.pilot.invalid/v1/ping')).text(), 'tls:registry.pilot.invalid/v1/ping');
  await assert.rejects(fetcher('https://wrong.pilot.invalid/'), (error) => {
    assert.equal(error.code, 'ERR_TLS_CERT_ALTNAME_INVALID');
    return true;
  });
  const untrusted = createProxyAwareFetch({ env: { HTTPS_PROXY: proxy.url }, directFetch: refuseDirect });
  await assert.rejects(untrusted('https://registry.pilot.invalid/'), /self[- ]signed|unable to verify|unable to get local issuer/i);
});

test('setup downloads the runtime through the proxy and keeps the checksum gate', { timeout: 60_000 }, async (t) => {
  const release = await startReleaseMirror(t);
  if (!release) return;
  const { proxy, served, tag, assetPath } = release;

  const home = release.home('fresh');
  const result = await release.install(home);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.path, join(home, '.pilot', 'bin', 'pilotctl'));
  assert.equal(readFileSync(join(home, '.pilot', 'bin', 'pilot-daemon'), 'utf8'), PROXY_DAEMON);
  assert.equal(readFileSync(join(home, '.pilot', 'bin', '.pilot-version'), 'utf8'), `${tag}\n`);
  assert.deepEqual(proxy.log, [
    { authority: 'pilotprotocol.network:443', authorized: true },
    { authority: 'github.com:443', authorized: true },
    { authority: 'release-assets.githubusercontent.com:443', authorized: true },
  ]);
  assert.deepEqual(served, [
    'pilotprotocol.network/.well-known/latest.json',
    `github.com${assetPath}`,
    'release-assets.githubusercontent.com/asset/pilot.tar.gz?sig=1',
  ]);

  release.setDigest('b'.repeat(64));
  const tampered = release.home('tampered');
  const rejected = await release.install(tampered);
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /checksum did not match/);
  assert.equal(existsSync(join(tampered, '.pilot', 'bin', 'pilotctl')), false);

  const denied = release.home('denied');
  const refused = await release.install(denied, { proxyURL: proxy.url.replace('s3cr3t', 'nope') });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /refused CONNECT pilotprotocol\.network:443: HTTP 407/);
  assert.doesNotMatch(refused.error, /nope|muse-agent/);
});

test('a per-user runtime without -proxy is upgraded through the proxy only to a newer release with -proxy', { timeout: 60_000 }, async (t) => {
  const release = await startReleaseMirror(t);
  if (!release) return;
  const legacy = (name, tag, extra = () => {}) => {
    const home = release.home(name);
    const bin = join(home, '.pilot', 'bin');
    mkdirSync(bin, { recursive: true });
    for (const binary of ['pilotctl', 'pilot-daemon']) {
      writeFileSync(join(bin, binary), LEGACY_DAEMON);
      chmodSync(join(bin, binary), 0o755);
    }
    if (tag !== null) writeFileSync(join(bin, '.pilot-version'), `${tag}\n`);
    extra(home);
    return home;
  };
  const daemonOf = (home) => readFileSync(join(home, '.pilot', 'bin', 'pilot-daemon'), 'utf8');
  const versionOf = (home) => readFileSync(join(home, '.pilot', 'bin', '.pilot-version'), 'utf8').trim();
  const stagesOf = (home) => readdirSync(join(home, '.pilot')).filter((name) => name.startsWith('.runtime-stage-'));

  const outdated = legacy('outdated', 'v1.13.9');
  const upgraded = await release.upgrade(outdated);
  assert.equal(upgraded.ok, true, upgraded.error);
  assert.deepEqual(upgraded.result, { upgraded: true, path: join(outdated, '.pilot', 'bin', 'pilotctl'), from: 'v1.13.9', to: release.tag });
  assert.equal(daemonOf(outdated), PROXY_DAEMON);
  assert.equal(versionOf(outdated), release.tag);
  // ensurePilotRuntime({ requireProxy }) takes the same path.
  const viaEnsure = legacy('via-ensure', 'v1.13.9');
  const ensured = await release.install(viaEnsure, { requireProxy: true });
  assert.equal(ensured.ok, true, ensured.error);
  assert.equal(daemonOf(viaEnsure), PROXY_DAEMON);

  // Already on the newest published release, or ahead of it (a beta, or a
  // runtime pilot-updater moved past the manifest): never a downgrade, and
  // nothing but the manifest is fetched.
  for (const [name, tag] of [['current', release.tag], ['ahead', 'v10.0.0-rc.1'], ['ahead-rc-of-same', `${release.tag}-rc.1`]]) {
    release.served.length = 0;
    const home = legacy(name, tag);
    const kept = await release.upgrade(home);
    assert.equal(kept.ok, true, kept.error);
    if (name === 'ahead-rc-of-same') {
      // v9.9.9 is newer than v9.9.9-rc.1, so that one does upgrade.
      assert.equal(kept.result.upgraded, true);
      continue;
    }
    assert.equal(kept.result.upgraded, false, name);
    assert.match(kept.result.reason, /is not newer than the installed/);
    assert.deepEqual(release.served, ['pilotprotocol.network/.well-known/latest.json'], name);
    assert.equal(daemonOf(home), LEGACY_DAEMON, name);
    assert.equal(versionOf(home), tag, name);
  }

  // Unknown or missing versions and managed nodes are never touched, and no
  // request is made for them.
  const managedControl = (home) => {
    mkdirSync(join(home, '.pilot', 'managed'), { recursive: true });
    writeFileSync(join(home, '.pilot', 'managed', 'enterprise-control.json'), '{}', { mode: 0o600 });
  };
  const managedConfig = (home) => writeFileSync(join(home, '.pilot', 'config.json'), JSON.stringify({ enterprise_control: '/secure/control.json' }));
  for (const [name, tag, extra, reason] of [
    ['untagged', null, undefined, /has no recorded version/],
    ['dev', 'dev', undefined, /dev is not a release version/],
    ['managed-tag', 'managed-runtime-v0.1.5', undefined, /managed \(runtime managed-runtime-v0\.1\.5\)/],
    ['managed-control', 'v1.13.9', managedControl, /managed \(enterprise control attachment\)/],
    ['managed-config', 'v1.13.9', managedConfig, /managed \(config\.json enterprise_control\)/],
  ]) {
    release.served.length = 0;
    const home = legacy(name, tag, extra);
    const kept = await release.upgrade(home);
    assert.equal(kept.ok, true, kept.error);
    assert.equal(kept.result.upgraded, false, name);
    assert.match(kept.result.reason, reason, name);
    assert.deepEqual(release.served, [], name);
    assert.equal(daemonOf(home), LEGACY_DAEMON, name);
    const viaEnsureKept = await release.install(home, { requireProxy: true });
    assert.equal(viaEnsureKept.ok, true, viaEnsureKept.error);
    assert.equal(daemonOf(home), LEGACY_DAEMON, name);
  }
  release.served.length = 0;
  const managedByEnv = legacy('managed-env', 'v1.13.9');
  const envKept = await release.upgrade(managedByEnv, { env: { PILOT_ENTERPRISE_CONTROL: '/secure/control.json' } });
  assert.equal(envKept.result.upgraded, false);
  assert.match(envKept.result.reason, /managed \(PILOT_ENTERPRISE_CONTROL\)/);
  assert.deepEqual(release.served, []);

  // A newer release whose daemon still lacks -proxy is checked in the
  // staging directory and discarded: the installed runtime stays in place.
  release.setDaemon(LEGACY_DAEMON);
  const stillLegacy = legacy('still-legacy', 'v1.13.9');
  const discarded = await release.upgrade(stillLegacy);
  assert.equal(discarded.ok, true, discarded.error);
  assert.equal(discarded.result.upgraded, false);
  assert.match(discarded.result.reason, /v9\.9\.9 does not support -proxy yet/);
  assert.equal(versionOf(stillLegacy), 'v1.13.9');
  assert.deepEqual(stagesOf(stillLegacy), []);
});

async function refuseDirect(url) {
  throw new Error(`unexpected direct request to ${url}`);
}

function startServer(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      close: () => new Promise((done) => {
        server.closeAllConnections?.();
        server.close(() => done());
      }),
    }));
  });
}

// startConnectProxy mimics the Muse egress proxy: Basic proxy auth, CONNECT
// only, port 443 only, routed by the requested hostname (never resolved).
async function startConnectProxy(routes) {
  const log = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    res.writeHead(405);
    res.end();
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('connect', (req, client, head) => {
    const authorized = req.headers['proxy-authorization'] === `Basic ${Buffer.from(CREDENTIALS).toString('base64')}`;
    log.push({ authority: req.url, authorized });
    const reply = (status, text) => client.end(`HTTP/1.1 ${status} ${text}\r\nContent-Length: 0\r\n\r\n`);
    if (!authorized) return reply(407, 'Proxy Authentication Required');
    const separator = req.url.lastIndexOf(':');
    const host = req.url.slice(0, separator);
    if (req.url.slice(separator + 1) !== '443') return reply(403, 'Forbidden');
    if (!routes[host]) return reply(502, 'Bad Gateway');
    const upstream = net.connect(routes[host], '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
    return undefined;
  });
  const { port, close } = await startServer(server);
  return {
    url: `http://${PROXY_USERINFO}@127.0.0.1:${port}`,
    log,
    close: () => {
      for (const socket of sockets) socket.destroy();
      return close();
    },
  };
}

function makeCertificate(t, names) {
  const dir = mkdtempSync(join(tmpdir(), 'pilot-proxy-pki-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const result = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
    '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-days', '2',
    '-subj', '/CN=pilot-proxy-test', '-addext', `subjectAltName=${names.map((name) => `DNS:${name}`).join(',')}`,
  ], { encoding: 'utf8', timeout: 20_000 });
  if (result.status !== 0) {
    t.skip(`openssl could not create a test certificate: ${result.error?.message ?? result.stderr}`);
    return null;
  }
  return { key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) };
}

// startReleaseMirror serves a fake release manifest, a GitHub release asset
// redirect and the asset itself over TLS for the real production hostnames,
// reachable only through the Muse-like proxy.
async function startReleaseMirror(t) {
  const key = runtimeKey();
  if (process.platform === 'win32' || !key) {
    t.skip('the runtime is published for macOS and Linux only');
    return null;
  }
  const pki = makeCertificate(t, ['pilotprotocol.network', 'github.com', 'release-assets.githubusercontent.com']);
  if (!pki) return null;
  const work = mkdtempSync(join(tmpdir(), 'pilot-proxy-runtime-'));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  let archive = buildRuntimeArchive(work, PROXY_DAEMON);
  const tag = 'v9.9.9';
  const assetPath = `/pilot-protocol/pilotprotocol/releases/download/${tag}/pilot-${key}.tar.gz`;
  let digest = createHash('sha256').update(archive).digest('hex');
  const served = [];
  const origin = await startServer(https.createServer({ key: pki.key, cert: pki.cert }, (req, res) => {
    served.push(`${req.headers.host}${req.url}`);
    if (req.headers.host === 'pilotprotocol.network' && req.url === '/.well-known/latest.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ latest_stable: tag, platforms: { [key]: { url: `https://github.com${assetPath}`, sha256: digest } } }));
    } else if (req.headers.host === 'github.com' && req.url === assetPath) {
      res.writeHead(302, { location: 'https://release-assets.githubusercontent.com/asset/pilot.tar.gz?sig=1' });
      res.end();
    } else if (req.headers.host === 'release-assets.githubusercontent.com') {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': archive.length });
      res.end(archive);
    } else {
      res.writeHead(404);
      res.end();
    }
  }));
  t.after(() => origin.close());
  const proxy = await startConnectProxy({
    'pilotprotocol.network': origin.port,
    'github.com': origin.port,
    'release-assets.githubusercontent.com': origin.port,
  });
  t.after(() => proxy.close());
  writeFileSync(join(work, 'ca.pem'), pki.cert);
  return {
    proxy,
    served,
    tag,
    assetPath,
    setDigest: (value) => { digest = value; },
    setDaemon: (script) => {
      archive = buildRuntimeArchive(work, script);
      digest = createHash('sha256').update(archive).digest('hex');
    },
    home: (name) => {
      const home = join(work, name);
      mkdirSync(home);
      return home;
    },
    install: (home, { proxyURL = proxy.url, requireProxy = false } = {}) => runRuntimeInstall(childEnv(home, proxyURL), 'ensurePilotRuntime', { requireProxy }),
    upgrade: (home, { env = {} } = {}) => runRuntimeInstall({ ...childEnv(home, proxy.url), ...env }, 'upgradeRuntimeForProxy', {}),
  };
  function childEnv(home, proxyURL) {
    return {
      HOME: home,
      PATH: '/usr/bin:/bin',
      HTTPS_PROXY: proxyURL,
      NODE_EXTRA_CA_CERTS: join(work, 'ca.pem'),
      PILOT_RELEASE_MANIFEST_URL: 'https://pilotprotocol.network/.well-known/latest.json',
    };
  }
}

function runtimeKey() {
  const arch = process.arch === 'x64' ? 'amd64' : process.arch;
  const key = `${process.platform}-${arch}`;
  return ['darwin-amd64', 'darwin-arm64', 'linux-amd64', 'linux-arm64'].includes(key) ? key : null;
}

function buildRuntimeArchive(work, daemonScript) {
  const stage = join(work, 'stage');
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage);
  for (const [name, script] of [['daemon', daemonScript], ['pilotctl', '#!/bin/sh\necho pilotctl\n']]) {
    writeFileSync(join(stage, name), script);
    chmodSync(join(stage, name), 0o755);
  }
  const archivePath = join(work, 'runtime.tar.gz');
  const packed = spawnSync('tar', ['-czf', archivePath, '-C', stage, 'daemon', 'pilotctl'], {
    encoding: 'utf8', env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  assert.equal(packed.status, 0, packed.stderr);
  return readFileSync(archivePath);
}

// The runtime installer resolves pilotctl from $HOME and $PATH, so it runs in
// a child with an isolated environment: nothing from the host leaks in and no
// request can bypass the proxy.
function runRuntimeInstall(env, entry, options = {}) {
  const runtime = new URL('../src/setup/runtime.js', import.meta.url).href;
  const script = `
    const runtime = await import(${JSON.stringify(runtime)});
    try {
      const result = await runtime[${JSON.stringify(entry)}](${JSON.stringify(options)});
      console.log(JSON.stringify(typeof result === 'string' ? { ok: true, path: result } : { ok: true, result }));
    } catch (error) {
      console.log(JSON.stringify({ ok: false, error: error.message }));
    }`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', () => {
      try {
        resolve(JSON.parse(stdout.trim().split('\n').pop()));
      } catch {
        reject(new Error(`runtime install produced no result: ${stdout} ${stderr}`));
      }
    });
  });
}
