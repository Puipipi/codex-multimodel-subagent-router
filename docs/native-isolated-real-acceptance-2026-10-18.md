# Native isolated real-API acceptance evidence

This record summarizes a real-API acceptance run of the staged patch 65 Windows
Codex CLI. The main conversation coordinated a native DeepSeek child, which
created a file and then completed a follow-up after a private app-server cold
restart using the same child thread. The main and child outputs were checked
against the actual rollout records. The raw receipts were independently
reviewed by the main controller; this document is its redacted projection.

## Result

The acceptance status was `passed`: all 14 top-level checks passed. The parent
and child completed, each genuine rollout session ID matched its thread, and
each rollout contained a permission profile. Both recorded profile enums were
`disabled`. The effective test configuration was full filesystem access with
approval policy `never`; these are separate observations and should not be
collapsed into one permission value. The child context count was 3.

The first two proof lines and a third-line same-child follow-up completed.
After the old private app-server was closed and a new process started, the
same parent and child threads were resumed to read their existing history
without starting a model turn. The subsequent fourth-line follow-up started a
new model turn and matched exactly.
The final proof was 186 bytes, four LF-terminated lines, UTF-8 without a BOM,
with SHA-256 `3fdc4a7df8f92e10e8b1a58bc6d1f6b27bdabdfe860f2cc2aa53a3c068e763df`.
Cleanup completed successfully.

The run made six model attempts: six fetches started, all six returned HTTP
200, and all six usage records completed. Relay count was zero and there were
no budget events. The harness's independent request cap was twelve. The parent
coordination reported 255,063 tokens (253,781 input, 244,992 cached input, and
1,282 output). The DeepSeek provider reported 771,283 tokens (767,242 input
and 4,041 output), with no relay. These are run-level provider counters, not
the total cost of the development effort; they do not imply a Codex quota
percentage or that Sol used zero tokens.

The validator reported 74 checks: 70 true, two expected false (`parent_wrote_proof`
and `parent_spawn_model_override`), two numeric count checks, and no null
checks. This is not “74 checks all true.”

## Scope and limits

This was a staged65 CLI acceptance with real API traffic. It was not a formal
plugin/native installation, restoration of the Scheduled Task, desktop UI
acceptance, user-click history acceptance, or a real multi-chat concurrency
test. It does not establish those states. The build identity matches the
[published staged65 runtime record](native-plaintext-runtime-2026-10-18.md).

Earlier real-API attempts 1 through 5 remain failed historical results; this
record does not rewrite them. The harness now uses the validated full-access /
never test configuration, Windows namespace validation, and its explicit
12-request cap. The fifth failure used the prior eight-request cap. Its event
did not retain a specific cause, so no cause is assigned here. Earlier
harness/profile differences are not asserted as the cause of those failures.

The successful run used the patch 65 staged binary, not an installed desktop
runtime. Its harness SHA-256 was
`cf2bd374ec1290f6142f4d16caf40d69c9bb280590c2d7f4cafb7e1696e800c3`; the
focused test SHA-256 was
`b09a84d81a7c75fd8af15b59a3e2d1fe859b99545e6aa98aed557f29875b3367`, and the
rollout helper SHA-256 was
`689edc2618612037b4232c2e40d91912029839357be4bfe26373b040775881d8`. The 47
fixtures and syntax checks exited 0. The successful stdout receipt SHA-256 is
`39949879EC83E9DA4FE9BB8CCA268587D11577F39849A6D7F2BA9CC422F05E7F`.
Structured counts, status enums, and hashes are in the accompanying
[JSON evidence](native-isolated-real-acceptance-2026-10-18.json).
