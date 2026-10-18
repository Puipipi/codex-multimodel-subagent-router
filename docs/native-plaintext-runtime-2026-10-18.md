# Native plaintext candidate runtime evidence

This note records the runtime evidence for the patch 65 candidate. The older
patch 51/binary beab encrypted-input RED remains a separate pre-fix result in
[the wire-fix evidence](native-plaintext-wire-fix-2026-10-18.md). The candidate
build and focused tests passed, and local-mock cases observed plaintext
DeepSeek inputs. One real API run exercised a native child and completed its
turn, but the complete acceptance gate failed at child discovery/verification;
the specific assertion was not retained. This is partial evidence, not a
complete acceptance or a claim that the missing proof failed for a particular
reason.

## Candidate build

[Windows workflow run `39074481203`](https://github.com/Puipipi/sol-luna-deepseek-router/actions/runs/39074481203)
used repository head `a5730feb0080cbe5343aa561cd6753c3278e26db`, pinned source
`4ebc485ca321243727539187169425fcf972f2c4`, and patch SHA-256
`65add65b454f29e9c16726b27993f58176a99b0bd6bb73355fc72a32836774ae`. It
passed 11 focused protocol tests and 6 focused core tests, then built the
Windows MSVC release target. Build and upload timestamps were 22:30:52–23:39:49
UTC and 23:45:56 UTC on October 17, 2026.

The staged artifact was `native-isolated-codex-windows-msvc-39074481203`
(artifact ID `12118234030`, reported size `117765448`). GitHub metadata reports
archive digest `sha256:eb48c1d2ddc9a00f9db9917a659ef1da658bf4c9139ae714c884ee0af0a999aa`;
the downloaded archive bytes were not independently rehashed. The extracted
binary and provenance were independently rehashed and matched SHA-256 values
`b311c3c365d1a9a5c19a6040428e02d49b10d7bdd766a859f0b842d42c3e3963` and
`644c27784e4b0de3b17f354c0592f53980ffefa1f03a9ffa52ea765a9c1cd356`,
respectively. The target was `x86_64-pc-windows-msvc`, version
`0.163.0-alpha.10.2`. The artifact was staged, not activated. Stock companion
executables came from an independent stock build of the same version; they
were not compiled from this artifact. The license, notice, and lock report
were checked.

## Local mock cases

Five genuine native-rollout cases completed once each: normal, flattened
collaboration alias, HTTP 401, connection/stream disconnect, and request/stream
timeout. Each returned exit code 0, status `passed`, and completed its stage;
the parent was verified as a genuine native rollout. All five cleanup checks
were true, stderr was empty, and no auth material was copied. No real API was
called in these cases.

The normal and flattened cases each recorded 8 main-provider HTTP requests,
3 DeepSeek-provider requests, one native DeepSeek spawn, one follow-up, one
Luna spawn, one local DeepSeek compaction, and zero remote compactions. The
same child answered a follow-up; local compaction completed; and after the
DeepSeek mock closed, the parent and Luna turn completed. All three DeepSeek
inputs had `encrypted=false`, and three decoded parent calls had empty
`encrypted_function_args`. The flattened wire item used a null namespace and
the name `collaboration-optimize.start_delegated_task`.

Each fault case recorded 5 main-provider requests, 1 DeepSeek-provider request,
one native DeepSeek spawn, and one Luna spawn. The child reached a failed
terminal state with classification `http_401`,
`connection_or_stream_disconnected`, or `request_or_stream_timeout`,
respectively. No additional DeepSeek request appeared after the terminal
failure; the same parent completed its Luna turn, with no duplicate child or
fallback. The timeout case used fixture-only
`stream_idle_timeout_ms=2000`; it does not establish a production gateway
timeout.

## Real API attempt

One real API run ended with exit code 1 at stage
`discover_and_verify_child`, with an `ERR_ASSERTION`. The specific check was
not saved, and cleanup removed the temporary evidence, so the cause is
unknown. Do not infer that file proof, language, task name, or backend
verification failed. The parent completed and one `native_deepseek` child was
observed with provider `deepseek-native` and model
`deepseek/deepseek-flash`; the child’s last turn completed without an error.
The genuine native rollout recorded one spawn and no fork or model override.

The gateway recorded 4 actual requests, all 4 DeepSeek HTTP responses had
status 200, and OpenAI-through-gateway, relay, and denied counts were zero.
This does not imply zero Sol usage: the completed parent reported 68,207 total
tokens (67,840 input, 50,176 cached input, 367 output), while the child
reported 498,609 total tokens (496,691 input, 375,680 cached input, 1,918
output, 861 reasoning). Relay requests and relay tokens were both zero. The
run took 29,889 ms. Cleanup of auth copy, app-server, gateway, and run
directory all succeeded; stderr was empty.

The run did not reach a follow-up or cold-resume acceptance. Four successful
provider responses and a completed child turn are useful real-API observations,
but they do not establish complete acceptance, file proof, formal installation,
or desktop behavior.

## Later real API attempts (runs 2 and 3)

Two later runs of the same patch 65 candidate again stopped at
`discover_and_verify_child`. In both, the parent completed and one child was
observed with role `native_deepseek`, provider `deepseek-native`, and model
`deepseek/deepseek-flash`; the child completed its turn without an error. The
granular spawn checks passed: one native `spawn_agent`, the expected role and
task name, `fork_turns=none`, no model override, and the Chinese instruction
suffix exactly once. The overall child-discovery gate did not pass, and the
retained failure `check_id` was `child_proof_write_evidence`; the underlying
reason that proof was unavailable remains unknown.

Neither run established file proof: the expected proof file was absent and
`child_proof_write_evidence` was false. `thread/read` exposed no
command-execution or file-change items, but that projection can omit ordinary
tool errors; this does not prove the model made no tool call. No same-child
follow-up or cold resume was reached. Each run recorded four DeepSeek HTTP 200
responses, with zero OpenAI-through-gateway, relay, or denied requests. This
does not mean zero Sol usage: run 2's parent used 51,142 total tokens (50,798
input, 33,408 cached input, 344 output), and run 3's parent used 68,243
(67,895 input, 63,232 cached input, 348 output). DeepSeek usage was 496,611
tokens in run 2 and 495,436 in run 3. All four cleanup checks passed and
stderr was empty for both runs.

