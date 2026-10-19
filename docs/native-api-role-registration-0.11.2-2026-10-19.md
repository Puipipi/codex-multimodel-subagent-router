# Native API role registration fix 0.11.2 (2026-10-19)

## Failure and correction

During the first real generic API dispatch attempt on the installed 0.11.1
plugin, native spawn returned `unknown agent_type`. No child was spawned and no
model API call was made. The install had generated the API role file and
provider/catalog data, but its root Codex configuration lacked the
`[agents.native_api_<profileId>]` registration and exact `config_file`. The
Node dispatch/status gate checked those artifacts without checking the root
agent registration, so it could report a false ready state.

The 0.11.2 source candidate writes the root agent registration alongside the
owned provider block and validates it in status and dispatch. An active legacy
provider-only installation remains not-ready; explicit Apply can repair its
owned registration after validating the active journal and artifacts. It
preserves unrelated roles, profiles, and the root model/provider settings.
Role-key conflict tests cover table, quoted, inline, and dotted-key forms. A
config-byte compare-and-swap check prevents the legacy repair from overwriting
a concurrent user edit.

## Evidence and limits

The focused artifact, install, and lifecycle tests cover generated role
registration, legacy Apply repair, readiness rejection, multi-profile rollback,
conflict detection, and concurrent root-config edits. A local app-server
`config/read` gate confirms the parsed response exposes the registered role and
its `config_file`; it makes no model request and does not establish host menu
discovery or successful spawn.

The installed 0.11.1 source remains pinned to `c9686e724966a41ce977c66e732539cf3e30afed`.
The existing runtime build `39140584735` and binary SHA-256
`48d1d326f2567cdc602c03337674d22da4d1933e36e84d5df229a93ff5ea174b` remain
unchanged; the native patch provenance SHA-256 remains
`2a5d6310c76b992ef772e62410c593204b570ff20f6e8a967f43deeac42bc3e7`.
No runtime was rebuilt or reinstalled for this source fix.

The formal installation of this 0.11.2 candidate, full restart, host role
discovery, and a real native API child spawn remain pending. The paid API role
was not spawned, and `apiVerified` remains false. The local credential check
reported by the user only established local credential availability; it sent
no API request and does not prove upstream authentication or a model response.
