// tools/search.js — directory search via the list-agents specialist.
//
// Wraps `pilotctl send-message list-agents --data '/data {"search":"<kw>","limit":N}' --wait`.
// The list-agents specialist does LITERAL TOKEN MATCH on agent blurbs — no
// semantic. Use short single-word keywords (bitcoin, weather, nba, joke).

import { pilotctlJSON } from '../daemon-bridge.js';

const KEYWORD_HINTS = {
  crypto: ['bitcoin', 'ticker', 'crypto', 'bitstamp', 'coinbase', 'binance'],
  weather: ['weather', 'metar', 'noaa', 'forecast', 'aviation'],
  transit: ['transit', 'bvg', 'amtrak', 'train', 'departures'],
  sports: ['nba', 'nfl', 'mlb', 'f1', 'sportsdb'],
  news: ['hn-top', 'hackernews', 'dev', 'gdelt', 'reddit'],
  papers: ['openalex', 'crossref', 'pubmed', 'dblp', 'papers'],
  space: ['iss', 'astros', 'space', 'nasa', 'apod'],
  joke: ['joke', 'chucknorris', 'dadjoke'],
  fact: ['cat', 'fact', 'advice', 'quote'],
};

// list-agents replies carry the payload as a JSON string in `data`, shaped:
//   { tiers: { free: { items: [...], count: N }, ... }, items: [...], count: N, total: N }
// Top-level `items` mirrors the tier items, so it is only counted when the
// reply carries no `tiers` object at all.
export function countMatches(data) {
  const payload = typeof data === 'string' ? tryParse(data) : data;
  if (!payload || typeof payload !== 'object') return null;

  if (payload.tiers && typeof payload.tiers === 'object') {
    let total = 0;
    let sawItems = false;
    for (const tier of Object.values(payload.tiers)) {
      if (tier && Array.isArray(tier.items)) {
        total += tier.items.length;
        sawItems = true;
      }
    }
    if (sawItems) return total;
  }
  if (Array.isArray(payload.items)) return payload.items.length;
  return null;
}

function tryParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Attaches the zero-match hint when the reply carries no specialists. A null
// count means the shape was unrecognized — leave the reply untouched.
export function annotateSearchResult(result, keyword) {
  if (!result || typeof result !== 'object') return result;
  if (countMatches(result.data) === 0) {
    const hint = Object.values(KEYWORD_HINTS).flat().slice(0, 5).join(', ');
    result._hint = `No matches for "${keyword}". Try a synonym. Common keywords: ${hint}.`;
  }
  return result;
}

export const search = {
  name: 'pilot_search',
  description:
    'Search the Pilot Protocol directory of 435+ specialist agents for ones matching a keyword. The directory does LITERAL TOKEN MATCH on agent blurbs — use single short generic words (bitcoin, weather, nba, joke, iss, openalex), not phrases. Returns a list of specialist hostnames + one-line descriptions. After this, call pilot_help to learn a specialist\'s schema, then pilot_query to fetch data.',
  inputSchema: {
    type: 'object',
    properties: {
      keyword: {
        type: 'string',
        description: 'Single short keyword. If your first attempt returns nothing, try a synonym (specialists often have multiple terms in their blurb).',
      },
      limit: { type: 'number', default: 10, description: 'Max matches to return. Default 10.' },
    },
    required: ['keyword'],
  },
  handler: async ({ keyword, limit = 10 }) => {
    const payload = JSON.stringify({ search: keyword, limit });
    const result = await pilotctlJSON([
      'send-message', 'list-agents',
      '--data', `/data ${payload}`,
      '--wait',
    ]);
    return annotateSearchResult(result, keyword);
  },
};
