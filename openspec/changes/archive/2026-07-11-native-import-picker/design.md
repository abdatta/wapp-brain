## Context

The import wizard (`ImportWizard`, `src/client/App.tsx:1167-1596`) currently asks for four inputs separately — encrypted `msgstore`, optional `wa.db`, a key (text or file), and the media folder — via a browser file picker (`FilePickRow`, ~1560) that streams bytes to staging (`/api/import/staging/*`, `stageImportFile`), plus typed-path fallbacks. The multi-GB media folder is not uploaded; the user hand-types its path. The reason is structural: a browser file picker returns `File` objects with only `name`/`webkitRelativePath`, **never an absolute path**.

A real WhatsApp Android backup is a single folder with a fixed shape (confirmed against a user's actual backup):

```
msgstore.db.crypt15          offloaded-media.db.crypt15    status_backup.db.crypt15
backup_settings.json.crypt15 chatsettingsbackup.db.crypt15 commerce_backup.db.crypt15
stickers_db.bak.crypt15      wa.db.crypt15                 Media/   (folder)
```

Every `.crypt15` is encrypted with the **same backup key**. So the natural input is not four files — it's *this folder plus the key*. The app is local-first: the server binds loopback-only (`127.0.0.1:3600`, `src/server/config.ts`), so browser and server share the machine and desktop session, and the server can open a native folder dialog to learn the folder's absolute path and read its contents in place. There is **no backward-compatibility constraint**, so the byte-upload/staging path is removed rather than kept alongside.

The pipeline below input selection stays path-based. `runImport` (`src/server/import/importer.ts:34`) validates with `fs` and reads off disk; the async import **job** model (`/api/import/jobs`, progress polling, cancel, snapshot restore) already updates the UI without blocking. Auto-detection simply *produces* the paths from one folder; `runImport` and the job model are reused.

## Goals / Non-Goals

**Goals:**
- Make the wizard's primary action a single native folder pick; the server auto-detects the standard backup layout inside it and reports what it found before import.
- Read `msgstore`, `wa.db`, and `Media/` in place from the detected paths — no upload, no staging of user files, any size.
- Provide the key as text only; the one key decrypts the whole backup. Remove file-based key support entirely.
- Recognize the auxiliary backup databases and surface them as detected-and-reserved, without ingesting them.
- Keep every setup step responsive: pick, scan, and verify show progress and never block the server event loop; the scan is shallow so it stays fast beside multi-GB media.
- Degrade gracefully where the native picker can't run (typed folder path, then typed per-input override); keep the web viewer working everywhere.
- Windows-first native dialog with a clean per-OS seam.

**Non-Goals:**
- Ingesting the auxiliary databases into features — each is reserved for its own follow-up so downstream consumers get a proper model.
- Converting to Electron or any desktop wrapper; the client stays a browser on the loopback server.
- Changing `runImport`, the parser, media backfill, or the import-job progress model; this change resolves paths and reuses them.
- Keeping the browser byte-upload / file-staging machinery, or the removed file-based key (no backward compat).
- Implementing macOS/Linux dialogs now (seam only), or supporting remote / cross-device access (loopback bind assumes co-location).

## Decisions

### 1. Single backup-folder native pick is the primary input
The wizard leads with one action: pick the WhatsApp backup folder via a native OS **folder** dialog, which returns its absolute path. This matches how backups exist on disk (one folder), makes the multi-GB media a non-issue (read in place), and reduces four picks and a typed path to a single click.

- **Why not the browser folder picker (`webkitdirectory`)?** It would upload every byte — including multi-GB media — and still never yield an absolute path. The native dialog is the only route that gives a path and reads in place.

### 2. Server-side auto-detection produces a manifest — shallow and async
`src/server/import/detectBackup.ts` scans a given folder with async `fs` and returns a manifest: resolved absolute paths for `msgstore` (required), `wa.db` (optional), and `Media/` (optional), plus a list of recognized auxiliary files. It is **shallow** — it inspects only the top-level entries of the folder and the standard `Databases/`/`Media/` subfolders, and confirms `Media/` exists without walking its (potentially multi-GB) contents; the full media walk happens later inside the import job, which has its own progress. Detection specifics:

- Searches root + `Databases/` (DBs) + `Media/` (media), case-insensitively; accepts encrypted (`.crypt15`) or plain (`.db`).
- Prefers the canonical `msgstore.db.crypt15`; if only dated rotations exist (`msgstore-YYYY-MM-DD.N.db.crypt15`), picks the newest and reports the choice.
- `msgstore` absent → manifest **invalid**, import not offered. `wa.db`/`Media/` absent → omitted; import still proceeds.
- Recognizes the auxiliary set by filename and lists them as detected/reserved.

### 3. Two endpoints: `POST /api/import/pick` and `POST /api/import/detect`
`/pick` opens the native dialog and returns a path (`kind`: `backup-root` | `media` folder dialogs, `msgstore` | `wa` file dialogs for overrides). `/detect` takes a folder path and returns the manifest. They are split so `/detect` serves **both** the native-picked path *and* a typed path, and so the wizard can show the detection summary before the key step. Both are POST, localhost-only, alongside the existing `/api/import/*` routes.

### 4. One text key decrypts the whole backup; file-based key removed
The key is always the text field. `keyPath`, the key `FilePickRow`, `useStagedKey`, and the `key` staging kind are deleted across `src/shared/types.ts`, the client, the routes (`/api/import`, `/verify-key`, `/jobs`), and staging. Verification runs locally against the detected `msgstore` using the text key; the same key decrypts every `.crypt15` in the folder. Per the project's no-backward-compat stance this is a clean deletion.

### 5. Auxiliary databases are detected and reserved, not ingested
The manifest lists the auxiliary files with a short note on likely future value, but this change ingests none. Each carries a distinct data model (chat organization settings, statuses, offloaded-media availability, business catalog, sticker packs) whose schema must be confirmed by decrypting the real file, and each deserves its own capability so downstream consumers get a deliberate shape. The detection report says plainly "found, reserved for a follow-up" so nothing looks silently dropped.

- Leading follow-up candidate: `chatsettingsbackup` (per-chat pin/mute/archive/disappearing-timer) — the highest-signal organizational metadata.

### 6. Native picker: Windows PowerShell dialogs, no new dependency, non-blocking
`src/server/import/nativePicker.ts` exposes `pickImportPath(kind, options)` dispatching on `process.platform`. Windows uses `System.Windows.Forms.FolderBrowserDialog` / `OpenFileDialog` via `powershell.exe -NoProfile -NonInteractive -STA -EncodedCommand <base64 UTF-16LE>`, shown with a `TopMost` owner form. It is a **spawned child**, so the HTTP handler awaits its exit via a promise while the Node event loop keeps serving other requests — the pending dialog never wedges the server. stdout carries the selected path; empty stdout → cancelled.

- **Injection safety**: the only client-controlled value reaching the picker is `kind`, validated against a fixed enum that selects a server-authored script; the optional `startIn` hint is passed as a script variable (never concatenated) and ignored unless it is an existing local directory. `-EncodedCommand` removes shell-quoting as an attack surface.
- **Single-flight & cancellable**: one dialog at a time (concurrent pick → `unavailable: "busy"`); the child is tracked and killed if the client aborts. No dialog timeout; unavailability is judged by spawn failure.
- **Availability probe**: `isPickerAvailable()` (Windows + launchable shell) is surfaced on the existing status payload so the wizard shows "Browse…" only where it works; the client still handles a runtime `unavailable` defensively.
- **Per-OS seam**: `darwin`/`linux` return `unavailable` now, with inline notes for `osascript` and `zenity`.

### 7. Read in place; remove the byte-upload/staging machinery
Since inputs are always paths, the browser byte-upload path (`/api/import/staging/*`, `stageImportFile`, `uploadImportFile`, `ImportStagingFileKind`) is deleted. User files are never copied into the app; only the importer's decrypted intermediates (e.g., the decrypted `msgstore.db` sqlite better-sqlite3 must open) live in the private workspace and are cleaned after import/cancel. `/api/import/jobs` is simplified to accept the detected paths + text key + mode directly (no staging session id), while keeping the async job/progress/cancel/snapshot-restore behavior intact.

### 8. Non-blocking, progress-indicated setup throughout
Every setup step that can exceed ~1s shows a UI indicator and runs off the event loop: the native pick is a spawned child (§6); detection uses async `fs` and is shallow (§2); key verification runs async and returns a quick verified/failed result while the wizard shows a busy state; the import itself reuses the existing job + polling progress (phase bars, yields between snapshots). Determinate progress is shown where a total is known (import phases), an indeterminate busy state otherwise (pick/scan/verify).

### 9. Fallbacks preserve the web viewer everywhere — still no uploads
When the picker is unavailable, the wizard offers a **typed backup-folder path**, run through the same `/detect`. Below that, an advanced **typed per-input override** (msgstore/wa/media paths) covers non-standard layouts. Both are read in place; nothing is uploaded. Native folder pick + auto-detect is the headline; these are graceful degradation.

## Risks / Trade-offs

- **Detection walks a huge media tree and stalls** → mitigated by shallow detection (only confirm `Media/` exists; the full walk is the import job's, which has progress).
- **Wrong file chosen among dated `msgstore` rotations** → prefer canonical, pick newest otherwise, show the resolved filename so the user can correct via the advanced override.
- **Non-standard or renamed layout** → auto-detection may miss inputs; the typed per-input override covers it, and a missing required `msgstore` is reported clearly.
- **Dialog opens behind the browser / headless server / LAN access** → `TopMost` owner form; unavailability caught as spawn failure with fallback; loopback bind keeps it same-machine.
- **Removing upload/staging or file-based key breaks external scripts** → accepted (no backward-compat); the folder-path + text-key flow is the documented path.
- **User expects the auxiliary data to appear** → the detection report explicitly labels those files "reserved for follow-up," and the design enumerates the follow-ups.

## Migration Plan

Revamp with no schema change and no data migration; two deliberate deletions (upload/staging, file-based key).
1. Add `nativePicker.ts` and `detectBackup.ts`; add `POST /api/import/pick` and `POST /api/import/detect`; surface `pickerAvailable`.
2. Remove `/api/import/staging/*`, the staging module, `uploadImportFile`, `ImportStagingFileKind`, and `keyPath`/`useStagedKey`/the key file; simplify `/api/import/jobs` to detected paths + text key + mode.
3. Rework the wizard to the folder-first flow with busy indicators; add the typed folder-path + typed per-input fallbacks.
4. Rollback = revert the new modules/routes/UI and restore the removed machinery; the core `runImport` pipeline and job model are untouched throughout.

## Open Questions

- **Remember the last backup folder** (non-persisted in-memory `startIn`) so re-imports skip re-navigating? Nice-to-have; resolve during apply.
- **Dated `msgstore` policy**: silently pick newest vs. surface a chooser when multiple rotations exist? Leaning: pick newest, show the name, allow override.
- **Follow-up sequencing for the reserved auxiliary DBs** — `chatsettingsbackup` first; the rest prioritized after inspecting decrypted schemas.
