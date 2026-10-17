# Native isolated CLI build

This workflow builds a custom Codex CLI from the pinned upstream source commit `4ebc485ca321243727539187169425fcf972f2c4`, with this repository's reviewed `patches/native-isolated-cli.patch`. The resulting executable contains custom backend changes and is **not the unmodified official Codex CLI**. It is not compiled or accepted until the manual workflow completes successfully; a source diff or a green unrelated test suite is not build acceptance.

## Pins and build checks

- Source: `openai/codex` at `4ebc485ca321243727539187169425fcf972f2c4`.
- Runner: GitHub Actions `windows-latest`, using the Windows MSVC target `x86_64-pc-windows-msvc`.
- Rust: `1.95.0` via the upstream-pinned toolchain action; Cargo build parallelism is limited to two jobs. Debug symbols are disabled for dev/test/release profiles to limit runner disk usage.
- The workflow requires `patches/native-isolated-cli.patch` in this repository. It checks the patch with `git apply --check` and fails clearly if the file is absent; it never silently builds vanilla upstream.
- It checks out this repository under `router/` and pinned upstream at the workspace root because upstream's local Rusty-V8 setup action reads its scripts and trusted checksum manifest relative to `GITHUB_WORKSPACE`. It runs that action and the upstream MSVC environment action, and applies upstream's x64 SQLite build flag.
- Before building, Cargo metadata must contain the `codex-protocol`, `codex-core`, and `codex-cli` packages, with the `codex` binary target specifically in `codex-cli`. From `codex-rs/`, it runs the focused tests with `--locked` and builds `codex-cli`'s release binary with `--locked`.
- The artifact contains `codex.exe`, `provenance.json` with the source commit and patch SHA-256, and upstream root `LICENSE`/`NOTICE` files only when those files exist in the checked-out source.

## Run it

In GitHub, open **Actions → Native isolated CLI build → Run workflow** and start the manual run from the intended repository branch. The workflow has no push, pull-request, schedule, release, or installation trigger. Download the artifact only after the job succeeds, then review its provenance against the pinned commit and patch before using it. The workflow does not publish a GitHub Release or install/replace the desktop application.

The current repository checkout must include the actual reviewed patch before this workflow can pass. Do not create a placeholder patch or interpret the expected missing-patch failure as a successful build.
