import type { ImportWarning } from "../../shared/types";

export function liveWarning(
  code: string,
  message: string,
  context?: Record<string, unknown> | null,
  severity: ImportWarning["severity"] = "warning"
): ImportWarning {
  return {
    severity,
    code,
    entityType: "live_sync",
    sourceTable: "wa-web",
    sourceRowId: safeIdentifier(context?.sourceRowId),
    message: message.slice(0, 500),
    context: sanitizeLiveContext(context)
  };
}

export function sanitizeLiveContext(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return sanitizeObject(value as Record<string, unknown>);
}

function sanitizeObject(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !/body|text|message|payload|auth|creds|credential|key|secret|qr/i.test(key))
      .map(([key, nested]) => [key, sanitizeValue(nested)])
  );
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === "string") {
    return safeIdentifier(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item));
  }
  if (value && typeof value === "object") {
    return sanitizeObject(value as Record<string, unknown>);
  }
  return value;
}

function safeIdentifier(value: unknown): string | null {
  if (typeof value !== "string" || !value) {
    return null;
  }
  if (value.length <= 128 && !/\s/.test(value)) {
    return value;
  }
  return `${value.slice(0, 32)}...`;
}
