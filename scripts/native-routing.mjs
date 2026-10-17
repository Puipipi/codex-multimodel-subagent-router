// Formal native routing policy. No test caps, no private paths, no credentials.
export const PICKER_SLUG = "deepseek/deepseek-flash";
export const WIRE_MODEL = "deepseek-flash";
export const DEEPSEEK_BASE = "https://api.deepseek.com";
export const NATIVE_BASE = "https://chatgpt.com/backend-api/codex";
export const COLLAB_ENVELOPE =
  /Message Type:\s*(?:NEW_TASK|MESSAGE|FOLLOWUP_TASK|FINAL_ANSWER)\b[\s\S]*\nPayload:\s*$/i;
export const NATIVE_ENCRYPTED_TOKEN = /^gAAAAA[A-Za-z0-9_-]+={0,2}$/;

export function isDeepSeekModel(model) {
  return model === PICKER_SLUG || model === WIRE_MODEL;
}

export function routeForModel(model) {
  return isDeepSeekModel(model) ? "deepseek" : "openai";
}

export function isNativeEncryptedToken(value) {
  return typeof value === "string" && NATIVE_ENCRYPTED_TOKEN.test(value);
}

function partText(part) {
  return part && ["input_text", "text", "output_text"].includes(part.type)
    && typeof part.text === "string"
    ? part.text
    : "";
}

export function visibleAgentText(item) {
  return Array.isArray(item?.content) ? item.content.map(partText).join("") : "";
}

export function encryptedAgentPayload(item) {
  if (!item || !Array.isArray(item.content)) return null;
  const encrypted = item.content.find(
    (part) => part?.type === "encrypted_content"
      && typeof part.encrypted_content === "string"
      && part.encrypted_content.length > 0,
  );
  if (!encrypted) return null;
  const visibleText = visibleAgentText(item);
  return {
    content: encrypted.encrypted_content,
    native: isNativeEncryptedToken(encrypted.encrypted_content),
    envelope: COLLAB_ENVELOPE.test(visibleText),
    visibleText,
  };
}

function blankMessage(item) {
  if (item?.type !== "message") return false;
  if (Array.isArray(item.tool_calls) && item.tool_calls.length > 0) return false;
  if (typeof item.content === "string") return item.content.trim() === "";
  if (Array.isArray(item.content)) return item.content.length === 0;
  return false;
}

function normalizePlainItem(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return item;
  if (item.type === "compaction_trigger") return null;
  if (item.type === "reasoning") {
    const hasReasoningText = Array.isArray(item.content)
      && item.content.some((part) => part?.type === "reasoning_text"
        && typeof part.text === "string" && part.text.length > 0);
    if (!hasReasoningText) return null;
  }
  const converted = { ...item };
  delete converted.id;
  if (converted.type === "message" && Array.isArray(converted.content)) {
    converted.content = converted.content.filter((part) => {
      if (!part || typeof part !== "object") return true;
      if (!["input_text", "output_text", "text", "reasoning_text"].includes(part.type)) return true;
      return typeof part.text === "string" ? part.text.trim() !== "" : true;
    });
  }
  if (converted.type === "agent_message") {
    const encrypted = Array.isArray(converted.content)
      && converted.content.some((part) => part?.type === "encrypted_content");
    if (!encrypted) {
      converted.type = "message";
      converted.role = "user";
    }
  }
  return blankMessage(converted) ? null : converted;
}

export function normalizePlainInput(input) {
  if (!Array.isArray(input)) return input;
  return input.map(normalizePlainItem).filter((item) => item !== null);
}

function encryptedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export async function normalizeRoutedAgentInput(input, { relay } = {}) {
  if (!Array.isArray(input)) return input;
  const output = [];
  for (const item of normalizePlainInput(input)) {
    const payload = encryptedAgentPayload(item);
    if (!payload) { output.push(item); continue; }
    if (!payload.envelope) {
      throw encryptedError("ERR_UNRECOGNIZED_ENCRYPTED_AGENT_ITEM",
        "Encrypted collaboration item does not have a recognized Payload: envelope");
    }
    let plaintext;
    if (payload.native) {
      if (typeof relay !== "function") {
        throw encryptedError("ERR_ENCRYPTED_AGENT_PAYLOAD",
          "Native collaboration payload requires the signed-in GPT relay");
      }
      plaintext = await relay({ item, encrypted: payload.content, native: true });
    } else {
      plaintext = payload.content;
    }
    if (typeof plaintext !== "string" || plaintext.length === 0) {
      throw encryptedError("ERR_EMPTY_RELAYED_AGENT_PAYLOAD",
        "Native relay returned no usable task payload");
    }
    const content = item.content.filter((part) => part?.type !== "encrypted_content");
    content.push({ type: "input_text", text: plaintext });
    const converted = { ...item, type: "message", role: "user", content };
    delete converted.id;
    output.push(converted);
  }
  return output;
}

// GPT-bound collaboration items can contain a DeepSeek plaintext payload in
// encrypted_content. Restore only that non-native collaboration payload; never
// touch native GPT ciphertext reasoning.
export function normalizeNativeAgentInput(input) {
  if (!Array.isArray(input)) return null;
  let changed = false;
  const output = input.map((item) => {
    if (item?.type !== "agent_message" || !Array.isArray(item.content)) return item;
    const plainPart = item.content.find((part) => part?.type === "encrypted_content"
      && typeof part.encrypted_content === "string"
      && part.encrypted_content.length > 0
      && !isNativeEncryptedToken(part.encrypted_content));
    if (!plainPart) return item;
    changed = true;
    const content = item.content.filter((part) => part !== plainPart);
    content.push({ type: "input_text", text: plainPart.encrypted_content });
    return { ...item, content };
  });
  return changed ? output : null;
}

export function buildDeepSeekBody(input) {
  const body = structuredClone(input);
  const effort = body.reasoning?.effort;
  body.model = WIRE_MODEL;
  body.store = false;
  body.reasoning = {
    ...(body.reasoning && typeof body.reasoning === "object" ? body.reasoning : {}),
    effort: ["low", "medium", "high"].includes(effort) ? "high" : "max",
  };
  delete body.reasoning.summary;
  delete body.reasoning.generate_summary;
  delete body.reasoning.context;
  delete body.previous_response_id;
  delete body.conversation;
  delete body.background;
  delete body.metadata;
  delete body.service_tier;
  delete body.use_responses_lite;
  delete body.responses_lite;
  return body;
}
