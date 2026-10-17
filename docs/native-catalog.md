# Native DeepSeek catalog metadata

`deepSeekEntry` uses DeepSeek's documented Codex integration metadata: `context_window` and `max_context_window` are 1,048,576, `effective_context_window_percent` is 95, and `auto_compact_token_limit` is unset (`null`). Source: [DeepSeek Codex agent integration](https://api-docs.deepseek.com/quick_start/agent_integrations/codex/).

`buildChildCatalog` creates a child-only catalog from an existing model-cache template, leaving the parent cache untouched. The legacy `mergeCatalog` behavior remains available for existing callers.

The larger context metadata does not establish that local compaction is correct. The local compaction protocol still requires validation with the runtime probe.
