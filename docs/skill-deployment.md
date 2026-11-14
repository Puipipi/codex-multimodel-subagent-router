# Canonical skill deployment

The active canonical skill is `~/.codex/skills/codex-multimodel-subagent-router`. Keep SKILL.md, agents/, scripts/, references/ and required docs/ together. Exclude the generated codex-plugin/ subtree; its SKILL.md would create duplicate discovery.

Use the generated plugin bundle as the migration source. The [identity migration tool](identity-migration.md) stages SKILL.pending.md and activates it only after disabling the old plugin and renaming the old discovery entry to SKILL.legacy-disabled.md. Keep the old directory and scripts in place for in-flight absolute references. Do not copy, move or reset the legacy LocalAppData state root.

Runtime source remains bound to the executing module root (or an explicit test/dependency override). A current new plugin cache uses its own source; in-flight references to old scripts continue to use the old source. Renaming does not introduce another source resolver or change backend selection.
