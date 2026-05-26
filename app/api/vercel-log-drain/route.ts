export const runtime = "nodejs";

type VercelLog = Record<string, unknown> & {
  timestamp?: number;
  source?: string;
  projectId?: string;
  projectName?: string;
  level?: string;
  environment?: string;
};

function safeLabel(value: unknown, fallback = "unknown") {
  const raw = value == null ? "" : String(value);
  const normalized = raw.trim();
  const finalValue = normalized.length > 0 ? normalized : fallback;
  return finalValue.replace(/[^a-zA-Z0-9_:.-]/g, "_").slice(0, 120);
}

function vercelMsToLokiNs(timestampMs: unknown): string {
  const ms = Number(timestampMs);
  const safeMs = Number.isFinite(ms) ? Math.trunc(ms) : Date.now();
  // Avoid `100n` BigInt literals so the TS target can be < ES2020.
  return String(BigInt(safeMs) * BigInt(1_000_000));
}

function parseVercelLogs(body: string): VercelLog[] {
  const trimmed = body.trim();
  if (!trimmed) return [];

  // Supports JSON array format too, but we will configure Vercel as NDJSON.
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) {
      throw new Error("Expected JSON array of log objects.");
    }
    return parsed as VercelLog[];
  }

  // NDJSON: one JSON object per line.
  const logs: VercelLog[] = [];
  const lines = trimmed.split("\n");
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      logs.push(JSON.parse(line) as VercelLog);
    } catch {
      const preview = line.slice(0, 200);
      throw new Error(
        `Invalid NDJSON line: ${preview}${line.length > 200 ? "..." : ""}`
      );
    }
  }
  return logs;
}

export async function POST(req: Request) {
  // Vercel uses `x-vercel-verify` during drain setup. Always respond with 200 and echo this header.
  const vercelVerify = req.headers.get("x-vercel-verify");
  if (vercelVerify) {
    return new Response("ok", {
      status: 200,
      headers: { "x-vercel-verify": vercelVerify },
    });
  }

  const expectedDrainToken = process.env.VERCEL_DRAIN_TOKEN;
  if (!expectedDrainToken) {
    return new Response("server misconfigured", { status: 500 });
  }

  const drainToken = req.headers.get("x-drain-token");
  if (drainToken !== expectedDrainToken) {
    return new Response("unauthorized", { status: 401 });
  }

  const grafanaPushUrl = process.env.GRAFANA_LOKI_PUSH_URL;
  const grafanaLokiUser = process.env.GRAFANA_LOKI_USER;
  const grafanaCloudToken = process.env.GRAFANA_CLOUD_TOKEN;
  if (!grafanaPushUrl || !grafanaLokiUser || !grafanaCloudToken) {
    return new Response("server misconfigured", { status: 500 });
  }

  let logs: VercelLog[];
  try {
    const body = await req.text();
    logs = parseVercelLogs(body);
  } catch (err) {
    console.error("Failed to parse Vercel drain payload:", err);
    return new Response("invalid log payload", { status: 400 });
  }

  if (logs.length === 0) return new Response("ok", { status: 200 });

  // Loki push expects: { streams: [{ stream: labels, values: [[timestampNs, line], ...] }, ...] }
  // To reduce request size, batch by identical label sets.
  const streamByLabels = new Map<
    string,
    { stream: Record<string, string>; values: Array<[string, string]> }
  >();

  for (const log of logs) {
    // Keep labels low-cardinality.
    // Do NOT label requestId, path, message, traceId. Those stay inside the JSON log line.
    const labels = {
      job: "vercel-log-drain",
      source: safeLabel(log.source),
      level: safeLabel(log.level),
      environment: safeLabel(log.environment),
      projectName: safeLabel(log.projectName ?? log.projectId),
    };

    const logLine = JSON.stringify({
      ...log,
      receivedBy: "vercel-loki-adapter",
    });

    const key = JSON.stringify(labels);
    const existing = streamByLabels.get(key);
    const value: [string, string] = [vercelMsToLokiNs(log.timestamp), logLine];

    if (existing) {
      existing.values.push(value);
    } else {
      streamByLabels.set(key, { stream: labels, values: [value] });
    }
  }

  const streams = Array.from(streamByLabels.values());

  const auth = Buffer.from(
    `${grafanaLokiUser}:${grafanaCloudToken}`
  ).toString("base64");

  let res: Response;
  try {
    res = await fetch(grafanaPushUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify({ streams }),
    });
  } catch (err) {
    console.error("Failed to push logs to Loki (fetch error):", err);
    return new Response("loki push failed", { status: 500 });
  }

  if (!res.ok) {
    const errorText = await res.text();
    console.error("Failed to push logs to Loki:", errorText);
    return new Response(`loki error: ${errorText}`, { status: 500 });
  }

  return new Response("ok", { status: 200 });
}