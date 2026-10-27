export function parseUsageFromSse(text) {
  for (const block of String(text || "").split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart()).join("\n").trim();
    if (!data || data === "[DONE]") continue;
    try {
      const event = JSON.parse(data);
      if (event?.type === "response.completed") return event.response?.usage || event.usage || null;
    } catch { /* ignore malformed event */ }
  }
  return null;
}

export function sumUsage(list) {
  const total = { requests: 0, input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  for (const usage of Array.isArray(list) ? list : []) {
    if (!usage || typeof usage !== "object") continue;
    total.requests += 1;
    total.input_tokens += Number(usage.input_tokens || 0);
    total.output_tokens += Number(usage.output_tokens || 0);
    total.total_tokens += Number(usage.total_tokens || 0);
  }
  return total;
}

export function usageSummary(perRequest) {
  const present = (Array.isArray(perRequest) ? perRequest : []).filter(Boolean);
  return {
    requests: Array.isArray(perRequest) ? perRequest.length : 0,
    present: present.length,
    per_request: Array.isArray(perRequest) ? perRequest : [],
    total: sumUsage(present),
    known: present.length > 0,
  };
}
