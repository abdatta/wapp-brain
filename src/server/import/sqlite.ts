import Database from "better-sqlite3";
import fs from "node:fs";
import { PublicError } from "../privacy";

export interface SQLiteColumnInfo {
  name: string;
  type: string;
  notnull: boolean;
  pk: boolean;
}

export interface SQLiteInspection {
  path: string;
  tables: Map<string, SQLiteColumnInfo[]>;
}

export function openReadableSQLite(filePath: string, kind: string): Database.Database {
  if (!fs.existsSync(filePath)) {
    throw new PublicError("INPUT_MISSING", `${kind} file was not found.`);
  }
  const stats = fs.statSync(filePath);
  if (!stats.isFile() || stats.size === 0) {
    throw new PublicError("INPUT_INVALID", `${kind} file is empty or not readable.`);
  }
  try {
    const db = new Database(filePath, { readonly: true, fileMustExist: true });
    const quickCheck = db.prepare("PRAGMA quick_check").pluck().get();
    if (quickCheck !== "ok") {
      db.close();
      throw new PublicError("SQLITE_CHECK_FAILED", `${kind} did not pass SQLite quick_check.`);
    }
    return db;
  } catch (error) {
    if (error instanceof PublicError) {
      throw error;
    }
    throw new PublicError("SQLITE_OPEN_FAILED", `${kind} is not a readable SQLite database.`);
  }
}

export function inspectSQLite(db: Database.Database, filePath = ""): SQLiteInspection {
  const rows = db
    .prepare(
      `SELECT name
       FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name`
    )
    .all() as Array<{ name: string }>;
  const tables = new Map<string, SQLiteColumnInfo[]>();
  for (const row of rows) {
    const columns = db.prepare(`PRAGMA table_info(${quoteIdentifier(row.name)})`).all() as Array<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }>;
    tables.set(
      row.name,
      columns.map((column) => ({
        name: column.name,
        type: column.type,
        notnull: Boolean(column.notnull),
        pk: Boolean(column.pk)
      }))
    );
  }
  return { path: filePath, tables };
}

export function hasTable(inspection: SQLiteInspection, table: string): boolean {
  return inspection.tables.has(table);
}

export function columnsFor(inspection: SQLiteInspection, table: string): Set<string> {
  return new Set((inspection.tables.get(table) ?? []).map((column) => column.name));
}

export function hasColumns(inspection: SQLiteInspection, table: string, columns: string[]): boolean {
  const available = columnsFor(inspection, table);
  return columns.every((column) => available.has(column));
}

export function pickColumn(columns: Set<string>, candidates: string[]): string | null {
  return candidates.find((candidate) => columns.has(candidate)) ?? null;
}

export function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

export function selectColumns(table: string, columns: Set<string>, candidates: string[]): string {
  const selected = candidates.filter((candidate) => columns.has(candidate));
  if (!selected.length) {
    return "";
  }
  return selected.map((column) => `${quoteIdentifier(table)}.${quoteIdentifier(column)} AS ${quoteIdentifier(column)}`).join(", ");
}

export function tableColumnNames(inspection: SQLiteInspection): Record<string, string[]> {
  return Object.fromEntries([...inspection.tables].map(([table, columns]) => [table, columns.map((column) => column.name)]));
}
