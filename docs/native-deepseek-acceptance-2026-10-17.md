# Native DeepSeek acceptance — 2026-10-17

> Historical acceptance record for the earlier shared-provider route. It is not evidence for the current isolated `native_deepseek` role contract.

## Result

- P3 run: `20261017123332-1c5dbca4`, root exec exit 0, `pass=true`.
- Parent: `01a149da-6a36-7e13-ba14-33769fedf1e0` (`gpt-6.1-sol`, provider `openai`).
- Native child: `01a149da-afc5-7451-ac60-a1d23514ea8f`.
- The parent used the earlier native collaboration contract with `task_name`, explicit `model: "deepseek/deepseek-flash"`, and `fork_turns: "none"`; this predates the isolated `agent_type: "native_deepseek"` role contract.
- Same child follow-up produced two child turns. The child used `commandExecution`, wrote the exact two-line proof, and reported in Chinese. The parent did not substitute its own file edit.
- `proof.txt` matched the expected bytes exactly.

## API and usage

The final cumulative numbers below come from the P3 original `thread/tokenUsage/updated` runtime events. Raw event files remain private and are not published.

- Main GPT parent `01a149da-6a36-7e13-ba14-33769fedf1e0`: input 79088, cached input 53888, output 464, total 79552.
- DeepSeek child `01a149da-afc5-7451-ac60-a1d23514ea8f`: input 506266, cached input 352768, output 1687, total 507953. This matches the summed six DeepSeek API responses; the first request input was 81704 tokens, consistent with the full tool/system context.
- Native relay: two calls, input 510, output 292, total 802.
- These are token counts, not quota percentages. They cannot be converted to plan quota without provider-side pricing/limits, and there is no native Luna baseline in this run. Do not claim a savings percentage from these numbers alone.

## What is verified

- The shared `openai` provider can route an exact DeepSeek slug through a local gateway without replacing the main model.
- Native child creation, same-child follow-up, Chinese child output, actual command execution, and exact proof bytes were observed.
- GPT encrypted reasoning is preserved; DeepSeek plaintext reasoning is passed back; plaintext collaboration payloads are not sent through the GPT relay.

## Not verified

- Desktop panel UI, model picker, visual child entry, status rendering, and full-history behavior remain pending acceptance for the isolated backend.
