import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function packageBlocks(lockText) {
  const starts = [...lockText.matchAll(/^\[\[package\]\]\r?$/gm)].map((match) => match.index);
  return starts.map((start, index) => ({
    start,
    end: starts[index + 1] ?? lockText.length,
    text: lockText.slice(start, starts[index + 1] ?? lockText.length),
  }));
}

function stringField(block, field) {
  const match = new RegExp(`^${field}\\s*=\\s*"([^"]*)"\\s*(?:#.*)?$`, "m").exec(block);
  return match?.[1] ?? null;
}

export function normalizeWorkspaceLock(metadata, lockText) {
  if (!Array.isArray(metadata.workspace_members) || !Array.isArray(metadata.packages)) {
    throw new Error("cargo metadata must contain workspace_members and packages arrays");
  }

  const memberIds = new Set(metadata.workspace_members);
  const members = metadata.packages.filter((pkg) => memberIds.has(pkg.id) && pkg.source == null);
  if (members.length !== memberIds.size) {
    throw new Error("cargo metadata did not resolve every workspace member to a local package");
  }
  const versionsByName = new Map();
  for (const pkg of members) {
    if (versionsByName.has(pkg.name) && versionsByName.get(pkg.name) !== pkg.version) {
      throw new Error(`workspace has multiple local versions of package ${pkg.name}`);
    }
    versionsByName.set(pkg.name, pkg.version);
  }

  const blocks = packageBlocks(lockText);
  const memberBlocks = new Map();
  for (const block of blocks) {
    if (stringField(block.text, "source") !== null) continue;
    const name = stringField(block.text, "name");
    if (versionsByName.has(name)) {
      if (memberBlocks.has(name)) throw new Error(`Cargo.lock has multiple source-less entries for workspace package ${name}`);
      memberBlocks.set(name, block);
    }
  }

  let normalized = lockText;
  const changes = [];
  const replacements = [];
  for (const [name, version] of versionsByName) {
    const block = memberBlocks.get(name);
    if (!block) throw new Error(`Cargo.lock has no source-less entry for workspace package ${name}`);
    const oldVersion = stringField(block.text, "version");
    if (oldVersion === version) continue;
    if (oldVersion !== "0.0.0") {
      throw new Error(`unexpected Cargo.lock version for local package ${name}: ${oldVersion}`);
    }
    const versionLine = /^(\s*version\s*=\s*)"0\.0\.0"(\s*(?:#.*)?\r?\n?)/m;
    if (!versionLine.test(block.text)) throw new Error(`cannot locate version field for workspace package ${name}`);
    const newBlock = block.text.replace(versionLine, `$1"${version}"$2`);
    replacements.push({ ...block, newBlock });
    changes.push({ name, from: oldVersion, to: version });
  }
  for (const block of replacements.sort((left, right) => right.start - left.start)) {
    normalized = normalized.slice(0, block.start) + block.newBlock + normalized.slice(block.end);
  }

  const diff = changes.length
    ? changes.map(({ name, from, to }) => `@@ [[package]] ${name} @@\n-version = "${from}"\n+version = "${to}"`).join("\n")
    : "(no local workspace package versions needed normalization)";
  return {
    text: normalized,
    report: {
      schema: 1,
      changed_packages: changes,
      original_lock_sha256: createHash("sha256").update(lockText, "utf8").digest("hex"),
      normalized_lock_sha256: createHash("sha256").update(normalized, "utf8").digest("hex"),
      lock_diff: diff,
    },
  };
}

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : null;
}

function main() {
  const metadataPath = argument("metadata");
  const lockPath = argument("lockfile");
  const reportPath = argument("report");
  if (!metadataPath || !lockPath || !reportPath) {
    throw new Error("usage: node normalize-cargo-workspace-lock.mjs --metadata PATH --lockfile PATH --report PATH");
  }
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  const original = readFileSync(lockPath, "utf8");
  const { text, report } = normalizeWorkspaceLock(metadata, original);
  if (text !== original) writeFileSync(lockPath, text, "utf8");
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ changed_packages: report.changed_packages.length, normalized_lock_sha256: report.normalized_lock_sha256 })}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === process.argv[1].toLowerCase()) {
  try { main(); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
