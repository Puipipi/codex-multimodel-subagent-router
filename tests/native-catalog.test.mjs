import assert from "node:assert/strict";
import { buildChildCatalog, deepSeekEntry, mergeCatalog } from "../scripts/native-catalog.mjs";
import { PICKER_SLUG } from "../scripts/native-routing.mjs";

let checks = 0;
const equal = (actual, expected, message) => { assert.equal(actual, expected, message); checks += 1; };
const ok = (value, message) => { assert.ok(value, message); checks += 1; };

const template = {
  slug: "gpt-6.1-sol",
  visibility: "list",
  context_window: 300000,
  max_context_window: 300000,
  effective_context_window_percent: 80,
  auto_compact_token_limit: 250000,
  input_modalities: ["text", "image"],
  supports_parallel_tool_calls: true,
  custom_cache_marker: "preserve-template-data",
};
const cache = { models: [template, { slug: "gpt-6-luna", visibility: "list" }, { slug: PICKER_SLUG, visibility: "list" }] };
const before = JSON.stringify(cache);
const entry = deepSeekEntry(template);
equal(entry.context_window, 1_048_576, "DeepSeek catalog uses the official 1M context window");
equal(entry.max_context_window, 1_048_576, "DeepSeek maximum context window matches official metadata");
equal(entry.effective_context_window_percent, 95, "DeepSeek effective context is 95 percent");
equal(entry.auto_compact_token_limit, null, "DeepSeek automatic compaction threshold is unset");
equal(entry.comp_hash, "sol-luna-native-deepseek-flash-v2", "DeepSeek catalog metadata has a new comp_hash version");
equal(entry.input_modalities.join(","), "text", "DeepSeek text-only input behavior remains unchanged");
equal(entry.supports_parallel_tool_calls, true, "template tool capability remains unchanged");
equal(entry.custom_cache_marker, "preserve-template-data", "unrelated template metadata is retained");

const child = buildChildCatalog(cache);
equal(child.models.length, 1, "child catalog contains only the native DeepSeek model");
equal(child.models[0].slug, PICKER_SLUG, "child catalog uses the exact picker slug");
equal(JSON.stringify(cache), before, "child catalog construction leaves the parent cache byte-for-byte unchanged");
ok(!child.models.some((model) => /^gpt-/i.test(model.slug)), "child catalog does not include GPT models");

const parent = mergeCatalog(cache);
equal(parent.models.filter((model) => model.slug === PICKER_SLUG).length, 1, "legacy merge retains exactly one DeepSeek entry");
ok(parent.models.some((model) => model.slug === "gpt-6.1-sol"), "legacy merge retains GPT parent models");
ok(parent.models.some((model) => model.slug === "gpt-6-luna"), "legacy merge retains Luna parent models");
equal(JSON.stringify(cache), before, "legacy merge does not mutate the cache");

assert.throws(() => buildChildCatalog({ models: [{ slug: PICKER_SLUG, visibility: "list" }] }), /no valid.*template/i);
checks += 1;
assert.throws(() => buildChildCatalog({ models: [] }), /models_cache\.json has no models/i);
checks += 1;

console.log(`PASS ${checks} native catalog assertions`);
