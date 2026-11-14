import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {spawnSync} from 'node:child_process';
import {createApiProfile, createDefaultRouterSettings, loadRouterSettings, saveRouterSettings, validateRouterSettings} from '../scripts/native-api-settings.mjs';
import {decideRoute} from '../scripts/route.mjs';
import {createRouterSettingsService, ROUTER_SETTINGS_TOOLS} from '../scripts/router-settings-mcp.mjs';

let checks = 0;
const eq = (actual, expected, message) => {assert.equal(actual, expected, message); checks++;};
const ok = (value, message) => {assert.ok(value, message); checks++;};
const rejects = async (fn, pattern, message) => {await assert.rejects(fn, pattern, message); checks++;};
const root = await mkdtemp(path.join(os.tmpdir(), 'router-computer-use-'));
const prior = {CODEX_HOME: process.env.CODEX_HOME, LOCALAPPDATA: process.env.LOCALAPPDATA, SOL_LUNA_PLUGIN_STATE: process.env.SOL_LUNA_PLUGIN_STATE};
process.env.CODEX_HOME = path.join(root, 'codex');
process.env.LOCALAPPDATA = path.join(root, 'local');
process.env.SOL_LUNA_PLUGIN_STATE = path.join(root, 'state');
try {
  const defaults = createDefaultRouterSettings();
  const terra = 'native:gpt-6.1-terra';
  eq(defaults.computerUseExecutor, 'inherit', 'default does not choose a computer model');
  const {computerUseExecutor: omitted, ...legacy} = defaults;
  eq(validateRouterSettings(legacy).computerUseExecutor, 'inherit', 'legacy settings inherit general routing');
  eq(validateRouterSettings({...defaults, computerUseExecutor: terra}).computerUseExecutor, terra, 'exact native selector survives validation');
  const api = createApiProfile({protocol: 'responses', baseUrl: 'https://example.invalid/v1', model: 'test', reasoning: {supported: ['none'], default: 'none', parameter: 'none'}, credential: {type: 'env', name: 'TEST_KEY'}}, {aliases: ['api-alias']});
  for (const invalid of ['luna', 'same', 'deepseek', api.profileId, 'api-alias', '', null, 12]) {
    assert.throws(() => validateRouterSettings({...defaults, profiles: {[api.profileId]: api}, computerUseExecutor: invalid}), /computerUseExecutor/); checks++;
  }
  const settingsPath = path.join(root, 'router.json');
  await saveRouterSettings(settingsPath, {...defaults, computerUseExecutor: terra});
  eq((await loadRouterSettings(settingsPath)).computerUseExecutor, terra, 'computer setting survives file round trip');
  const base = {at: '2026-10-19T12:00:00+08:00', stateDir: path.join(root, 'overrides'), readNativeModels: async () => [{value: 'gpt-6.1-terra', title: 'Terra'}, {value: 'gpt-6-luna', title: 'Luna'}], guardStatus: {state: 'disabled'}};
  const settings = {...defaults, computerUseExecutor: terra};
  let route = await decideRoute({...base, routerSettings: settings, taskKind: 'computer-use'});
  eq(route.executor, 'native', 'computer task uses dedicated native model despite API guard');
  eq(route.native_spawn.model, 'gpt-6.1-terra', 'Terra is exact with no substitution');
  eq(route.source, 'computer_use', 'dedicated selection has a distinct source');
  route = await decideRoute({...base, routerSettings: settings, taskKind: 'computer-use', executor: 'native:gpt-6-luna'});
  eq(route.native_spawn.model, 'gpt-6-luna', 'one-time native override wins over computer setting');
  eq(route.source, 'one_time_override', 'one-time source remains intact');
  await decideRoute({...base, routerSettings: settings, sessionId: 'chat', setSessionExecutor: 'luna'});
  route = await decideRoute({...base, routerSettings: settings, taskKind: 'computer-use', sessionId: 'chat'});
  eq(route.native_spawn.model, 'gpt-6.1-terra', 'dedicated computer selection wins over sticky general override');
  route = await decideRoute({...base, routerSettings: {...settings, computerUseExecutor: 'inherit'}, taskKind: 'computer-use', sessionId: 'chat'});
  eq(route.executor, 'luna', 'inherit uses the existing session route');
  route = await decideRoute({...base, routerSettings: {...settings, enabled: false}, taskKind: 'computer-use', executor: 'deepseek', readNativeModels: async () => {throw new Error('must not read');}});
  eq(route.executor, 'off', 'global off wins over every computer choice and avoids catalog reads');
  route = await decideRoute({...base, routerSettings: settings});
  eq(route.executor, 'off', 'generic task still follows normal valley and its API guard');
  for (const executor of ['deepseek', api.profileId, 'api-alias']) {
    await rejects(() => decideRoute({...base, routerSettings: {...settings, profiles: {[api.profileId]: api}}, taskKind: 'computer-use', executor}), /requires a native Codex executor/, 'API and gateway cannot silently service computer tasks');
  }
  await rejects(() => decideRoute({...base, routerSettings: defaults, taskKind: 'computer-use'}), /requires a native Codex executor/, 'inherit valley reports unavailable instead of silently selecting Terra');
  await rejects(() => decideRoute({...base, routerSettings: settings, taskKind: 'computer-use', readNativeModels: async () => []}), /not present.*gpt-6.1-terra/, 'missing Terra fails explicitly');
  await rejects(() => decideRoute({...base, routerSettings: defaults, taskKind: 'wrong'}), /task-kind/, 'unknown task kind rejected');
  const cli = spawnSync(process.execPath, [new URL('../scripts/route.mjs', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'), '--settings', settingsPath, '--task-kind', 'computer-use', '--json'], {encoding: 'utf8', env: process.env, windowsHide: true});
  eq(cli.status, 2, 'CLI task kind is parsed and missing isolated catalog fails');
  ok(/catalog|models_cache/i.test(cli.stderr) && !/Unknown option/.test(cli.stderr), 'CLI reaches native resolution without a new model call');

  const servicePath = path.join(root, 'mcp-router.json');
  const models = [{value: 'gpt-6.1-terra', title: 'Terra', reasoningEfforts: ['low']}];
  const service = createRouterSettingsService({settingsPath: servicePath, readNativeModels: async () => models, guardStatus: async () => ({state: 'healthy'}), readCurrentModel: async () => ({model: 'gpt-6.1-sol'})});
  const initial = (await service.callTool('router_settings_read', {})).payload;
  eq(initial.values.computerUseExecutor, 'inherit', 'MCP form reads default');
  assert.deepEqual(initial.schema.properties.computerUseExecutor.enum, ['inherit', terra]); checks++;
  ok(initial.layout[0].items.some(item => item.property === 'computerUseExecutor'), 'structured form includes computer field');
  ok(ROUTER_SETTINGS_TOOLS.find(tool => tool.name === 'router_settings_update').inputSchema.properties.set.properties.computerUseExecutor.description.includes('computer-use'), 'MCP update schema describes dedicated routing');
  const saved = (await service.callTool('router_settings_update', {set: {computerUseExecutor: terra}})).payload;
  eq(saved.values.computerUseExecutor, terra, 'MCP update writes dedicated model');
  const snapshot = (await service.callTool('router_settings_snapshot', {})).payload;
  eq(snapshot.settings.computerUseExecutor, terra, 'MCP snapshot returns dedicated model');
  const unavailableCatalogService = createRouterSettingsService({settingsPath: servicePath, readNativeModels: async () => [], guardStatus: async () => ({state: 'healthy'}), readCurrentModel: async () => ({model: 'gpt-6.1-sol'})});
  const missingCatalogRead = (await unavailableCatalogService.callTool('router_settings_read', {})).payload;
  eq(missingCatalogRead.values.computerUseExecutor, terra, 'MCP read preserves saved model when catalog is empty');
  ok(missingCatalogRead.schema.properties.computerUseExecutor.enum.includes(terra), 'MCP schema includes missing saved value without claiming availability');
  const otherCatalogService = createRouterSettingsService({settingsPath: servicePath, readNativeModels: async () => [{value: 'other-native', title: 'Other'}], guardStatus: async () => ({state: 'healthy'}), readCurrentModel: async () => ({model: 'gpt-6.1-sol'})});
  const missingModelRead = (await otherCatalogService.callTool('router_settings_read', {})).payload;
  ok(missingModelRead.schema.properties.computerUseExecutor.enum.includes(missingModelRead.values.computerUseExecutor), 'MCP values conform to schema when selected model is absent');
  const again = (await service.callTool('router_settings_save', {settings: {...snapshot.settings, computerUseExecutor: 'inherit'}, expectedSha256: snapshot.sha256})).payload;
  eq(again.settings.computerUseExecutor, 'inherit', 'full settings save returns inherited selection');
  await rejects(() => service.callTool('router_settings_update', {set: {computerUseExecutor: 'api-alias'}}), /computerUseExecutor/, 'MCP update refuses aliases');
  const readAgain = (await service.callTool('router_settings_read', {})).payload;
  eq(readAgain.values.computerUseExecutor, 'inherit', 'rejected update preserves existing setting');

  const html = await readFile(new URL('../ui/router-settings.html', import.meta.url), 'utf8');
  ok(html.includes('id="computer-use-executor"'), 'UI includes dedicated dropdown');
  ok(html.includes('byId("computer-use-executor").addEventListener("change", markDirty)'), 'computer dropdown marks settings dirty');
  const renderSource = html.slice(html.indexOf('  function renderSnapshot('), html.indexOf('\n  function ', html.indexOf('  function renderSnapshot(') + 5));
  const nodes = new Map();
  const byId = id => {if (!nodes.has(id)) nodes.set(id, {selectedOptions: [{}]}); return nodes.get(id);};
  const context = {state: {}, byId, modeInputs: [], fillSelect: (node, options, current) => {node.options = options; node.value = current;}, renderMode() {}, renderProfiles() {}, renderStatus() {}, renderConfiguredExecutorStatus() {}, renderApplyAvailability() {}};
  vm.createContext(context); vm.runInContext(renderSource, context);
  context.snapshot = {settings: {...defaults, computerUseExecutor: terra}, nativeModels: models};
  vm.runInContext('renderSnapshot(snapshot)', context);
  eq(byId('computer-use-executor').value, terra, 'UI renders saved Terra exactly');
  assert.deepEqual(Array.from(byId('computer-use-executor').options, item => item.value), ['inherit', terra]); checks++;
  const collectSource = html.slice(html.indexOf('  function collectSettings('), html.indexOf('\n  async function ', html.indexOf('  function collectSettings(')));
  context.modeInputs = [{checked: true, value: 'auto'}]; vm.runInContext(collectSource, context);
  eq(vm.runInContext('collectSettings().computerUseExecutor', context), terra, 'UI collection preserves dedicated selector');
  context.snapshot = {settings: defaults, nativeModels: []}; vm.runInContext('renderSnapshot(snapshot)', context);
  eq(byId('computer-use-executor').options.length, 1, 'empty catalog offers only inherit');
  ok(byId('computer-use-hint').textContent.includes('模型目录为空'), 'empty catalog describes configuration availability');
  context.snapshot = {settings: {...defaults, computerUseExecutor: terra}, nativeModels: []}; vm.runInContext('renderSnapshot(snapshot)', context);
  eq(byId('computer-use-executor').selectedOptions[0].disabled, true, 'stale saved model is disabled without silently replacing it');
  ok(byId('computer-use-hint').textContent.includes('派发会明确失败'), 'missing model warns of explicit routing failure');
} finally {
  for (const [key, value] of Object.entries(prior)) {if (value === undefined) delete process.env[key]; else process.env[key] = value;}
  await rm(root, {recursive: true, force: true});
}
console.log(`PASS ${checks} computer-use routing/settings/UI assertions`);
