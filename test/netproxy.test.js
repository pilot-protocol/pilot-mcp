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
  daemonProxySetting,
  inspectProxy,
  parseProxySetting,
  proxyCommandFor,
  proxyHasCredentials,
  redactProxyURL,
  resolveProxy,
  runProxyCommand,
  SANDBOX_PROXY_CMD,
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

test('an unusable ALL_PROXY is skipped; an unusable HTTPS_PROXY means no proxy, as in common v0.5.14', () => {
  assert.equal(resolveProxy('https://github.com/', { HTTPS_PROXY: 'proxy.internal:3128' }).href, 'http://proxy.internal:3128/');
  assert.equal(resolveProxy('https://github.com/', { ALL_PROXY: 'socks5://127.0.0.1:1080' }), null);
  // ALL_PROXY does not name the TLS proxy, so Go skips it to all_proxy (the
  // review repro: Go proxies via p.corp:3128 here).
  const skipped = { ALL_PROXY: 'socks5://127.0.0.1:1080', all_proxy: 'http://p.corp:3128' };
  assert.equal(resolveProxy('https://github.com/', skipped).host, 'p.corp:3128');
  assert.equal(configuredProxy(skipped).source, 'all_proxy');
  assert.match(inspectProxy(skipped).warnings.join('\n'), /^ALL_PROXY is not a usable proxy \(unsupported scheme "socks5", want http or https\); skipped$/);
  // An unusable HTTPS_PROXY fails Go's whole environment: the daemon dials
  // directly, so setup selects no proxy either, for any target.
  const env = { HTTPS_PROXY: 'socks5://user:s3cr3t@127.0.0.1:1080', ALL_PROXY: 'http://c:3', HTTP_PROXY: 'http://d:4' };
  assert.equal(resolveProxy('https://github.com/', env), null);
  assert.equal(resolveProxy('http://github.com/', env), null);
  assert.equal(configuredProxy(env), null);
  const { warnings } = inspectProxy(env);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^HTTPS_PROXY is not a usable proxy \(unsupported scheme "socks5", want http or https\); pilot-daemon then ignores the proxy environment/);
  assert.doesNotMatch(warnings[0], /s3cr3t|user/);
});

