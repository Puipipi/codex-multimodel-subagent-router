import { createHash, randomUUID } from "node:crypto";

import { isOfficialDeepSeekProfile } from "./native-api-settings.mjs";

export class NativeApiProtocolError extends Error {
  constructor(message, { status = 400, code = "invalid_request_error" } = {}) {
    super(message);
    this.name = "NativeApiProtocolError";
    this.status = status;
    this.code = code;
  }
}

const REQUEST_FIELDS = new Set([
  "model", "input", "instructions", "stream", "tools", "tool_choice", "parallel_tool_calls",
  "reasoning", "text", "max_output_tokens", "temperature", "top_p", "store", "metadata", "include", "prompt_cache_key", "client_metadata",
]);

function invalid(message, code = "invalid_request_error") {
  throw new NativeApiProtocolError(message, { code });
}

function newId(prefix) {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function toolKey(kind, namespace, name) {
  return createHash("sha256").update(JSON.stringify([kind, namespace || "", name])).digest("hex").slice(0, 32);
}

function registerTool(toolMap, kind, namespace, name, definition = {}) {
  if (typeof name !== "string" || !name) invalid("Tool name must be a non-empty string.");
  const providerName = `codex_${toolKey(kind, namespace, name)}`;
  const existing = toolMap.get(providerName);
  if (existing && (existing.kind !== kind || existing.name !== name || existing.namespace !== namespace)) {
    invalid("Tool name collision while flattening Responses tools.");
  }
  const cleanDefinition = Object.fromEntries(Object.entries(definition).filter(([, value]) => value !== undefined));
  const descriptor = { ...existing, kind, name, ...(namespace ? { namespace } : {}), ...cleanDefinition };
  toolMap.set(providerName, descriptor);
  return providerName;
}

function toTextContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) invalid("Only text message content is supported by this Chat profile.", "unsupported_parameter");
  return content.map((part) => {
    if (!part || typeof part !== "object" || !["input_text", "output_text", "text"].includes(part.type) || typeof part.text !== "string") {
      invalid(`Unsupported Responses message content type: ${part?.type ?? "unknown"}.`, "unsupported_parameter");
    }
    return part.text;
  }).join("");
}

function outputToText(output) {
  if (typeof output === "string") return output;
  if (!Array.isArray(output)) invalid("Tool output must be text or text content blocks.", "unsupported_parameter");
  return output.map((part) => {
    if (typeof part === "string") return part;
    if (!part || !["input_text", "output_text", "text"].includes(part.type) || typeof part.text !== "string") {
      invalid(`Unsupported tool output content type: ${part?.type ?? "unknown"}.`, "unsupported_parameter");
    }
    return part.text;
  }).join("");
}

function formatToChat(format) {
  if (format === undefined || format === null || format.type === "text") return undefined;
  if (format.type === "json_schema") {
    if (!format.schema || typeof format.schema !== "object") invalid("A JSON schema format requires schema.");
    return {
      type: "json_schema",
      json_schema: {
        name: format.name || "response",
        ...(format.description ? { description: format.description } : {}),
        schema: format.schema,
        ...(format.strict !== undefined ? { strict: format.strict } : {}),
      },
    };
  }
  if (format.type === "json_object") return { type: "json_object" };
  invalid(`Unsupported Responses text format: ${format.type ?? "unknown"}.`, "unsupported_parameter");
}

