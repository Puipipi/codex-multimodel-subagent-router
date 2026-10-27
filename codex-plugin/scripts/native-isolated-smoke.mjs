import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { AppServer } from "./native-app-server.mjs";

const RPC_TIMEOUT_MS = 15_000;
const ROLE_NAME = "native_deepseek";
const DEEPSEEK_PROVIDER = "deepseek-native";
const DEEPSEEK_MODEL = "deepseek/deepseek-flash";

function inside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function toLocalPath(value, base) {
  assert.equal(typeof value, "string", "configured path is missing");
  const path = value.startsWith("file:") ? fileURLToPath(value) : resolve(base, value);
  return resolve(path);
}

function providerMap(config) {
  return config?.model_providers ?? config?.additional?.model_providers ?? {};
}

function rootBaseUrl(config) {
  const value = config?.openai_base_url ?? config?.additional?.openai_base_url;
  return value === undefined ? null : value;
}

function providerBaseUrl(provider) {
  return provider?.base_url ?? provider?.additional?.base_url ?? null;
}

function loopbackHostPort(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (!["localhost", "127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(hostname)) return null;
    return `loopback:${url.port || (url.protocol === "https:" ? "443" : "80")}`;
  } catch {
    return null;
  }
}

function roleMap(config, layers) {
  const candidates = [config?.agents, config?.additional?.agents];
  for (const layer of layers ?? []) {
    candidates.push(layer?.config?.agents, layer?.config?.additional?.agents);
  }
  return candidates.find((value) => value && typeof value === "object") ?? {};
}

function modelName(model) {
  return model?.model ?? model?.slug ?? model?.id;
}

function safeFailure(stage, error) {
  return {
    stage,
    code: error?.rpc?.code ?? error?.code ?? "SMOKE_ERROR",
  };
}

/**
 * Read-only, isolated app-server config preflight. preparedHome must be an already
 * prepared disposable Codex home containing its local root model catalog.
 */
export async function runIsolatedConfigSmoke({
  exePath,
  preparedHome,
  expectedMainModel,
  expectedMainProvider,
  expectedRootBaseUrl,
  deepseekModel = DEEPSEEK_MODEL,
  deepseekProvider = DEEPSEEK_PROVIDER,
  roleName = ROLE_NAME,
  rpcTimeoutMs = RPC_TIMEOUT_MS,
  appServerFactory = (options) => new AppServer(options),
} = {}) {
  const result = {
    status: "failed",
    stage: "preflight",
    checks: {
      explicit_executable_present: false,
      isolated_home_present: false,
      main_model_and_provider_match: false,
      root_base_url_matches_expectation: false,
      main_provider_separate_from_deepseek_loopback: false,
      root_catalog_is_local_and_not_deepseek_only: false,
      deepseek_provider_compaction_unsupported: false,
      role_config_file_present: false,
      app_server_closed: false,
    },
  };
  let app;
  let stage = "preflight";
  try {
    assert(typeof exePath === "string" && isAbsolute(exePath), "exePath must be an explicit absolute path");
    assert(existsSync(exePath) && statSync(exePath).isFile(), "explicit executable does not exist");
    result.checks.explicit_executable_present = true;
    assert(typeof preparedHome === "string" && isAbsolute(preparedHome), "preparedHome must be an explicit absolute path");
    const home = resolve(preparedHome);
    assert(existsSync(home) && statSync(home).isDirectory(), "preparedHome directory does not exist");
    const userCodexHome = resolve(process.env.CODEX_HOME || resolve(homedir(), ".codex"));
    assert(!inside(userCodexHome, home) && !inside(home, userCodexHome), "preparedHome must be separate from the real user Codex home");
    result.checks.isolated_home_present = true;
    assert(typeof expectedMainModel === "string" && expectedMainModel.length > 0, "expectedMainModel is required");
    assert((typeof expectedMainProvider === "string" && expectedMainProvider.length > 0) || expectedMainProvider === null, "expectedMainProvider must be a provider id or null");
    assert(Object.hasOwn(arguments[0] ?? {}, "expectedRootBaseUrl"), "expectedRootBaseUrl is required; use null to require no root URL override");
    assert(expectedRootBaseUrl === null || (typeof expectedRootBaseUrl === "string" && expectedRootBaseUrl.length > 0), "expectedRootBaseUrl must be a non-empty string or null");

    stage = "app_server_start";
    app = appServerFactory({
      exe: exePath,
      codexHome: home,
      cwd: home,
      eventLog: null,
      envOverrides: { SOL_LUNA_NATIVE_PLAINTEXT_V2: "1" },
    });
    await app.start();

    stage = "initialize";
    await app.call("initialize", {
      clientInfo: { name: "isolated-config-smoke", title: "Isolated Config Smoke", version: "1.0.0" },
      capabilities: { experimentalApi: true },
    }, rpcTimeoutMs);

    stage = "config_read";
    const read = await app.call("config/read", { includeLayers: true }, rpcTimeoutMs);
    const config = read?.config;
    assert(config && typeof config === "object", "config/read returned no config object");
    assert.equal(config.model, expectedMainModel, "effective main model mismatch");
    assert.equal(config.model_provider, expectedMainProvider, "effective main provider mismatch");
    result.checks.main_model_and_provider_match = true;
    assert.equal(rootBaseUrl(config), expectedRootBaseUrl, "root OpenAI base URL does not match the caller's expected value");
    result.checks.root_base_url_matches_expectation = true;

    const catalogValue = config.model_catalog_json ?? config.additional?.model_catalog_json;
    const catalogPath = toLocalPath(catalogValue, home);
    assert(inside(home, catalogPath), "root model catalog must be inside preparedHome");
    assert(existsSync(catalogPath) && statSync(catalogPath).isFile(), "root model catalog file is missing");
    const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
    const catalogModels = Array.isArray(catalog) ? catalog : catalog?.models;
    assert(Array.isArray(catalogModels), "root model catalog has no models array");
    const catalogNames = catalogModels.map(modelName).filter((value) => typeof value === "string");
    assert(catalogNames.includes(expectedMainModel), "root model catalog does not contain expected main model");
    assert(!catalogNames.includes(deepseekModel), "root model catalog was taken over by the DeepSeek-only catalog");

    stage = "model_list";
    // This RPC has no force-refresh parameter. Requiring a local catalog above keeps
    // this preflight on the prepared static catalog instead of an uncached network route.
    const listed = await app.call("model/list", { includeHidden: true }, rpcTimeoutMs);
    const listedModels = Array.isArray(listed?.data) ? listed.data.map(modelName) : [];
    assert(listedModels.includes(expectedMainModel), "model/list omitted the expected root main model");
    assert(!listedModels.includes(deepseekModel), "model/list exposed the child-owned DeepSeek model in the root catalog");
    result.checks.root_catalog_is_local_and_not_deepseek_only = true;

    stage = "provider_config";
    const providers = providerMap(config);
    const deepseek = providers[deepseekProvider];
    assert(deepseek && typeof deepseek === "object", "DeepSeek provider config is missing");
    assert.equal(deepseek.capabilities?.remote_compaction, "unsupported", "DeepSeek remote_compaction capability mismatch");
    const effectiveProviderId = expectedMainProvider ?? "openai";
    const mainProvider = providers[effectiveProviderId];
    const mainUrl = effectiveProviderId === "openai" ? (rootBaseUrl(config) ?? providerBaseUrl(mainProvider)) : providerBaseUrl(mainProvider);
    const deepseekUrl = providerBaseUrl(deepseek);
    const mainLoopback = loopbackHostPort(mainUrl);
    const deepseekLoopback = loopbackHostPort(deepseekUrl);
    assert(!(mainLoopback && deepseekLoopback && mainLoopback === deepseekLoopback), "main and DeepSeek provider URLs share a loopback host and port");
    result.checks.main_provider_separate_from_deepseek_loopback = true;
    result.checks.deepseek_provider_compaction_unsupported = true;

    stage = "role_config";
    const roles = roleMap(config, read?.layers);
    const role = roles[roleName];
    assert(role && typeof role === "object", "native DeepSeek role declaration is missing from config/read");
    const roleConfigPath = toLocalPath(role.config_file, home);
    assert(inside(home, roleConfigPath), "role config_file must be inside preparedHome");
    assert(existsSync(roleConfigPath) && statSync(roleConfigPath).isFile(), "role config_file target is missing");
    result.checks.role_config_file_present = true;
    result.status = "passed";
    result.stage = "complete";
  } catch (error) {
    result.failure = safeFailure(stage, error);
    result.stage = stage;
  } finally {
    if (app) {
      try {
        await app.close({ timeoutMs: 6_000, killAfterMs: 2_000 });
        result.checks.app_server_closed = app.child === null && app.exitObserved === true;
      } catch {
        result.checks.app_server_closed = app.child === null && app.exitObserved === true;
      }
    } else {
      result.checks.app_server_closed = true;
    }
    if (!result.checks.app_server_closed) {
      result.status = "failed";
      result.stage = "cleanup";
      result.failure ??= { stage: "cleanup", code: "APP_SERVER_NOT_CLOSED" };
    }
  }
  return result;
}
