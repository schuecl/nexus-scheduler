import { describe, expect, it } from "vitest";
import {
  decryptSecret,
  encryptSecret,
  generateResetToken,
  generateWebhookSecret,
  hashResetToken,
  signWebhookPayload,
} from "./crypto.js";

const VALID_KEY = "a-valid-32-character-master-key!!";

describe("encryptSecret / decryptSecret", () => {
  it("round-trips a plaintext secret", () => {
    const plaintext = "sk-super-secret-librechat-api-key";
    const encrypted = encryptSecret(plaintext, VALID_KEY);
    expect(encrypted).not.toContain(plaintext);
    expect(decryptSecret(encrypted, VALID_KEY)).toBe(plaintext);
  });

  it("round-trips an empty string", () => {
    const encrypted = encryptSecret("", VALID_KEY);
    expect(decryptSecret(encrypted, VALID_KEY)).toBe("");
  });

  it("produces different ciphertext for the same plaintext on each call (random IV)", () => {
    const a = encryptSecret("same plaintext", VALID_KEY);
    const b = encryptSecret("same plaintext", VALID_KEY);
    expect(a).not.toBe(b);
    expect(decryptSecret(a, VALID_KEY)).toBe("same plaintext");
    expect(decryptSecret(b, VALID_KEY)).toBe("same plaintext");
  });

  it("fails to decrypt with the wrong master key", () => {
    const encrypted = encryptSecret("secret", VALID_KEY);
    const otherKey = "a-different-32-character-master!!";
    expect(() => decryptSecret(encrypted, otherKey)).toThrow();
  });

  it("fails to decrypt tampered ciphertext (GCM auth tag check)", () => {
    const encrypted = encryptSecret("secret", VALID_KEY);
    const raw = Buffer.from(encrypted, "base64");
    // Flip a bit somewhere in the ciphertext portion (past IV + auth tag).
    raw[raw.length - 1] = raw[raw.length - 1]! ^ 0xff;
    const tampered = raw.toString("base64");
    expect(() => decryptSecret(tampered, VALID_KEY)).toThrow();
  });

  // Regression for #16: an empty or too-short master key used to derive
  // a silently "working" but globally-predictable key via
  // scryptSync('', SALT) instead of failing loudly.
  it("throws on an empty master key instead of silently deriving a predictable key", () => {
    expect(() => encryptSecret("secret", "")).toThrow(/at least 32 characters/);
  });

  it("throws on a master key shorter than 32 characters", () => {
    expect(() => encryptSecret("secret", "short-key")).toThrow(/at least 32 characters/);
  });

  it("accepts a master key exactly at the 32-character minimum", () => {
    const exactly32 = "12345678901234567890123456789012";
    expect(exactly32).toHaveLength(32);
    const encrypted = encryptSecret("secret", exactly32);
    expect(decryptSecret(encrypted, exactly32)).toBe("secret");
  });
});

describe("generateWebhookSecret", () => {
  it("generates a 64-character hex string (256 bits)", () => {
    const secret = generateWebhookSecret();
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
  });

  it("generates a different value on each call", () => {
    expect(generateWebhookSecret()).not.toBe(generateWebhookSecret());
  });
});

describe("signWebhookPayload", () => {
  it("produces a deterministic HMAC-SHA256 hex digest for the same body and secret", () => {
    const body = JSON.stringify({ runId: "abc", status: "SUCCESS" });
    const secret = generateWebhookSecret();
    const sigA = signWebhookPayload(body, secret);
    const sigB = signWebhookPayload(body, secret);
    expect(sigA).toBe(sigB);
    expect(sigA).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces a different signature for a different body", () => {
    const secret = generateWebhookSecret();
    const sigA = signWebhookPayload(JSON.stringify({ a: 1 }), secret);
    const sigB = signWebhookPayload(JSON.stringify({ a: 2 }), secret);
    expect(sigA).not.toBe(sigB);
  });

  it("produces a different signature for a different secret", () => {
    const body = JSON.stringify({ a: 1 });
    const sigA = signWebhookPayload(body, generateWebhookSecret());
    const sigB = signWebhookPayload(body, generateWebhookSecret());
    expect(sigA).not.toBe(sigB);
  });
});

describe("generateResetToken / hashResetToken", () => {
  it("generates a 64-character hex token", () => {
    expect(generateResetToken()).toMatch(/^[0-9a-f]{64}$/);
  });

  it("generates a different token on each call", () => {
    expect(generateResetToken()).not.toBe(generateResetToken());
  });

  it("hashes the same token deterministically", () => {
    const token = generateResetToken();
    expect(hashResetToken(token)).toBe(hashResetToken(token));
  });

  it("produces different hashes for different tokens", () => {
    expect(hashResetToken(generateResetToken())).not.toBe(hashResetToken(generateResetToken()));
  });
});
