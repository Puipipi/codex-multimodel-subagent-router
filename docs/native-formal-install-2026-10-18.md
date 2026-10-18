# Native isolated install record

This host-specific record is based on the accepted prepare and activate safe receipts. It documents plugin source version `0.10.2` from source commit `ad72ed11f6be9c97bc58bb7fba360ad72f1b5029`.

The single `prepare` run exited successfully: all 9 smoke checks passed, temporary cleanup completed, and all 7 runtime hashes were verified. The formal configuration hash was unchanged across preparation. The single `activate`, `status`, and explicit native readiness checks also exited successfully. The exact owned scheduled task was `Running`; strict health reported `deepseek_only=true` and `relay_allowed=false`. All three managed environment values matched the plan, the prior managed Startup entry was retired, and the root model/provider/base URL/catalog fields remained unchanged (`gpt-6.1-sol`; provider, base URL, and catalog absent).

The status still reports `runtimeObserved=false`, `desktopAccepted=false`, and `restartNeeded=true`. Fully exit and restart Codex before expecting new chats to inherit the updated user environment. This record establishes the formal installation path on this host only. It does not establish desktop acceptance, a real child task failure path, multi-chat behavior, or notification delivery. No model API request was made as part of this installation. Earlier private file-followup, cold-start, and upstream-401 diagnostics are separate evidence and do not substitute for Task or desktop acceptance.

The later [stable gateway source acceptance](native-stable-gateway-acceptance-2026-10-18.md) supersedes this record only for the current gateway source path and the subsequent Task process switch. This document remains the evidence for the initial 0.10.2 prepare and activation.

| Safe receipt | SHA-256 |
| --- | --- |
| Prepare | `689e82e5f7455ced912ad77eca18bc2f46f93f6d9803119b148ccd0dd1253345` |
| Activate/status/readiness | `537c0e348f43ac5ca622c875cfd8346382a92cd43b4d925da5be604e2e36b61c` |
