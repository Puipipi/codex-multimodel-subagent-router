# Canonical skill deployment

The active canonical skill is `~/.codex/skills/codex-multimodel-subagent-router`. Keep SKILL.md, agents/, scripts/, references/ and required docs/ together. Exclude the generated codex-plugin/ subtree; its SKILL.md would create duplicate discovery.

Use the generated plugin bundle as the migration source. The [identity migration tool](identity-migration.md) stages SKILL.pending.md and activates it only after disabling the old plugin and renaming the old discovery entry to SKILL.legacy-disabled.md. Keep the old directory and scripts in place for in-flight absolute references. Do not copy, move or reset the legacy LocalAppData state root.

For local source lookup, scripts/router-identity.mjs prefers the new canonical directory, with old-directory fallback solely for source compatibility. Source lookup never changes backend, provider, model or user settings.
