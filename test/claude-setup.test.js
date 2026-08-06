import assert from 'node:assert/strict';
import test from 'node:test';

import { removeObsoletePromptHook } from '../src/setup/harnesses/claude.js';

test('removes the obsolete Claude heartbeat prompt hook', () => {
  const hooks = {
    UserPromptSubmit: [{
      matcher: '*',
      hooks: [{ type: 'command', command: 'npx -y pilotprotocol-mcp heartbeat --claude' }],
    }],
  };

  removeObsoletePromptHook(hooks);

  assert.equal('UserPromptSubmit' in hooks, false);
});

test('preserves unrelated prompt hooks and mixed hook groups', () => {
  const custom = { type: 'command', command: '/usr/local/bin/custom-prompt-hook' };
  const hooks = {
    UserPromptSubmit: [
      { matcher: 'custom', hooks: [custom] },
      {
        matcher: '*',
        hooks: [
          { type: 'command', command: 'npx -y pilot-mcp heartbeat --claude' },
          custom,
        ],
      },
      { matcher: 'opaque' },
    ],
  };

  removeObsoletePromptHook(hooks);

  assert.deepEqual(hooks.UserPromptSubmit, [
    { matcher: 'custom', hooks: [custom] },
    { matcher: '*', hooks: [custom] },
    { matcher: 'opaque' },
  ]);
});

test('ignores similarly named non-Pilot commands', () => {
  const hooks = {
    UserPromptSubmit: [{
      hooks: [{ type: 'command', command: 'heartbeat --claude' }],
    }],
  };

  removeObsoletePromptHook(hooks);

  assert.equal(hooks.UserPromptSubmit.length, 1);
});
