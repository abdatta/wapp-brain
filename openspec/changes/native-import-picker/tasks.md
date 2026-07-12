## 1. Server: native picker module

- [x] 1.1 Create `src/server/import/nativePicker.ts` exporting `pickImportPath(kind, options)`; define `PickKind` (`"backup-root" | "media" | "msgstore" | "wa"`) and the result union `{ path: string } | { cancelled: true } | { unavailable: true; reason: string }`, dispatching on `process.platform`
- [x] 1.2 Implement the Windows path: `FolderBrowserDialog` for `backup-root`/`media`, `OpenFileDialog` (filter `*.crypt15;*.db`) for `msgstore`/`wa`, shown with a `TopMost` owner form, spawned via `powershell.exe -NoProfile -NonInteractive -STA -EncodedCommand <base64 UTF-16LE>`
- [x] 1.3 Await the spawned child asynchronously so the pending dialog never blocks the Node event loop; parse stdout: trimmed non-empty → `{ path }`; empty → `{ cancelled }`; spawn error or non-Windows → `{ unavailable, reason }`
- [x] 1.4 Validate the optional `startIn` hint (must be an existing local directory), pass it only as a script variable — never concatenated into the command — and ignore it when invalid
- [x] 1.5 Enforce single-flight (concurrent pick → `{ unavailable, reason: "busy" }`) and track the spawned child so an aborted request kills it (no dialog timeout)
- [x] 1.6 Add `darwin`/`linux` seams returning `{ unavailable }` now, with inline notes for future `osascript` (`choose folder`/`choose file`) and `zenity --file-selection [--directory]`
- [x] 1.7 Add `isPickerAvailable()` (true when `process.platform === "win32"` and the shell is launchable)

## 2. Server: backup auto-detection module

- [x] 2.1 Create `src/server/import/detectBackup.ts` exporting `detectBackupFolder(root)` using async `fs`, returning a manifest: resolved `msgstore` (required), `wa` (optional), `media` folder (optional), recognized auxiliary files, chosen-file notes, and a validity flag
- [x] 2.2 Keep the scan shallow — inspect the root and the standard `Databases/`/`Media/` subfolders case-insensitively and confirm `Media/` exists without walking its contents; accept `.crypt15` or plain `.db` for `msgstore`/`wa`
- [x] 2.3 Prefer canonical `msgstore.db.crypt15`; when only dated rotations exist, select the newest and record which file was chosen
- [x] 2.4 Recognize the auxiliary set (`chatsettingsbackup`, `status_backup`, `offloaded-media`, `backup_settings.json`, `commerce_backup`, `stickers_db`) by filename and list them as detected/reserved (no decryption, no ingestion)
- [x] 2.5 Report the manifest invalid when no `msgstore` is found; omit missing optional inputs without erroring

## 3. Server: endpoints and availability

- [x] 3.1 Add `POST /api/import/pick`: validate `kind`, call `pickImportPath`, return `{ ok, path } | { ok, cancelled } | { ok:false, unavailable, reason }`; wire request-abort to cancel the child
- [x] 3.2 Add `POST /api/import/detect`: validate the folder path is a local directory, call `detectBackupFolder`, return the manifest (privacy-safe — file kinds and chosen filename, not full private paths in logs)
- [x] 3.3 Surface `pickerAvailable` (from `isPickerAvailable()`) on the existing status/health payload the wizard reads
- [x] 3.4 Keep both routes on the loopback-only surface with no new exposure/CORS changes, and non-blocking (async handlers)

## 4. Remove upload/staging and file-based key

- [x] 4.1 Remove the byte-upload/staging machinery: `POST /api/import/staging/*` routes, `src/server/import/staging.ts` file-staging, the client `uploadImportFile`, and `ImportStagingFileKind`
- [x] 4.2 Simplify `POST /api/import/jobs` to accept the detected paths + text key + mode directly (no staging session id), keeping the async job/progress/cancel/snapshot-restore behavior
- [x] 4.3 Remove file-based key everywhere: `keyPath` from `ImportRequest`, `useStagedKey`, and the `key` staging kind, across `src/shared/types.ts`, the routes (`/api/import`, `/verify-key`, `/jobs`), and the importer
- [x] 4.4 `src/server/import/importer.ts`: require the text `key`, read inputs in place, and continue writing only decrypted intermediates to the private workspace (cleaned on completion/cancel)

