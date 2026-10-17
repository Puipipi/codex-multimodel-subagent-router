import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createNativeGateway } from "../scripts/native-gateway.mjs";
import { resolveDeepSeekAuth } from "../scripts/native-credentials.mjs";

const dir = await mkdtemp(path.join(os.tmpdir(), "native-gateway-account-auth-"));
const calls = [];
const fixture = (token) => `records:\n  deepseek-account-platform/default:\n    kind: grant\n    payload:\n      version: 1\n      token: '${token}'\n      issuer: 'https://platform.deepseek.com'\nrefs:\n  DEEPSEEK_API_KEY: legacy-api-key\n`;
let current = fixture("account-token-one");
const fetchImpl = async (url, options) => {
  calls.push({ url, headers: new Headers(options.headers), redirect: options.redirect });
  return new Response("data: {\"type\":\"response.completed\",\"response\":{\"usage\":{}}}\n\n", {
    status: 200, headers: { "content-type": "text/event-stream" },
  });
};
const gateway = createNativeGateway({
  logPath: path.join(dir, "gateway.jsonl"), token: "local-token", fetchImpl,
  deepSeekAuthResolver: () => resolveDeepSeekAuth({ text: current }),
});
const port = await gateway.start();
const endpoint = `http://127.0.0.1:${port}/local-token/v1/responses`;
const request = () => fetch(endpoint, {
  method: "POST", headers: { "content-type": "application/json", authorization: "Bearer chatgpt-secret" },
  body: JSON.stringify({ model: "deepseek-flash", input: "hello" }),
});
try {
  let response = await request();
  assert.equal(response.status, 200);
  assert.equal(calls[0].url, "https://api.deepseek.com/responses");
  assert.equal(calls[0].headers.get("x-dsh-auth-token"), "account-token-one");
  assert.equal(calls[0].headers.get("authorization"), null);
  assert.equal(calls[0].redirect, "error");
  const health = await fetch(`http://127.0.0.1:${port}/local-token/_health`);
  assert.deepEqual((await health.json()).deepseek_credential, { present: true, mode: "account" });
  current = fixture("account-token-two");
  response = await request();
  assert.equal(response.status, 200);
  assert.equal(calls[1].headers.get("x-dsh-auth-token"), "account-token-two");
  current = fixture("bad-token").replace("https://platform.deepseek.com", "https://evil.example");
  response = await request();
  assert.equal(response.status, 503);
  assert.equal(calls.length, 2);
  assert.equal((await response.text()).includes("bad-token"), false);
  const wrongOriginGateway = createNativeGateway({
    logPath: path.join(dir, "wrong-origin.jsonl"), token: "wrong-origin", fetchImpl,
    deepSeekBase: "https://api.deepseek.com.attacker.example",
    deepSeekAuthResolver: () => resolveDeepSeekAuth({ text: fixture("account-token-three") }),
  });
  const wrongPort = await wrongOriginGateway.start();
  try {
    const blocked = await fetch(`http://127.0.0.1:${wrongPort}/wrong-origin/v1/responses`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "deepseek-flash", input: "hello" }),
    });
    assert.equal(blocked.status, 502);
    assert.equal((await blocked.text()).includes("account-token-three"), false);
    assert.equal(calls.length, 2);
  } finally {
    await wrongOriginGateway.close();
  }
} finally {
  await gateway.close();
  await rm(dir, { recursive: true, force: true });
}