function registerDefinitions(tools, toolMap) {
  if (tools === undefined) return [];
  if (!Array.isArray(tools)) invalid("tools must be an array.");
  const result = [];
  const add = (tool, namespace) => {
    if (!tool || typeof tool !== "object") invalid("Each tool definition must be an object.");
    if (tool.type === "function") {
      const toolNamespace = tool.namespace || namespace;
      const name = registerTool(toolMap, "function", toolNamespace, tool.name, {
        description: tool.description,
        parameters: tool.parameters,
        strict: tool.strict,
      });
      result.push({
        type: "function",
        function: {
          name,
          ...(tool.description ? { description: tool.description } : {}),
          ...(tool.parameters ? { parameters: tool.parameters } : {}),
          ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
        },
      });
      return;
    }
    if (tool.type === "custom") {
      if (tool.format && !["text", "grammar"].includes(tool.format.type)) {
        invalid(`Custom tool format ${tool.format.type ?? "unknown"} cannot be represented by a Chat function tool.`, "unsupported_parameter");
      }
      const toolNamespace = tool.namespace || namespace;
      const name = registerTool(toolMap, "custom", toolNamespace, tool.name, { description: tool.description, format: tool.format });
      const grammarText = tool.format?.type === "grammar"
        ? `\nRequested input grammar (${tool.format.syntax || "unknown syntax"}):\n${typeof tool.format.definition === "string" ? tool.format.definition : JSON.stringify(tool.format)}`
        : "";
      result.push({
        type: "function",
        function: {
          name,
          description: [tool.description, "This is a free-form custom tool. Put the exact tool input string in the required input property.", grammarText, tool.format?.type === "grammar" ? "The Chat provider cannot enforce this grammar; the Codex tool executor remains responsible for validation." : ""].filter(Boolean).join("\n"),
          parameters: {
            type: "object",
            properties: { input: { type: "string" } },
            required: ["input"],
            additionalProperties: false,
          },
        },
      });
      return;
    }
    invalid(`Unsupported Responses tool type: ${tool.type ?? "unknown"}.`, "unsupported_parameter");
  };
  for (const tool of tools) {
    if (tool?.type === "namespace") {
      if (!Array.isArray(tool.tools)) invalid("Namespace tools must contain a tools array.");
      for (const child of tool.tools) add(child, tool.name);
    } else add(tool, undefined);
  }
  return result;
}

function mapToolChoice(choice, toolMap) {
  if (choice === undefined || typeof choice === "string") return choice;
  if (!choice || typeof choice !== "object") invalid("tool_choice must be a string or object.");
  if (choice.type === "function" || choice.type === "custom") {
    const kind = choice.type;
    const providerName = registerTool(toolMap, kind, choice.namespace, choice.name);
    return { type: "function", function: { name: providerName } };
  }
  invalid(`Unsupported Responses tool_choice type: ${choice.type ?? "unknown"}.`, "unsupported_parameter");
}

function mapReasoning(body, profile, chat) {
  const config = profile.reasoning || { supported: [], parameter: "none" };
  const requested = body.reasoning?.effort;
  if (config.parameter === "none") {
    const reasoning = body.reasoning;
    const empty = reasoning === undefined || reasoning === null
      || (typeof reasoning === "object" && !Array.isArray(reasoning) && Object.keys(reasoning).length === 0)
      // Some Codex builds serialize an explicit disabled effort even when the
      // profile has parameter=none. It has no thinking effect and is accepted;
      // any other explicit effort, summary, or context remains meaningful.
      || (reasoning && typeof reasoning === "object" && !Array.isArray(reasoning)
        && Object.keys(reasoning).length === 1 && reasoning.effort === "none");
    if (!empty) invalid("This profile does not accept reasoning parameters.", "unsupported_parameter");
    return;
  }
  let effort = requested ?? config.default;
  if (effort === undefined) return;
  if (effort === "xhigh"
      && (isOfficialDeepSeekProfile(profile) || profile.credential?.type === "dsh_account")
      && config.supported?.includes("high")) effort = "high";
  if (!Array.isArray(config.supported) || !config.supported.includes(effort)) {
    invalid(`Reasoning effort ${String(requested ?? effort)} is not supported by profile ${profile.profileId}.`, "unsupported_parameter");
  }
  if (config.parameter === "reasoning_effort") chat.reasoning_effort = effort;
  else if (config.parameter === "reasoning") chat.reasoning = { effort };
  else invalid(`Unknown reasoning parameter mapping: ${config.parameter}.`);
}