## 5. Client: API and shared types

- [x] 5.1 Add `PickKind`, the pick result type, and the detection manifest type to `src/shared/types.ts`; remove `ImportStagingFileKind` and `keyPath`
- [x] 5.2 Add `pickImportPath(kind)` and `detectBackupFolder(root)` to `src/client/api.ts`; expose `pickerAvailable` from the status fetch; remove `uploadImportFile`
- [x] 5.3 Remove `keyPath` / `useStagedKey` / staging-session fields from `verifyImportKey` and `startImportJob` request bodies; `startImportJob` sends detected paths + text key + mode

## 6. Client: import wizard rework

- [x] 6.1 In `ImportWizard` (`src/client/App.tsx`), make the primary step a single "Browse for your WhatsApp backup folder" action (shown when `pickerAvailable`), calling `pickImportPath("backup-root")` then `detectBackupFolder`
- [x] 6.2 Render a detection summary: messages ✓ / contacts ✓ / media ✓ (with the chosen `msgstore` filename) and a count of recognized auxiliary files marked "reserved for a follow-up"
- [x] 6.3 Replace the key file picker with the text field only; remove `useStagedKey`, the key `FilePickRow`, and all byte-upload UI
- [x] 6.4 Feed the detected paths into the verify-key and start-import calls (read in place; nothing uploaded)
- [x] 6.5 Add the typed backup-folder path fallback (native unavailable) and an advanced typed per-input override (all read in place, no upload)

## 7. Responsiveness and progress

- [x] 7.1 Show a "waiting for you to choose…" indicator while a native pick is pending, and confirm the server still serves other requests during it
- [x] 7.2 Show a busy indicator during the folder scan and during key verification; run verification async and re-enable input on resolve
- [x] 7.3 Keep the existing async import-job phase progress + polling for the import itself (determinate where totals are known, indeterminate otherwise)
- [x] 7.4 Add/adjust styles in `src/client/styles.css` for the Browse control, detection summary, and busy indicators

## 8. Tests

- [x] 8.1 Unit-test `nativePicker` per-kind command construction, stdout parsing (path/cancelled/unavailable), `startIn` validation (no interpolation), single-flight busy, and that awaiting the child does not block (a second request resolves while a pick is pending)
- [x] 8.2 Unit-test `detectBackupFolder`: full standard folder, `Databases/`+`Media/` subfolder layout, missing `msgstore` (invalid), missing optional inputs, dated-rotation selection, auxiliary recognition, and shallow behavior (does not enumerate media contents)
- [x] 8.3 Test `POST /api/import/pick` and `POST /api/import/detect`: valid/invalid kind, non-directory path rejected, unavailable-picker fallback contract, manifest shape
- [x] 8.4 Test the removals: no `/api/import/staging/*` route, `uploadImportFile` gone, and verify/import work with detected paths + text key and reject `keyPath`/staging fields
- [x] 8.5 Test the wizard wiring: a picked folder yields a manifest, detected paths reach the import request without an upload, and the text key verifies

## 9. Verification and docs

- [x] 9.1 On Windows, run `npm run dev`, Browse to a real backup folder, confirm the detection summary and busy indicators, enter the key, and confirm an import runs reading in place with nothing uploaded — including the multi-GB `Media/` folder
- [x] 9.2 Confirm cancel leaves state unchanged; confirm the server stays responsive while a pick dialog is open; with `pickerAvailable=false` confirm the typed folder path and advanced override keep the web viewer working
- [x] 9.3 Update user-facing copy/docs (README, `docs/`, wizard text) to describe the single-folder Browse + text-key flow, the removal of uploads and the key file, and that auxiliary files are detected and reserved
