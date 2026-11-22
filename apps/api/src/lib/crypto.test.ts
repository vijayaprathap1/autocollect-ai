import { describe, expect, it } from "vitest";
import { decryptWithRing, encryptWithRing, reencryptJson, type KeyRing } from "./crypto.js";

function ring(writeVersion: number, ...materials: string[]): KeyRing {
  const keys = new Map<number, Buffer>();
  materials.forEach((raw, i) => keys.set(i + 1, Buffer.from(raw, "utf8")));
  return { keys, writeVersion };
}

const V1 = "0123456789abcdef0123456789abcdef";
const V2 = "abcdef0123456789abcdef0123456789";

describe("credential encryption", () => {
  it("round-trips with a versioned prefix", () => {
    const keys = ring(1, V1);
    const stored = encryptWithRing("refresh-token", keys);
    expect(stored.startsWith("enc:v1:")).toBe(true);
    expect(decryptWithRing(stored, keys)).toBe("refresh-token");
  });

  it("decrypts an older version after the write key moves", () => {
    const old = encryptWithRing("qbo-secret", ring(1, V1));
    const both = ring(2, V1, V2);
    expect(decryptWithRing(old, both)).toBe("qbo-secret");
    const rewritten = reencryptJson({ access_token: old, plain: "keep" }, both);
    expect(rewritten.changed).toBe(true);
    const value = rewritten.value as { access_token: string; plain: string };
    expect(value.access_token.startsWith("enc:v2:")).toBe(true);
    expect(value.plain).toBe("keep");
    expect(decryptWithRing(value.access_token, both)).toBe("qbo-secret");
  });

  it("leaves plaintext alone when no key is configured", () => {
    expect(encryptWithRing("dev", { keys: new Map(), writeVersion: 0 })).toBe("dev");
  });

  it("refuses ciphertext whose version is not in the ring", () => {
    const stored = encryptWithRing("secret", ring(1, V1));
    const onlyV2: KeyRing = { keys: new Map([[2, Buffer.from(V2, "utf8")]]), writeVersion: 2 };
    expect(() => decryptWithRing(stored, onlyV2)).toThrow(/version 1/);
  });
});