In run 3, the generated child catalog reported shell type `unified_exec` and a
null tool mode. That static catalog field is not evidence of a resolved
runtime. Its request diagnostic sampled 128 items, at the sample cap, with the
complete total unknown: 122 function items, one custom item, and five
namespace items. `exec_command`, `write_stdin`, and `apply_patch` were seen;
visibility of other tools is unknown because the sample was truncated. The
four input function-item counts were 0, 1, 1, and 2; custom-item counts were
0, 0, 1, and 1. The request choice was `auto` and `encrypted=false`. Four SSE
monitors reached `SSE_LINE_LIMIT` with truncated samples; their zero counters
are unknown, not proof that no call occurred. Although the failed check ID is
known, the underlying tool-execution cause remains unresolved. Pause further
paid runs until a larger fixture and a free actual-CLI file-dispatch check are
available.

## Remaining acceptance

- Identify the underlying cause of the failed discover-and-verify stage; the
  first run's assertion was not retained, and later runs still did not prove
  file writing.
- Verify real file proof, same-child follow-up, and cold resume.
- Complete formal installation, desktop panel/history, and multiple-session
  acceptance.
- Exercise formal fault cases and the peak/off-peak notification demonstration.
- Do not treat a missing setup wrapper as a provider failure: that setup
  attempt never started the runner or made an API call. Later local fixture
  tests for the private capture layer are not a substitute for a new real run.

The companion [JSON summary](native-plaintext-runtime-2026-10-18.json) contains
the same sanitized allowlisted evidence. It omits private capture IDs, thread
IDs, absolute paths, gateway URLs, credentials, raw messages, and HTTP bodies.
