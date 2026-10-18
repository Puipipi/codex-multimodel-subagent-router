import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {createHash} from "node:crypto";
import {mkdir, mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const temp = await mkdtemp(path.join(os.tmpdir(), "router-settings-mcp-"));
const settingsFile = path.join(temp, "sol-luna-deepseek-router", "native-api", "router.json");
const keyFile = path.join(temp, "mimo.key");
await mkdir(path.dirname(settingsFile), {recursive: true});
await writeFile(keyFile, "file-secret-never-returned\n", "utf8");

let checks = 0;
const ok = (value, message) => { assert.ok(value, message); checks += 1; };
const equal = (actual, expected, message) => { assert.equal(actual, expected, message); checks += 1; };
const deepEqual = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks += 1; };
const match = (value, pattern, message) => { assert.match(value, pattern, message); checks += 1; };
const doesNotMatch = (value, pattern, message) => { assert.doesNotMatch(value, pattern, message); checks += 1; };

class StdioClient {
  constructor(child) {
    this.child = child;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.stderr = "";
    this.closed = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => { this.stderr += chunk; });
    child.stdout.on("data", chunk => this.#read(chunk));
    child.on("exit", (code, signal) => {
      this.closed = true;
      const error = new Error(`plugin MCP exited (${code ?? signal}); stderr: ${this.stderr.slice(-2000)}`);
      for (const {reject} of this.pending.values()) reject(error);
      this.pending.clear();
    });
  }

