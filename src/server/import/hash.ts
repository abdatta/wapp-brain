import { createHash } from "node:crypto";

export function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function stableMessageKey(parts: Array<string | number | boolean | null | undefined>): string {
  return sha256Text(parts.map((part) => (part == null ? "" : String(part))).join("\u001f"));
}
