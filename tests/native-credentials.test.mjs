import assert from "node:assert/strict";
import { resolveDeepSeekAuth } from "../scripts/native-credentials.mjs";

const accountToken = "fixture-account-token";
const fixture = (issuer = "https://platform.deepseek.com", token = accountToken) => `
records:
  deepseek-account-platform/default:
    kind: grant
    payload:
      version: 1
      token: '${token}' # DSH account grant
      issuer: '${issuer}'
refs:
  DEEPSEEK_API_KEY: legacy-api-key
`;

assert.deepEqual(resolveDeepSeekAuth({ text: fixture() }), {
  mode: "account", headers: { "x-dsh-auth-token": accountToken },
});
assert.deepEqual(resolveDeepSeekAuth({ text: "refs:\n  DEEPSEEK_API_KEY: legacy-api-key\nrecords:\n  deepseek-account-platform/default:\n    kind: grant\n    payload:\n      version: 1\n      token: account-token\n      issuer: https://platform.deepseek.com\n" }), {
  mode: "account", headers: { "x-dsh-auth-token": "account-token" },
});
assert.deepEqual(resolveDeepSeekAuth({ text: "refs:\n  DEEPSEEK_API_KEY: legacy-api-key\n" }), {
  mode: "api-key", headers: { authorization: "Bearer legacy-api-key" },
});
assert.throws(() => resolveDeepSeekAuth({ text: fixture("https://attacker.example") }), /issuer/i);
assert.throws(() => resolveDeepSeekAuth({ text: fixture("https://platform.deepseek.com", "bad\nheader: x") }), /token/i);
assert.throws(() => resolveDeepSeekAuth({ text: fixture().replace("kind: grant", "kind: password") }), /record|grant/i);
assert.throws(() => resolveDeepSeekAuth({ text: fixture().replace("kind: grant", "kind: grant\n    kind: grant") }), /duplicate/i);
assert.throws(() => resolveDeepSeekAuth({ text: fixture().replace("token: 'fixture-account-token' # DSH account grant", "token: 'bad\n    kind: grant'") }), /token|record/i);
assert.throws(() => resolveDeepSeekAuth({ text: "records:\n  deepseek-account-platform/default:\n    kind: grant\n    payload:\n      version: 1\nrefs:\n  DEEPSEEK_API_KEY: legacy-api-key\n" }), /invalid|token/i);
assert.throws(() => resolveDeepSeekAuth({ text: "records:\n  deepseek-account-platform/default: {kind: grant}\nrefs:\n  DEEPSEEK_API_KEY: legacy-api-key\n" }), /unsupported|record/i);
assert.throws(() => resolveDeepSeekAuth({ text: "records: {deepseek-account-platform/default: {kind: grant}}\nrefs:\n  DEEPSEEK_API_KEY: legacy-api-key\n" }), /unsupported|records/i);

console.log("PASS native credential resolution assertions");
