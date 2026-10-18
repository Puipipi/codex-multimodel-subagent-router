# Native API MSIX path fix 0.11.1 (2026-10-19)

## Scope and behavior

On Windows, Node's native realpath implementation resolves the default
`%LOCALAPPDATA%\sol-luna-deepseek-router\native-api` alias into the exact
Codex MSIX package's `LocalCache\Local` tree. The default API-root resolver now
recognizes only that package layout and returns its canonical path when the
existing directory has no symlink or junction components. It uses
`realpathSync.native`, matching the downstream gateway source guard; ordinary
`realpathSync` on this host returned the nominal alias instead.

During install preparation, a nominal default `router.json` path is bound to
the canonical file only after native realpath, same-file device/inode, file
type, and settings revision SHA-256 checks succeed. The prepared journal and
Task launcher then retain the canonical settings path. Explicit custom API
roots and settings paths remain unchanged. The shared gateway source guard
continues to reject reparse traversal, and no settings file is copied or
migrated.

## Verification evidence

- `native-api-manager.test.mjs`: 9 assertions passed.
- `native-api-install.test.mjs`: 69 assertions passed, including canonical
  settings binding and rejection before identity, Task, journal, registry, or
  role writes for realpath, file-ID, and revision mismatches.
- `native-gateway-source.test.mjs`: 20 assertions passed, including rejection
  of a real junction.
- `git diff --check` passed.
- The shared `native-gateway-source.mjs` source hash remains
  `9462CF7D87C457E97D03A061EAAB37D6CBA780128DA9EABB8FB2404BCD6C6230`.
- The prior 0.11.0 formal Apply attempt stopped after creating only the owned
  gateway identity. It created no Task, registry, journal, or role. This
  record does not change that observed state or the 0.11.0 acceptance record.
- Formal Apply and desktop acceptance for 0.11.1 remain pending. Since the
  user selected Luna-only execution, no new paid model API was called for this
  fix.

The runtime is reused from run `39140584735`, head `51381b…`, artifact
`12144790530`, binary SHA-256
`48d1d326…`. The Rust patch SHA-256 remains
`2a5d6310c76b992ef772e62410c593204b570ff20f6e8a967f43deeac42bc3e7`. No new
runtime build was launched, and the original provenance record was not edited
to imply a new build or source commit.
