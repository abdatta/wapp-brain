import { config } from "../config";
import type { ArchiveRepository } from "./repository";
import { initializeSqliteArchive, SqliteArchiveRepository } from "./sqliteRepository";

export function createArchiveRepository(): ArchiveRepository {
  return new SqliteArchiveRepository(config.archive.sqlitePath);
}

export async function initializeArchiveDatabase(): Promise<void> {
  initializeSqliteArchive(config.archive.sqlitePath);
}

export function archiveAdapterLabel(): string {
  return "SQLite";
}
