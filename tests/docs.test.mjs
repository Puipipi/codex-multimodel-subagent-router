import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
const read=name=>readFileSync(new URL('../'+name,import.meta.url),'utf8');
const skill=read('SKILL.md'),readme=read('README.md'),plugin=read('PLUGIN.md'),execution=read('references/execution.md'),capabilities=read('references/capabilities.md'),history=read('references/history/README.md');
const manifest=JSON.parse(read('.codex-plugin/plugin.json')),marketplace=JSON.parse(read('.agents/plugins/marketplace.json'));
assert.equal(manifest.name,'codex-multimodel-subagent-router');
assert.equal(marketplace.name,manifest.name);assert.equal(marketplace.plugins[0].name,manifest.name);
assert.equal(marketplace.plugins[0].source.path,'./codex-plugin');
for(const text of [readme,plugin,skill]) {
 assert.match(text,/codex-multimodel-subagent-router/);
 assert.match(text,/references\/capabilities.md/);
 assert.match(text,/references\/history\/README.md/);
 assert.doesNotMatch(text,/native-api-role-registration-0\.11\.2-2026-10-19/,'entrypoints load historical records only through the index');
 assert.doesNotMatch(text,/[A-Za-z]:\\Users\\|sk-[A-Za-z0-9_-]{12,}/);
}
for(const invariant of ['模型选择','可信归属','租约','兼容校验','身份兼容']) assert.ok(skill.includes(invariant));
assert.match(skill,/不静默切换/);assert.match(skill,/不迁移、不复制、不重算/);
assert.match(skill,/普通路由不安装、Apply、独立启网关/);
assert.match(skill,/CODEX_THREAD_ID/);assert.match(skill,/_meta.threadId/);
assert.match(skill,/用户可见的进度与最终报告必须使用简体中文/);
assert.match(skill,/子代理不主动发送用户进度/);
assert.match(execution,/trusted .*CODEX_THREAD_ID/);
assert.match(execution,/For each DeepSeek follow-up, rerun the gate/);
assert.match(execution,/observed executable must match the approved patched binary hash/);
assert.match(execution,/--reuse-child CHILD_THREAD_ID/);
assert.match(execution,/should not send unsolicited user-facing progress/);
assert.match(execution,/one concise internal handoff/);
assert.match(execution,/DSH remains only an explicit legacy/);
assert.match(execution,/Native Luna,.*same.*native:<slug>/);
assert.match(capabilities,/0\.167\.0-alpha\.4\.1/);
assert.match(capabilities,/gpt-6\.1-sol/);
assert.match(capabilities,/21 个工具/);
assert.match(capabilities,/没有 tools\/call/);
assert.match(capabilities,/源码契约/);assert.match(capabilities,/离线验证/);assert.match(capabilities,/未验收/);
assert.match(history,/0\.11\.4/);assert.match(history,/保留原位/);
assert.match(read('agents/openai.yaml'),/default_prompt:.*\$codex-multimodel-subagent-router/);
assert.doesNotMatch(read('agents/openai.yaml'),/保存后显式应用/);
assert.equal(manifest.skills,undefined);
assert.ok(!existsSync(new URL('../skills/',import.meta.url)));
const hooks=JSON.parse(read('hooks/hooks.json'));
for(const event of ['UserPromptSubmit','PreToolUse']) assert.equal(hooks.hooks[event][0].hooks[0].command,'node "${PLUGIN_ROOT}/scripts/route-hook.mjs"');
// Every local markdown link introduced by the new on-demand entrypoints resolves in source.
for(const name of ['SKILL.md','README.md','README_cn.md','PLUGIN.md','references/execution.md','references/capabilities.md','references/history/README.md','docs/identity-migration.md','docs/skill-deployment.md']) {
 for(const match of read(name).matchAll(/\]\(([^)]+)\)/g)) {
  const link=match[1];if(/^(?:https?:|#)/.test(link))continue;
  assert.ok(existsSync(new URL(link,new URL('../'+name,import.meta.url))),name+' missing '+link);
 }
}
for(const name of ['SKILL.md','references/execution.md','references/capabilities.md','references/history/README.md','docs/identity-migration.md','docs/skill-deployment.md']) {
 const generated='codex-plugin/'+name;
 assert.equal(read(generated),read(name),'generated '+name+' is synchronized');
 for(const match of read(generated).matchAll(/\]\(([^)]+)\)/g)) {
  const link=match[1];if(/^(?:https?:|#)/.test(link))continue;
  assert.ok(existsSync(new URL(link,new URL('../'+generated,import.meta.url))),generated+' missing packaged '+link);
 }
}
console.log('PASS current entrypoints, invariants, evidence boundaries and on-demand link closure');
