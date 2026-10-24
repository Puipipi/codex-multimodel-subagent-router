import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PICKER_SLUG } from "./native-routing.mjs";
import { ensureNativeDeepseekDispatch } from "./native-isolated-install.mjs";
import { defaultRouterSettingsPath, loadRouterSettings } from "./native-api-settings.mjs";
import { ensureNativeApiDispatch } from "./native-api-install.mjs";
import { defaultNativeApiDir } from "./native-api-manager.mjs";
import { defaultModelsCachePath } from "./native-model-catalog.mjs";

export { defaultModelsCachePath, nativeModelOptionsFromCache, readNativeModelOptions } from "./native-model-catalog.mjs";

const LUNA_MAP = {
  "gpt-6.1-sol": "gpt-6-luna",
  "gpt-6-sol": "gpt-6-luna",
  "gpt-5.6-sol": "gpt-5.6-luna",
};

export function modelsFromCache(cache) {
  if (!cache || !Array.isArray(cache.models)) throw new Error("models_cache.json has no models");
  return cache.models.map((model) => model?.slug).filter((slug) => typeof slug === "string");
}

export function resolveNativeAgent({ executor, mainModel, models = [], apiProfiles = {} }) {
  if (executor === "same") {
    if (typeof mainModel !== "string" || !mainModel.trim()) throw new Error("same-model dispatch requires the trusted current chat model");
    return { executor: "same", model: mainModel, fork_turns: "none" };
  }
  if (typeof executor === "string" && executor.startsWith("native:")) {
    const model = executor.slice("native:".length);
    if (!model || !models.includes(model)) throw new Error(`Selected native model is not present in the current Codex catalog: ${model || "(empty)"}`);
    return { executor: "native", model, fork_turns: "none" };
  }
  if (executor === "deepseek") {
    return {
      executor: "deepseek",
      agent_type: "native_deepseek",
      fork_turns: "none",
      resolved_model: PICKER_SLUG,
    };
  }
  if (executor !== "luna" && executor !== "deepseek") {
    if (typeof executor !== "string" || !executor.trim()) {
      throw new Error("executor must be luna, deepseek, or a configured API profile; same and native:<model> are also supported");
    }
    const profile = apiProfiles[executor]
      || Object.values(apiProfiles).find((candidate) => candidate.aliases?.includes(executor));
    if (!profile) throw new Error("unknown API profile; refusing executor fallback");
    return {
      executor: "api",
      profile_id: profile.profileId,
      provider_id: `api-native-${profile.profileId}`,
      agent_type: `native_api_${profile.profileId}`,
      resolved_model: profile.model,
      fork_turns: "none",
    };
  }
  const available = new Set(models);
  const preferred = LUNA_MAP[mainModel];
  const lunaModels = models.filter((slug) => /luna/i.test(slug));
  const model = (preferred && available.has(preferred) ? preferred : null)
    || lunaModels.find((slug) => /^gpt-6-luna$/i.test(slug))
    || lunaModels[0];
  if (!model) throw new Error("No supported native Luna model is present in the current catalog; do not invent one");
  return {
    executor: "luna",
    model,
    fork_turns: "none",
  };
}

async function main(argv) {
  const get = (name, fallback) => {
    const at = argv.indexOf(`--${name}`);
    return at >= 0 ? argv[at + 1] : fallback;
  };
  const executor = get("executor");
  const mainModel = get("main-model");
  if (typeof executor !== "string" || !executor.trim()) {
    throw new Error("executor must be luna, deepseek, or a configured API profile; same and native:<model> are also supported");
  }
  const apiDir = get("api-dir") || defaultNativeApiDir();
  const settingsPath = get("settings") || (executor !== "luna" && executor !== "same" && !executor.startsWith("native:")
    ? path.join(apiDir, "router.json")
    : defaultRouterSettingsPath());
  const routerSettings = await loadRouterSettings(settingsPath);
  if (!routerSettings.enabled) throw new Error("Automatic child dispatch is disabled in router settings");
  if (executor === "deepseek") {
    const journalFlagAt = argv.indexOf("--install-journal");
    let journalPath;
    if (journalFlagAt >= 0) {
      journalPath = argv[journalFlagAt + 1];
      if (typeof journalPath !== "string" || !journalPath.trim() || journalPath.startsWith("--")) throw new Error("--install-journal must not be empty");
    } else {
      journalPath = process.env.SOL_LUNA_NATIVE_INSTALL_JOURNAL;
      if (typeof journalPath !== "string" || !journalPath.trim()) throw new Error("an installed isolation journal path is required for native DeepSeek dispatch; activate the isolated installer first");
    }
    await ensureNativeDeepseekDispatch({ journalPath });
    process.stdout.write(`${JSON.stringify(resolveNativeAgent({ executor, mainModel, models: [] }))}\n`);
    return;
  }
  if (executor !== "luna" && executor !== "same" && !executor.startsWith("native:")) {
    const result = resolveNativeAgent({ executor, mainModel, apiProfiles: routerSettings.profiles });
    const apiJournal = get("api-journal");
    await ensureNativeApiDispatch({
      profileId: result.profile_id,
      apiDir,
      settingsPath,
      journalPath: apiJournal || undefined,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (executor === "same") {
    process.stdout.write(`${JSON.stringify(resolveNativeAgent({ executor, mainModel }))}\n`);
    return;
  }
  const cacheAt = path.resolve(get("models-cache", defaultModelsCachePath()));
  if (!existsSync(cacheAt)) throw new Error(`models_cache.json is missing at ${cacheAt}; Luna resolution never substitutes a model`);
  const cache = JSON.parse(readFileSync(cacheAt, "utf8"));
  const result = resolveNativeAgent({ executor, mainModel, models: modelsFromCache(cache) });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 2; });
}
