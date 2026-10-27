import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../ui/router-settings.html', import.meta.url), 'utf8');
const source = html.match(/<script id="router-locale">([\s\S]*?)<\/script>/)?.[1];
assert.ok(source, 'the settings page includes its locale adapter');
function fixture(browserLocale, documentLocale = '') {
  const text = (value, protectedContent = false) => ({nodeValue: value, parentElement: {closest: () => protectedContent ? {} : null}});
  const texts = [text('保存路由'), text('有未保存更改'), text('我的配置', true), text('别名 我的别名')];
  const input = {value: '不要改变输入', attributes: new Map([['placeholder', '例如 MiMo']]), getAttribute(k) {return this.attributes.get(k) ?? null;}, setAttribute(k, v) {this.attributes.set(k, v);}};
  const document = {body: {}, title: '路由设置', documentElement: {lang: documentLocale}, createTreeWalker() {let i = 0; return {nextNode: () => texts[i++] ?? null};}, querySelectorAll: () => [input]};
  const window = {navigator: {language: browserLocale}, MutationObserver: class {observe() {} disconnect() {}}, addEventListener() {}};
  const context = {window, document, navigator: window.navigator, NodeFilter: {SHOW_TEXT: 4}, MutationObserver: window.MutationObserver, queueMicrotask: fn => fn()};
  vm.runInNewContext(source, context);
  return {locale: window.RouterLocale, document, texts, input};
}
const f = fixture('en-US');
assert.equal(f.document.documentElement.lang, 'en');
assert.equal(f.texts[0].nodeValue, 'Save routing');
assert.equal(f.input.getAttribute('placeholder'), 'For example, MiMo');
assert.equal(f.input.value, '不要改变输入');
assert.equal(f.texts[2].nodeValue, '我的配置');
assert.equal(f.texts[3].nodeValue, 'Alias 我的别名');
f.locale.setLocale('zh-CN');
assert.equal(f.texts[0].nodeValue, '保存路由', 'host locale overrides the browser fallback');
assert.equal(f.texts[1].nodeValue, '有未保存更改');
assert.equal(f.input.getAttribute('placeholder'), '例如 MiMo');
f.locale.setLocale('en-GB');
assert.equal(f.texts[1].nodeValue, 'Unsaved changes');
f.texts[1].nodeValue = '正在保存路由…';
f.locale.refresh();
assert.equal(f.texts[1].nodeValue, 'Saving routing…', 'new status messages use the active locale');
f.locale.setLocale('zh-TW');
assert.equal(f.document.documentElement.lang, 'zh-CN');
assert.equal(f.texts[1].nodeValue, '正在保存路由…');
f.locale.setLocale('fr-FR');
assert.equal(f.document.documentElement.lang, 'en', 'unsupported locales use English');
assert.equal(f.locale.translate('原生 Luna'), 'Native Luna');
assert.equal(f.locale.translate('模型目录已确认（未调用）'), 'Model catalog confirmed (no model call)');
assert.equal(f.locale.translate('查看最近错误'), 'View recent errors');
assert.equal(f.locale.translate('高峰：原生 Luna；低谷：原生 DeepSeek。这是已保存的计划配置。'), 'Peak: Native Luna; valley: Native DeepSeek. This is the saved schedule.');
assert.match(f.locale.translate('新委派任务将使用此模型。只检查本地配置，不发送模型请求。'), /no model request is sent/);
assert.match(f.locale.translate('原生模型不受 API 兼容守卫影响；目录检查不代表实际调用成功。'), /independent of the API compatibility guard/);
for (const [catalog, expected] of [
  ['状态来自本地 Codex 模型目录；不会调用 API。', 'Status comes from the local Codex model catalog'],
  ['选定原生模型不在当前目录：missing-model。派发会明确失败，不会替换模型。', 'Selected native models are absent'],
]) {
  const combined = `${catalog} same 跟随当前聊天模型 current-model。 · 原生模型不受 API 兼容守卫影响；目录检查不代表实际调用成功。`;
  assert.match(f.locale.translate(combined), new RegExp(expected));
  assert.match(f.locale.translate(combined), /same follows the current chat model current-model/);
  assert.doesNotMatch(f.locale.translate(combined), /[\u4e00-\u9fff]/);
  const unknown = `${catalog} same 当前聊天模型未知，派发会明确失败。 · 原生模型不受 API 兼容守卫影响；目录检查不代表实际调用成功。`;
  assert.match(f.locale.translate(unknown), /current chat model is unknown; same-model dispatch will fail explicitly/);
  assert.doesNotMatch(f.locale.translate(unknown), /[\u4e00-\u9fff]/);
}
assert.match(f.locale.translate('自动分工已关闭，未读取记录。开启并保存后可查看。'), /records were not read/);
assert.equal(f.locale.translate('与当前聊天相同的模型'), 'Same model as the current chat');
assert.equal(f.locale.translate('来自上游的原始错误'), '来自上游的原始错误', 'unknown provider diagnostics remain verbatim');
assert.equal(fixture('en-US', 'zh-CN').document.documentElement.lang, 'zh-CN', 'host-mirrored document language overrides browser fallback');
assert.match(html, /RouterLocale\.setLocale\(context\.locale\)/, 'host-context updates select the UI language');
console.log('UI locale checks passed');
