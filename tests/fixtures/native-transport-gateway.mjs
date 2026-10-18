import { createInterface } from "node:readline";
import { readFile } from "node:fs/promises";
import { createNativeGateway } from "../../scripts/native-gateway.mjs";

const upstreamPort = Number(process.argv[2]);
const logPath = process.argv[3];
if (!Number.isInteger(upstreamPort) || upstreamPort < 1 || !logPath) {
  process.stdout.write('{"type":"fixture_error","code":"INVALID_FIXTURE_INPUT"}\n');
  process.exit(2);
}

const gateway = createNativeGateway({
  token: "native-transport-test-token",
  deepSeekOnly: true,
  deepSeekBase: `http://127.0.0.1:${upstreamPort}`,
  deepSeekTimeoutMs: 180,
  logPath,
  deepSeekAuthResolver: async () => ({ mode: "api-key", headers: { authorization: "Bearer fixture-only" } }),
});

try {
  const port = await gateway.start();
  process.stdout.write(`${JSON.stringify({ type: "ready", port })}\n`);
  const input = createInterface({ input: process.stdin });
  let closing = false;
  input.on("line", async (line) => {
    if (line !== "shutdown" || closing) return;
    closing = true;
    input.close();
    process.stdin.destroy();
    try {
      await gateway.close();
      const logLines = (await readFile(logPath, "utf8")).trim().split(/\r?\n/).filter(Boolean);
      const events = logLines.map((line) => JSON.parse(line)).flatMap((event) => {
        if (event.kind === "error") {
          const knownCode = ["ECONNREFUSED", "ECONNRESET", "UND_ERR_SOCKET"].includes(event.code) ? event.code : null;
          return [{ kind: "error", status: Number.isInteger(event.status) ? event.status : null, code: knownCode }];
        }
        if (["deepseek_timeout", "deepseek"].includes(event.kind)) {
          return [{ kind: event.kind, status: Number.isInteger(event.status) ? event.status : null }];
        }
        return [];
      });
      const summary = `${JSON.stringify({
        type: "summary",
        stats: {
          requests: gateway.stats.requests,
          deepseek_requests: gateway.stats.deepseek_requests,
          relay_calls: gateway.stats.relay_calls,
          statuses: gateway.stats.statuses.filter((status) => Number.isInteger(status)),
        },
        events,
      })}\n`;
      process.stdout.write(summary);
    } catch {
      process.stdout.write('{"type":"fixture_error","code":"SUMMARY_FAILED"}\n');
      process.exitCode = 1;
    }
  });
} catch {
  process.stdout.write('{"type":"fixture_error","code":"GATEWAY_START_FAILED"}\n');
  process.exitCode = 1;
}
