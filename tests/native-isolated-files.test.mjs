import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NATIVE_RUNTIME_PATCH_SHA256, NATIVE_RUNTIME_SOURCE_COMMIT, NATIVE_RUNTIME_TARGET, NATIVE_RUNTIME_VERSION } from "../scripts/native-runtime.mjs";
import { apply, plan, rollback } from "../scripts/native-isolated-files.mjs";
import { removeIsolatedConfig } from "../scripts/native-isolated-config.mjs";

let checks = 0;
const equal = (actual, expected, message) => { assert.equal(actual, expected, message); checks += 1; };
const ok = (value, message) => { assert.ok(value, message); checks += 1; };
const rejects = async (fn, pattern, message) => { await assert.rejects(fn, pattern, message); checks += 1; };
const sha = (value) => createHash("sha256").update(value).digest("hex");

async function unlinkOwnedJunction(junctionPath, ownedRoot) {
  const rootPath = path.resolve(ownedRoot);
  const linkPath = path.resolve(junctionPath);
  const relativePath = path.relative(rootPath, linkPath);
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error("refusing to unlink a junction outside the test-owned root");
  }

  let linkStat;
  try {
    linkStat = await lstat(linkPath);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  if (!linkStat.isSymbolicLink()) {
    throw new Error("refusing to unlink a test path that is not a symbolic link");
  }
  await unlink(linkPath);
  return true;
}

