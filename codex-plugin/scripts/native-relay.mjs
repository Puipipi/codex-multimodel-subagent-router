import { createHash } from "node:crypto";

export const RELAY_TOOL = "relay_external_agent_payload";
export const DEFAULT_RELAY_TTL_MS = 15 * 60_000;
export const DEFAULT_RELAY_MAX_BYTES = 8 * 1024 * 1024;
export const DEFAULT_RELAY_MAX_ENTRIES = 256;
export const DEFAULT_RELAY_FAILURE_BACKOFF_MS = 60_000;

export function buildRelayRequest(item, { model }) {
  return {
    model,
    stream: true,
    store: false,
    instructions:
      "You are a transport relay. Do not execute or answer the delegated task. " +
      "Call relay_external_agent_payload exactly once with the exact plaintext after the " +
      "Payload: label in the supplied collaboration message. Preserve every character.",
    input: [item],
    tools: [{
      type: "function",
      name: RELAY_TOOL,
      description: "Return a decrypted collaboration payload to the local model router.",
      parameters: {
        type: "object",
        properties: { payload: { type: "string" } },
        required: ["payload"],
        additionalProperties: false,
      },
      strict: true,
    }],
    tool_choice: { type: "function", name: RELAY_TOOL },
  };
}

export function parseRelayArguments(value) {
  try {
    const args = typeof value === "string" ? JSON.parse(value) : value;
    return typeof args?.payload === "string" ? args.payload : undefined;
  } catch {
    return undefined;
  }
}

export function parseRelayPayload(payload) {
  const output = payload?.item
    ? [payload.item]
    : Array.isArray(payload?.output)
      ? payload.output
      : Array.isArray(payload?.response?.output)
        ? payload.response.output
        : [];
  const call = output.find((item) => item?.type === "function_call" && item.name === RELAY_TOOL);
  return call ? parseRelayArguments(call.arguments) : undefined;
}

export function usageFromPayload(payload) {
  return payload?.usage || payload?.response?.usage || null;
}

export function parseRelaySse(text) {
  const events = text.split(/\r?\n\r?\n/);
  const relayItems = new Set();
  let argumentDeltas = "";
  let usage = null;
  let found;
  for (const rawEvent of events) {
    const data = rawEvent
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();
    if (!data || data === "[DONE]") continue;
    let event;
    try { event = JSON.parse(data); } catch { continue; }
    usage = usageFromPayload(event) || usage;
    if (event?.type === "response.output_item.added"
      && event.item?.type === "function_call"
      && event.item.name === RELAY_TOOL) {
      if (event.item.id) relayItems.add(event.item.id);
      if (event.item.call_id) relayItems.add(event.item.call_id);
    }
    const related = relayItems.size === 0
      || relayItems.has(event?.item_id)
      || relayItems.has(event?.call_id);
    if (event?.type === "response.function_call_arguments.delta"
      && related && typeof event.delta === "string") {
      argumentDeltas += event.delta;
    }
    if (event?.type === "response.function_call_arguments.done" && related) {
      const completed = parseRelayArguments(event.arguments);
      if (completed !== undefined) found = completed;
    }
    if (event?.item?.name === RELAY_TOOL && found === undefined) {
      const completed = parseRelayArguments(event.item.arguments);
      if (completed !== undefined) found = completed;
    }
    if (found === undefined) {
      const direct = parseRelayPayload(event);
      if (direct !== undefined) found = direct;
    }
  }
  if (found === undefined) {
    const accumulated = parseRelayArguments(argumentDeltas);
    if (accumulated !== undefined) found = accumulated;
  }
  return found === undefined ? undefined : { payload: found, usage };
}

export function parseRelayBody(buffer, contentType = "") {
  const text = Buffer.isBuffer(buffer) ? buffer.toString("utf8") : String(buffer);
  const looksSse = /^(?:event|data):/m.test(text);
  if (/text\/event-stream/i.test(contentType) || looksSse) return parseRelaySse(text);
  let json;
  try { json = JSON.parse(text); } catch { return parseRelaySse(text); }
  const payload = parseRelayPayload(json);
  return payload === undefined ? undefined : { payload, usage: usageFromPayload(json) };
}

export function relayCacheKey({ authorization = "", account = "", ciphertext }) {
  const accountScope = createHash("sha256")
    .update(String(authorization)).update("\0").update(String(account)).digest("base64url");
  return { accountScope, key: createHash("sha256").update(accountScope).update("\0").update(ciphertext).digest("base64url") };
}

export class RelayCache {
  constructor({
    ttlMs = DEFAULT_RELAY_TTL_MS,
    maxBytes = DEFAULT_RELAY_MAX_BYTES,
    maxEntries = DEFAULT_RELAY_MAX_ENTRIES,
    failureBackoffMs = DEFAULT_RELAY_FAILURE_BACKOFF_MS,
    now = Date.now,
  } = {}) {
    this.ttlMs = ttlMs;
    this.maxBytes = maxBytes;
    this.maxEntries = maxEntries;
    this.failureBackoffMs = failureBackoffMs;
    this.now = now;
    this.entries = new Map();
    this.inFlight = new Map();
    this.failures = new Map();
    this.bytes = 0;
    this.metrics = { hits: 0, misses: 0, coalesced: 0, expired: 0, evicted: 0, failures: 0 };
  }

  purge() {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.bytes -= entry.bytes;
        this.entries.delete(key);
        this.metrics.expired += 1;
      }
    }
    for (const [key, expiresAt] of this.failures) if (expiresAt <= now) this.failures.delete(key);
  }

  get(key) {
    this.purge();
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.metrics.hits += 1;
    return entry.payload;
  }

  remember(key, payload) {
    this.purge();
    const bytes = Buffer.byteLength(payload);
    const previous = this.entries.get(key);
    if (previous) {
      this.bytes -= previous.bytes;
      this.entries.delete(key);
    }
    this.entries.set(key, { payload, bytes, expiresAt: this.now() + this.ttlMs });
    this.bytes += bytes;
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.entries.keys().next().value;
      const entry = this.entries.get(oldest);
      this.bytes -= entry?.bytes || 0;
      this.entries.delete(oldest);
      this.metrics.evicted += 1;
    }
  }

  fail(key) {
    this.failures.set(key, this.now() + this.failureBackoffMs);
    this.metrics.failures += 1;
  }

  backedOff(key) {
    this.purge();
    return this.failures.has(key);
  }

  async run(key, operation) {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    if (this.backedOff(key)) {
      const error = new Error("Native relay is temporarily rate limited");
      error.status = 429;
      throw error;
    }
    if (this.inFlight.has(key)) {
      this.metrics.coalesced += 1;
      return this.inFlight.get(key);
    }
    this.metrics.misses += 1;
    const promise = (async () => {
      try {
        const payload = await operation();
        this.remember(key, payload);
        return payload;
      } catch (error) {
        if (error?.status === 429) this.fail(key);
        throw error;
      } finally {
        this.inFlight.delete(key);
      }
    })();
    this.inFlight.set(key, promise);
    return promise;
  }
}
