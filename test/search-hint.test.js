// The zero-match hint must key off the shape list-agents actually returns:
// `data` is a JSON string holding { tiers: { <tier>: { items: [...] } }, ... }.
import { test } from 'node:test';
import assert from 'node:assert';
import { countMatches, annotateSearchResult } from '../src/tools/search.js';

// Verbatim shape of a real zero-match list-agents reply.
const EMPTY = JSON.stringify({
  source: 'list-agents',
  tiers: { free: { description: 'Community data sources — no per-request cost.', items: [], count: 0 } },
  items: [],
  count: 0,
  total: 430,
  total_free: 430,
  filters_applied: { search: 'zzqq', limit: 5 },
  groups: {},
});

const NONEMPTY = JSON.stringify({
  source: 'list-agents',
  tiers: { free: { items: [{ hostname: 'open-meteo' }, { hostname: 'noaa' }], count: 2 } },
  items: [{ hostname: 'open-meteo' }, { hostname: 'noaa' }],
  count: 2,
  total: 430,
});

test('countMatches reads tier items from the JSON-string payload', () => {
  assert.strictEqual(countMatches(EMPTY), 0);
  assert.strictEqual(countMatches(NONEMPTY), 2);
});

test('countMatches counts tier items across multiple tiers without double counting', () => {
  const payload = { tiers: { free: { items: [1, 2] }, paid: { items: [3] } }, items: [1, 2, 3] };
  assert.strictEqual(countMatches(payload), 3);
});

test('countMatches falls back to top-level items when no tiers are present', () => {
  assert.strictEqual(countMatches({ items: [1, 2, 3] }), 3);
  assert.strictEqual(countMatches({ items: [] }), 0);
});

test('countMatches returns null for an unrecognized shape', () => {
  assert.strictEqual(countMatches({ total: 430 }), null);
  assert.strictEqual(countMatches('not json'), null);
  assert.strictEqual(countMatches(undefined), null);
});

test('zero matches attaches the hint', () => {
  const result = annotateSearchResult({ agent: 'list-agents', ok: true, data: EMPTY }, 'zzqq');
  assert.match(result._hint, /No matches for "zzqq"/);
});

test('non-zero matches leaves the reply untouched', () => {
  const result = annotateSearchResult({ agent: 'list-agents', ok: true, data: NONEMPTY }, 'weather');
  assert.strictEqual(result._hint, undefined);
});

test('unrecognized payloads leave the reply untouched', () => {
  const result = annotateSearchResult({ agent: 'list-agents', ok: true, data: 'not json' }, 'weather');
  assert.strictEqual(result._hint, undefined);
});