test('credentials may hold unescaped / ? # @: the userinfo runs to the last @, as in common v0.5.14', () => {
  // The review repro: Go gives mode=auto proxy=http://***@proxy.corp:3128.
  const selected = configuredProxy({ HTTPS_PROXY: 'http://abc/def:tok@proxy.corp:3128' });
  assert.equal(selected.url.host, 'proxy.corp:3128');
  assert.deepEqual(credentialsOf(selected.url), ['abc/def', 'tok']);
  assert.equal(redactProxyURL(selected.url), 'http://***@proxy.corp:3128');
  assert.equal(configuredProxy({ HTTPS_PROXY: `http://${PROXY_USERINFO}@proxy:3128` }).url.hostname, 'proxy');
  assert.deepEqual(credentialsOf(configuredProxy({ HTTPS_PROXY: `http://${CREDENTIALS}@proxy:3128` }).url), ['muse-agent', 's3cr3t/p@ss']);
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

test('PILOT_PROXY selects auto, off, or an explicit http(s):// proxy, as pilot-daemon and pilotctl accept them', () => {
  const env = { HTTPS_PROXY: 'http://env:1', NO_PROXY: 'github.com' };
  assert.equal(resolveProxy('https://pilotprotocol.network/', { ...env, PILOT_PROXY: 'auto' }).host, 'env:1');
  assert.equal(resolveProxy('https://pilotprotocol.network/', { ...env, PILOT_PROXY: ' AUTO ' }).host, 'env:1');
  for (const off of ['off', 'OFF', 'none', ' None ', 'no', 'false', 'direct']) {
    assert.equal(resolveProxy('https://pilotprotocol.network/', { ...env, PILOT_PROXY: off }), null, off);
    assert.equal(inspectProxy({ ...env, PILOT_PROXY: off }).mode, 'off', off);
    assert.equal(inspectProxy({ ...env, PILOT_PROXY: off }).setting, 'PILOT_PROXY', off);
    assert.deepEqual(parseProxySetting(off), { mode: 'off' }, off);
  }
  // An explicit proxy applies to every target; NO_PROXY does not exempt any.
  assert.equal(resolveProxy('https://github.com/', { ...env, PILOT_PROXY: 'https://u:p@explicit:2' }).host, 'explicit:2');
  assert.equal(resolveProxy('https://github.com/', { PILOT_PROXY: 'HTTP://Proxy.corp:3128' }).host, 'proxy.corp:3128');
});

test('an unusable PILOT_PROXY never throws: it is ignored with a warning and auto applies', () => {
  // Without an http(s):// scheme a setting is refused (by pilotctl and
  // pilot-daemon too), so a typo never becomes a proxy host name.
  for (const value of ['socks5://explicit:2', 'http://', 'http://u:s3cr3t@:3128', 'proxy.corp:3128', 'u:s3cr3t@proxy.corp:3128', 'nonee', 'yes', 'user:pa://s3cr3t@proxy:3128']) {
    assert.doesNotThrow(() => resolveProxy('https://github.com/', { PILOT_PROXY: value }));
    assert.equal(resolveProxy('https://github.com/', { PILOT_PROXY: value }), null, value);
    assert.equal(resolveProxy('https://github.com/', { PILOT_PROXY: value, HTTPS_PROXY: 'http://env:1' }).host, 'env:1', value);
    const { mode, warnings } = inspectProxy({ PILOT_PROXY: value });
    assert.equal(mode, 'auto', value);
    assert.equal(parseProxySetting(value).mode, 'invalid', value);
    assert.match(warnings.join('\n'), /^PILOT_PROXY is not a usable proxy setting/, value);
    assert.doesNotMatch(warnings.join('\n'), /s3cr3t/);
  }
});

test('pilot-daemon gets PILOT_PROXY exactly as setup read it', () => {
  // Every off alias becomes "off", which every pilot-daemon build accepts
  // (older builds took "none" as the proxy host http://none).
  for (const off of ['off', 'OFF', 'none', 'No', 'false', 'direct']) assert.equal(daemonProxySetting(off), 'off', off);
  assert.equal(daemonProxySetting('AUTO'), 'auto');
  assert.equal(daemonProxySetting(' http://u:p@proxy:3128 '), 'http://u:p@proxy:3128');
  // A value setup ignores is not handed over: '' is the daemon's auto default.
  for (const ignored of ['socks5://127.0.0.1:1080', 'proxy.corp:3128', 'http://', 'nonee', '', '  ']) {
    assert.equal(daemonProxySetting(ignored), '', ignored);
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

// Parity table: the test vectors of common/netproxy v0.5.14
// (netproxy/zz_resolver_test.go), which pilot-daemon resolves -proxy with.
// When common changes a rule, port it to src/netproxy.js and here.
const REGISTRY = 'https://registry.pilotprotocol.network/';

test('common v0.5.14 parity: TestFromEnvPrecedence', () => {
  for (const [name, env, want] of [
    ['none', {}, ''],
    ['HTTPS_PROXY', { HTTPS_PROXY: 'http://a:1', https_proxy: 'http://b:1', ALL_PROXY: 'http://c:1' }, 'http://a:1'],
    ['https_proxy', { https_proxy: 'http://b:1', ALL_PROXY: 'http://c:1' }, 'http://b:1'],
    ['ALL_PROXY fallback', { ALL_PROXY: 'http://c:1', all_proxy: 'http://d:1' }, 'http://c:1'],
    ['all_proxy fallback', { all_proxy: 'http://d:1' }, 'http://d:1'],
    ['blank values skipped', { HTTPS_PROXY: '  ', all_proxy: 'http://d:1' }, 'http://d:1'],
    ['HTTP_PROXY alone does not cover TCP/TLS targets', { HTTP_PROXY: 'http://h:1' }, ''],
    ['scheme-less value means http', { HTTPS_PROXY: 'proxy.internal:3128' }, 'http://proxy.internal:3128'],
  ]) {
    assert.equal(inspectProxy(env).mode, 'auto', name);
    assert.equal(show(resolveProxy(REGISTRY, env)), want, name);
    assert.equal(show(resolveProxy('https://registry.pilotprotocol.network/x', env)), want, name);
  }
});

test('common v0.5.14 parity: TestFromEnvPlainHTTPRequests', () => {
  const both = { HTTPS_PROXY: 'http://secure:1', HTTP_PROXY: 'http://plain:1' };
  assert.equal(show(resolveProxy('http://example.pilot.invalid/', both)), 'http://plain:1');
  assert.equal(show(resolveProxy('https://example.pilot.invalid/', both)), 'http://secure:1');
  assert.equal(show(resolveProxy('http://example.pilot.invalid/', { HTTPS_PROXY: 'http://secure:1' })), 'http://secure:1');
  assert.equal(resolveProxy('http://example.pilot.invalid/', { REQUEST_METHOD: 'GET', HTTP_PROXY: 'http://evil:1' }), null);
  assert.equal(show(resolveProxy('http://example.pilot.invalid/', { REQUEST_METHOD: 'GET', HTTP_PROXY: 'http://evil:1', http_proxy: 'http://ok:1' })), 'http://ok:1');
});

test('common v0.5.14 parity: TestAutoAlwaysBypassesLoopback', () => {
  const env = { HTTPS_PROXY: 'http://p:1' };
  for (const target of ['https://localhost:443/', 'https://LOCALHOST:1/', 'https://127.0.0.1:9000/', 'https://127.9.9.9:1/', 'https://[::1]:443/']) {
    assert.equal(resolveProxy(target, env), null, target);
  }
  assert.equal(show(resolveProxy('https://10.0.0.1/', env)), 'http://p:1');
});

test('common v0.5.14 parity: TestParseExplicitURLs', () => {
  for (const [raw, scheme, host, user, password] of [
    ['http://proxy:3128', 'http:', 'proxy:3128'],
    ['HTTP://Proxy:3128', 'http:', 'proxy:3128'],
    ['https://u:p@proxy.example', 'https:', 'proxy.example', 'u', 'p'],
    ['proxy.example:8080', 'http:', 'proxy.example:8080'],
    ['u:p@proxy.example:8080', 'http:', 'proxy.example:8080', 'u', 'p'],
    ['  http://[::1]:3128  ', 'http:', '[::1]:3128'],
    ['http://u%40corp:p%3Aw@h:1/x', 'http:', 'h:1', 'u@corp', 'p:w'],
  ]) {
    // Go's Explicit takes a scheme-less URL; a proxy *setting* (PILOT_PROXY)
    // must name its scheme, so those two are checked as HTTPS_PROXY values.
    const envs = [{ HTTPS_PROXY: raw }];
    if (raw.includes('://')) envs.push({ PILOT_PROXY: raw });
    for (const env of envs) {
      const selected = configuredProxy(env);
      assert.ok(selected, `${raw} ${Object.keys(env)}`);
      assert.equal(selected.url.protocol, scheme, raw);
      assert.equal(selected.url.host, host, raw);
      assert.deepEqual(credentialsOf(selected.url), user === undefined ? null : [user, password], raw);
    }
  }
});

test('common v0.5.14 parity: TestParseErrorsNeverLeakCredentials', () => {
  for (const raw of [
    'socks5://user:hunter2@proxy:1080',
    'http://user:hunter2@proxy:bad-port',
    'http://user:hunter2@',
    'http://user:hunter2@proxy%zz:1',
    'ftp://proxy:21',
    'http://',
  ]) {
    for (const [name, env] of [['PILOT_PROXY', { PILOT_PROXY: raw }], ['HTTPS_PROXY', { HTTPS_PROXY: raw }]]) {
      const { proxy, warnings } = inspectProxy(env);
      assert.equal(proxy, null, `${name}=${raw}`);
      assert.equal(warnings.length, 1, `${name}=${raw}`);
      assert.ok(warnings[0].startsWith(`${name} is not a usable proxy`), warnings[0]);
      assert.doesNotMatch(warnings[0], /hunter2|user:/, `${name}=${raw}`);
    }
  }
  const { proxy, warnings } = inspectProxy({ HTTP_PROXY: 'gopher://user:hunter2@x:1' });
  assert.equal(proxy, null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^HTTP_PROXY is not a usable proxy/);
  assert.doesNotMatch(warnings[0], /hunter2|user/);
});

test('common v0.5.14 parity: TestFromEnvVariablesAreIndependent', () => {
  const secure = 'http://u:p@egress:3128';
  for (const [name, env, wantTLS, wantPlain, wantWarned] of [
    ['socks HTTP_PROXY beside a valid HTTPS_PROXY', { HTTPS_PROXY: secure, HTTP_PROXY: 'socks5://proxy:1080' }, secure, secure, ['HTTP_PROXY']],
    ['garbage http_proxy beside a valid https_proxy', { https_proxy: secure, http_proxy: 'garbage with space' }, secure, secure, ['http_proxy']],
    ['unusable HTTP_PROXY falls through to http_proxy', { HTTPS_PROXY: secure, HTTP_PROXY: 'socks5h://x:1', http_proxy: 'http://plain:8080' }, secure, 'http://plain:8080', ['HTTP_PROXY']],
    ['socks ALL_PROXY alone is ignored', { ALL_PROXY: 'socks5://127.0.0.1:1080' }, '', '', ['ALL_PROXY']],
    ['unusable ALL_PROXY falls through to all_proxy', { ALL_PROXY: 'socks5://127.0.0.1:1080', all_proxy: secure }, secure, secure, ['ALL_PROXY']],
    ['everything unusable except HTTPS_PROXY', { HTTPS_PROXY: secure, ALL_PROXY: 'socks5://a:1', HTTP_PROXY: 'http://bad port', http_proxy: 'ftp://c:21' }, secure, secure, ['HTTP_PROXY', 'http_proxy']],
  ]) {
    assert.equal(show(resolveProxy(REGISTRY, env)), wantTLS, name);
    assert.equal(show(resolveProxy('http://plain.pilot.invalid/', env)), wantPlain, name);
    const { warnings } = inspectProxy(env);
    assert.deepEqual(warnings.map((warning) => warning.split(' ')[0]), wantWarned, name);
    assert.doesNotMatch(warnings.join('\n'), /u:p/, name);
  }
});

test('common v0.5.14 parity: TestFromEnvUnusableTLSProxyIsAnError', () => {
  for (const [env, variable] of [
    [{ HTTPS_PROXY: 'socks5://user:hunter2@a:1', https_proxy: 'http://ok:1', HTTP_PROXY: 'http://ok:1' }, 'HTTPS_PROXY'],
    [{ https_proxy: 'http://user:hunter2@a:bad', ALL_PROXY: 'http://ok:1' }, 'https_proxy'],
  ]) {
    // Go returns an error; pilot-daemon then uses no proxy at all.
    assert.equal(resolveProxy(REGISTRY, env), null, variable);
    assert.equal(resolveProxy('http://plain.pilot.invalid/', env), null, variable);
    const { warnings } = inspectProxy(env);
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].startsWith(`${variable} is not a usable proxy`), warnings[0]);
    assert.doesNotMatch(warnings[0], /hunter2|user/);
  }
});

test('common v0.5.14 parity: TestUnescapedDelimitersInUserinfo', () => {
  for (const [raw, user, password, host, secrets] of [
    ['http://abcDEF/ghi+jkl@proxy.muse:3128', 'abcDEF/ghi+jkl', null, 'proxy.muse:3128', ['abcDEF', 'ghi']],
    ['http://user:9876/zz@proxy:3128', 'user', '9876/zz', 'proxy:3128', ['user', '9876']],
    ['http://user:9876?zz@proxy:3128', 'user', '9876?zz', 'proxy:3128', ['user', '9876']],
    ['http://user:98#76@proxy:3128', 'user', '98#76', 'proxy:3128', ['user', '98']],
    ['http://AbC/dEf+ghi==@proxy:3128', 'AbC/dEf+ghi==', null, 'proxy:3128', ['AbC', 'dEf']],
    ['https://tok:a/b?c#d@egress.internal', 'tok', 'a/b?c#d', 'egress.internal', ['tok', 'a/b']],
    ['user:pa/ss@proxy:3128', 'user', 'pa/ss', 'proxy:3128', ['user', 'pa/ss']],
    ['user:pa://ss@proxy:3128', 'user', 'pa://ss', 'proxy:3128', ['user', 'pa:']],
    ['http://us@er:p@ss@proxy:3128', 'us@er', 'p@ss', 'proxy:3128', ['us@er', 'p@ss']],
    ['http://u%2Fx:p%23w/q@proxy:3128/', 'u/x', 'p#w/q', 'proxy:3128', ['u%2F', 'p%23']],
  ]) {
    const envs = [{ HTTPS_PROXY: raw }];
    if (/^https?:\/\//.test(raw)) envs.push({ PILOT_PROXY: raw });
    for (const env of envs) {
      const selected = configuredProxy(env);
      assert.ok(selected, `${raw} ${Object.keys(env)}`);
      assert.equal(selected.url.host, host, raw);
      assert.deepEqual(credentialsOf(selected.url), [user, password ?? ''], raw);
      const logged = redactProxyURL(selected.url);
      assert.ok(logged.endsWith(`***@${host}`), logged);
      for (const secret of secrets) assert.ok(!logged.includes(secret), `${raw}: ${logged} leaks ${secret}`);
    }
  }
});

test('common v0.5.14 parity: TestUnusableUserinfoNeverLeaks', () => {
  for (const raw of [
    'http://se/cret:hunter2@proxy:bad-port',
    'http://se?cret:hun#ter2@',
    'http://se/cret:hun%zzter2@proxy:1',
    'http://se/cret:hunter2\x7f@proxy:1',
    'http://se/cret:hunter2@proxy%zz:1',
    'secret://hunter2@proxy:1',
    'socks5://se/cret:hunter2@proxy:1',
  ]) {
    for (const env of [{ HTTPS_PROXY: raw }, { PILOT_PROXY: raw }]) {
      const { proxy, warnings } = inspectProxy(env);
      assert.equal(proxy, null, raw);
      for (const secret of ['se/cret', 'se?cret', 'cret', 'hunter2', 'hun', 'secret']) {
        assert.ok(!warnings.join('\n').includes(secret), `${raw}: ${warnings} leaks ${secret}`);
      }
    }
  }
});

test('common v0.5.14 parity: TestProxyForRequestDefaultPorts', () => {
  const env = { HTTPS_PROXY: 'http://p:1', NO_PROXY: 'a.invalid:443,b.invalid:80' };
  assert.equal(resolveProxy('https://a.invalid/', env), null);
  assert.notEqual(resolveProxy('https://b.invalid/', env), null);
  assert.equal(resolveProxy('http://b.invalid/', env), null);
});

test('common v0.5.14 parity: TestNoProxyMatching', () => {
  for (const [noProxy, host, port, bypass] of [
    ['', 'registry.pilotprotocol.network', '443', false],
    ['*', 'anything.example', '1', true],
    ['example.com', 'example.com', '443', true],
    ['example.com', 'api.example.com', '443', true],
    ['example.com', 'notexample.com', '443', false],
    ['.example.com', 'api.example.com', '443', true],
    ['.example.com', 'example.com', '443', false],
    ['*.example.com', 'api.example.com', '443', true],
    ['*.example.com', 'example.com', '443', false],
    ['EXAMPLE.com', 'Api.Example.COM', '443', true],
    ['example.com:8443', 'example.com', '8443', true],
    ['example.com:8443', 'example.com', '443', false],
    ['10.1.2.3', '10.1.2.3', '443', true],
    ['10.1.2.3:9000', '10.1.2.3', '443', false],
    ['10.1.2.3:9000', '10.1.2.3', '9000', true],
    ['10.0.0.0/8', '10.200.1.1', '443', true],
    ['10.0.0.0/8', '11.0.0.1', '443', false],
    ['fd00::/8', 'fd00::1', '443', true],
    ['[2001:db8::1]:443', '2001:db8::1', '443', true],
    ['2001:db8::1', '2001:db8::1', '80', true],
    [' a.invalid ,\tb.invalid  c.invalid ', 'c.invalid', '1', true],
    [',,:443,.,*.,', 'x.invalid', '1', false],
    ['example.com', '10.0.0.1', '443', false],
  ]) {
    const target = `https://${host.includes(':') ? `[${host}]` : host}:${port}/`;
    const direct = resolveProxy(target, { HTTPS_PROXY: 'http://p:1', NO_PROXY: noProxy }) === null;
    assert.equal(direct, bypass, `NO_PROXY=${JSON.stringify(noProxy)} ${host}:${port}`);
  }
});

test('unescaped credentials authenticate through the tunnel exactly as percent-encoded ones', { timeout: 20_000 }, async (t) => {
  const origin = await startServer(http.createServer((req, res) => res.end('ok')));
  t.after(() => origin.close());
  const proxy = await startConnectProxy({ 'releases.pilot.invalid': origin.port });
  t.after(() => proxy.close());
  const port = new URL(proxy.url).port;
  for (const proxyURL of [proxy.url, `http://${CREDENTIALS}@127.0.0.1:${port}`, `${CREDENTIALS}@127.0.0.1:${port}`]) {
    const fetcher = createProxyAwareFetch({ env: { HTTPS_PROXY: proxyURL }, directFetch: refuseDirect });
    assert.equal(await (await fetcher('http://releases.pilot.invalid:443/')).text(), 'ok', redactProxyURL(proxyURL));
  }
  assert.deepEqual(proxy.log.map((entry) => entry.authorized), [true, true, true]);
});

// Rotating credentials (Meta Muse): the proxy command is re-run before every
// request and redirect hop, and once more on a 407, with a single retry.
test('downloads re-read rotating proxy credentials before every request and redirect hop', { timeout: 20_000 }, async (t) => {
  const origin = await startServer(http.createServer((req, res) => {
    if (req.url === '/moved') {
      res.writeHead(302, { location: 'http://assets.pilot.invalid:443/manifest.json' });
      res.end();
      return;
    }
    res.end(`ok:${req.headers.host}${req.url}`);
  }));
  t.after(() => origin.close());
  // Every set of credentials lets exactly one CONNECT through.
  const proxy = await startRotatingProxy(t, { 'releases.pilot.invalid': origin.port, 'assets.pilot.invalid': origin.port }, { rotateAfterConnect: true });
  t.after(() => proxy.close());

  // The launch-time HTTPS_PROXY is stale after the first CONNECT.
  const fetcher = createProxyAwareFetch({ env: { HTTPS_PROXY: proxy.url }, proxyCommand: proxy.command, directFetch: refuseDirect });
  for (let i = 0; i < 3; i++) {
    assert.equal(await (await fetcher('http://releases.pilot.invalid:443/moved')).text(), 'ok:assets.pilot.invalid:443/manifest.json');
  }
  assert.equal(proxy.log.length, 6);
  assert.ok(proxy.log.every((entry) => entry.authorized), JSON.stringify(proxy.log));

  // Without the command the redirect hop, the next CONNECT, is refused.
  const stale = createProxyAwareFetch({ env: { HTTPS_PROXY: proxy.urlFor(proxy.generation()) }, directFetch: refuseDirect });
  await assert.rejects(stale('http://releases.pilot.invalid:443/moved'), /refused CONNECT assets\.pilot\.invalid:443: HTTP 407/);
});

test('a 407 re-runs the proxy command and retries once with the new credentials', { timeout: 20_000 }, async (t) => {
  const origin = await startServer(http.createServer((req, res) => res.end('ok')));
  t.after(() => origin.close());
  for (const malformed of [false, true]) {
    // The credentials rotate between the command's run and the CONNECT.
    const proxy = await startRotatingProxy(t, { 'releases.pilot.invalid': origin.port }, { rotateBefore: (count) => count === 0, malformed });
    t.after(() => proxy.close());
    let runs = 0;
    const counted = async (command, options) => {
      runs += 1;
      return runProxyCommand(command, options);
    };
    const fetcher = createProxyAwareFetch({ env: { HTTPS_PROXY: proxy.url }, proxyCommand: proxy.command, runCommand: counted, directFetch: refuseDirect });
    assert.equal(await (await fetcher('http://releases.pilot.invalid:443/')).text(), 'ok', `malformed=${malformed}`);
    assert.deepEqual(proxy.log.map((entry) => entry.authorized), [false, true], `malformed=${malformed}`);
    assert.equal(runs, 2);
  }

  // Credentials that are refused every time: one retry, then the 407.
  const proxy = await startRotatingProxy(t, { 'releases.pilot.invalid': origin.port }, { rotateBefore: () => true });
  t.after(() => proxy.close());
  const fetcher = createProxyAwareFetch({ env: { HTTPS_PROXY: proxy.url }, proxyCommand: proxy.command, directFetch: refuseDirect });
  await assert.rejects(fetcher('http://releases.pilot.invalid:443/'), (error) => {
    assert.match(error.message, /refused CONNECT releases\.pilot\.invalid:443: HTTP 407/);
    assert.doesNotMatch(error.message, /rot\d|muse-agent/);
    return true;
  });
  assert.equal(proxy.log.length, 2);

  // A refusal that is not about credentials is not retried.
  const plain = await startConnectProxy({});
  t.after(() => plain.close());
  let runs = 0;
  const once = createProxyAwareFetch({
    env: {},
    proxyCommand: 'x',
    directFetch: refuseDirect,
    runCommand: async () => {
      runs += 1;
      return { url: new URL(plain.url) };
    },
  });
  await assert.rejects(once('https://github.com:8443/'), /HTTP 403/);
  assert.equal(runs, 1);
  assert.equal(plain.log.length, 1);
});

test('a failing proxy command keeps the last URL it gave, at first the environment\'s proxy', { timeout: 20_000 }, async (t) => {
  const origin = await startServer(http.createServer((req, res) => res.end('ok')));
  t.after(() => origin.close());
  const proxy = await startConnectProxy({ 'releases.pilot.invalid': origin.port });
  t.after(() => proxy.close());
  const dir = mkdtempSync(join(tmpdir(), 'pilot-proxy-cmd-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const target = 'http://releases.pilot.invalid:443/';
  const wrong = proxy.url.replace('s3cr3t', 'wrong-secret');

  // Fails from the start: the environment's proxy serves.
  let fetcher = createProxyAwareFetch({ env: { HTTPS_PROXY: proxy.url }, proxyCommand: 'exit 3', directFetch: refuseDirect });
  assert.equal(await (await fetcher(target)).text(), 'ok');
  // ...and when that one is refused too, the error says why no fresh
  // credentials came, without either credential.
  fetcher = createProxyAwareFetch({ env: { HTTPS_PROXY: wrong }, proxyCommand: 'exit 3', directFetch: refuseDirect });
  await assert.rejects(fetcher(target), (error) => {
    assert.match(error.message, /HTTP 407 \(proxy credential refresh failed: the proxy command failed \(exit status 3\)\)/);
    assert.doesNotMatch(error.message, /wrong-secret|s3cr3t|muse-agent/);
    return true;
  });

  // Worked once, then prints something unusable: the last good URL stays.
  const file = join(dir, 'url');
  writeFileSync(file, proxy.url);
  fetcher = createProxyAwareFetch({ env: { HTTPS_PROXY: wrong }, proxyCommand: `cat '${file}'`, directFetch: refuseDirect });
  assert.equal(await (await fetcher(target)).text(), 'ok');
  writeFileSync(file, 'muse-agent:s3cr3t@proxy-without-scheme:3128');
  assert.equal(await (await fetcher(target)).text(), 'ok');
  assert.deepEqual(proxy.log.map((entry) => entry.authorized), [true, false, true, true]);

  // PILOT_PROXY=off turns proxying off: the command is not even run.
  let runs = 0;
  const direct = async () => new Response('direct');
  fetcher = createProxyAwareFetch({
    env: { PILOT_PROXY: 'off', HTTPS_PROXY: proxy.url },
    proxyCommand: 'x',
    directFetch: direct,
    runCommand: async () => {
      runs += 1;
      return {};
    },
  });
  assert.equal(await (await fetcher(target)).text(), 'direct');
  assert.equal(runs, 0);
});

test('the proxy command runs the way pilot-daemon runs it: sh -c, bounded, output withheld', { timeout: 20_000 }, async (t) => {
  assert.equal(show((await runProxyCommand("printf ' http://muse-agent:s3cr3t@proxy:3128\\n'")).url), 'http://muse-agent:s3cr3t@proxy:3128');
  assert.equal(show((await runProxyCommand('printf %s "$X"', { env: { X: 'https://p.corp:8443' } })).url), 'https://p.corp:8443');
  for (const [command, expected] of [
    ['echo http://muse-agent:s3cr3t@proxy:3128; exit 2', /^the proxy command failed \(exit status 2\)$/],
    ['true', /^the proxy command printed nothing$/],
    ['echo muse-agent:s3cr3t@proxy:3128', /unusable proxy URL \(value withheld/],
    ['echo socks5://muse-agent:s3cr3t@proxy:1080', /unusable proxy URL \(value withheld/],
    ['head -c 70000 /dev/zero | tr "\\000" a', /printed more than 65536 bytes/],
  ]) {
    const result = await runProxyCommand(command);
    assert.equal(result.url, undefined, command);
    assert.match(result.error, expected, command);
    assert.doesNotMatch(result.error, /s3cr3t|muse-agent/, command);
  }
  // A hung command is killed along with everything it started.
  const dir = mkdtempSync(join(tmpdir(), 'pilot-proxy-cmd-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pidFile = join(dir, 'pid');
  const started = Date.now();
  const hung = await runProxyCommand(`sleep 30 & echo $! > '${pidFile}'; wait`, { timeoutMs: 300 });
  assert.match(hung.error, /timed out after 0\.3s/);
  assert.ok(Date.now() - started < 5_000);
  const child = Number(readFileSync(pidFile, 'utf8'));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.throws(() => process.kill(child, 0), { code: 'ESRCH' });
});

test('setup\'s proxy command: the configured one, else the sandbox default where credentials can rotate', () => {
  const sandbox = { sandbox: true, bash: true };
  const creds = 'http://muse-agent:s3cr3t@proxy:3128';
  assert.deepEqual(proxyCommandFor({ PILOT_PROXY_CMD: ' cat /x ' }, { proxy_cmd: 'cat /y' }, sandbox), { command: 'cat /x', source: 'PILOT_PROXY_CMD' });
  assert.deepEqual(proxyCommandFor({}, { proxy_cmd: 'cat /y' }, { sandbox: false, bash: false }), { command: 'cat /y', source: 'config.json proxy_cmd' });
  assert.deepEqual(proxyCommandFor({ HTTPS_PROXY: creds }, {}, sandbox), { command: SANDBOX_PROXY_CMD, source: 'sandbox default' });
  assert.deepEqual(proxyCommandFor({ https_proxy: creds }, { proxy_cmd: '  ' }, sandbox), { command: SANDBOX_PROXY_CMD, source: 'sandbox default' });
  // The command pilotctl and install.sh use, byte for byte.
  assert.equal(SANDBOX_PROXY_CMD, 'bash -c \'printf %s "${https_proxy:-$HTTPS_PROXY}"\'');
  for (const [label, env, host] of [
    ['not a sandbox', { HTTPS_PROXY: creds }, { sandbox: false, bash: true }],
    ['no bash', { HTTPS_PROXY: creds }, { sandbox: true, bash: false }],
    ['no credentials', { HTTPS_PROXY: 'http://proxy:3128' }, sandbox],
    ['credentials only in ALL_PROXY', { ALL_PROXY: creds }, sandbox],
    ['explicit PILOT_PROXY', { PILOT_PROXY: creds, HTTPS_PROXY: creds }, sandbox],
    ['PILOT_PROXY=off', { PILOT_PROXY: 'off', HTTPS_PROXY: creds }, sandbox],
    ['nothing', {}, sandbox],
  ]) {
    assert.equal(proxyCommandFor(env, {}, host), null, label);
  }
  assert.equal(proxyHasCredentials('http://u:p@h:1'), true);
  assert.equal(proxyHasCredentials('u@h:1'), true);
  assert.equal(proxyHasCredentials('http://h:1'), false);
  assert.equal(proxyHasCredentials('socks5://u:p@h:1'), false);
  assert.equal(proxyHasCredentials(''), false);
});

test('setup downloads the runtime through a proxy whose credentials rotate on every CONNECT', { timeout: 60_000 }, async (t) => {
  const release = await startReleaseMirror(t, { rotating: true });
  if (!release) return;
  const { proxy, tag } = release;
  const current = () => proxy.urlFor(proxy.generation());

  // PILOT_PROXY_CMD, and config.json "proxy_cmd": each of the three requests
  // (manifest, release redirect, asset) runs it first.
  for (const where of ['env', 'config']) {
    const home = release.home(`rotating-${where}`);
    const env = where === 'env' ? { PILOT_PROXY_CMD: proxy.command } : {};
    if (where === 'config') {
      mkdirSync(join(home, '.pilot'), { recursive: true });
      writeFileSync(join(home, '.pilot', 'config.json'), JSON.stringify({ proxy_cmd: proxy.command }));
    }
    proxy.log.length = 0;
    const result = await release.install(home, { proxyURL: current(), env });
    assert.equal(result.ok, true, `${where}: ${result.error}`);
    assert.equal(readFileSync(join(home, '.pilot', 'bin', '.pilot-version'), 'utf8'), `${tag}\n`);
    assert.deepEqual(proxy.log, [
      { authority: 'pilotprotocol.network:443', authorized: true },
      { authority: 'github.com:443', authorized: true },
      { authority: 'release-assets.githubusercontent.com:443', authorized: true },
    ], where);
  }

  // Without a proxy command the launch-time credentials go stale after the
  // first request.
  proxy.log.length = 0;
  const stale = await release.install(release.home('stale'), { proxyURL: current() });
  assert.equal(stale.ok, false);
  assert.match(stale.error, /refused CONNECT github\.com:443: HTTP 407/);
  assert.doesNotMatch(stale.error, /rot\d|muse-agent/);
});

// show renders a proxy URL the way Go's url.URL.String does for the vectors
// above: scheme://[user:password@]host.
function show(url) {
  if (!url) return '';
  const userinfo = url.username || url.password ? `${url.username}:${url.password}@` : '';
  return `${url.protocol}//${userinfo}${url.host}`;
}

// credentialsOf decodes a proxy URL's userinfo, as sent in
// Proxy-Authorization: [user, password] or null.
function credentialsOf(url) {
  if (!url.username && !url.password) return null;
  return [decodeURIComponent(url.username), decodeURIComponent(url.password)];
}

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
//
// `credentials` returns the user:password the proxy accepts now; `before`
// runs as a CONNECT arrives and `onAuthorized` after one is let through (a
// rotating proxy changes the credentials there). `malformed` answers bad
// credentials with bytes that are not HTTP, as the Meta Muse proxy's 407
// reads to a client.
async function startConnectProxy(routes, { credentials = () => CREDENTIALS, before = () => {}, onAuthorized = () => {}, malformed = false } = {}) {
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
    before(log.length);
    const authorized = req.headers['proxy-authorization'] === `Basic ${Buffer.from(credentials()).toString('base64')}`;
    log.push({ authority: req.url, authorized });
    const reply = (status, text) => client.end(`HTTP/1.1 ${status} ${text}\r\nContent-Length: 0\r\n\r\n`);
    if (!authorized) return malformed ? client.end('\u0000\u0001 not http\r\n\r\n') : reply(407, 'Proxy Authentication Required');
    onAuthorized();
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

// startRotatingProxy is a Muse-like proxy whose credentials rotate: with
// rotateAfterConnect each set lets exactly one CONNECT through. The current
// proxy URL is kept in a file, and `command` prints it the way a fresh
// shell prints the sandbox's current $https_proxy.
async function startRotatingProxy(t, routes, { rotateAfterConnect = false, rotateBefore = () => false, malformed = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pilot-rotating-proxy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'proxy-url');
  let generation = 0;
  let port;
  const secret = (n) => `rot${n}/p@ss`;
  const urlFor = (n) => `http://muse-agent:${encodeURIComponent(secret(n))}@127.0.0.1:${port}`;
  const publish = () => writeFileSync(file, `${urlFor(generation)}\n`);
  const rotate = () => {
    generation += 1;
    publish();
  };
  const proxy = await startConnectProxy(routes, {
    credentials: () => `muse-agent:${secret(generation)}`,
    before: (count) => { if (rotateBefore(count)) rotate(); },
    onAuthorized: () => { if (rotateAfterConnect) rotate(); },
    malformed,
  });
  port = new URL(proxy.url).port;
  publish();
  return { ...proxy, url: urlFor(0), file, command: `cat '${file}'`, urlFor, rotate, generation: () => generation };
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
async function startReleaseMirror(t, { rotating = false } = {}) {
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
  const routes = {
    'pilotprotocol.network': origin.port,
    'github.com': origin.port,
    'release-assets.githubusercontent.com': origin.port,
  };
  const proxy = rotating ? await startRotatingProxy(t, routes, { rotateAfterConnect: true }) : await startConnectProxy(routes);
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
    install: (home, { proxyURL = proxy.url, requireProxy = false, env = {} } = {}) => runRuntimeInstall({ ...childEnv(home, proxyURL), ...env }, 'ensurePilotRuntime', { requireProxy }),
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