function mapHistory(input, messages, toolMap) {
  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
    return;
  }
  if (!Array.isArray(input)) invalid("input must be a string or an array.");
  const pendingCalls = [];
  const callsById = new Map();
  const flush = () => {
    if (!pendingCalls.length) return;
    messages.push({ role: "assistant", content: null, tool_calls: pendingCalls.splice(0) });
  };
  for (const item of input) {
    if (!item || typeof item !== "object") invalid("Each input item must be an object.");
    if (item.type === "message") {
      flush();
      if (!["system", "developer", "user", "assistant"].includes(item.role)) invalid(`Unsupported message role: ${item.role ?? "unknown"}.`, "unsupported_parameter");
      messages.push({ role: item.role, content: toTextContent(item.content) });
      continue;
    }
    if (item.type === "function_call" || item.type === "custom_tool_call") {
      const kind = item.type === "function_call" ? "function" : "custom";
      const callId = item.call_id;
      if (typeof callId !== "string" || !callId) invalid(`${item.type} requires call_id.`);
      if (callsById.has(callId)) invalid(`Duplicate tool call id: ${callId}.`);
      const providerName = registerTool(toolMap, kind, item.namespace, item.name);
      const args = kind === "function" ? item.arguments : JSON.stringify({ input: item.input });
      if (typeof args !== "string") invalid(`${item.type} requires string arguments/input.`);
      const call = { id: callId, type: "function", function: { name: providerName, arguments: args } };
      pendingCalls.push(call);
      callsById.set(callId, toolMap.get(providerName));
      continue;
    }
    if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      flush();
      if (typeof item.call_id !== "string" || !callsById.has(item.call_id)) {
        invalid(`Tool output ${item.call_id ?? ""} has no matching call in this request history.`, "invalid_tool_output");
      }
      messages.push({ role: "tool", tool_call_id: item.call_id, content: outputToText(item.output) });
      callsById.delete(item.call_id);
      continue;
    }
    if (item.type === "reasoning") {
      if (typeof item.encrypted_content === "string" && item.encrypted_content.length) {
        invalid("Encrypted reasoning history cannot be replayed through a Chat Completions profile.", "unsupported_parameter");
      }
      const text = Array.isArray(item.content)
        ? item.content.filter((part) => part?.type === "reasoning_text" && typeof part.text === "string").map((part) => part.text).join("")
        : "";
      if (text) {
        flush();
        messages.push({ role: "assistant", content: text });
      }
      continue;
    }
    if (item.type === "agent_message") {
      if (Array.isArray(item.content) && item.content.some((part) => part?.type === "encrypted_content")) {
        invalid("Encrypted agent messages cannot be replayed through a Chat Completions profile.", "unsupported_parameter");
      }
      flush();
      const content = toTextContent(item.content);
      messages.push({ role: "user", content });
      continue;
    }
    invalid(`Unsupported Responses input item type: ${item.type ?? "unknown"}.`, "unsupported_parameter");
  }
  flush();
}

export function responsesRequestToChat(body, profile) {
  if (!body || typeof body !== "object" || Array.isArray(body)) invalid("Request body must be an object.");
  for (const key of Object.keys(body)) if (!REQUEST_FIELDS.has(key)) invalid(`Unsupported Responses request parameter: ${key}.`, "unsupported_parameter");
  if (!profile || profile.protocol !== "chat_completions") invalid("A Chat Completions profile is required.");
  if (body.model !== profile.model) invalid("Request model does not match the selected profile.", "model_mismatch");
  if (body.store === true) invalid("Chat Completions profiles are stateless; store must not be enabled.", "unsupported_parameter");
  if (body.include !== undefined) {
    if (!Array.isArray(body.include) || body.include.some((value) => typeof value !== "string")) invalid("include must be an array of strings.");
    const unsupportedIncludes = body.include.filter((value) => value !== "reasoning.encrypted_content");
    if (unsupportedIncludes.length) invalid(`This Chat profile cannot represent Responses include values: ${unsupportedIncludes.join(", ")}.`, "unsupported_parameter");
  }
  // Codex client_metadata is local request context and is intentionally not forwarded to a provider.
  const toolMap = new Map();
  const messages = [];
  if (body.instructions) messages.push({ role: "system", content: body.instructions });
  mapHistory(body.input, messages, toolMap);
  const tools = registerDefinitions(body.tools, toolMap);
  const chat = { model: profile.model, messages, stream: body.stream === true };
  if (body.prompt_cache_key !== undefined) chat.prompt_cache_key = body.prompt_cache_key;
  if (tools.length) chat.tools = tools;
  if (tools.length && body.tool_choice !== undefined) chat.tool_choice = mapToolChoice(body.tool_choice, toolMap);
  if (body.parallel_tool_calls !== undefined) {
    if (typeof body.parallel_tool_calls !== "boolean") invalid("parallel_tool_calls must be a boolean.");
    chat.parallel_tool_calls = body.parallel_tool_calls;
  }
  if (body.max_output_tokens !== undefined) chat.max_tokens = body.max_output_tokens;
  if (body.temperature !== undefined) chat.temperature = body.temperature;
  if (body.top_p !== undefined) chat.top_p = body.top_p;
  if (body.metadata !== undefined) chat.metadata = body.metadata;
  if (body.stream === true) chat.stream_options = { include_usage: true };
  if (body.text !== undefined) {
    if (Object.keys(body.text).some((key) => key !== "format")) invalid("Unsupported Responses text configuration.", "unsupported_parameter");
    const responseFormat = formatToChat(body.text.format);
    if (responseFormat) chat.response_format = responseFormat;
  }
  mapReasoning(body, profile, chat);
  return { body: chat, toolMap };
}

