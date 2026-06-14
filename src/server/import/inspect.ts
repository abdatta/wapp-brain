import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { ImportRequest, ImportWarning } from "../../shared/types";
import { ensureManagedWorkDir } from "../cleanup";
import { config } from "../config";
import { prepareMsgstore } from "./decrypt";
import { parseWhatsAppSource } from "./parser";
import { openReadableSQLite } from "./sqlite";

export interface InspectSummary {
  supported: boolean;
  schemaKind: "legacy" | "modern" | "unsupported";
  encryptedInput: boolean;
  decryptedDuringInspect: boolean;
  counts: {
    tables: number;
    contacts: number;
    chats: number;
    warnings: number;
  };
  tables: Array<{ name: string; columns: string[] }>;
  warnings: ImportWarning[];
}

export async function inspectArchive(request: ImportRequest): Promise<InspectSummary> {
  await ensureManagedWorkDir();
  const outputDir = path.resolve(config.workDir, "decrypted");
  await mkdir(outputDir, { recursive: true });
  const prepared = await prepareMsgstore({
    encryptedPath: request.msgstorePath,
    key: request.key,
    keyPath: request.keyPath,
    outputDir,
    keepDecrypted: request.keepDecrypted
  });
  const msgstoreDb = openReadableSQLite(prepared.sqlitePath, "msgstore");
  const waDb = request.waPath ? openReadableSQLite(request.waPath, "wa.db") : null;
  try {
    const parsed = parseWhatsAppSource(msgstoreDb, waDb);
    const tables = Object.entries(parsed.schemaReport)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, columns]) => ({ name, columns }));
    return {
      supported: parsed.supported,
      schemaKind: inferSchemaKind(parsed.schemaReport, parsed.supported),
      encryptedInput: /\.crypt15$/i.test(request.msgstorePath),
      decryptedDuringInspect: prepared.createdByDecryption,
      counts: {
        tables: tables.length,
        contacts: parsed.contacts.length,
        chats: parsed.chats.length,
        warnings: parsed.warnings.length
      },
      tables,
      warnings: parsed.warnings
    };
  } finally {
    msgstoreDb.close();
    waDb?.close();
    await prepared.cleanup();
  }
}

function inferSchemaKind(schemaReport: Record<string, string[]>, supported: boolean): "legacy" | "modern" | "unsupported" {
  if (!supported) {
    return "unsupported";
  }
  if (schemaReport.messages?.includes("key_remote_jid")) {
    return "legacy";
  }
  if (schemaReport.message && schemaReport.chat && schemaReport.jid) {
    return "modern";
  }
  return "unsupported";
}
