import { createHash, randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalWorkspace, hashThread, resolveStateDir, withFileLock, writeJsonAtomic,
} from "./plugin-state.mjs";

async function readJson(file) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function childId(value) {
  if (typeof value !== "string" || value.trim() === "") throw new Error("childThreadId must be a non-empty string");
  return value.trim();
}

function parentId(value) {
  if (typeof value !== "string" || value.trim() === "") throw new Error("parentThreadId must be a non-empty string");
  return value.trim();
}

function nonce(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{8,200}$/.test(value)) throw new Error("taskNonce must be a safe non-empty identifier");
  return value;
}

function normalizeBinding(binding) {
  if (binding === null || binding === undefined) return null;
  if (typeof binding !== "object" || Array.isArray(binding)) throw new Error("child executor binding must be an object");
  const executor = binding.executor;
  if (!["luna", "deepseek", "api"].includes(executor)) throw new Error("child executor binding must be luna, deepseek, or api");
  const model = typeof binding.model === "string" && binding.model.trim() ? binding.model.trim() : null;
  if (!model) throw new Error("child executor binding requires an exact model");
  if (executor === "api") {
    const profileId = binding.profileId;
    if (typeof profileId !== "string" || !/^[a-f0-9]{24}$/.test(profileId)) throw new Error("API child binding requires a 24-character lowercase profile id");
    if (binding.role !== `native_api_${profileId}`) throw new Error("API child role must match its immutable profile id");
    if (binding.providerId !== `api-native-${profileId}`) throw new Error("API child provider must match its immutable profile id");
    return { executor, profileId, model, role: binding.role, providerId: binding.providerId };
  }
  if (executor === "deepseek") {
    if (binding.role !== undefined && binding.role !== "native_deepseek") throw new Error("DeepSeek child role must be native_deepseek");
    return { executor, profileId: null, model, role: "native_deepseek", providerId: null };
  }
  if (binding.profileId !== undefined && binding.profileId !== null) throw new Error("Luna child binding cannot carry an API profile");
  return { executor, profileId: null, model, role: null, providerId: null };
}

function sameBinding(left, right) {
  return JSON.stringify(normalizeBinding(left)) === JSON.stringify(normalizeBinding(right));
}

export class NativeTasks {
  constructor({ stateDir } = {}) {
    this.stateDir = resolveStateDir(stateDir);
    this.file = path.join(this.stateDir, "native-tasks.json");
    this.lock = path.join(this.stateDir, "native-tasks.lock");
  }

  async _read() {
    const value = await readJson(this.file);
    if (!value) return { version: 1, tasks: {} };
    if (!value.tasks || typeof value.tasks !== "object" || Array.isArray(value.tasks)) {
      throw new Error("Native task state is corrupt; refusing to act");
    }
    return value;
  }

  async _mutate(operation) {
    return withFileLock(this.lock, async () => {
      const data = await this._read();
      const result = await operation(data);
      data.version = 1;
      data.updated_at = new Date().toISOString();
      await writeJsonAtomic(this.file, data);
      return result;
    });
  }

