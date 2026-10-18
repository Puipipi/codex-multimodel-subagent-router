# Native plaintext wire marker fix

The native router classifies a collaboration message as plaintext only when
`encrypted_function_args` is present and empty. A missing field is classified
as encrypted. The wire tool schema explicitly marks the collaboration
`message` argument as plaintext, so an older CLI could send a plaintext
`function_call` without the metadata needed by that classifier.

The protocol decoder now handles this wire representation. For the three
collaboration message aliases, it adds an empty `encrypted_function_args` only
when the decoded field is absent. Explicit empty or non-empty values are
preserved. A flattened wire `FunctionCall` is also normalized to the canonical
collaboration namespace and bare function name so the native tool router can
resolve it. Tool-schema encoding remains unchanged.

## Tested pre-fix artifact

[Windows workflow run `39062300727`](https://github.com/Puipipi/sol-luna-deepseek-router/actions/runs/39062300727) at repository head
`1390c4767436e1c4cdeefe61f415ced030ecc74d` compiled and staged version
`0.163.0-alpha.10.2` from source commit
`4ebc485ca321243727539187169425fcf972f2c4` with combined patch SHA-256
`51c1a0bde0fdabd449216de6aef4e14403a39a0999057e289a939497f936eb75`. The
staged binary SHA-256 was
`beab648206ce0e42ad7dc2776f9be1be196106a567b069e4d3d2e117a4ee161b`. This
pre-fix binary was not activated.

The local-mock acceptance of that binary completed successfully: it exercised
a same-child follow-up, DeepSeek local auto-compaction, and a Luna turn after
the DeepSeek mock closed. The probe recorded eight main-provider HTTP requests
and three DeepSeek-provider HTTP requests. These success results apply to the
51/beab binary; they do not test the fix candidate below.

## Encrypted-input guard RED

An independent guard evaluated the three DeepSeek-provider HTTP request
inputs and observed `encrypted-input=true` for all three, where the expected
value was false. Separately, inspection found the raw `encrypted_function_args`
metadata missing on three parent collaboration calls: DeepSeek spawn, DeepSeek
follow-up, and Luna spawn. These parent-call metadata observations are a
separate set and do not correspond one-to-one with the three DeepSeek HTTP
requests. The guard assertion exited 1. The underlying local-mock protocol
probe itself retained status `passed` and exit 0 because it did not assert this
classification; the two results are reported separately in the evidence JSON.

This RED result belongs to the pre-fix 51/beab binary. The fix candidate uses
protocol source normalized LF SHA-256
`B163648D7C753F5E222F3210E90C909E5C4A81CBCFA80EA1905E63834D803967` and
combined patch SHA-256
`65add65b454f29e9c16726b27993f58176a99b0bd6bb73355fc72a32836774ae`. That
candidate was compiled and its focused protocol/core tests passed in Windows
workflow run `39074481203`; see [the candidate runtime evidence](native-plaintext-runtime-2026-10-18.md).
Its local-mock cases also observed plaintext inputs, but the separate real API
run did not pass the complete acceptance gate. The candidate is not a verified
end-to-end fix.

A separate earlier real run stopped at the gateway preflight. The previous
matcher did not expose a child-level response error, so no real API child HTTP
403 was observed or established. The candidate's first real API attempt and
two later attempts are reported in the [runtime evidence](native-plaintext-runtime-2026-10-18.md).
The later attempts again failed at child discovery/verification: child proof
was not established, and no follow-up or cold resume was reached. Their
retained failure check was `child_proof_write_evidence`; the underlying reason
proof was unavailable remains unknown. Real file proof, same-child follow-up,
cold resume, installation, and desktop acceptance remain pending.
