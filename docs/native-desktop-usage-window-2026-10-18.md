# Sol 主会话用量窗口（2026-10-18）

本记录只汇总 `gpt-6.1-sol` 主会话 rollout 在 2026-10-18T08:06:37.000Z 至 08:07:46.999Z 的 `event_msg/token_count` 事件。共 14 条事件，其中 13 个唯一 `total_token_usage` 快照；一条重复快照与前一快照的 last/total counters 完全相同，统计时去重。

对 13 个唯一快照的 `last_token_usage` 求和为 input 830,765 tokens（其中 cached input 为 816,640、cache-write input 为 0）；output 为 1,990 tokens（其中 reasoning output 为 405），total 为 832,755。首末快照 total counters 的净增为 input 771,929、cached input 758,656、output 1,652、reasoning output 405、total 773,581；首个事件之前缺少 baseline，因此该净增不含首事件。

这是指定 rollout 时间窗的事件 usage 统计，不是精确单任务或整个目标的用量。它与 DeepSeek gateway 的请求/usage 记录分开，不应相加推断配额百分比，也不用于宣称全目标零用量。
