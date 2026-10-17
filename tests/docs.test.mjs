import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const readme = read('README.md');
const skill = read('SKILL.md');
const pluginDoc = read('PLUGIN.md');
const pluginManifest = JSON.parse(read('.codex-plugin/plugin.json'));
const nativeBuild = read('docs/native-isolated-cli-build.md');
const nativeInstaller = read('docs/native-isolated-install.md');
const nativeAcceptance = read('docs/native-deepseek-acceptance-2026-10-17.md');
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

assert.match(skill, /用户可见的进度与最终报告必须使用简体中文；代码、命令和内部 GPT-DeepSeek 通信可保持原文。/,
  'SKILL.md must put the Chinese child-output instruction in every spawn/followup message');
assert.match(skill, /agent_type: "native_deepseek"/i, 'SKILL.md must select the isolated DeepSeek role');
assert.match(skill, /omit `model`/i, 'SKILL.md must not send an explicit DeepSeek model override');
assert.match(skill, /current `CODEX_HOME\/models_cache\.json`/, 'SKILL.md must resolve Luna from the live catalog');
assert.doesNotMatch(skill, /shared-root gateway path is the formal|root `openai_base_url`[^\n]*formal route/i, 'SKILL.md must not use shared root routing as the formal path');
assert.match(skill, /native-isolated-install\.mjs/);
assert.match(skill, /--deepseek-only/);
assert.match(skill, /relay_allowed=false/);
assert.match(readme, /rejects GPT\/unknown models and encrypted collaboration input before any upstream call/i);
assert.match(readme, /relay cap is forced to zero/i);
assert.match(pluginDoc, /--deepseek-only/);
assert.match(nativeInstaller, /Task 状态为 `Running`/);
assert.match(skill, /--install-journal/);
assert.match(skill, /before each DeepSeek `followup_task`/);
assert.match(skill, /does not create native Codex child sessions/);
for (const command of ['prepare', 'activate', 'rollback', 'status']) assert.match(skill, new RegExp(`\\b${command}\\b`), `SKILL.md must list installer command ${command}`);
assert.match(skill, /ordinary task routing.*never run them/i, 'SKILL.md must keep ordinary routing separate from setup');
assert.match(skill, /explicitly asks to set up or activate.*authorizes.*without another approval prompt/i, 'SKILL.md must avoid redundant approval for an explicitly requested setup');
assert.match(skill, /actual isolated CLI installation has not been run/i, 'SKILL.md must not claim the source installer has run');
assert.match(skill, /desktop acceptance remains pending|desktop acceptance.*still pending/i, 'SKILL.md must distinguish configured source from desktop acceptance');
assert.doesNotMatch(skill, /ACL file lock|blocks the intended UI check/i, 'SKILL.md must not preserve the obsolete UI blocker claim');
assert.doesNotMatch(skill, /node \.\\scripts\\native-install\.mjs install/i, 'SKILL.md must not present the old shared-root installer as the setup path');
assert.match(readme, /formal native DeepSeek route.*native_deepseek.*provider/i, 'README must present the isolated role/provider as the formal route');
assert.match(readme, /native Luna.*normal provider.*live model catalog/i, 'README must state that Sol and Luna keep their normal provider/catalog');
assert.match(readme, /docs\/native-isolated-install\.md/, 'README must link the isolated installer guide');
assert.match(readme, /desktop acceptance remains pending/i, 'README must distinguish prepared/configured state from desktop acceptance');
assert.doesNotMatch(readme, /formal DeepSeek path uses a shared `openai` provider/i, 'README must not present the shared-root path as formal');
assert.doesNotMatch(readme, /Native gateway \(current path\)|Do not pass `agent_type`|ACL file lock.*blocks the intended UI check/i, 'README must not retain obsolete native route or UI blocker claims');
assert.match(pluginDoc, /formal native DeepSeek path.*isolated.*native_deepseek/i, 'PLUGIN.md must describe the isolated route as formal');
assert.match(pluginDoc, /skill.*separately.*plugin.*Codex CLI/i, 'PLUGIN.md must distinguish standalone skill sync from plugin refresh');
assert.match(pluginDoc, /no automatic release.integration script/i, 'PLUGIN.md must not claim a nonexistent skill sync automation');
assert.doesNotMatch(pluginDoc, /current formal path is native collaboration through the hidden loopback gateway|Native child spawning uses `spawn_agent` with `task_name`, `model:/i, 'PLUGIN.md must not describe the shared-root spawn contract as current');
assert.doesNotMatch(pluginDoc, /ACL file lock.*blocks the interface check/i, 'PLUGIN.md must not retain the obsolete UI blocker claim');
assert.match(pluginManifest.interface.longDescription, /native_deepseek.*provider.*catalog/i, 'plugin manifest must describe the isolated DeepSeek role');
assert.doesNotMatch(pluginManifest.interface.longDescription, /shared `openai` provider|transparently relays GPT traffic/i, 'plugin manifest must not sell the shared-root relay as formal');
assert.doesNotMatch(pluginManifest.interface.defaultPrompt.join(' '), /Start the native DeepSeek gateway/i, 'plugin examples must not start the old default gateway');
assert.match(nativeBuild, /native-isolated-install\.mjs/, 'build note must name the installer entrypoint');
assert.match(nativeBuild, /native-isolated-install\.md/, 'build note must link the installer orchestration');
assert.match(nativeBuild, /no real installation or desktop acceptance has been performed/i, 'build note must distinguish source implementation from actual acceptance');
assert.match(nativeInstaller, /--expected-main-model/);
assert.match(nativeInstaller, /--expected-main-provider null/);
assert.match(nativeInstaller, /--expected-root-base-url null/);
assert.match(nativeInstaller, /prepare[\s\S]*activate[\s\S]*desktop/i);
assert.match(nativeInstaller, /configured=true.*restartNeeded=true/);
assert.match(nativeInstaller, /runtimeObserved=false.*desktopAccepted=false/);
assert.match(nativeInstaller, /尚未在真实用户配置或环境上执行/, 'installer documentation must state that real installation has not run');
assert.match(nativeAcceptance, /Historical acceptance record for the earlier shared-provider route/i, 'old acceptance evidence must be labeled historical');
assert.doesNotMatch(nativeAcceptance, /ACL file lock|blocked the intended UI check/i, 'acceptance record must not claim the obsolete ACL blocker');
assert.doesNotMatch(skill, /at most one shell(?:\/exec)? attempt/i,
  'SKILL.md must not generalize the one-attempt P3 test cap to product work');

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
