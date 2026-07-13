#!/usr/bin/env node
// Reconcile the ROADMAP.md Status column from actual folder state.
//
// Deterministic and agent-agnostic — run it from Claude, Codex, or a plain
// shell (`npm run roadmap:sync`). It derives each change's lifecycle state from
// the changes/ and archive/ folders and rewrites ONLY the Status cell of each
// inventory row, so the roadmap is a computed board rather than a manually
// stamped one. Idempotent: running it repeatedly converges to the same result.
//
// Lifecycle derivation (per change name in the inventory table):
//   archived  → a folder `openspec/changes/archive/<YYYY-MM-DD>-<name>/` exists
//               → Status becomes `**archived YYYY-MM-DD**`
//   active    → `openspec/changes/<name>/tasks.md` exists AND has a checked task
//   proposed  → `openspec/changes/<name>/tasks.md` exists but nothing checked
//   seeded    → the folder exists with no tasks.md (proposal seed only)
//   (skipped) → no folder anywhere: the row is left untouched
//
// Only the Status column changes; every other cell (deps, checkpoint) is kept
// verbatim, and rows are never inserted or removed.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const openspecDir = path.resolve(scriptDir, ".."); // openspec/
const changesDir = path.join(openspecDir, "changes");
const roadmapPath = path.join(changesDir, "ROADMAP.md");
const archiveDir = path.join(changesDir, "archive");

if (!fs.existsSync(roadmapPath)) {
  console.log(`No roadmap at ${roadmapPath}; nothing to reconcile.`);
  process.exit(0);
}

// name -> archive date, from `<YYYY-MM-DD>-<name>` archive folders.
const archivedByName = new Map();
if (fs.existsSync(archiveDir)) {
  for (const entry of fs.readdirSync(archiveDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const m = entry.name.match(/^(\d{4}-\d{2}-\d{2})-(.+)$/);
    if (m) archivedByName.set(m[2], m[1]);
  }
}

function deriveStatus(name) {
  const archivedDate = archivedByName.get(name);
  if (archivedDate) return `**archived ${archivedDate}**`;
  const dir = path.join(changesDir, name);
  if (!fs.existsSync(dir)) return null; // not present anywhere → leave as-is
  const tasksPath = path.join(dir, "tasks.md");
  if (fs.existsSync(tasksPath)) {
    const tasks = fs.readFileSync(tasksPath, "utf8");
    return /^\s*[-*]\s*\[x\]/im.test(tasks) ? "active" : "proposed";
  }
  return "seeded";
}

// Inventory rows: | <num> | `<name>`[ extra] | <model> | <status> | <deps> | <checkpoint> |
const rowRe = /^(\|\s*\d+\s*\|\s*`([^`]+)`[^|]*\|[^|]*\|)([^|]*)(\|.*)$/;

const src = fs.readFileSync(roadmapPath, "utf8");
const eol = src.includes("\r\n") ? "\r\n" : "\n";
const lines = src.split(/\r?\n/);
const changed = [];
let modified = false;

const out = lines.map((line) => {
  const m = line.match(rowRe);
  if (!m) return line;
  const name = m[2].trim();
  const derived = deriveStatus(name);
  if (derived == null) return line; // no folder → untouched
  const current = m[3].trim();
  if (current === derived) return line;
  modified = true;
  changed.push([name, current || "(empty)", derived]);
  return `${m[1]} ${derived} ${m[4]}`;
});

if (modified) fs.writeFileSync(roadmapPath, out.join(eol), "utf8");

console.log(`Roadmap status reconciled: ${changed.length} row(s) updated.`);
for (const [name, from, to] of changed) console.log(`  ${name}: ${from} → ${to}`);
if (!modified) console.log("  (already in sync)");
