# Formal gateway fault acceptance — partial

This record separates three evidence scopes. It does not claim that the full native gateway goal, desktop acceptance, or the complete fault matrix passed. The installed plugin client for the formal Task checks was 0.10.3; 0.10.4 is only the current source candidate and is not installed.

## Formal Task recovery check

The first Task check returned `readiness_recovered`. Its recovery and stability checks passed: the old gateway process exited, readiness recovered on the same owned Task with a new process, and the Task returned to its expected healthy state. The recorded `LastTaskResult` value `267009` describes the final Running state; it is not a crash exit code. Private safe receipt SHA-256: `c6b82b8ebba6a2aee0b81643810fcd116716442a82463dfb6e1afb5fff7ec251`.

The separate crash-restart check did not observe the expected Task restart. It ended `failed_closed` with `TASK_RESTART_NOT_OBSERVED` after 112,891 ms of observation; this is shorter than the harness's overall 125-second budget because time was reserved for its final RPC. Final readiness recovery and stability checks passed, but automatic restart acceptance did not. The driver set `process.exitCode` to 2; the exec adapter reported outer exit 1. No inner operating-system exit code was recorded. Task event logging was disabled with zero records, so there is no per-round state or exit-code evidence. The parent matched the exact Task WSH. No cause is inferred. Private safe receipt SHA-256: `d3266118295ade8b46f63a406e78a008bbc714bd3090d239268728c7979a3f31`.

A separate port-conflict check returned `port_conflict_rejected_and_recovered`; all 18 recorded checks passed, including strict readiness recovery, with the root config, managed environment, Task specification, and gateway identity unchanged. It made zero model API and relay calls. This confirms the explicit readiness path recovered the owned Task after that fault, but does not change the failed automatic-restart result above. Private safe receipt SHA-256: `1521b3c9fb30f58d65263c298ce6068b6fbd859ff16c2f38dd6e3d955f98ecf0`.

## Local TCP transport checks

The new [transport fault test](../tests/native-transport-faults.test.mjs) passed 26 assertions using the production gateway in a hidden, independent Node child with its default `fetch` and a dummy auth resolver. A private empty DSH home isolated the child. The test exercised only loopback TCP: a closed-port refusal returned 502; a listener that accepted and then closed the socket returned 502; and an accepted request whose server withheld response headers returned 504 and caused the socket to close. The same gateway then returned a dummy 200 response after each fault.

The measured counts were six gateway requests, five upstream HTTP requests, six accepted upstream TCP connections, and zero relay calls. The success mode accepted four TCP connections but processed three successful HTTP requests; this does not establish an extra model request. The gateway log did not expose a usable transport error code, so the reset evidence is the test server's observed accept and socket close, not an asserted `ECONNRESET` code. No official model API was called.

This is not evidence of public Internet disconnection, upstream transport behavior from the formal Scheduled Task, or desktop/UI acceptance. The test and fixture SHA-256 values are `e238ea7aad29a679467be9de1da8cd3600e185f10de03d9f28db992f5d12f97e` and `2306a25805fc2a626cf0158edb9c7934980ae9865b5accb90f9bdb57a805a660` respectively.

At the recorded process snapshot, no process matched the intended runtime binary; two other readable Codex processes matched a different binary, and neither was attributed to the desktop session. Runtime observation therefore remains unconfirmed.

The prior [stable gateway source acceptance](native-stable-gateway-acceptance-2026-10-18.md) and [upstream 401 record](native-real401-acceptance-2026-10-18.md) cover different scopes and do not change these results. Formal automatic Task restart acceptance, runtime observation, desktop acceptance, hook delivery, and full fault recovery remain pending. The local TCP checks are not a public Internet, formal Task upstream, or desktop/UI test. This record makes no claim of zero overall Codex usage.
