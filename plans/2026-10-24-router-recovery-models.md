# Router recovery and model routing plan

## Accepted behavior

- Keep `mode` as auto/fixed/scheduled; add backward-compatible `enabled` defaulting to true. Off wins before schedule, sticky, explicit override, native catalog lookup, and DSH start/followup. Keep settings accessible and retain history.
- Support Luna, DSH DeepSeek, `same`, exact `native:<slug>`, and saved immutable API profiles. Same resolves the active chat model from trusted thread metadata and spawns a separate `fork_turns:none` child. API provider presets only prefill existing fields; manual model entry remains available.
- Native catalog and model metadata are local read-only inputs. API model discovery is explicit user action only, bounded, redirect-safe, credential-safe, and tested only on loopback mocks.

## Work sequence

1. **Model routing/UI**: settings schema, selectors, catalog snapshot, API presets/model list, MCP caller context, same-model metadata resolution, off priority. Add red/green tests first.
2. **Upgrade/lifecycle protection**: persistent guard status and owned task lifecycle; effective-off when user disabled or guard disabled; defer stopping until gateway-backed native/DSH children terminate. Stop only journal-verified plugin-owned gateway tasks. Native/Luna routes need no gateway. Do not interrupt active work.
3. **Reconnect diagnosis**: integrate the reviewed explicit UI/MCP action; no startup polling, provider calls, body/key/full-URL logging, or assumptions that the issue occurs on every startup.
4. **Task 4 integration**: connect caller-specific model metadata, the reviewed diagnostics action, owned gateway lifecycle, and a pre-spawn gateway dispatch reservation. Update plugin source metadata/version and focused CI tests. Do not install, change user environment/services, or restart Codex.
5. **Runtime gate (separate task)**: for API/DeepSeek, verify the running `codex.exe` ancestor hash against the approved compatibility receipt before dispatch. API Apply must explicitly arm an approved persistent bootstrap receipt. Missing artifact/provenance means hard refusal; it never silently substitutes Luna. Native Luna/same/catalog routes remain independent of the shim.
6. **Packaging (separate task)**: add the minimal reproducible Windows ZIP and SHA file list, proving that native/bootstrap binaries and all imported helpers are included. No archive is claimed until that task produces evidence.

## Upgrade override maintenance plan (not applied)

The router JSON `enabled` value is the sole user-off marker. Do not write or clear `upgrade-status.json` to represent user intent: that file belongs to the C upgrade guard, and its fault-disabled state must remain intact. When turning off, a legacy isolated-install journal may authorize compare-before-set removal of only its exact owned `CODEX_CLI_PATH`; preserve any changed/manual path and never restore an old WindowsApps path. Do not kill or hot-switch the running process; the next launch resolves the official app. The upcoming runtime-gate task must reject API/DeepSeek dispatch unless the actual running CLI image matches an approved receipt. Re-enabling native-only routing needs no shim; API remains unavailable until explicit Apply has an approved artifact/receipt.

## Verification boundary

Use temporary `CODEX_HOME`, `LOCALAPPDATA`, SQLite fixtures, Task Scheduler fakes, gateway fakes, and loopback HTTP. Prove caller-thread isolation, disabled precedence/no-spawn, journal/task ownership, active-child deferral, and exact API discovery behavior. No real DeepSeek/OpenAI requests, no system settings/service changes, and no installation in this task.
