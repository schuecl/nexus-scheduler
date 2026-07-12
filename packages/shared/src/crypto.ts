import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

// AES-256-GCM for at-rest encryption of LibreChat API keys (REQUIREMENTS
// §4) and other secrets stored in Postgres. AES-256-GCM is a FIPS-approved
// mode (REQUIREMENTS §10) — final FIPS-module wiring happens at the
// container/runtime level (Node built in FIPS mode), not in this code.
//
// `masterKey` is expected to come from API_KEY_ENCRYPTION_KEY (a K8s
// Secret in production, a randomly generated value in the local Compose
// setup — REQUIREMENTS §9) — never hardcoded or defaulted here.

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const SALT = "nexus-scheduler-static-salt-v1"; // fixed salt is fine: the secret is the master key, not the salt

function deriveKey(masterKey: string): Buffer {
  return scryptSync(masterKey, SALT, 32);
}

export function encryptSecret(plaintext: string, masterKey: string): string {
  const key = deriveKey(masterKey);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString("base64");
}

export function decryptSecret(encoded: string, masterKey: string): string {
  const key = deriveKey(masterKey);
  const raw = Buffer.from(encoded, "base64");
  const iv = raw.subarray(0, IV_LENGTH);
  const authTag = raw.subarray(IV_LENGTH, IV_LENGTH + 16);
  const ciphertext = raw.subarray(IV_LENGTH + 16);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
