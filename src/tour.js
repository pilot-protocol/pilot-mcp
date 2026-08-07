import process from 'node:process';

import { search } from './tools/search.js';

export async function runTour(options = {}) {
  const write = options.write ?? ((value) => process.stdout.write(`${value}\n`));
  const result = await search.handler({ keyword: 'weather', limit: 1 });
  write('Pilot tour: one live specialist-directory query');
  write(JSON.stringify(result, null, 2));
  return result;
}