function usageFromChat(usage) {
  if (!usage || typeof usage !== "object") return null;
  const result = {};
  if (Number.isFinite(usage.prompt_tokens)) result.input_tokens = usage.prompt_tokens;
  if (Number.isFinite(usage.completion_tokens)) result.output_tokens = usage.completion_tokens;
  if (Number.isFinite(usage.total_tokens)) result.total_tokens = usage.total_tokens;
  const cached = usage.prompt_tokens_details?.cached_tokens;
  if (Number.isFinite(cached)) result.input_tokens_details = { cached_tokens: cached };
  const reasoning = usage.completion_tokens_details?.reasoning_tokens;
  if (Number.isFinite(reasoning)) result.output_tokens_details = { reasoning_tokens: reasoning };
  return Object.keys(result).length ? result : null;
}

function textResponseItem(text, id = newId("msg")) {
  return { id, type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] };
}

function responseBase({ id, model, createdAt = Math.floor(Date.now() / 1000), status = "completed", output = [], usage = null, error = null, incompleteDetails = null }) {
  return {
    id,
    object: "response",
    created_at: createdAt,
    status,
    model,
    output,
    usage,
    error,
    incomplete_details: incompleteDetails,
  };
}

function finishReason(finish) {
  if (finish === "length") return { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, type: "response.incomplete" };
  if (finish === "content_filter") return { status: "incomplete", incomplete_details: { reason: "content_filter" }, type: "response.incomplete" };
  return { status: "completed", incomplete_details: null, type: "response.completed" };
}

function responseItemsFromMessage(message, toolMap, { idFactory = newId } = {}) {
  const output = [];
  if (typeof message?.content === "string" && message.content.length) output.push(textResponseItem(message.content, idFactory("msg")));
  else if (Array.isArray(message?.content)) {
    const text = message.content.map((part) => typeof part === "string" ? part : part?.text || "").join("");
    if (text) output.push(textResponseItem(text, idFactory("msg")));
  }
  for (const toolCall of message?.tool_calls || []) {
    if (toolCall?.type !== "function") invalid(`Unsupported Chat tool call type: ${toolCall?.type ?? "unknown"}.`, "unsupported_tool_call");
    const descriptor = toolMap?.get(toolCall.function?.name);
    if (!descriptor) invalid(`Chat tool call name was not present in the request: ${toolCall.function?.name ?? "unknown"}.`, "unmapped_tool_call");
    if (typeof toolCall.id !== "string" || !toolCall.id) invalid("Chat tool call is missing its call id.", "invalid_tool_call");
    if (descriptor.kind === "custom") {
      let args;
      try { args = JSON.parse(toolCall.function.arguments || "{}"); }
      catch { invalid("Custom tool arguments were not valid JSON.", "invalid_tool_call"); }
      if (typeof args.input !== "string") invalid("Custom tool arguments must contain a string input.", "invalid_tool_call");
      output.push({
        id: idFactory("ctc"), type: "custom_tool_call", status: "completed", call_id: toolCall.id,
        name: descriptor.name, input: args.input, ...(descriptor.namespace ? { namespace: descriptor.namespace } : {}),
      });
    } else {
      output.push({
        id: idFactory("fc"), type: "function_call", status: "completed", call_id: toolCall.id,
        name: descriptor.name, arguments: toolCall.function.arguments || "{}",
        ...(descriptor.namespace ? { namespace: descriptor.namespace } : {}),
      });
    }
  }
  return output;
}

export function chatCompletionToResponse(chat, { requestId = null, model, toolMap = new Map(), idFactory = newId, createdAt } = {}) {
  const choice = chat?.choices?.[0];
  if (!choice) invalid("Chat completion did not contain a choice.", "invalid_upstream_response");
  const output = responseItemsFromMessage(choice.message, toolMap, { idFactory });
  const terminal = finishReason(choice.finish_reason);
  return responseBase({
    id: `resp_${requestId || chat.id || randomUUID().replaceAll("-", "")}`,
    model: model || chat.model,
    createdAt: createdAt ?? chat.created ?? Math.floor(Date.now() / 1000),
    status: terminal.status,
    output,
    usage: usageFromChat(chat.usage),
    incompleteDetails: terminal.incomplete_details,
  });
}

