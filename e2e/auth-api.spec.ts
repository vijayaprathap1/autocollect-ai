import { test, expect } from "@playwright/test";

const API_URL = process.env.PLAYWRIGHT_API_URL ?? "http://localhost:4000";

test("signup rejects passwords that do not meet the auth policy", async ({ request }) => {
  const response = await request.post(`${API_URL}/auth/signup`, {
    data: {
      email: `auth-validation-${Date.now()}@example.com`,
      password: "short",
    },
  });

  expect(response.status()).toBe(400);
  const body = await response.json();
  expect(body.error.code).toBe("VALIDATION_ERROR");
});

test("email verification requires a token", async ({ request }) => {
  const response = await request.post(`${API_URL}/auth/verify-email`, {
    data: {},
  });

  expect(response.status()).toBe(400);
  const body = await response.json();
  expect(body.error.code).toBe("BAD_REQUEST");
  expect(body.error.message).toBe("Token is required");
});