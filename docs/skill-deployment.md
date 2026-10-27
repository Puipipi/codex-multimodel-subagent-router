# Canonical skill deployment

Install the canonical skill from the repository root, keeping `SKILL.md`, `agents/`, `scripts/`, and referenced `docs/` together. Exclude the root `codex-plugin/` directory when copying into `~/.codex/skills/sol-luna-deepseek-router`: it is a generated plugin projection containing a copy of `SKILL.md`, which Codex may discover as a second skill. Keep `codex-plugin/` intact in plugin marketplace releases; it is the marketplace plugin source.
