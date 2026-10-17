import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PICKER_SLUG } from "./native-routing.mjs";

export const CATALOG_FILE = "sol-luna-native-models.json";

export function catalogPath(codexHome) {
  return path.join(codexHome, CATALOG_FILE);
}

export function deepSeekEntry(template) {
  if (!template || typeof template !== "object") throw new Error("A native model entry is required as the catalog template");
  const entry = structuredClone(template);
  Object.assign(entry, {
    slug: PICKER_SLUG,
    display_name: "DeepSeek Flash",
    description: "DeepSeek Flash via the official DeepSeek Responses API and the local native gateway.",
    default_reasoning_level: "high",
    supported_reasoning_levels: [
      { effort: "low", description: "Faster reasoning" },
      { effort: "high", description: "Deep reasoning" },
      { effort: "max", description: "Maximum reasoning" },
    ],
    priority: 0,
    visibility: "list",
    supported_in_api: true,
    prefer_websockets: false,
    support_verbosity: false,
    default_verbosity: "low",
    apply_patch_tool_type: "freeform",
    web_search_tool_type: "text",
    input_modalities: ["text"],
    supports_image_detail_original: false,
    supports_parallel_tool_calls: true,
    supports_search_tool: false,
    tool_mode: null,
    multi_agent_version: "v2",
    multi_agent_reasoning_effort: "high",
    use_responses_lite: false,
    include_skills_usage_instructions: false,
    context_window: 131072,
    max_context_window: 131072,
    effective_context_window_percent: 90,
    auto_compact_token_limit: 100000,
    default_reasoning_summary: "none",
    supports_reasoning_summaries: false,
    availability_nux: null,
    upgrade: null,
    experimental_supported_tools: [],
    comp_hash: "sol-luna-native-deepseek-flash-v1",
  });
  delete entry.additional_speed_tiers;
  delete entry.service_tiers;
  delete entry.default_service_tier;
  return entry;
}

export function mergeCatalog(cache) {
  if (!cache || !Array.isArray(cache.models) || cache.models.length === 0) {
    throw new Error("models_cache.json has no models; open Codex once before merging the catalog");
  }
  const native = cache.models.filter((model) => model?.slug !== PICKER_SLUG);
  const template = native.find((model) => model?.visibility === "list") || native[0];
  return { models: [...native, deepSeekEntry(template)] };
}

export function readCatalogCache(codexHome) {
  const file = path.join(codexHome, "models_cache.json");
  if (!existsSync(file)) throw new Error(`Codex models_cache.json is missing at ${file}`);
  return JSON.parse(readFileSync(file, "utf8"));
}

export function writeCatalog(file, catalog) {
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(catalog, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temp, file);
}

export function buildAndWriteCatalog(codexHome, output = catalogPath(codexHome)) {
  const catalog = mergeCatalog(readCatalogCache(codexHome));
  writeCatalog(output, catalog);
  return { output, models: catalog.models.map((model) => model.slug) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const result = buildAndWriteCatalog(codexHome);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