  #read(chunk) {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); }
      catch { throw new Error(`Non-JSON MCP stdout: ${line.slice(0, 500)}`); }
      if (message.id === undefined) continue;
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      pending.resolve(message);
    }
  }

  request(method, params = {}) {
    if (this.closed) return Promise.reject(new Error("plugin MCP is closed"));
    const id = this.nextId++;
    const message = {jsonrpc: "2.0", id, method, params};
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method} (id ${id}); stderr: ${this.stderr.slice(-2000)}`));
      }, 10_000);
      this.pending.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
    });
  }

  async close() {
    if (this.closed) return;
    this.child.stdin.end();
    await new Promise(resolve => {
      const timer = setTimeout(() => { this.child.kill(); resolve(); }, 5000);
      this.child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }
}

const env = {
  ...process.env,
  LOCALAPPDATA: temp,
  SOL_LUNA_PLUGIN_STATE: path.join(temp, "plugin-state"),
  DSH_HOME: path.join(temp, "dsh"),
  MIMO_API_KEY: "env-secret-never-returned",
};
const child = spawn(process.execPath, [path.join(root, "scripts", "plugin-mcp.mjs")], {
  cwd: root,
  env,
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});
const client = new StdioClient(child);

function payload(response) {
  return response.result?.structuredContent ?? JSON.parse(response.result?.content?.[0]?.text ?? "null");
}
function text(response) {
  return response.result?.content?.map(item => item?.text ?? "").join("\n") ?? "";
}
function isError(response) {
  return response.result?.isError === true;
}
function toolCall(name, args = {}, meta) {
  const params = {name, arguments: args};
  if (meta !== undefined) params._meta = meta;
  return client.request("tools/call", params);
}

try {
  const init = await client.request("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: {name: "router-settings-test", version: "1.0.0"},
  });
  equal(init.result.protocolVersion, "2025-11-25", "initialize negotiates MCP 2025-11-25");
  ok(init.result.capabilities.tools, "initialize advertises tools");
  ok(init.result.capabilities.resources, "initialize advertises resources");
  const settingsCapability = init.result.capabilities.experimental?.["openai/settings"];
  deepEqual(settingsCapability, {
    readTool: "router_settings_read",
    updateTool: "router_settings_update",
  }, "initialize advertises the OpenAI settings capability through experimental");

  const listed = await client.request("tools/list");
  const tools = listed.result.tools;
  const names = tools.map(tool => tool.name);
  for (const name of [
    "router_settings_open",
    "router_settings_read",
    "router_settings_update",
    "router_settings_snapshot",
    "router_settings_save",
    "router_settings_save_profile",
    "router_settings_check_credential",
  ]) ok(names.includes(name), `tools/list includes ${name}`);
  for (const name of ["dsh_start", "dsh_status", "dsh_wait", "dsh_followup", "dsh_list", "dsh_trace"]) {
    ok(names.includes(name), `tools/list retains legacy ${name}`);
  }

  const openTool = tools.find(tool => tool.name === "router_settings_open");
  equal(openTool.title, "路由设置", "the entrypoint has a user-facing title");
  equal(openTool._meta.ui.resourceUri, "ui://router/settings", "the entrypoint binds the UI resource");
  deepEqual(openTool._meta["openai/ui"].entrypoints, [{type: "global"}, {type: "thread"}],
    "the entrypoint registers global and thread entrypoints");
  deepEqual(openTool.inputSchema, {type: "object", additionalProperties: false, properties: {}},
    "the entrypoint accepts exactly an empty object");
  ok(!openTool.inputSchema.required || openTool.inputSchema.required.length === 0,
    "the entrypoint requires no arguments");

  const readTool = tools.find(tool => tool.name === "router_settings_read");
  ok(readTool.outputSchema, "the settings read tool declares an outputSchema");
  deepEqual(readTool.outputSchema.required, ["schema", "values"], "SettingsReadResult requires schema and values");
  ok(readTool.outputSchema.properties.layout, "SettingsReadResult declares layout");
  equal(readTool.annotations.readOnlyHint, true, "the settings read tool is read-only");
  deepEqual(readTool.inputSchema, {type: "object", additionalProperties: false, properties: {}},
    "the settings read tool accepts exactly an empty object");

  const updateTool = tools.find(tool => tool.name === "router_settings_update");
  ok(updateTool.inputSchema.properties.set, "the settings update tool accepts set");
  deepEqual(updateTool.inputSchema.required, ["set"], "the settings update tool requires set");
  ok(updateTool.outputSchema.properties.values, "the settings update tool returns values");
  const profileTool = tools.find(tool => tool.name === "router_settings_save_profile");
  const contextWindowSchema = profileTool.inputSchema.properties.definition.properties.contextWindow;
  equal(contextWindowSchema.type, "integer", "the profile interface accepts an optional contextWindow");
  equal(contextWindowSchema.minimum, 1024, "the context budget minimum is 1024 tokens");
  equal(contextWindowSchema.maximum, 2000000, "the context budget maximum is 2000000 tokens");
  ok(!profileTool.inputSchema.properties.definition.required.includes("contextWindow"),
    "contextWindow remains optional so old profiles keep their hash");

  const resources = await client.request("resources/list");
  const resource = resources.result.resources.find(item => item.uri === "ui://router/settings");
  ok(resource, "resources/list includes the router settings resource");
  equal(resource.mimeType, "text/html;profile=mcp-app", "the resource uses the MCP App MIME type");

  const resourceRead = await client.request("resources/read", {uri: "ui://router/settings"});
  const contents = resourceRead.result.contents;
  equal(contents.length, 1, "resources/read returns one content item");
  equal(contents[0].uri, "ui://router/settings", "the read content matches the requested URI");
  equal(contents[0].mimeType, "text/html;profile=mcp-app", "the read content keeps the MCP App MIME type");
  const html = contents[0].text;
  match(html, /<!doctype html>/i, "the UI is a complete HTML document");
  match(html, /ui\/initialize/, "the UI performs the standard ui/initialize handshake");
  match(html, /ui\/notifications\/initialized/, "the UI sends the initialized notification");
  match(html, /ui\/notifications\/tool-result/, "the UI handles tool results");
  match(html, /router_settings_snapshot/, "the UI loads a settings snapshot through a tool");
  match(html, /router_settings_save/, "the UI saves with a server-side CAS tool");
  match(html, /router_settings_check_credential/, "the UI checks local credential availability");
  doesNotMatch(html, /<script[^>]+src=/i, "the UI has no external script");
  doesNotMatch(html, /<link[^>]+href=/i, "the UI has no external stylesheet");
  doesNotMatch(html, /@import/i, "the UI has no remote CSS import");
  doesNotMatch(html, /\bfetch\s*\(|XMLHttpRequest|new\s+WebSocket/i, "the UI has no network request path");
  doesNotMatch(html, /ui\/message/, "the UI never sends a chat message");
  doesNotMatch(html, /type=["']password["']/i, "the UI has no API key field");
  match(html, /hostCapabilities/, "the UI checks host capabilities");
  match(html, /serverTools/, "the UI names the required host capability");
  match(html, /上下文预算（tokens）/, "the API editor labels the context budget in Chinese");
  match(html, /id="profile-context-window"[^>]*type="number"/, "the context budget is a numeric input");
  match(html, /id="profile-context-window"[^>]*min="1024"/, "the context budget input advertises the minimum");
  match(html, /id="profile-context-window"[^>]*max="2000000"/, "the context budget input advertises the maximum");
  match(html, /128000/, "the new-profile default context budget is 128000");
  match(html, /按所选模型的上下文上限设置/, "the hint asks the user to follow the selected model's context limit");
  match(html, /id="context-window-note"/, "the UI has an inline contextWindow capability note");
  match(html, /capabilities\?\.contextWindow/, "the UI consumes the contextWindow capability flag");
  doesNotMatch(html, /所有模型[^<]*(?:安全|保守)/, "the hint does not claim every model is conservatively safe");

  const unknownResource = await client.request("resources/read", {uri: "ui://router/missing"});
  ok(unknownResource.error, "an unknown resource is a JSON-RPC error");
  match(unknownResource.error.message, /resource/i, "the unknown-resource error is explicit");

  const initialRead = await toolCall("router_settings_read", {});
  ok(!isError(initialRead), "settings read works without a model or thread identity");
  const initial = payload(initialRead);
  ok(initial.schema?.properties, "settings read returns the schema");
  ok(initial.values, "settings read returns values");
  ok(Array.isArray(initial.layout), "settings read returns layout groups");
  for (const key of Object.keys(initial.schema.properties)) {
    ok(Object.hasOwn(initial.values, key), `settings read supplies a value for ${key}`);
  }
  equal(initial.values.mode, "auto", "the default mode is automatic");
  equal(initial.values.peak, "luna", "the default peak selector is Luna");
  equal(initial.values.valley, "deepseek", "the default valley selector is DeepSeek");

  const opened = await toolCall("router_settings_open", {});
  ok(!isError(opened), "the entrypoint accepts an empty object");
  equal(payload(opened).resourceUri, "ui://router/settings", "the entrypoint reports its UI resource");
  match(text(opened), /路由设置/, "the entrypoint result is readable in Chinese");

  const updated = await toolCall("router_settings_update", {
    set: {mode: "scheduled", peak: "deepseek", valley: "luna"},
  });
  ok(!isError(updated), "settings update works through the settings capability");
  const updatedValues = payload(updated).values;
  equal(updatedValues.mode, "scheduled", "settings update changes the mode");
  equal(updatedValues.peak, "deepseek", "settings update changes the peak selector");
  equal(updatedValues.valley, "luna", "settings update changes the valley selector");
  const afterUpdate = payload(await toolCall("router_settings_read", {}));
  equal(afterUpdate.values.mode, "scheduled", "the updated mode is persisted");
  equal(afterUpdate.values.peak, "deepseek", "the updated peak selector is persisted");
  equal(afterUpdate.values.valley, "luna", "the updated valley selector is persisted");

  let snapshot = payload(await toolCall("router_settings_snapshot", {}));
  ok(snapshot.sha256, "the snapshot exposes a revision");
  equal(snapshot.status.save, "saved", "the snapshot distinguishes a saved configuration");
  equal(snapshot.status.install, "unknown", "the snapshot does not claim installation");
  equal(snapshot.status.verify, "not_verified", "the snapshot does not claim verification");
  equal(snapshot.status.resolverReady, false, "the snapshot reports the resolver is not declared ready");
  equal(typeof snapshot.capabilities.contextWindow, "boolean",
    "the snapshot reports whether the core supports contextWindow");

  const raw = JSON.parse(await readFile(settingsFile, "utf8"));
  const changedBytes = Buffer.from(`${JSON.stringify(raw, null, 2)}\n\n`, "utf8");
  await writeFile(settingsFile, changedBytes);
  const changedHash = createHash("sha256").update(changedBytes).digest("hex");
  ok(changedHash !== snapshot.sha256, "the external write changes the revision");
  const conflict = await toolCall("router_settings_save", {
    settings: raw,
    expectedSha256: snapshot.sha256,
  });
  ok(isError(conflict), "a stale revision cannot overwrite settings");
  match(text(conflict), /reload|重新|changed since/i, "the CAS conflict asks the caller to reload");

  snapshot = payload(await toolCall("router_settings_snapshot", {}));
  equal(snapshot.sha256, changedHash, "reread returns the new exact revision");
  const saved = await toolCall("router_settings_save", {
    settings: raw,
    expectedSha256: snapshot.sha256,
  });
  ok(!isError(saved), "a fresh revision can be saved");
  ok(payload(saved).sha256, "save returns the committed revision");

  const invalidProfile = await toolCall("router_settings_save_profile", {
    expectedSha256: payload(saved).sha256,
    definition: {
      protocol: "responses",
      baseUrl: "https://api.mimo.example/v1",
      model: "mimo-v2-pro",
      reasoning: {supported: ["low", "medium"], default: "medium", parameter: "reasoning_effort"},
      credential: {type: "env", name: "BAD NAME"},
    },
  });
  ok(isError(invalidProfile), "an invalid credential reference is rejected");
  const secretField = await toolCall("router_settings_save_profile", {
    expectedSha256: payload(saved).sha256,
    definition: {
      protocol: "responses",
      baseUrl: "https://api.mimo.example/v1",
      model: "mimo-v2-pro",
      reasoning: {supported: ["low", "medium"], default: "medium", parameter: "reasoning_effort"},
      credential: {type: "env", name: "MIMO_API_KEY"},
      apiKey: "sk-should-never-be-accepted",
    },
  });
  ok(isError(secretField), "a profile rejects an embedded API key");
  doesNotMatch(text(secretField), /sk-should-never-be-accepted/, "the rejection never echoes the secret");

  const checkEnv = await toolCall("router_settings_check_credential", {
    baseUrl: "https://api.mimo.example/v1",
    protocol: "responses",
    credential: {type: "env", name: "MIMO_API_KEY"},
  });
  ok(!isError(checkEnv), "an environment credential check succeeds");
  equal(payload(checkEnv).available, true, "the environment credential is locally available");
  equal(payload(checkEnv).verified, false, "a local check does not claim authentication");
  doesNotMatch(JSON.stringify(payload(checkEnv)), /env-secret-never-returned/, "the credential value is never returned");

  const checkFile = await toolCall("router_settings_check_credential", {
    baseUrl: "https://api.mimo.example/v1",
    protocol: "chat_completions",
    credential: {type: "file", path: keyFile},
  });
  ok(!isError(checkFile), "a key file check succeeds");
  equal(payload(checkFile).available, true, "the key file is locally available");
  doesNotMatch(JSON.stringify(payload(checkFile)), /file-secret-never-returned/, "the key file value is never returned");

  const missing = await toolCall("router_settings_check_credential", {
    baseUrl: "https://api.mimo.example/v1",
    protocol: "responses",
    credential: {type: "env", name: "MISSING_MIMO_API_KEY"},
  });
  equal(payload(missing).available, false, "a missing credential is reported as unavailable");
  match(payload(missing).reason, /环境变量|credential/i, "the missing credential explains the local check");

  const firstProfile = await toolCall("router_settings_save_profile", {
    expectedSha256: payload(saved).sha256,
    label: "MiMo",
    aliases: ["mimo"],
    definition: {
      protocol: "responses",
      baseUrl: "https://api.mimo.example/v1",
      model: "mimo-v2-pro",
      reasoning: {supported: ["low", "medium"], default: "medium", parameter: "reasoning_effort"},
      credential: {type: "env", name: "MIMO_API_KEY"},
    },
  });
  ok(!isError(firstProfile), "a valid API profile can be added");
  const first = payload(firstProfile);
  match(first.profileId, /^[a-f0-9]{24}$/, "the new profile has a stable immutable id");
  equal(first.created, true, "the first profile is recorded as a new version");
  ok(first.settings.profiles[first.profileId], "the profile is persisted in the returned snapshot");
  match(first.pending.message, /安装|重启/, "the response states that installation or restart is pending");
  equal(first.pending.restartRequired, true, "the response marks the restart requirement");
  equal(first.status.install, "unknown", "profile creation does not claim installation");

  const withFixed = await toolCall("router_settings_save", {
    expectedSha256: first.sha256,
    settings: {
      ...first.settings,
      mode: "fixed",
      fixedExecutor: "mimo",
    },
  });
  ok(!isError(withFixed), "the alias can be selected as the fixed executor");
  equal(payload(withFixed).settings.fixedExecutor, first.profileId,
    "an alias selection is stored as the immutable profile id");

  const secondProfile = await toolCall("router_settings_save_profile", {
    expectedSha256: payload(withFixed).sha256,
    basedOnProfileId: first.profileId,
    label: "MiMo",
    aliases: ["mimo"],
    definition: {
      protocol: "responses",
      baseUrl: "https://api.mimo.example/v1",
      model: "mimo-v2-lite",
      reasoning: {supported: ["low", "medium"], default: "medium", parameter: "reasoning_effort"},
      credential: {type: "env", name: "MIMO_API_KEY"},
    },
  });
  ok(!isError(secondProfile), "editing a profile creates a new immutable version");
  const second = payload(secondProfile);
  ok(second.profileId !== first.profileId, "the edited profile gets a new id");
  ok(second.settings.profiles[first.profileId], "the old profile is retained for existing children");
  equal(second.settings.profiles[first.profileId].model, "mimo-v2-pro", "the old profile definition is unchanged");
  equal(second.settings.profiles[second.profileId].model, "mimo-v2-lite", "the new profile has the new model");
  deepEqual(second.settings.profiles[second.profileId].aliases, ["mimo"], "the alias moves to the new version");
  ok(!second.settings.profiles[first.profileId].aliases?.includes("mimo"), "the old version no longer owns the ambiguous alias");
  equal(second.settings.fixedExecutor, second.profileId, "active selectors migrate to the new immutable version");
  equal(second.supersedes, first.profileId, "the response identifies the superseded profile");

  const aliasConflict = await toolCall("router_settings_save_profile", {
    expectedSha256: second.sha256,
    label: "Other",
    aliases: ["mimo"],
    definition: {
      protocol: "responses",
      baseUrl: "https://api.other.example/v1",
      model: "other-model",
      reasoning: {supported: ["none"], default: "none", parameter: "none"},
      credential: {type: "env", name: "MIMO_API_KEY"},
    },
  });
  ok(isError(aliasConflict), "a different profile cannot steal an alias");
  match(text(aliasConflict), /alias/i, "the alias conflict is explicit");

  const currentSettings = payload(await toolCall("router_settings_snapshot", {}));
  const contextDefinition = {
    protocol: "responses",
    baseUrl: "https://api.mimo.example/v1",
    model: "mimo-v2-pro",
    reasoning: {supported: ["low", "medium"], default: "medium", parameter: "reasoning_effort"},
    credential: {type: "env", name: "MIMO_API_KEY"},
  };
  const tooSmall = await toolCall("router_settings_save_profile", {
    expectedSha256: currentSettings.sha256,
    definition: {...contextDefinition, contextWindow: 1023},
  });
  ok(isError(tooSmall), "a context budget below 1024 is rejected");
  match(text(tooSmall), /1024/, "the low-bound rejection names the limit");
  const tooLarge = await toolCall("router_settings_save_profile", {
    expectedSha256: currentSettings.sha256,
    definition: {...contextDefinition, contextWindow: 2000001},
  });
  ok(isError(tooLarge), "a context budget above 2000000 is rejected");
  match(text(tooLarge), /2000000/, "the high-bound rejection names the limit");

  const contextProfile = await toolCall("router_settings_save_profile", {
    expectedSha256: currentSettings.sha256,
    label: "Context Budget",
    definition: {...contextDefinition, contextWindow: 128000},
  });
  if (isError(contextProfile)) {
    match(text(contextProfile), /尚未支持 contextWindow|unsupported field/i,
      "the current core rejects contextWindow explicitly before integration");
    match(text(contextProfile), /未保存/, "the pending field never pretends to save");
  } else {
    const contextResult = payload(contextProfile);
    ok(contextResult.profileId !== first.profileId,
      "an explicit context budget creates a distinct profile identity");
    equal(contextResult.settings.profiles[contextResult.profileId].contextWindow, 128000,
      "the explicit context budget is persisted after the integration field lands");
    equal(contextResult.settings.profiles[first.profileId].contextWindow, undefined,
      "the old profile without a context budget remains unchanged");
    const withoutContext = await toolCall("router_settings_save_profile", {
      expectedSha256: contextResult.sha256,
      label: "No Context Budget",
      definition: contextDefinition,
    });
    ok(!isError(withoutContext), "a profile without a context budget remains saveable");
    const withoutResult = payload(withoutContext);
    ok(withoutResult.profileId !== contextResult.profileId,
      "an explicitly present contextWindow participates in the profile identity");
    equal(withoutResult.settings.profiles[withoutResult.profileId].contextWindow, undefined,
      "an absent contextWindow keeps the old profile definition shape");
  }

  const withoutIdentity = await toolCall("dsh_status", {agent_id: "missing"});
  ok(isError(withoutIdentity), "legacy DSH tools still require trusted identity");
  match(text(withoutIdentity), /_meta\.threadId/, "the legacy identity guard remains");
  const ownedCheck = await toolCall("dsh_status", {agent_id: "missing"}, {threadId: "router-settings-test-chat"});
  ok(isError(ownedCheck), "legacy DSH tools still enforce ownership");
  match(text(ownedCheck), /not available to this chat/, "the legacy ownership guard remains");

  equal((await readFile(settingsFile, "utf8")).includes("env-secret-never-returned"), false,
    "the settings file never contains the env credential");
  equal((await readFile(settingsFile, "utf8")).includes("file-secret-never-returned"), false,
    "the settings file never contains the file credential");
} finally {
  await client.close();
  await rm(temp, {recursive: true, force: true});
}

console.log(`PASS ${checks} router settings MCP assertions`);
