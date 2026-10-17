# Native runtime environment transaction

The runtime environment module is a preparation layer only. This change does not activate the staged CLI or call the Windows environment setter. A plan verifies the staged runtime and snapshots only `CODEX_CLI_PATH` and `SOL_LUNA_NATIVE_PLAINTEXT_V2`; unrelated values are neither returned nor changed.

Apply refuses a stale plan. Its rollback snapshot restores the previous values only while both owned values still match what the transaction applied. If either value changed afterward, rollback refuses and preserves the user's current settings. Failed partial application attempts try every eligible owned key even if one restoration fails, then report the original error together with all restoration failures.
