import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { WaContactRow, WaContactsSummary } from "../../shared/types";
import { config } from "../config";
import { ensureManagedWorkDir } from "../cleanup";
import { PublicError } from "../privacy";
import { prepareSidecarDatabase } from "./decrypt";
import { columnsFor, hasTable, inspectSQLite, openReadableSQLite, pickColumn, quoteIdentifier } from "./sqlite";

export interface WaContactsOptions {
  waPath: string;
  key?: string | null;
  keyPath?: string | null;
  keepDecrypted?: boolean;
}

const NAME_COLUMNS = ["display_name", "wa_name", "notify_name", "given_name", "family_name", "sort_name"];
const NUMBER_COLUMNS = ["number", "phone_number"];

export async function listWaContacts(options: WaContactsOptions): Promise<WaContactsSummary> {
  await ensureManagedWorkDir();
  const outputDir = path.resolve(config.workDir, "decrypted");
  await mkdir(outputDir, { recursive: true });
  const prepared = await prepareSidecarDatabase({
    encryptedPath: options.waPath,
    key: options.key,
    keyPath: options.keyPath,
    outputDir,
    keepDecrypted: options.keepDecrypted,
    label: "contacts database",
    outputPrefix: "wa"
  });
  const db = openReadableSQLite(prepared.sqlitePath, "wa.db");
  try {
    const inspection = inspectSQLite(db, prepared.sqlitePath);
    if (!hasTable(inspection, "wa_contacts")) {
      throw new PublicError("WA_CONTACTS_MISSING", "This database did not contain a wa_contacts table.");
    }
    const columns = columnsFor(inspection, "wa_contacts");
    const jidColumn = pickColumn(columns, ["jid", "raw_string", "wa_id", "number"]);
    if (!jidColumn) {
      throw new PublicError("WA_CONTACTS_JID_MISSING", "wa_contacts did not include a supported JID column.");
    }
    const lidColumn = pickColumn(columns, ["lid_jid", "lid", "lid_raw_string"]);
    const selected = [jidColumn, ...(lidColumn ? [lidColumn] : []), ...NAME_COLUMNS, ...NUMBER_COLUMNS].filter(
      (column, index, all) => columns.has(column) && all.indexOf(column) === index
    );
    const rows = db
      .prepare(`SELECT ${selected.map(quoteIdentifier).join(", ")} FROM ${quoteIdentifier("wa_contacts")}`)
      .all() as Array<Record<string, unknown>>;
    const contacts: WaContactRow[] = rows
      .map((row) => {
        const jid = firstNonEmptyString(row, [jidColumn]);
        const displayName = firstNonEmptyString(row, NAME_COLUMNS);
        return {
          jid: jid ?? "",
          lid: lidColumn ? firstNonEmptyString(row, [lidColumn]) : null,
          number: firstNonEmptyString(row, NUMBER_COLUMNS),
          displayName,
          resolved: Boolean(displayName)
        };
      })
      .filter((contact) => contact.jid.length > 0);
    const resolvedCount = contacts.filter((contact) => contact.resolved).length;
    return {
      table: "wa_contacts",
      decryptedDuringInspect: prepared.createdByDecryption,
      totalContacts: contacts.length,
      resolvedCount,
      unresolvedCount: contacts.length - resolvedCount,
      contacts
    };
  } finally {
    db.close();
    await prepared.cleanup();
  }
}

function firstNonEmptyString(row: Record<string, unknown>, columns: string[]): string | null {
  for (const column of columns) {
    const value = row[column];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}
