# Stable native gateway source acceptance

This host-specific record combines three separate checks: a disposable Task-stop probe, the formal active-journal source binding, and the subsequent real source-switch restart. It is based on the accepted private safe receipts, not on copied journal or process data.

The disposable probe showed that accepting `Stop-ScheduledTask` does not prove the gateway Node process exited. The probe then used the exact owned gateway identity and graceful shutdown, observed that process exit, and cleaned up only its disposable Task. It did not stop or modify the formal Task.

The formal source binding used source commit `67f841cbd63c05a42c3c3b264b6f1a8a52948272`. It created the immutable five-script bundle `f3896c385f90239986020efe12a305467971cf53902c463a6c35af3d67bbf193` with manifest SHA-256 `9655c1e0ccdd3a12f434001d37b288bb5a4d3e87d1ca1e07a7d0f899f41bd946`. The installed 0.10.3 plugin source and bundle files matched byte for byte:

| Script | SHA-256 |
| --- | --- |
| `native-credentials.mjs` | `68b089912a8b0d7bd2eabf63514093f4c035cf6d1267e88a8b1b9298048b0519` |
| `native-gateway.mjs` | `664d1771c6ea0a949c2f93579a6b01c00ba7d9f9a9130af34335d667e65aa587` |
| `native-relay.mjs` | `80cc113bf0cc28f0543ba612f58ff365cd77ad71c731432ace59737155eef89a` |
| `native-routing.mjs` | `cef5726dae3e6f4b8aef8f6ee2815a70e2291edf35a9d3305957647148fb7a4f` |
| `native-usage.mjs` | `f44a5c57c4a987dda159fa2529373029d196c4aec6a6e077a690507878911b38` |

The source-binding operation changed only the launcher’s future gateway-script path and the active journal. It did not restart the already-running gateway. The subsequent source-switch check gracefully stopped that gateway, observed the old process creation exit, and started the same owned Task. CIM verified a different process creation and an exact command line using the stable bundle. The Task remained exact and `Running`, strict health remained `deepseek_only=true` and `relay_allowed=false`, and request/relay counters were zero before and after. The complete source-switch observation took 20,701 ms; that is the duration of the whole check, not a gateway startup-time measurement.

The configuration SHA-256 remained `9ddcdec8aeed1fbd6e956b8c2f61ac8801ea5788d68fe61d1c30711a1303171f`; the identity SHA-256 remained `46766f4e5d2f1fbddd16d01f3ad7d13a863ad51b8856aca1d6c1cbfedbee2387`. The active journal SHA-256 is `11abcd84d2f722dc95c5cb48dc8096eb30cce52dc54cc5f6c032cd2a4cde96a7`; the current launcher SHA-256 is `0760c6af52f0a0c32694634e544271442555fb4fd372ac0bd7c2c1d18e105c0b`. Root configuration still selects `gpt-6.1-sol`; root provider, base URL, and catalog remain absent. All three managed user environment values match the plan, while the already-running process inherits none of those three values. The existing CLI process remains alive, so a full Codex restart is still needed before expecting future chats to inherit the updated environment.

The installed plugin client is still version 0.10.3. The fixed Rust backend SHA-256 remains `b311c3c365d1a9a5c19a6040428e02d49b10d7bdd766a859f0b842d42c3e3963`; it was not rebuilt. No model API request or relay occurred during these checks.

This acceptance is limited to the formal Task’s stable gateway source and restart on this host. `runtimeObserved=false` and `desktopAccepted=false` remain the reported state. Hook delivery, multi-chat inheritance after a full app restart, desktop/UI acceptance, and the complete fault-recovery matrix remain pending. This record does not claim zero overall Codex usage.

Receipt hashes: disposable Task-stop probe `4c79d373034f4a24712d89e07dfbf1da83386246f6a4fba10a483d613ba63446`; formal source binding `29f090f3752a9db9cd414dd4fca40048d7f06c6f7196c416f716d9383199bb02`; formal source switch `e6dc364078e92c1fb9943300ed223ad3b175bac1901ce10b6e16e31c8b7a010a`.