  async begin({ parentThreadId, childThreadId, model, workspace = null, taskNonce = null, binding = null }) {
    const parent = parentId(parentThreadId);
    const child = childId(childThreadId);
    const normalizedBinding = normalizeBinding(binding);
    return this._mutate((data) => {
      const existing = data.tasks[child];
      if (existing && existing.owner !== hashThread(parent)) {
        throw new Error("This child thread belongs to another parent chat");
      }
      const immutable = existing?.binding ? normalizeBinding(existing.binding) : null;
      if (immutable && normalizedBinding && !sameBinding(immutable, normalizedBinding)) {
        throw new Error("This child's executor/profile binding is immutable and cannot be changed");
      }
      if (!immutable && normalizedBinding && existing?.model && existing.model !== normalizedBinding.model) {
        throw new Error("This child already has a different model; a late executor binding cannot change it");
      }
      const bound = immutable || normalizedBinding;
      if (immutable && typeof model === "string" && model !== immutable.model) {
        throw new Error("This child's model binding is immutable and cannot be changed");
      }
      if (existing?.task_nonce && taskNonce && existing.task_nonce !== taskNonce) {
        throw new Error("This child's task nonce cannot be changed");
      }
      const at = new Date().toISOString();
      data.tasks[child] = {
        child_thread_id: child,
        owner: hashThread(parent),
        task_nonce: existing?.task_nonce || taskNonce,
        model: bound ? bound.model : (typeof model === "string" ? model : existing?.model ?? null),
        ...(bound ? { binding: bound } : {}),
        workspace,
        status: "running",
        created_at: existing?.created_at ?? at,
        updated_at: at,
      };
      return { ...data.tasks[child], owner: undefined };
    });
  }

  async finish({ parentThreadId, childThreadId, status = "completed" }) {
    const parent = parentId(parentThreadId);
    const child = childId(childThreadId);
    return this._mutate((data) => {
      const existing = data.tasks[child];
      if (!existing || existing.owner !== hashThread(parent)) throw new Error("This child thread belongs to another parent chat");
      existing.status = status;
      existing.updated_at = new Date().toISOString();
      return { ...existing, owner: undefined };
    });
  }

  async assertOwner(childThreadId, parentThreadId) {
    const data = await this._read();
    const task = data.tasks[childId(childThreadId)];
    if (!task || task.owner !== hashThread(parentId(parentThreadId))) throw new Error("This child thread belongs to another parent chat");
    return { ...task, owner: undefined };
  }

  async owned(parentThreadId) {
    const owner = hashThread(parentId(parentThreadId));
    const data = await this._read();
    return Object.values(data.tasks)
      .filter((task) => task.owner === owner)
      .map((task) => ({ ...task, owner: undefined }));
  }

  async binding({ parentThreadId, childThreadId }) {
    const task = await this.assertOwner(childThreadId, parentThreadId);
    return task.binding ? normalizeBinding(task.binding) : null;
  }
}

export class NativeWriterLease {
  constructor({ stateDir } = {}) {
    this.stateDir = resolveStateDir(stateDir);
    this.directory = path.join(this.stateDir, "native-leases");
  }

  async _paths(workspace) {
    const canonical = await canonicalWorkspace(workspace);
    const key = createHash("sha256").update(canonical).digest("hex");
    return {
      canonical,
      lease: path.join(this.directory, `${key}.json`),
      guard: path.join(this.directory, `${key}.guard`),
    };
  }

  async reserve({ workspace, parentThreadId, taskNonce = randomUUID() }) {
    const owner = hashThread(parentId(parentThreadId));
    const task = nonce(taskNonce);
    const paths = await this._paths(workspace);
    return withFileLock(paths.guard, async () => {
      const existing = await readJson(paths.lease);
      if (existing) {
        if (existing.owner !== owner || existing.task_nonce !== task) {
          throw new Error(`Workspace is already reserved by another native task in ${paths.canonical}; only an explicit release or a known terminal task may clear it`);
        }
        return { ...existing, owner: undefined };
      }
      const at = new Date().toISOString();
      const lease = {
        version: 2,
        workspace: paths.canonical,
        owner,
        task_nonce: task,
        state: "reserved",
        child_thread_id: null,
        created_at: at,
        updated_at: at,
      };
      await writeJsonAtomic(paths.lease, lease);
      return { ...lease, owner: undefined };
    });
  }

  async bind({ workspace, parentThreadId, taskNonce, childThreadId }) {
    const owner = hashThread(parentId(parentThreadId));
    const task = nonce(taskNonce);
    const child = childId(childThreadId);
    const paths = await this._paths(workspace);
    return withFileLock(paths.guard, async () => {
      const existing = await readJson(paths.lease);
      if (!existing || existing.owner !== owner || existing.task_nonce !== task) {
        throw new Error("The workspace reservation changed before the native child was bound; refusing to continue");
      }
      existing.child_thread_id = child;
      existing.state = "active";
      existing.updated_at = new Date().toISOString();
      await writeJsonAtomic(paths.lease, existing);
      return { ...existing, owner: undefined };
    });
  }

