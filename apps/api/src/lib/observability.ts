import { createHash, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";

type Labels = Record<string, string | number>;

const counters = new Map<string, number>();

function seriesKey(name: string, labels?: Labels): string {
  if (!labels || Object.keys(labels).length === 0) return name;
  const parts = Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k]}`);
  return `${name}{${parts.join(",")}}`;
}

/** Process-local counter. Exposed on GET /metrics. Resets when the process restarts. */
export function increment(name: string, by = 1, labels?: Labels): void {
  const key = seriesKey(name, labels);
  counters.set(key, (counters.get(key) ?? 0) + by);
}

export function metricsSnapshot(): { name: string; labels: string; value: number }[] {
  return [...counters.entries()].map(([key, value]) => {
    const brace = key.indexOf("{");
    if (brace === -1) return { name: key, labels: "", value };
    return { name: key.slice(0, brace), labels: key.slice(brace), value };
  });
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

/** Prometheus text exposition (version 0.0.4). */
export function metricsText(): string {
  const lines = [
    "# HELP autocollect_up 1 while this process is serving metrics",
    "# TYPE autocollect_up gauge",
    "autocollect_up 1",
  ];
  const grouped = new Map<string, { labels: string; value: number }[]>();
  for (const row of metricsSnapshot()) {
    const list = grouped.get(row.name) ?? [];
    list.push({ labels: row.labels, value: row.value });
    grouped.set(row.name, list);
  }
  for (const [name, rows] of grouped) {
    lines.push(`# TYPE ${name} counter`);
    for (const row of rows) {
      if (!row.labels) {
        lines.push(`${name} ${row.value}`);
        continue;
      }
      const inner = row.labels.slice(1, -1);
      const rendered = inner
        .split(",")
        .filter(Boolean)
        .map((pair) => {
          const eq = pair.indexOf("=");
          return `${pair.slice(0, eq)}="${escapeLabel(pair.slice(eq + 1))}"`;
        })
        .join(",");
      lines.push(`${name}{${rendered}} ${row.value}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function parseSentryDsn(dsn: string): { envelopeUrl: string; publicKey: string } | null {
  if (!dsn) return null;
  try {
    const url = new URL(dsn);
    const publicKey = decodeURIComponent(url.username);
    const projectId = url.pathname.replace(/^\//, "").split("/")[0];
    if (!publicKey || !projectId) return null;
    return { envelopeUrl: `${url.origin}/api/${projectId}/envelope/`, publicKey };
  } catch {
    return null;
  }
}

export type CapturedError = {
  message: string;
  name?: string;
  stack?: string;
  context?: Record<string, unknown>;
};

/**
 * Env-gated error sink. With SENTRY_DSN, posts a Sentry envelope (no SDK).
 * With ERROR_WEBHOOK_URL, posts a small JSON body (Slack-compatible incoming
 * webhooks accept `{ "text" }` and also ignore unknown fields).
 * Never throws — monitoring must not take the request down.
 */
export async function captureException(err: unknown, context: Record<string, unknown> = {}): Promise<void> {
  const error: CapturedError = {
    message: err instanceof Error ? err.message : String(err),
    name: err instanceof Error ? err.name : "Error",
    stack: err instanceof Error ? err.stack?.slice(0, 4000) : undefined,
    context,
  };
  increment("autocollect_errors_total", 1, {
    name: (error.name ?? "Error").slice(0, 40),
  });

  const tasks: Promise<unknown>[] = [];
  const sentry = parseSentryDsn(config.sentryDsn);
  if (sentry) {
    const eventId = createHash("sha256").update(`${Date.now()}:${error.message}:${Math.random()}`).digest("hex").slice(0, 32);
    const header = JSON.stringify({ event_id: eventId, dsn: config.sentryDsn, sent_at: new Date().toISOString() });
    const item = JSON.stringify({ type: "event" });
    const event = JSON.stringify({
      event_id: eventId,
      timestamp: Date.now() / 1000,
      platform: "node",
      level: "error",
      server_name: "autocollect-api",
      release: config.version,
      environment: config.nodeEnv,
      message: { formatted: error.message.slice(0, 500) },
      exception: { values: [{ type: error.name, value: error.message.slice(0, 500) }] },
      extra: context,
    });
    const body = `${header}\n${item}\n${event}\n`;
    tasks.push(
      fetch(sentry.envelopeUrl, {
        method: "POST",
        headers: {
          "content-type": "application/x-sentry-envelope",
          "x-sentry-auth": `Sentry sentry_version=7, sentry_key=${sentry.publicKey}, sentry_client=autocollect/1.0`,
        },
        body,
        signal: AbortSignal.timeout(3000),
      }).catch(() => {}),
    );
  }
  if (config.errorWebhookUrl) {
    tasks.push(
      fetch(config.errorWebhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: `AutoCollect error: ${error.message.slice(0, 300)}`,
          service: "autocollect-api",
          version: config.version,
          level: "error",
          message: error.message.slice(0, 500),
          context,
          at: new Date().toISOString(),
        }),
        signal: AbortSignal.timeout(3000),
      }).catch(() => {}),
    );
  }
  if (tasks.length) await Promise.allSettled(tasks);
}

/** Constant-time string compare that does not leak length. */
export function secretsEqual(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}

/** Test helper. */
export function resetMetrics(): void {
  counters.clear();
}
