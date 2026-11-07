// Seals small secrets (Slack signing secrets, tokens) at rest with AES-256-GCM.
// The key comes from PEEBLO_SECRET_KEY (32 bytes, base64) and never leaves core.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { config } from "./config.ts";

const key = (): Buffer => {
  const k = Buffer.from(config.secretKey, "base64");
  if (k.length !== 32) throw new Error("PEEBLO_SECRET_KEY must be 32 bytes, base64 encoded (openssl rand -base64 32)");
  return k;
};

export function seal(value: unknown): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([c.update(JSON.stringify(value), "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]);
}

export function unseal<T>(blob: Buffer): T {
  const d = createDecipheriv("aes-256-gcm", key(), blob.subarray(0, 12));
  d.setAuthTag(blob.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(blob.subarray(28)), d.final()]).toString("utf8"));
}
