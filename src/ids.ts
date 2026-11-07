import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"; // Crockford base32, lower case

// Short random ids with a readable prefix: tm_, pe_, se_, su_, ru_, ap_, gr_, sc_, ch_.
export function newId(prefix: string): string {
  const bytes = randomBytes(12);
  let out = "";
  for (const b of bytes) out += ALPHABET[b & 31];
  return `${prefix}_${out}`;
}
