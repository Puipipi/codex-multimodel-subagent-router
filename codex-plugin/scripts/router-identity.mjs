// Installation/display identity is intentionally separate from durable storage/protocol identity.
import {existsSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
export const ROUTER_ID = 'codex-multimodel-subagent-router';
export const ROUTER_DISPLAY_NAME = 'Codex 主控 · 多模型峰谷子代理';
export const ROUTER_VERSION = '0.13.0';
export const LEGACY_STORAGE_ID = 'sol-luna-deepseek-router';
export const LEGACY_PLUGIN_KEY = 'sol-luna-deepseek-router@sol-luna';
export const PLUGIN_KEY = ROUTER_ID + '@' + ROUTER_ID;

// Source lookup only: this never selects a model/provider/backend or mutates any installation.
export function resolveCanonicalSkillSource({codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), exists = existsSync} = {}) {
  for (const identity of [ROUTER_ID, LEGACY_STORAGE_ID]) {
    const directory = path.join(codexHome, 'skills', identity);
    if (exists(path.join(directory, 'scripts', 'route.mjs')) && (identity === LEGACY_STORAGE_ID || exists(path.join(directory, 'SKILL.md')))) return directory;
  }
  throw new Error('canonical router skill source is unavailable; no backend substitution is permitted');
}
