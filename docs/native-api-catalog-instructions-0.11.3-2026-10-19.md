# Native API catalog instructions repair 0.11.3 (2026-10-19)

The 0.11.2 runtime was fully restarted and the host exposed the registered native API role. The only authorized real spawn attempt then failed before child creation: the generated model catalog lacked both supported instruction fields. No API request was made, and the paid authorization remains unused. The installed catalog remained unchanged during diagnosis.

The 0.11.3 source repair derives instructions from the existing native model catalog without pinning a model slug. It preserves the selected model's complete `model_messages` object, supports non-empty `base_instructions` as the alternate contract, and rejects missing instructions during readiness/dispatch checks. Apply migrates only the exact owned prior catalog, retains the existing ownership, busy-state, and journal protections, and can recover the catalog-before-journal interruption using deterministic target bytes. Other profiles, providers, root model instructions, and user configuration are preserved.

Focused regression tests cover the missing-instructions failure, both supported instruction forms, readiness rejection, ownership/CAS behavior, and interrupted Apply recovery. The real installed CLI rejected the old catalog with the expected missing-instructions diagnostic. `model/list` succeeded for both test inputs but does not parse this custom catalog path; those results are not parse or runtime acceptance evidence. No model request, runtime rebuild, installation, or Apply was performed for this candidate.

The 0.11.3 source candidate still requires explicit Apply, a full restart, and one authorized real child spawn before API acceptance. Until then, `apiVerified` remains false and this candidate is not final-installable.