function parseSseFrame(frame) {
  let event = "message";
  const data = [];
  for (const line of frame.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") event = value;
    if (field === "data") data.push(value);
  }
  return { event, data: data.join("\n") };
}

async function* sseRecords(chunks) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of chunks) {
    buffer += decoder.decode(chunk, { stream: true });
    for (;;) {
      const match = /\r?\n\r?\n/.exec(buffer);
      if (!match) break;
      const frame = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      const record = parseSseFrame(frame);
      if (record.data) yield record;
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) {
    const record = parseSseFrame(buffer);
    if (record.data) yield record;
  }
}

export async function* chatSseToResponses(chunks, { requestId = null, model, toolMap = new Map(), idFactory = newId, createdAt = Math.floor(Date.now() / 1000) } = {}) {
  const responseId = `resp_${requestId || randomUUID().replaceAll("-", "")}`;
  const response = responseBase({ id: responseId, model, createdAt, status: "in_progress", output: [], usage: null });
  let sequence = 0;
  const emit = (type, fields = {}) => ({ type, sequence_number: sequence++, ...fields });
  yield emit("response.created", { response: structuredClone(response) });
  yield emit("response.in_progress", { response: structuredClone(response) });
  let outputIndex = 0;
  let message = null;
  const tools = new Map();
  let finish = null;
  let doneSent = false;
  let terminalSent = false;

  const ensureMessage = async function* () {
    if (message) return;
    message = { id: idFactory("msg"), type: "message", status: "in_progress", role: "assistant", content: [] };
    message.output_index = outputIndex++;
    response.output.push(message);
    const { output_index: _outputIndex, ...addedMessage } = message;
    yield emit("response.output_item.added", { output_index: message.output_index, item: { ...addedMessage, content: [] } });
    const part = { type: "output_text", text: "", annotations: [] };
    message.content.push(part);
    yield emit("response.content_part.added", { item_id: message.id, output_index: message.output_index, content_index: 0, part: structuredClone(part) });
  };

  const startTool = async function* (state) {
    if (state.started || !state.name || !state.callId) return;
    const descriptor = toolMap.get(state.name);
    if (!descriptor) {
      if ([...toolMap.keys()].some((name) => name.startsWith(state.name))) return;
      invalid(`Chat tool call name was not present in the request: ${state.name}.`, "unmapped_tool_call");
    }
    if (descriptor.kind === "custom") {
      state.item = { id: idFactory("ctc"), type: "custom_tool_call", status: "in_progress", call_id: state.callId, name: descriptor.name, input: "", ...(descriptor.namespace ? { namespace: descriptor.namespace } : {}) };
    } else {
      state.item = { id: idFactory("fc"), type: "function_call", status: "in_progress", call_id: state.callId, name: descriptor.name, arguments: "", ...(descriptor.namespace ? { namespace: descriptor.namespace } : {}) };
    }
    state.descriptor = descriptor;
    state.outputIndex = outputIndex++;
    state.started = true;
    response.output.push(state.item);
    yield emit("response.output_item.added", { output_index: state.outputIndex, item: structuredClone(state.item) });
    if (descriptor.kind === "function" && state.arguments) {
      state.item.arguments = state.arguments;
      yield emit("response.function_call_arguments.delta", { item_id: state.item.id, output_index: state.outputIndex, delta: state.arguments });
      state.emittedArguments = state.arguments.length;
    }
  };

  const endTool = async function* (state) {
    if (!state.started) yield* startTool(state);
    if (!state.started) invalid("Chat stream ended with a tool call missing its name or id.", "invalid_tool_call");
    if (state.descriptor.kind === "custom") {
      let args;
      try { args = JSON.parse(state.arguments || "{}"); }
      catch { invalid("Custom tool arguments were not valid JSON.", "invalid_tool_call"); }
      if (typeof args.input !== "string") invalid("Custom tool arguments must contain a string input.", "invalid_tool_call");
      state.item.input = args.input;
      if (args.input) yield emit("response.custom_tool_call_input.delta", { item_id: state.item.id, output_index: state.outputIndex, delta: args.input });
      yield emit("response.custom_tool_call_input.done", { item_id: state.item.id, output_index: state.outputIndex, input: args.input });
    } else {
      const remaining = state.arguments.slice(state.emittedArguments || 0);
      if (remaining) yield emit("response.function_call_arguments.delta", { item_id: state.item.id, output_index: state.outputIndex, delta: remaining });
      state.item.arguments = state.arguments || "{}";
      yield emit("response.function_call_arguments.done", { item_id: state.item.id, output_index: state.outputIndex, arguments: state.item.arguments });
    }
    state.item.status = "completed";
    yield emit("response.output_item.done", { output_index: state.outputIndex, item: structuredClone(state.item) });
  };

  const complete = (incomplete = false) => {
    const terminal = finishReason(finish);
    response.status = terminal.status;
    response.incomplete_details = terminal.incomplete_details;
    response.usage = response.usage || null;
    terminalSent = true;
    return emit(terminal.type, { response: structuredClone(response) });
  };

  try {
    for await (const record of sseRecords(chunks)) {
      if (record.data === "[DONE]") {
        doneSent = true;
        break;
      }
      let chunk;
      try { chunk = JSON.parse(record.data); }
      catch { invalid("Malformed JSON in Chat SSE stream.", "invalid_upstream_response"); }
      if (chunk.error) invalid(chunk.error.message || "Chat upstream stream failed.", chunk.error.code || "upstream_error");
      if (chunk.usage) response.usage = usageFromChat(chunk.usage);
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta || {};
      if (typeof delta.content === "string" && delta.content) {
        yield* ensureMessage();
        const part = message.content[0];
        part.text += delta.content;
        yield emit("response.output_text.delta", { item_id: message.id, output_index: message.output_index, content_index: 0, delta: delta.content });
      }
      for (const call of delta.tool_calls || []) {
        if (!Number.isInteger(call.index) || call.index < 0) invalid("Chat tool call delta is missing a valid index.", "invalid_tool_call");
        const state = tools.get(call.index) || { callId: null, name: "", arguments: "", emittedArguments: 0, started: false };
        tools.set(call.index, state);
        if (call.id) state.callId = call.id;
        if (call.function?.name) state.name += call.function.name;
        if (typeof call.function?.arguments === "string") state.arguments += call.function.arguments;
        if (state.name && state.callId) {
          yield* startTool(state);
          if (state.started && state.descriptor.kind === "function") {
            const deltaArgs = state.arguments.slice(state.emittedArguments || 0);
            if (deltaArgs) {
              state.item.arguments += deltaArgs;
              state.emittedArguments = state.arguments.length;
              yield emit("response.function_call_arguments.delta", { item_id: state.item.id, output_index: state.outputIndex, delta: deltaArgs });
            }
          }
        }
      }
      if (choice.finish_reason) {
        finish = choice.finish_reason;
        if (message) {
          const part = message.content[0];
          yield emit("response.output_text.done", { item_id: message.id, output_index: message.output_index, content_index: 0, text: part.text });
          yield emit("response.content_part.done", { item_id: message.id, output_index: message.output_index, content_index: 0, part: structuredClone(part) });
          message.status = "completed";
          yield emit("response.output_item.done", { output_index: message.output_index, item: structuredClone(message) });
        }
        for (const [, state] of [...tools.entries()].sort(([a], [b]) => a - b)) yield* endTool(state);
      }
    }
    if (!doneSent || !finish) {
      response.status = "failed";
      response.error = { code: "incomplete_stream", message: "Chat upstream stream ended before a terminal completion." };
      terminalSent = true;
      yield emit("response.failed", { response: structuredClone(response) });
      return;
    }
    yield complete(finish === "length" || finish === "content_filter");
  } catch (error) {
    response.status = "failed";
    response.error = { code: error?.code || "upstream_error", message: error?.message || "Chat upstream stream failed." };
    terminalSent = true;
    yield emit("response.failed", { response: structuredClone(response) });
  }
  void terminalSent;
}

export function responseErrorEvent({ requestId = null, model, message, code = "upstream_error", createdAt = Math.floor(Date.now() / 1000) } = {}) {
  const response = responseBase({ id: `resp_${requestId || randomUUID().replaceAll("-", "")}`, model, createdAt, status: "failed", error: { code, message } });
  return { type: "response.failed", sequence_number: 0, response };
}

