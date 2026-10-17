import assert from "node:assert/strict";
import {
  buildDeepSeekBody, normalizeNativeAgentInput, normalizeRoutedAgentInput, normalizePlainInput,
  routeForModel, PICKER_SLUG, WIRE_MODEL,
} from "../scripts/native-routing.mjs";

let checks = 0;
const equal = (actual, expected, message) => { assert.equal(actual, expected, message); checks += 1; };
const ok = (value, message) => { assert.ok(value, message); checks += 1; };
const deepEqual = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks += 1; };

const envelope = (encrypted) => ({
  type: "agent_message",
  content: [
    { type: "input_text", text: "Message Type: NEW_TASK\nTask name: native_deepseek\nSender: /root\nPayload:\n" },
    { type: "encrypted_content", encrypted_content: encrypted },
  ],
});

equal(routeForModel(PICKER_SLUG), "deepseek", "exact picker slug routes to DeepSeek");
equal(routeForModel(WIRE_MODEL), "deepseek", "wire model routes to DeepSeek");
equal(routeForModel("gpt-6.1-sol"), "openai", "unknown models remain OpenAI");
equal(routeForModel("deepseek/deepseek-v4-flash"), "openai", "near-miss slug is not routed");

const plain = normalizePlainInput([{ type: "agent_message", content: [{ type: "input_text", text: "plain task" }] }]);
equal(plain[0].type, "message", "plain collaboration becomes a message");
equal(plain[0].role, "user", "NEW_TASK is never an assistant message");

const reasoning = normalizePlainInput([
  { type: "reasoning", content: [{ type: "reasoning_text", text: "keep me" }] },
  { type: "reasoning", encrypted_content: "gAAAAAopaque", content: [] },
]);
equal(reasoning.length, 1, "only real DeepSeek reasoning_text survives");
equal(reasoning[0].content[0].text, "keep me", "DeepSeek reasoning_text is preserved verbatim");

const followup = normalizePlainInput([
  { type: "message", role: "user", content: [{ type: "input_text", text: "first task" }] },
  { type: "reasoning", content: [{ type: "reasoning_text", text: "first deepseek thinking" }] },
  { type: "message", role: "assistant", content: [{ type: "output_text", text: "first answer" }] },
  { type: "agent_message", content: [{ type: "input_text", text: "follow-up to the same child" }] },
]);
equal(followup.length, 4, "same-child follow-up history keeps all meaningful items");
equal(followup[1].content[0].text, "first deepseek thinking", "follow-up replays DeepSeek reasoning_text");
equal(followup[3].role, "user", "follow-up collaboration is a user message");
equal(followup[2].role, "assistant", "earlier assistant answer remains assistant");

let relayCalls = 0;
const native = await normalizeRoutedAgentInput([envelope("gAAAAAnativeciphertext")], {
  relay: async ({ native: isNative }) => { relayCalls += 1; equal(isNative, true, "native token uses relay"); return "exact plaintext"; },
});
equal(relayCalls, 1, "native ciphertext relays once");
equal(native[0].role, "user", "relayed task is a user message");
equal(native[0].content.at(-1).text, "exact plaintext", "relay plaintext is preserved");
equal(native[0].content.some((part) => part.type === "encrypted_content"), false, "ciphertext is removed");

let plaintextRelayCalls = 0;
const direct = await normalizeRoutedAgentInput([envelope("already-plaintext")], {
  relay: async () => { plaintextRelayCalls += 1; return "bad"; },
});
equal(plaintextRelayCalls, 0, "non-native plaintext never calls GPT relay");
equal(direct[0].content.at(-1).text, "already-plaintext", "non-native plaintext is read directly");

const nativeInput = normalizeNativeAgentInput([
  envelope("deepseek plaintext collaboration"),
  { type: "reasoning", encrypted_content: "gAAAAAgptciphertext" },
]);
ok(nativeInput, "GPT-bound plaintext collaboration is normalized");
equal(nativeInput[0].content.at(-1).type, "input_text", "GPT collaboration gets plaintext input");
equal(nativeInput[1].encrypted_content, "gAAAAAgptciphertext", "GPT reasoning ciphertext is untouched");
equal(normalizeNativeAgentInput([envelope("gAAAAAgptciphertext")]), null, "native GPT ciphertext is not rewritten");

const body = buildDeepSeekBody({
  model: "gpt-6.1-sol", store: true, use_responses_lite: true,
  input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "x" }] }],
  reasoning: { effort: "max", summary: "auto" }, previous_response_id: "x",
});
equal(body.model, WIRE_MODEL, "DeepSeek wire model is exact");
equal(body.store, false, "DeepSeek store is disabled");
equal(body.use_responses_lite, undefined, "ResponsesLite is removed");
equal(body.previous_response_id, undefined, "previous_response_id is removed");
deepEqual(body.reasoning, { effort: "max" }, "reasoning summary is removed");

console.log(`PASS ${checks} native routing assertions`);
