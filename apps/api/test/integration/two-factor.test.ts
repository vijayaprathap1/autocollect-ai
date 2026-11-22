/**
 * TOTP enrollment and the login challenge. Opt-in, so accounts without it
 * still receive a session from POST /auth/login.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { base32Decode, totpCode } from "../../src/lib/totp.js";

process.env.WEB_ORIGIN = "http://localhost:5175";
process.env.APP_URL = "http://localhost:4000";

type App = Awaited<ReturnType<typeof import("../../src/app.js").buildApp>>;
let app: App;
let db: typeof import("../../src/lib/db.js");
const ORIGIN = { origin: "http://localhost:5175" };
const mail: string[] = [];

class Jar {
  cookies = new Map<string, string>();
  header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  store(setCookie: string | string[] | undefined) {
    for (const c of [setCookie ?? []].flat()) {
      const [pair, ...attrs] = c.split(";");
      const [k, ...v] = pair.split("=");
      if (attrs.some((a) => /max-age=0/i.test(a.trim()))) this.cookies.delete(k.trim());
      else this.cookies.set(k.trim(), v.join("="));
    }
  }
}

async function call(jar: Jar | null, method: "GET" | "POST", url: string, body?: unknown) {
  const res = await app.inject({
    method,
    url,
    payload: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(jar ? { cookie: jar.header(), "x-requested-with": "test" } : {}),
      ...ORIGIN,
    },
  });
  jar?.store(res.headers["set-cookie"] as string | string[] | undefined);
  return { status: res.statusCode, body: res.body ? (JSON.parse(res.body) as Record<string, unknown>) : {}, setCookie: res.headers["set-cookie"] };
}

describe("TOTP two-factor", () => {
  beforeAll(async () => {
    const { migrate } = await import("../../src/scripts/migrate.js");
    await migrate();
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      mail.push(args.map(String).join(" "));
    });
    db = await import("../../src/lib/db.js");
    const mod = await import("../../src/app.js");
    app = mod.buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await db?.closeDb();
  });

  it("requires a code after the password and accepts a recovery code once", async () => {
    const email = `totp-${Date.now().toString(36)}@example.com`;
    const password = "Str0ngPass!";
    const signedUp = await call(null, "POST", "/auth/signup", { email, password, name: "Totp", organizationName: "Totp Co" });
    expect(signedUp.status).toBe(202);
    const link = [...mail.join("\n").matchAll(/verify-email\?([^\s]+)/g)].pop();
    const token = new URLSearchParams(link?.[1] ?? "").get("token");
    const jar = new Jar();
    expect((await call(jar, "POST", "/auth/verify-email", { token })).status).toBe(200);

    const setup = await call(jar, "POST", "/auth/2fa/setup", {});
    expect(setup.status).toBe(200);
    const secret = base32Decode(String(setup.body.secret));
    const enabled = await call(jar, "POST", "/auth/2fa/enable", { code: totpCode(secret) });
    expect(enabled.status).toBe(200);
    const recoveryCodes = enabled.body.recoveryCodes as string[];
    expect(recoveryCodes).toHaveLength(10);

    await call(jar, "POST", "/auth/logout");
    const login = await call(null, "POST", "/auth/login", { email, password, rememberMe: true });
    expect(login.status).toBe(200);
    expect(login.body.twoFactorRequired).toBe(true);
    expect(login.setCookie).toBeUndefined();

    const bad = await call(null, "POST", "/auth/2fa/verify", { challengeToken: login.body.challengeToken, code: "000000" });
    expect(bad.status).toBe(401);

    const again = await call(null, "POST", "/auth/login", { email, password, rememberMe: true });
    const session = new Jar();
    const ok = await call(session, "POST", "/auth/2fa/verify", {
      challengeToken: again.body.challengeToken,
      code: recoveryCodes[0],
    });
    expect(ok.status).toBe(200);
    expect((await call(session, "GET", "/me")).status).toBe(200);

    const third = await call(null, "POST", "/auth/login", { email, password });
    const reused = await call(null, "POST", "/auth/2fa/verify", {
      challengeToken: third.body.challengeToken,
      code: recoveryCodes[0],
    });
    expect(reused.status).toBe(401);
  });
});
