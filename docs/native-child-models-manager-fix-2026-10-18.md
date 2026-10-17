# Native child ModelsManager patch integration

The reviewed `thread_manager` child-catalog fix is appended exactly once to
`patches/native-isolated-cli.patch`. The combined patch keeps the existing
wire-alias and native child-config changes and adds:

- per-session selection of a child `ModelsManager` for the `native_deepseek`
  role, while root, Sol, and Luna sessions keep the shared root manager;
- explicit `SessionStartupGuard` cleanup when selection fails before
  `Session::spawn`;
- a selector-level regression test covering the 1M child catalog,
  `auto_compact_token_limit = 1`, the 32K root catalog, unchanged root/Luna
  manager pointers, and missing provider/catalog errors.

## Pins

- Upstream source: `4ebc485ca321243727539187169425fcf972f2c4`.
- Upstream clean `thread_manager.rs` SHA-256:
  `6888f63946839c28d375e1514d1fe938db728aed6a7ffd694daf41b90aeed3fb`.
- Portable source change SHA-256:
  `2913f5d68452ec316e82e98a472a053b29e7d615332e7705ed1aea9230b6ef67`.
- Portable patch SHA-256:
  `05148f1b0129a3a3d346f675542b817f711a75b9ce19ea89df6c955ed00eff94`.
- Combined `native-isolated-cli.patch` SHA-256:
  `51c1a0bde0fdabd449216de6aef4e14403a39a0999057e289a939497f936eb75`.
- Patched `thread_manager.rs` SHA-256 after applying the combined patch:
  `2913f5d68452ec316e82e98a472a053b29e7d615332e7705ed1aea9230b6ef67`.

The previous combined patch SHA was
`e9919356c03641e64c36792028b8d3c19d6b1a2933ea6c782ff4e675af6229cd`; the
existing SSE, wire-alias, and child-config hunks are unchanged. Historical
build/run and binary hashes in the build note are not rewritten.

## Verification

- A clean extraction of the pinned upstream archive had no `thread_manager`
  hunk in the original patch, and `git -c core.autocrlf=false apply --check`
  passed for the original patch.
- The same combined patch passed
  `git -c core.autocrlf=false apply --check` and `git apply` on a second clean
  extraction. The resulting `codex-rs/core/src/thread_manager.rs` matched the
  portable source SHA above.
- The appended patch has one `thread_manager` diff header, no duplicate hunk,
  LF endings, and no BOM.
- A targeted Node check passed 21 assertions covering byte-for-byte append,
  current SHA pins, one `thread_manager` header, and the workflow filter.
  The SHA/version-sensitive Node suites passed with 56, 51, and 179
  assertions; the docs consistency test passed.
- `git diff --check` excluding the patch file is clean. The whole-worktree
  check reports the appended patch's standard blank context line (`" "`),
  which is diff syntax rather than source whitespace.
- The workflow filter `cargo test --locked -p codex-core native_deepseek --lib`
  includes the new module and test because both names contain
  `native_deepseek`.

## Later fixture evidence

A later free app-server probe using local mock providers verified the native
child's configured `deepseek-native` provider and
`deepseek/deepseek-flash` model, and completed a follow-up on that same child.
It did **not** trigger automatic local compaction: the sanitized receipt records
zero local-compaction requests. This is not a DeepSeek API call or desktop
acceptance, and it does not verify the current child-catalog metadata fix.
That fix still needs a Rust build and a rerun that observes the child model's
actual catalog metadata and compaction behavior.

The separate Windows junction fixture had previously failed three times with
`ENOTEMPTY` while recursively cleaning its temporary root. Its test-only cleanup
now verifies and unlinks the fixture-owned `agents` junction before removing
that root; the target sentinel remains intact. The junction rejection assertion
and production plan safety check are unchanged. The file test now passes 54
assertions (the original 50 plus four cleanup checks); the isolated installer
test passes 179 assertions and the docs consistency test passes. This fixture
change does not compile or test the Rust patch.

## Subsequent plaintext-wire integration

The protocol alias decoder was later updated to restore the canonical namespace
and bare function name for flattened wire calls. For the three collaboration
message aliases only, a missing `encrypted_function_args` field is represented
as an empty vector so the existing plaintext dispatch classification can
recognize it. Explicit encrypted arguments remain unchanged. The combined patch
now has SHA-256
`65add65b454f29e9c16726b27993f58176a99b0bd6bb73355fc72a32836774ae`.
The `51c1a0b...` value above remains the historical hash for the earlier
ModelsManager combination and is not a build or test result for this later
patch. The Rust tests for this protocol change have not yet run.

## Limits

Rust was not compiled or tested locally, so this is not proof that the change
builds or passes Cargo tests. The new test exercises the selector, not a full
`spawn_thread` or cold-resume Session. The first real compile and selector test
run must happen in the GitHub native build; real compaction thresholds and
cold-resume behavior still require runtime acceptance after that build.