const root = await mkdtemp(path.join(os.tmpdir(), "native-isolated-files-test-"));
let ownedJunctionPath;
let ownedJunctionTarget;
try {
  const codexHome = path.join(root, "codex-home");
  const versionDir = path.join(root, "runtime", "versions", "approved");
  await mkdir(path.join(codexHome, "agents"), { recursive: true });
  await mkdir(versionDir, { recursive: true });
  const runtimeFiles = {
    "codex.exe": Buffer.from("verified staged binary"),
    "provenance.json": Buffer.from(JSON.stringify({ source_commit: NATIVE_RUNTIME_SOURCE_COMMIT, patch_sha256: NATIVE_RUNTIME_PATCH_SHA256, target: NATIVE_RUNTIME_TARGET }) + "\n"),
    "codex-code-mode-host.exe": Buffer.from("helper"),
    "codex-command-runner.exe": Buffer.from("helper"),
    "codex-windows-sandbox-setup.exe": Buffer.from("helper"),
  };
  for (const [name, bytes] of Object.entries(runtimeFiles)) await writeFile(path.join(versionDir, name), bytes);
  const runtimeManifest = {
    version: NATIVE_RUNTIME_VERSION,
    source_commit: NATIVE_RUNTIME_SOURCE_COMMIT,
    patch_sha256: NATIVE_RUNTIME_PATCH_SHA256,
    target: NATIVE_RUNTIME_TARGET,
    stock_cli_version: NATIVE_RUNTIME_VERSION,
    binary_sha256: sha(runtimeFiles["codex.exe"]),
    files: Object.fromEntries(Object.entries(runtimeFiles).map(([name, bytes]) => [name, sha(bytes)])),
  };
  await writeFile(path.join(versionDir, "runtime-manifest.json"), `${JSON.stringify(runtimeManifest, null, 2)}\n`);

  const oldConfig = [
    'model = "gpt-6-sol"',
    "",
    "# sol-luna-native-gateway begin",
    'openai_base_url = "http://127.0.0.1:43127/v1"',
    'model_catalog_json = "legacy-global-catalog"',
    "# sol-luna-native-gateway end",
    "",
    "[features]",
    "multi_agent = true",
    "user_flag = 7",
    "",
  ].join("\n");
  const cache = { models: [
    { slug: "gpt-6-sol", visibility: "list", context_window: 123456, experimental_supported_tools: ["keep-template-shape"] },
    { slug: "gpt-6-luna", visibility: "list", context_window: 234567 },
  ] };
  const cacheBytes = Buffer.from(`${JSON.stringify(cache, null, 2)}\n`);
  await writeFile(path.join(codexHome, "config.toml"), oldConfig);
  await writeFile(path.join(codexHome, "models_cache.json"), cacheBytes);
  await writeFile(path.join(codexHome, "other-user-file.txt"), "retain me\n");
  const legacyManifest = { prior_root: { openai_base_url: "https://api.openai.com/v1", model_catalog_json: "user-root-catalog" } };
  const baseUrl = "http://127.0.0.1:43127/v1";
  const firstPlan = await plan({ codexHome, baseUrl, versionDir, legacyManifest });
  equal(Object.keys(firstPlan.files).sort().join(","), "agents/native_deepseek.toml,config.toml,sol-luna-native-models.json", "plan owns exactly the three intended files");
  equal(firstPlan.files["agents/native_deepseek.toml"].prior.exists, false, "plan captures a missing role file");
  equal((await readFile(path.join(codexHome, "config.toml"), "utf8")), oldConfig, "plan leaves old config bytes untouched");
  equal((await readFile(path.join(codexHome, "models_cache.json"))).equals(cacheBytes), true, "plan leaves models cache untouched");
  ok(firstPlan.files["config.toml"].next.includes('model = "gpt-6-sol"'), "migration preserves user root model");
  ok(firstPlan.files["config.toml"].next.includes('openai_base_url = "https://api.openai.com/v1"'), "migration restores the prior root OpenAI URL");
  ok(firstPlan.files["config.toml"].next.includes('model_catalog_json = "user-root-catalog"'), "migration restores the prior root catalog value");
  equal(firstPlan.files["config.toml"].next.includes("legacy-global-catalog"), false, "migration removes the old shared gateway block");
  const expectedUninstallConfig = removeIsolatedConfig(firstPlan.files["config.toml"].next);
  equal(firstPlan.files["config.toml"].uninstallPrior?.bytes?.toString("utf8"), expectedUninstallConfig, "verified legacy migration records a clean uninstall config separately from exact activation prior");
  const plannedChildCatalog = JSON.parse(firstPlan.files["sol-luna-native-models.json"].next);
  equal(plannedChildCatalog.models.length, 1, "child catalog has exactly one model");
  equal(plannedChildCatalog.models[0].slug, "deepseek/deepseek-flash", "child catalog contains only DeepSeek");
  equal(firstPlan.files["agents/native_deepseek.toml"].next.includes('model = "deepseek/deepseek-flash"'), true, "role config selects the fixed DeepSeek slug");
  equal(firstPlan.files["agents/native_deepseek.toml"].next.includes("model_provider"), false, "child provider remains assigned by the patched role helper");

  const snapshotBeforeApply = Object.fromEntries(await Promise.all(Object.entries(firstPlan.files).map(async ([name, item]) => [name, await readFile(item.path).catch(() => null)])));
  const applied = await apply(firstPlan);
  equal(await readFile(path.join(codexHome, "config.toml"), "utf8"), firstPlan.files["config.toml"].next, "apply writes migrated isolated config");
  equal(JSON.parse(await readFile(path.join(codexHome, "sol-luna-native-models.json"), "utf8")).models.length, 1, "apply writes isolated child catalog");
  equal(await readFile(path.join(codexHome, "other-user-file.txt"), "utf8"), "retain me\n", "unowned files remain untouched");
  await rejects(() => apply(firstPlan), /file changed since plan/i, "reapplying a stale plan is rejected");
  await rollback(applied);
  equal(await readFile(path.join(codexHome, "config.toml"), "utf8"), oldConfig, "first-install rollback restores the original config exactly");
  equal(await readFile(path.join(codexHome, "agents/native_deepseek.toml")).catch(() => null), null, "first-install rollback removes the initially absent role");
  equal(await readFile(path.join(codexHome, "sol-luna-native-models.json")).catch(() => null), null, "first-install rollback removes the initially absent catalog");
  const installed = await apply(await plan({ codexHome, baseUrl, versionDir, legacyManifest }));
  const freshPlan = await plan({ codexHome, baseUrl, versionDir });
  const repeated = await apply(freshPlan);
  equal(await readFile(path.join(codexHome, "config.toml"), "utf8"), firstPlan.files["config.toml"].next, "fresh repeated apply is idempotent");
  await rollback(repeated);
  equal(await readFile(path.join(codexHome, "config.toml"), "utf8"), firstPlan.files["config.toml"].next, "rollback restores the pre-repeat config bytes");
  await rollback(installed);
  equal(await readFile(path.join(codexHome, "config.toml"), "utf8"), oldConfig, "first-install rollback restores the original config exactly");
  equal(await readFile(path.join(codexHome, "agents/native_deepseek.toml")).catch(() => null), null, "first-install rollback removes the initially absent role");
  equal(await readFile(path.join(codexHome, "sol-luna-native-models.json")).catch(() => null), null, "first-install rollback removes the initially absent catalog");
  equal(snapshotBeforeApply["config.toml"].toString("utf8"), oldConfig, "plan snapshots original config bytes");

  const migratedUninstallHome = path.join(root, "migrated-uninstall-home");
  await mkdir(path.join(migratedUninstallHome, "agents"), { recursive: true });
  await writeFile(path.join(migratedUninstallHome, "config.toml"), oldConfig);
  await writeFile(path.join(migratedUninstallHome, "models_cache.json"), cacheBytes);
  const migratedPlan = await plan({ codexHome: migratedUninstallHome, baseUrl, versionDir, legacyManifest });
  const migratedApplied = await apply(migratedPlan);
  await rollback(migratedApplied, { target: "uninstall" });
  const cleanedMigratedConfig = await readFile(path.join(migratedUninstallHome, "config.toml"), "utf8");
  equal(cleanedMigratedConfig.includes("sol-luna-native-gateway begin"), false, "active uninstall does not restore the retired shared gateway block");
  equal(cleanedMigratedConfig.includes('openai_base_url = "https://api.openai.com/v1"'), true, "active uninstall restores manifest prior root URL");
  equal(cleanedMigratedConfig.includes("sol-luna-native-isolated begin"), false, "active uninstall removes isolated provider config");

  await writeFile(path.join(migratedUninstallHome, "config.toml"), oldConfig);
  const oldFormatBasePlan = await plan({ codexHome: migratedUninstallHome, baseUrl, versionDir, legacyManifest });
  await apply(oldFormatBasePlan);
  const oldStandalonePlan = { ...oldFormatBasePlan, files: { ...oldFormatBasePlan.files } };
  delete oldStandalonePlan.legacyMigration;
  oldStandalonePlan.files["config.toml"] = { ...oldStandalonePlan.files["config.toml"] };
  delete oldStandalonePlan.files["config.toml"].uninstallPrior;
  await rejects(() => rollback(oldStandalonePlan, { target: "uninstall" }), /legacy migration uninstall target is missing/i,
    "standalone old-format file plan detects the legacy block and refuses to restore it");
  equal(await readFile(path.join(migratedUninstallHome, "config.toml"), "utf8"), oldFormatBasePlan.files["config.toml"].next,
    "standalone old-format refusal leaves the active config untouched");
  await rollback(oldFormatBasePlan);

  const localhostPriorHome = path.join(root, "localhost-prior-home");
  await mkdir(path.join(localhostPriorHome, "agents"), { recursive: true });
  await writeFile(path.join(localhostPriorHome, "config.toml"), oldConfig);
  await writeFile(path.join(localhostPriorHome, "models_cache.json"), cacheBytes);
  const userLocalhost = "http://127.0.0.1:59999/user-owned/v1";
  const localhostPlan = await plan({ codexHome: localhostPriorHome, baseUrl, versionDir, legacyManifest: { prior_root: { openai_base_url: userLocalhost, model_catalog_json: null } } });
  ok(localhostPlan.files["config.toml"].uninstallPrior.bytes.toString("utf8").includes(userLocalhost), "uninstall preserves a user localhost URL recorded in prior_root");

  const uninstallFailureHome = path.join(root, "uninstall-failure-home");
  await mkdir(path.join(uninstallFailureHome, "agents"), { recursive: true });
  await writeFile(path.join(uninstallFailureHome, "config.toml"), oldConfig);
  await writeFile(path.join(uninstallFailureHome, "models_cache.json"), cacheBytes);
  const uninstallFailurePlan = await plan({ codexHome: uninstallFailureHome, baseUrl, versionDir, legacyManifest });
  await apply(uninstallFailurePlan);
  let uninstallWrites = 0;
  await rejects(() => rollback(uninstallFailurePlan, { target: "uninstall", async writeFileAtomic(file, bytes) {
    uninstallWrites += 1;
    const { writeFile, rename } = await import("node:fs/promises");
    const temp = `${file}.uninstall-${uninstallWrites}`;
    await writeFile(temp, bytes, { flag: "wx" });
    await rename(temp, file);
    if (uninstallWrites === 1) throw new Error("uninstall config mutation failure");
  } }), /uninstall config mutation failure/i, "uninstall reports a write-after-change failure");
  equal(await readFile(path.join(uninstallFailureHome, "config.toml"), "utf8"), uninstallFailurePlan.files["config.toml"].next, "failed uninstall write-after-throw reapplies the active config");

  const failureHome = path.join(root, "failure-home");
  await mkdir(path.join(failureHome, "agents"), { recursive: true });
  await writeFile(path.join(failureHome, "config.toml"), oldConfig);
  await writeFile(path.join(failureHome, "models_cache.json"), cacheBytes);
  const failurePlan = await plan({ codexHome: failureHome, baseUrl, versionDir, legacyManifest });
  let writes = 0;
  await rejects(() => apply(failurePlan, {
    async writeFileAtomic(file, bytes) {
      writes += 1;
      const { writeFile, rename } = await import("node:fs/promises");
      const temp = `${file}.injected-${writes}`;
      await writeFile(temp, bytes, { flag: "wx" });
      await rename(temp, file);
      if (writes === 2) throw new Error("injected post-write failure");
    },
  }), /injected post-write failure/i, "partially written files are restored after failure");
  equal(await readFile(path.join(failureHome, "config.toml"), "utf8"), oldConfig, "partial failure restores the first file");
  equal(await readFile(path.join(failureHome, "agents/native_deepseek.toml")).catch(() => null), null, "partial failure removes a file that was initially absent");
  equal(await readFile(path.join(failureHome, "sol-luna-native-models.json")).catch(() => null), null, "failure does not leave later files behind");

  const unownedHome = path.join(root, "unowned-home");
  await mkdir(path.join(unownedHome, "agents"), { recursive: true });
  await writeFile(path.join(unownedHome, "config.toml"), 'model = "gpt-6-sol"\n');
  await writeFile(path.join(unownedHome, "models_cache.json"), cacheBytes);
  const userRoleBytes = Buffer.from([0xff, 0x00, 0x75, 0x73, 0x65, 0x72]);
  await writeFile(path.join(unownedHome, "agents/native_deepseek.toml"), userRoleBytes);
  await rejects(() => plan({ codexHome: unownedHome, baseUrl, versionDir }), /unowned agents\/native_deepseek\.toml/i, "unowned role file is refused");
  await rm(path.join(unownedHome, "agents/native_deepseek.toml"));
  const userCatalogBytes = Buffer.from([0xff, 0x00, 0x63, 0x61, 0x74]);
  await writeFile(path.join(unownedHome, "sol-luna-native-models.json"), userCatalogBytes);
  await rejects(() => plan({ codexHome: unownedHome, baseUrl, versionDir }), /unowned sol-luna-native-models\.json/i, "unowned child catalog is refused");

  const ownedHome = path.join(root, "owned-home");
  await mkdir(path.join(ownedHome, "agents"), { recursive: true });
  await writeFile(path.join(ownedHome, "config.toml"), 'model = "gpt-6-sol"\n');
  await writeFile(path.join(ownedHome, "models_cache.json"), cacheBytes);
  const ownedRoleBytes = Buffer.from([0xff, 0x00, 0x72, 0x6f, 0x6c, 0x65]);
  const ownedCatalogBytes = Buffer.from([0xff, 0x00, 0x63, 0x61, 0x74, 0x61, 0x6c, 0x6f, 0x67]);
  const ownedRolePath = path.join(ownedHome, "agents/native_deepseek.toml");
  const ownedCatalogPath = path.join(ownedHome, "sol-luna-native-models.json");
  await writeFile(ownedRolePath, ownedRoleBytes);
  await writeFile(ownedCatalogPath, ownedCatalogBytes);
  const ownedManifest = { agent: ownedRolePath, catalog: ownedCatalogPath };
  const ownedPlan = await plan({ codexHome: ownedHome, baseUrl, versionDir, legacyManifest: ownedManifest });
  const ownedApplied = await apply(ownedPlan);
  await rollback(ownedApplied);
  equal((await readFile(ownedRolePath)).equals(ownedRoleBytes), true, "rollback restores original non-UTF8 role bytes exactly");
  equal((await readFile(ownedCatalogPath)).equals(ownedCatalogBytes), true, "rollback restores original non-UTF8 catalog bytes exactly");

  const rollbackFailureHome = path.join(root, "rollback-failure-home");
  await mkdir(path.join(rollbackFailureHome, "agents"), { recursive: true });
  await writeFile(path.join(rollbackFailureHome, "config.toml"), 'model = "gpt-6-sol"\n');
  await writeFile(path.join(rollbackFailureHome, "models_cache.json"), cacheBytes);
  const rollbackRolePath = path.join(rollbackFailureHome, "agents/native_deepseek.toml");
  const rollbackCatalogPath = path.join(rollbackFailureHome, "sol-luna-native-models.json");
  await writeFile(rollbackRolePath, Buffer.from("old role"));
  await writeFile(rollbackCatalogPath, Buffer.from("old catalog"));
  const rollbackPlan = await plan({ codexHome: rollbackFailureHome, baseUrl, versionDir, legacyManifest: { agent: rollbackRolePath, catalog: rollbackCatalogPath } });
  const rollbackApplied = await apply(rollbackPlan);
  let rollbackWriteCount = 0;
  await rejects(() => rollback(rollbackApplied, {
    async writeFileAtomic(file, bytes) {
      rollbackWriteCount += 1;
      const { writeFile, rename } = await import("node:fs/promises");
      const temp = `${file}.rollback-${rollbackWriteCount}`;
      await writeFile(temp, bytes, { flag: "wx" });
      await rename(temp, file);
      if (rollbackWriteCount === 2) throw new Error("rollback role mutation failure");
      if (rollbackWriteCount === 3) throw new Error("rollback recovery role failure");
    },
  }), (error) => {
    const details = [error.message, ...(error.errors ?? []).map((item) => item.message)].join(" | ");
    return /rollback role mutation failure/i.test(details) && /rollback recovery role failure/i.test(details);
  }, "rollback reports mutation and recovery failures while continuing recovery");
  equal((await readFile(rollbackCatalogPath, "utf8")), rollbackPlan.files["sol-luna-native-models.json"].next, "rollback continues to restore later keys after role recovery fails");

  const symlinkHome = path.join(root, "symlink-home");
  const symlinkTarget = path.join(root, "symlink-target-agents");
  await mkdir(symlinkHome);
  await mkdir(symlinkTarget);
  await writeFile(path.join(symlinkTarget, "sentinel.txt"), "junction target sentinel\n");
  const junctionPath = path.join(symlinkHome, "agents");
  await symlink(symlinkTarget, junctionPath, "junction");
  ownedJunctionPath = junctionPath;
  ownedJunctionTarget = symlinkTarget;
  await rejects(() => plan({ codexHome: symlinkHome, baseUrl, versionDir }), /agents directory must be a real directory/i, "agents junction is refused");

  const userEditPlan = await plan({ codexHome, baseUrl, versionDir, legacyManifest });
  const userEditApplied = await apply(userEditPlan);
  await writeFile(path.join(codexHome, "agents/native_deepseek.toml"), "user edit\n");
  await rejects(() => rollback(userEditApplied), /file changed since apply/i, "rollback refuses if any managed file changed later");
  equal(await readFile(path.join(codexHome, "agents/native_deepseek.toml"), "utf8"), "user edit\n", "rollback preserves user edit");
  equal(await readFile(path.join(codexHome, "other-user-file.txt"), "utf8"), "retain me\n", "rollback preserves unowned file");

  await rejects(() => plan({ codexHome, baseUrl, versionDir: path.join(root, "missing-runtime") }), /runtime version directory is missing/i, "plan rejects missing unverified runtime");

  const vanishHome = path.join(root, "vanish-home");
  await mkdir(path.join(vanishHome, "agents"), { recursive: true });
  await writeFile(path.join(vanishHome, "config.toml"), oldConfig);
  await writeFile(path.join(vanishHome, "models_cache.json"), cacheBytes);
  const vanishApplied = await apply(await plan({ codexHome: vanishHome, baseUrl, versionDir, legacyManifest }));
  await rm(path.join(root, "runtime"), { recursive: true });
  await rollback(vanishApplied);
  equal(await readFile(path.join(vanishHome, "config.toml"), "utf8"), oldConfig, "rollback succeeds after staged runtime is deleted");
} finally {
  if (ownedJunctionPath) {
    const removed = await unlinkOwnedJunction(ownedJunctionPath, root);
    equal(removed, true, "cleanup unlinks the test-owned agents junction explicitly");
    equal(await readFile(path.join(ownedJunctionTarget, "sentinel.txt"), "utf8"), "junction target sentinel\n", "unlinking the junction leaves its target contents intact");
    await rejects(() => lstat(ownedJunctionPath), { code: "ENOENT" }, "the owned junction is absent before recursive root cleanup");
  }
  const resolvedRoot = path.resolve(root);
  const resolvedTempRoot = path.resolve(os.tmpdir());
  if (path.dirname(resolvedRoot).toLowerCase() !== resolvedTempRoot.toLowerCase()
    || !path.basename(resolvedRoot).startsWith("native-isolated-files-test-")) {
    throw new Error("refusing to recursively remove a path that is not this test's mkdtemp root");
  }
  await rm(root, { recursive: true, force: true });
}

await rejects(() => lstat(root), { code: "ENOENT" }, "the test-owned temporary root is removed after junction unlink");

console.log(`PASS ${checks} isolated file transaction assertions`);
