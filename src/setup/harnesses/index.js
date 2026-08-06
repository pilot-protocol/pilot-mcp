// Per-harness MCP config writers. Keyed by harness id (matches detect.js).
// 'continue' is fine as an object property key (it's a reserved statement
// keyword, not a reserved property name).

import * as claudeMod from './claude.js';
import * as cursorMod from './cursor.js';
import * as clineMod from './cline.js';
import * as continueMod from './continue.js';
import * as openclawMod from './openclaw.js';
import * as hermesMod from './hermes.js';
import * as picoclawMod from './picoclaw.js';
import * as openhandsMod from './openhands.js';
import * as codexMod from './codex.js';
import * as geminiMod from './gemini.js';
import * as junieMod from './junie.js';
import * as copilotMod from './copilot.js';

export const claude = claudeMod;
export const cursor = cursorMod;
export const cline = clineMod;
export const openclaw = openclawMod;
export const hermes = hermesMod;
export const picoclaw = picoclawMod;
export const openhands = openhandsMod;
export const codex = codexMod;
export const gemini = geminiMod;
export const junie = junieMod;
export const copilot = copilotMod;

// 'continue' as an object property: valid in modern JS.
const registry = {
  claude, cursor, cline, openclaw, hermes, picoclaw,
  openhands, codex, gemini, junie, copilot,
  continue: continueMod,
};

export default registry;
