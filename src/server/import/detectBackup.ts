import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type {
  BackupAuxiliaryFile,
  BackupDetectionFile,
  BackupDetectionManifest,
  BackupInputKind
} from "../../shared/types";

// Recognized auxiliary WhatsApp backup databases. Detected and reserved for
// future ingestion — this import never decrypts or reads them. Matched by the
// filename prefix (before the first dot), case-insensitive, so `.crypt15` /
// `.db` / `.json.crypt15` variants all resolve to the same kind.
const AUXILIARY_PREFIXES: Record<string, string> = {
  chatsettingsbackup: "chatsettingsbackup",
  status_backup: "status_backup",
  "offloaded-media": "offloaded-media",
  backup_settings: "backup_settings",
  commerce_backup: "commerce_backup",
  stickers_db: "stickers_db"
};

interface Candidate {
  name: string;
  path: string;
  encrypted: boolean;
}

interface MsgstoreCandidate extends Candidate {
  // Sort key: canonical files rank above dated rotations; among rotations, the
  // newest date/sequence wins. Higher is preferred.
  rank: number;
  dateKey: string;
}

// Scan a selected backup folder and build a manifest of the core inputs plus any
// recognized auxiliary files. The scan is shallow: it reads only the folder root
// and the standard `Databases/` and `Media/` subfolders, and confirms the media
// folder's presence without enumerating its (potentially multi-GB) contents.
export async function detectBackupFolder(root: string): Promise<BackupDetectionManifest> {
  const resolvedRoot = path.resolve(root);
  const manifest: BackupDetectionManifest = {
    root: resolvedRoot,
    valid: false,
    msgstore: null,
    wa: null,
    media: null,
    auxiliary: [],
    notes: []
  };

  const rootEntries = await readDirEntries(resolvedRoot);
  if (!rootEntries) {
    manifest.notes.push("The selected folder could not be read.");
    return manifest;
  }

  // DBs live at the root or under a `Databases/` subfolder; media is a `Media/`
  // subfolder. Names are matched case-insensitively throughout.
  const databasesDir = rootEntries.find((entry) => entry.isDirectory() && entry.name.toLowerCase() === "databases");
  const dbDirs = [resolvedRoot, ...(databasesDir ? [path.join(resolvedRoot, databasesDir.name)] : [])];

  const dbFiles: Array<{ name: string; dir: string }> = [];
  for (const dir of dbDirs) {
    const entries = dir === resolvedRoot ? rootEntries : await readDirEntries(dir);
    if (!entries) continue;
    for (const entry of entries) {
      if (entry.isFile()) dbFiles.push({ name: entry.name, dir });
    }
  }

  manifest.msgstore = pickMsgstore(dbFiles, manifest.notes);
  manifest.wa = pickNamed(dbFiles, "wa.db", "wa");
  manifest.media = findMediaFolder(resolvedRoot, rootEntries);
  manifest.auxiliary = collectAuxiliary(dbFiles);
  manifest.valid = manifest.msgstore != null;

  if (!manifest.valid) {
    manifest.notes.push("No msgstore database was found in this folder.");
  }
  return manifest;
}

async function readDirEntries(dir: string): Promise<Dirent[] | null> {
  try {
    const info = await stat(dir);
    if (!info.isDirectory()) return null;
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
}

// Prefer canonical `msgstore.db.crypt15` > canonical `msgstore.db` > newest dated
// `.crypt15` rotation > newest dated `.db` rotation.
function pickMsgstore(dbFiles: Array<{ name: string; dir: string }>, notes: string[]): BackupDetectionFile | null {
  const candidates: MsgstoreCandidate[] = [];
  for (const file of dbFiles) {
    const parsed = classifyMsgstore(file.name);
    if (!parsed) continue;
    candidates.push({
      name: file.name,
      path: path.join(file.dir, file.name),
      encrypted: parsed.encrypted,
      rank: parsed.rank,
      dateKey: parsed.dateKey
    });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => (b.rank - a.rank) || b.dateKey.localeCompare(a.dateKey));
  const chosen = candidates[0];
  if (chosen.rank < 2) {
    notes.push(`Using the most recent backup rotation: ${chosen.name}.`);
  }
  return { kind: "msgstore", name: chosen.name, path: chosen.path, encrypted: chosen.encrypted };
}

function classifyMsgstore(name: string): { encrypted: boolean; rank: number; dateKey: string } | null {
  const lower = name.toLowerCase();
  const canonical = /^msgstore\.db(\.crypt15)?$/.exec(lower);
  if (canonical) {
    const encrypted = Boolean(canonical[1]);
    // Canonical crypt15 = 3, canonical plain = 2 (both above any rotation).
    return { encrypted, rank: encrypted ? 3 : 2, dateKey: "" };
  }
  const dated = /^msgstore-(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.db(\.crypt15)?$/.exec(lower);
  if (dated) {
    const encrypted = Boolean(dated[3]);
    const sequence = dated[2] ? dated[2].padStart(4, "0") : "0000";
    // Dated crypt15 = 1, dated plain = 0; tiebreak by date then sequence.
    return { encrypted, rank: encrypted ? 1 : 0, dateKey: `${dated[1]}.${sequence}` };
  }
  return null;
}

function pickNamed(
  dbFiles: Array<{ name: string; dir: string }>,
  baseName: string,
  kind: BackupInputKind
): BackupDetectionFile | null {
  const lowerBase = baseName.toLowerCase();
  const match =
    dbFiles.find((file) => file.name.toLowerCase() === `${lowerBase}.crypt15`) ??
    dbFiles.find((file) => file.name.toLowerCase() === lowerBase);
  if (!match) return null;
  return {
    kind,
    name: match.name,
    path: path.join(match.dir, match.name),
    encrypted: match.name.toLowerCase().endsWith(".crypt15")
  };
}

function findMediaFolder(root: string, rootEntries: Dirent[]): { name: string; path: string } | null {
  const media = rootEntries.find((entry) => entry.isDirectory() && entry.name.toLowerCase() === "media");
  return media ? { name: media.name, path: path.join(root, media.name) } : null;
}

function collectAuxiliary(dbFiles: Array<{ name: string; dir: string }>): BackupAuxiliaryFile[] {
  const found: BackupAuxiliaryFile[] = [];
  const seen = new Set<string>();
  for (const file of dbFiles) {
    const prefix = file.name.toLowerCase().split(".")[0];
    const kind = AUXILIARY_PREFIXES[prefix];
    if (!kind || seen.has(kind)) continue;
    seen.add(kind);
    found.push({ kind, name: file.name, path: path.join(file.dir, file.name) });
  }
  return found;
}
