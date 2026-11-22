import { describe, expect, it } from "vitest";
import { generateRecoveryCodes, generateTotpSecret, normalizeRecoveryCode, totpCode, verifyTotp } from "./totp.js";

describe("TOTP", () => {
  it("accepts the current code and one step of clock skew", () => {
    const secret = generateTotpSecret();
    const at = Date.UTC(2026, 10, 22, 12, 0, 0);
    const code = totpCode(secret, at);
    expect(verifyTotp(secret, code, at)).toBe(true);
    expect(verifyTotp(secret, code, at + 30_000)).toBe(true);
    expect(verifyTotp(secret, code, at + 90_000)).toBe(false);
    expect(verifyTotp(secret, "000000", at)).toBe(false);
  });

  it("rejects non-numeric input", () => {
    expect(verifyTotp(generateTotpSecret(), "abcdef", Date.now())).toBe(false);
  });

  it("issues recovery codes that normalize without the dash", () => {
    const codes = generateRecoveryCodes(4);
    expect(codes).toHaveLength(4);
    expect(normalizeRecoveryCode(codes[0].toLowerCase())).toBe(codes[0].replace("-", ""));
  });
});
