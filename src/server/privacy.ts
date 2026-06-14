import path from "node:path";

const SECRETISH = /(key|token|secret|password)=?[^&\s]*/gi;

export class PublicError extends Error {
  public readonly code: string;
  public readonly safeMessage: string;

  constructor(code: string, safeMessage: string) {
    super(safeMessage);
    this.name = "PublicError";
    this.code = code;
    this.safeMessage = safeMessage;
  }
}

export function publicErrorMessage(error: unknown): string {
  if (error instanceof PublicError) {
    return error.safeMessage;
  }
  if (error instanceof Error) {
    if (isLocalSqliteError(error.message)) {
      return "Local archive database is not initialized or not reachable.";
    }
    return redactForDisplay(error.message);
  }
  return "Unexpected local error.";
}

export function redactForDisplay(value: string): string {
  return value
    .replace(SECRETISH, "[redacted]")
    .replace(/[A-Fa-f0-9]{64}/g, "[redacted-key]")
    .replace(/[A-Za-z]:\\(?:[^\\\s]+\\)+[^\\\s]+/g, (match) => `[local-file:${path.basename(match)}]`);
}

export function safeBasename(filePath: string | null | undefined): string | null {
  if (!filePath) {
    return null;
  }
  return path.basename(filePath);
}

export function isLocalSqliteError(message: string): boolean {
  return /SQLITE_CANTOPEN|SQLITE_READONLY|SQLITE_IOERR|database is locked|unable to open database file/i.test(message);
}

export function isLocalDatabaseError(message: string): boolean {
  return isLocalSqliteError(message);
}
