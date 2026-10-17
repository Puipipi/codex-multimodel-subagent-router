import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const readme = read('README.md');
const skill = read('SKILL.md');
const client = read('scripts/dsh-mcp-client.mjs');
const hooks = JSON.parse(read('hooks/hooks.json'));
const marketplace = JSON.parse(read('.agents/plugins/marketplace.json'));

assert.equal(marketplace.name, 'sol-luna', 'the repo marketplace has a stable portable name');
assert.equal(marketplace.plugins.length, 1, 'the repo marketplace lists one routing plugin');
assert.equal(marketplace.plugins[0].name, 'sol-luna-deepseek-router', 'the marketplace plugin matches the manifest name');
assert.equal(marketplace.plugins[0].source.source, 'local', 'the marketplace plugin is local');
assert.equal(marketplace.plugins[0].source.path, './', 'the plugin source stays inside the marketplace root');
assert.doesNotMatch(marketplace.plugins[0].source.path, /^(?:[A-Za-z]:[\\/]|\\\\)/, 'the marketplace source is not an absolute path');
assert.equal(marketplace.plugins[0].policy.installation, 'AVAILABLE', 'the marketplace installation policy is explicit');
assert.equal(marketplace.plugins[0].policy.authentication, 'ON_INSTALL', 'the marketplace auth policy is explicit');
assert.equal(marketplace.plugins[0].category, 'Developer Tools', 'the marketplace category is explicit');

const hookCommand = 'node "${PLUGIN_ROOT}/scripts/route-hook.mjs"';
assert.equal(hooks.hooks.UserPromptSubmit[0].hooks[0].command, hookCommand, 'UserPromptSubmit must use the quoted plugin root');
assert.equal(hooks.hooks.PreToolUse[0].hooks[0].command, hookCommand, 'PreToolUse must use the quoted plugin root');

const pinned = [...`${readme}\n${client}`.matchAll(/dsh-subagent-mcp@(\d+\.\d+\.\d+)/g)].map(match => match[1]);
assert.deepEqual([...new Set(pinned)], ['0.7.0'], 'install and client commands must pin the same published version');
assert.match(readme, /0\.7\.0/, 'README must state the pinned version');
assert.match(skill, /0\.7\.0/, 'SKILL.md must state the pinned version');
assert.match(readme, /--no-skill/, 'installation must disable the upstream skill');
assert.match(readme, /Node\.js 24\+/, 'README must state the Node.js prerequisite');
assert.match(readme, /PowerShell 7\.3\+/, 'README must state the PowerShell prerequisite');
assert.match(skill, /PowerShell 7\.3\+/, 'SKILL.md must state the PowerShell prerequisite');
assert.match(skill, /Node\.js 24\+/, 'SKILL.md must state the Node.js prerequisite');
assert.match(readme, /deepseek-official/, 'README must document the official provider');
assert.match(readme, /deepseek-flash/, 'README must document the default model');
assert.match(skill, /deepseek-official/, 'SKILL.md must document the official provider');
assert.match(skill, /deepseek-flash/, 'SKILL.md must document the default model');

for (const [name, text] of [['README.md', readme], ['SKILL.md', skill]]) {
  assert.match(text, /auto-discovers? `hooks\/hooks\.json`|auto-discovered from `hooks\/hooks\.json`/i, `${name} must document hook auto-discovery`);
  assert.match(text, /no manifest `hooks` pointer is required/i, `${name} must not require a manifest hooks pointer`);
  assert.match(text, /exactly one routing skill|one routing skill copy|install it once/i, `${name} must preserve one routing skill`);
  assert.match(text, /does not create a new chat|no new chat/i, `${name} must state that the hook creates no chat`);
  assert.match(text, /idle/i, `${name} must state the no-idle-inference limitation`);
  assert.match(text, /manual .* wins|manual one-task choice/i, `${name} must state that manual choice wins`);
  assert.match(text, /snapshot/i, `${name} must describe the trace as a snapshot`);
  assert.match(text, /native Codex child/i, `${name} must state the native-child trace limitation`);
  assert.match(text, /PLUGIN_ROOT/, `${name} must document the supported plugin-root command`);
  assert.match(text, /no bundled skill|has no `skills\/` directory|does not add a second scheduler, agent loop, or bundled skill/i,
    `${name} must state that the plugin contributes no bundled skill`);
  assert.doesNotMatch(text, /plugin-local (?:copy|skill)|plugin loader also exposes the plugin-local/i,
    `${name} must not claim a plugin-local routing skill copy`);
  assert.match(text, /\/hooks/, `${name} must document the official hook trust review path`);
  assert.match(text, /untrusted|does not trust them automatically/i, `${name} must not claim hooks are pre-trusted`);
  assert.match(text, /do not open a new chat merely|preserve the current conversation/i,
    `${name} must not require a new chat for peak switching`);
}

for (const [name, text] of [['README.md', readme], ['SKILL.md', skill]]) {
  assert.doesNotMatch(text, /[A-Za-z]:\\Users\\/i, `${name} must not contain a Windows user path`);
  assert.doesNotMatch(text, /\/(?:Users|home)\/[^/\s]+\//, `${name} must not contain a local Unix home path`);
  assert.doesNotMatch(text, /AppData[\\/]Local[\\/]Temp/i, `${name} must not contain a temporary artifact path`);
  assert.doesNotMatch(text, /(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})/, `${name} must not contain a credential`);
}

const testScripts = [
  'route.test.mjs', 'route-hook.test.mjs', 'dsh-mcp-client.test.mjs', 'docs.test.mjs',
  'plugin-state.test.mjs', 'plugin-cross-process.test.mjs', 'plugin-trace.test.mjs',
  'plugin-mcp.test.mjs', 'plugin-client.test.mjs', 'plugin-manifest.test.mjs',
  'patch-backend-windows.test.mjs',
];
for (const script of testScripts) assert.match(readme, new RegExp(script.replaceAll('.', '\\.')), `README must list ${script}`);
assert.match(readme, /dsh-agent-helper\.test\.ps1/, 'README must list the PowerShell helper test');

console.log('PASS docs/version consistency');