  async release({ workspace, parentThreadId, taskNonce }) {
    const owner = hashThread(parentId(parentThreadId));
    const task = nonce(taskNonce);
    const paths = await this._paths(workspace);
    return withFileLock(paths.guard, async () => {
      const existing = await readJson(paths.lease);
      if (!existing || existing.owner !== owner || existing.task_nonce !== task) return false;
      await unlink(paths.lease).catch((error) => { if (error.code !== "ENOENT") throw error; });
      return true;
    });
  }

  async get(workspace) {
    const paths = await this._paths(workspace);
    const value = await readJson(paths.lease);
    return value ? { ...value, owner: undefined } : null;
  }
}

function trustedParent() {
  const value = process.env.CODEX_THREAD_ID?.trim();
  if (!value) throw new Error("CODEX_THREAD_ID is required; ownership must come from the trusted Codex environment, not an arbitrary --parent argument");
  return value;
}

async function main(argv) {
  if (argv.includes("--parent")) {
    throw new Error("--parent is not accepted; ownership comes only from the trusted CODEX_THREAD_ID environment");
  }
  const command = argv[0];
  const get = (name) => {
    const at = argv.indexOf(`--${name}`);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  const stateDir = get("state-dir");
  const workspace = get("workspace");
  const taskNonce = get("task-nonce");
  const parent = trustedParent();
  if (command === "reserve") {
    const lease = await new NativeWriterLease({ stateDir }).reserve({ workspace, parentThreadId: parent, taskNonce: taskNonce || randomUUID() });
    process.stdout.write(`${JSON.stringify({ parent, writer: lease })}\n`);
    return;
  }
  if (command === "bind") {
    const child = get("child");
    const bindingValues = {
      executor: get("executor"),
      profileId: get("profile-id"),
      role: get("role"),
      providerId: get("provider-id"),
      model: get("model"),
    };
    const hasBinding = ["executor", "profile-id", "role", "provider-id"].some((name) => bindingValues[name] !== undefined);
    const writer = await new NativeWriterLease({ stateDir }).bind({ workspace, parentThreadId: parent, taskNonce, childThreadId: child });
    const task = await new NativeTasks({ stateDir }).begin({
      parentThreadId: parent,
      childThreadId: child,
      model: get("model"),
      workspace,
      taskNonce,
      binding: hasBinding ? bindingValues : null,
    });
    process.stdout.write(`${JSON.stringify({ task, writer })}\n`);
    return;
  }
  if (command === "finish") {
    const child = get("child");
    const task = await new NativeTasks({ stateDir }).finish({ parentThreadId: parent, childThreadId: child, status: get("status") || "completed" });
    const released = await new NativeWriterLease({ stateDir }).release({ workspace, parentThreadId: parent, taskNonce });
    process.stdout.write(`${JSON.stringify({ task, released })}\n`);
    return;
  }
  if (command === "who") {
    const owned = await new NativeTasks({ stateDir }).owned(parent);
    process.stdout.write(`${JSON.stringify({ owned })}\n`);
    return;
  }
  if (command === "binding") {
    const child = get("child");
    const binding = await new NativeTasks({ stateDir }).binding({ parentThreadId: parent, childThreadId: child });
    process.stdout.write(`${JSON.stringify({ binding })}\n`);
    return;
  }
  throw new Error("usage: native-state.mjs <reserve|bind|finish|who|binding> --workspace PATH [--task-nonce ID] [--child ID] [--model MODEL] [--executor NAME --profile-id ID --role ROLE --provider-id ID] [--state-dir PATH]");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
