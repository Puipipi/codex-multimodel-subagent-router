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
- When this source-fix record was first written, formal Apply and desktop
  acceptance for 0.11.1 were pending. The subsequent installation evidence is
  recorded below.

The runtime is reused from run `39140584735`, head `51381b…`, artifact
`12144790530`, binary SHA-256
`48d1d326…`. The Rust patch SHA-256 remains
`2a5d6310c76b992ef772e62410c593204b570ff20f6e8a967f43deeac42bc3e7`. No new
runtime build was launched, and the original provenance record was not edited
to imply a new build or source commit.

## Formal installation observation

The 0.11.1 plugin installed from immutable source commit
`c9686e724966a41ce977c66e732539cf3e30afed`. All 163 release files matched the
candidate bytes, and the 95 owned standalone skill files were installed while
the four preexisting foreign files and their hashes were preserved. The
matching CI run `39153706565` completed successfully for that source commit.

The settings snapshot verified the nominal and canonical settings paths as the
same file by device/inode, and the fixed router revision is
`5f5287d6ef7ebdc021843d542a8e2d907c3d53e411cad4a37d18a4fd6dc08fd6`. The
first confirmed Apply response reported success and required an app restart.
The install journal reached `active` with its file, launcher, and Task stages
complete. Read-only checks observed one healthy hidden API Task in `Running`
state with `api_only=true` and `relay_allowed=false`; a separate Task XML
inspection found no triggers. The root model remained `gpt-6.1-sol`, with no
root model-provider override or root base URL. The only reported config changes
were the marketplace source and the owned API provider entry.

A follow-on status-collection helper accidentally invoked Apply a second time.
That invocation returned an already-exists error while writing its safe
response file, so its Apply response was not captured. Subsequent read-only
checks confirmed the same active profile and revision, a healthy gateway, and
one running API Task. This does not establish that the second Apply was
idempotent, and this record does not claim to preserve its response.

The local API gate generated spawn metadata but did not spawn a child or make a
model-interface call; `apiVerified` remains false. Full application restart,
desktop acceptance, and a real API child task remain pending. Paid model tests
are paused under the user's Luna-only instruction and were not run. The later
documentation commit does not change or reinstall the pinned 0.11.1 plugin
source.
