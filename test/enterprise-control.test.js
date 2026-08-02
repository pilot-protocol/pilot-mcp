import test from 'node:test';
import assert from 'node:assert/strict';

import { withEnterpriseControl } from '../src/daemon-bridge.js';

test('unconfigured MCP calls preserve existing arguments', () => {
  const args = ['send-message', 'agent-a', '--data', 'hello'];
  assert.deepEqual(withEnterpriseControl(args, {}), args);
  assert.notEqual(withEnterpriseControl(args, {}), args);
});

test('configured message and file calls enter the real governed transport', () => {
  const env = { PILOT_ENTERPRISE_CONTROL: '/secure/control.json' };
  assert.deepEqual(withEnterpriseControl(['send-message', 'agent-a', '--data', 'hello'], env), [
    'send-message', 'agent-a', '--data', 'hello',
    '--enterprise-control', '/secure/control.json', '--governed-resource', 'agent:agent-a/inbox',
  ]);
  assert.deepEqual(withEnterpriseControl(['send-file', 'agent-b', '/tmp/report.pdf'], env), [
    'send-file', 'agent-b', '/tmp/report.pdf',
    '--enterprise-control', '/secure/control.json', '--governed-resource', 'agent:agent-b/inbox',
  ]);
});

test('unsupported actions and explicit flags are not silently rewritten', () => {
  const env = { PILOT_ENTERPRISE_CONTROL: '/secure/control.json' };
  assert.deepEqual(withEnterpriseControl(['handshake', 'agent-a'], env), ['handshake', 'agent-a']);
  const explicit = ['send-message', 'agent-a', '--enterprise-control', 'custom.json', '--governed-resource', 'agent:x/inbox'];
  assert.deepEqual(withEnterpriseControl(explicit, env), explicit);
});

test('resource template must be explicit and target-bound', () => {
  assert.throws(() => withEnterpriseControl(['send-message', 'agent-a'], {
    PILOT_ENTERPRISE_CONTROL: '/secure/control.json',
    PILOT_GOVERNED_RESOURCE_TEMPLATE: 'agent:fixed/inbox',
  }), /must contain \{target\}/);
  assert.deepEqual(withEnterpriseControl(['send-message', 'agent-a'], {
    PILOT_ENTERPRISE_CONTROL: '/secure/control.json',
    PILOT_GOVERNED_RESOURCE_TEMPLATE: 'tenant:alpha/agent:{target}/inbox',
  }).slice(-2), ['--governed-resource', 'tenant:alpha/agent:agent-a/inbox']);
});

