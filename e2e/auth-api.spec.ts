import { test, expect } from "@playwright/test";

test("signup rejects passwords that do not meet the policy", async ({ request }) => {
  const res = await request.post("/api/auth/signup", {
    data: { email: `auth-validation-${Date.now()}@example.com`, password: "short" },
  });
  expect(res.status()).toBe(400);
  expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
});

test("email verification requires a token", async ({ request }) => {
  const res = await request.post("/api/auth/verify-email", { data: {} });
  expect(res.status()).toBe(400);
  expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
});

test("cross-site writes are rejected", async ({ request }) => {
  const res = await request.post("/api/auth/login", {
    data: { email: "a@example.com", password: "x" },
    headers: { origin: "https://evil.example" },
  });
  expect(res.status()).toBe(403);
  expect((await res.json()).error.code).toBe("CSRF_ORIGIN_REJECTED");
});

test("security headers are present on the app shell", async ({ request }) => {
  const res = await request.get("/login");
  expect(res.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(res.headers()["x-content-type-options"]).toBe("nosniff");
});
