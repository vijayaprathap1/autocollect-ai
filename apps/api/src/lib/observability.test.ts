import { describe, expect, it } from "vitest";
import { increment, metricsText, parseSentryDsn, resetMetrics } from "./observability.js";
import { likeContains } from "./like.js";

describe("metrics and sentry hooks", () => {
  it("renders prometheus counters", () => {
    resetMetrics();
    increment("autocollect_jobs_total", 2, { job: "dunning", result: "ok" });
    const text = metricsText();
    expect(text).toContain("autocollect_up 1");
    expect(text).toContain('autocollect_jobs_total{job="dunning",result="ok"} 2');
  });

  it("parses a sentry DSN into an envelope URL", () => {
    const parsed = parseSentryDsn("https://abc123@o1.ingest.sentry.io/99");
    expect(parsed).toEqual({
      envelopeUrl: "https://o1.ingest.sentry.io/api/99/envelope/",
      publicKey: "abc123",
    });
    expect(parseSentryDsn("")).toBeNull();
  });
});

describe("likeContains", () => {
  it("escapes wildcards and wraps the term", () => {
    expect(likeContains(" 100%_done ")).toBe("%100\\%\\_done%");
    expect(likeContains("   ")).toBeNull();
  });
});
