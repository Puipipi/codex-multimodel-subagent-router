# Native isolated CLI build

This workflow builds a custom Codex CLI from the pinned upstream source commit `4ebc485ca321243727539187169425fcf972f2c4`, with this repository's reviewed `patches/native-isolated-cli.patch` (SHA-256 `e9919356c03641e64c36792028b8d3c19d6b1a2933ea6c782ff4e675af6229cd`). The resulting executable contains custom backend changes and is **not the unmodified official Codex CLI**.

The manual Windows workflow completed successfully for run `39047673090` at this router-repository head: `23ffbe392728544d82e368af639b30b1308bbc76`. Artifact `native-isolated-codex-windows-msvc-39047673090` was downloaded and staged, and the staged binary's `--version` check passed. Its SHA-256 is `a672010e06eea66cece81ad91ac1487b290357a3abf084c0b5ab2d50fd289b25`. This establishes a successful build and staging check only. A separate end-to-end probe could not find the DeepSeek child and produced zero mock DeepSeek requests; isolated runtime/API behavior and desktop acceptance remain unverified. No production gateway or model API request was used for that probe.

The patched backend supports the isolated `native_deepseek` child role while leaving the parent and Luna provider selection unchanged. The repository includes `native-isolated-install.mjs` prepare/activate/rollback/status orchestration, with mocked installer and read-only app-server smoke tests. The source entrypoints exist; no real installation or desktop acceptance has been performed. Building this artifact does not install or activate it. See [the isolated installer guide](native-isolated-install.md) for the staged-runtime and explicit setup commands and their three separate states.

## Pins and build checks

- Source: `openai/codex` at `4ebc485ca321243727539187169425fcf972f2c4`.
- Runner: GitHub Actions `windows-latest`, using the Windows MSVC target `x86_64-pc-windows-msvc`.
- Rust: `1.95.0` via the upstream-pinned toolchain action; Cargo build parallelism is limited to two jobs. Debug symbols are disabled for dev/test/release profiles to limit runner disk usage.
- The workflow requires `patches/native-isolated-cli.patch` in this repository. It checks the patch with `git apply --check` and fails clearly if the file is absent; it never silently builds vanilla upstream.
- It checks out this repository under `router/` and pinned upstream at the workspace root because upstream's local Rusty-V8 setup action reads its scripts and trusted checksum manifest relative to `GITHUB_WORKSPACE`. It runs that action and the upstream MSVC environment action, and applies upstream's x64 SQLite build flag.
- Before building, Cargo metadata must contain the `codex-protocol`, `codex-core`, and `codex-cli` packages, with the `codex` binary target specifically in `codex-cli`. From `codex-rs/`, it runs the focused tests with `--locked` and builds `codex-cli`'s release binary with `--locked`.
- The pinned workspace manifests use release versions while the checked-in lockfile records local workspace packages as `0.0.0`. Before any `--locked` test or build, the workflow uses `cargo metadata --locked --no-deps` to update only source-less `Cargo.lock` package version fields for workspace members that are exactly `0.0.0`. It rejects unexpected versions or duplicate/missing local records; external registry/git dependency records, source URLs, checksums, and versions remain byte-for-byte unchanged. The normalized lock is hashed and its local-only diff is retained in the artifact and provenance.
- The artifact contains `codex.exe`, `provenance.json` with the source commit, patch SHA-256, original and normalized Cargo.lock SHA-256 values and local-version diff, a standalone `cargo-lock-normalization.json` audit, and upstream root `LICENSE`/`NOTICE` files only when those files exist in the checked-out source. The successful run's staged binary hash is recorded above for comparison with the artifact provenance.

## Run it

In GitHub, open **Actions → Native isolated CLI build → Run workflow** and start the manual run from the intended repository branch. The workflow has no push, pull-request, schedule, release, or installation trigger. Download the artifact only after the job succeeds, then review its provenance against the pinned commit and patch before using it. The workflow does not publish a GitHub Release or install/replace the desktop application.

The current repository checkout must include the actual reviewed patch before this workflow can pass. Do not create a placeholder patch or interpret the expected missing-patch failure as a successful build.
