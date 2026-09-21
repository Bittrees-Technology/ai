import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHmac,
} from "node:crypto";
export class Vault {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error("A 32-byte storage key is required");
  }
  seal(value: unknown, purpose: string): Buffer {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(purpose));
    const body = Buffer.concat([
      cipher.update(JSON.stringify(value), "utf8"),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]);
  }
  open<T>(value: Buffer, purpose: string): T {
    const cipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      value.subarray(0, 12),
    );
    cipher.setAAD(Buffer.from(purpose));
    cipher.setAuthTag(value.subarray(12, 28));
    return JSON.parse(
      Buffer.concat([
        cipher.update(value.subarray(28)),
        cipher.final(),
      ]).toString("utf8"),
    ) as T;
  }
  fingerprint(value: unknown): string {
    return createHmac("sha256", this.key)
      .update(canonical(value))
      .digest("hex");
  }
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value) ?? "null";
}
