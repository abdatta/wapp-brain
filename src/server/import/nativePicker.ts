import { spawn } from "node:child_process";
import fs from "node:fs";
import type { PickKind, PickResult } from "../../shared/types";

export type { PickKind, PickResult } from "../../shared/types";

export interface PickOptions {
  startIn?: string | null;
  signal?: AbortSignal;
}

interface DialogSpec {
  mode: "file" | "folder";
  title: string;
  filter?: string;
}

// Filter hint only — the importer still validates whatever path comes back, so a
// filter can never wrongly block a valid file.
const CRYPT_FILTER = "WhatsApp backup (*.crypt15;*.db)|*.crypt15;*.db|All files (*.*)|*.*";

// Maps the (validated) kind enum to a fixed dialog spec. This is the only place
// a kind turns into a dialog, and no client string participates.
export function dialogSpecForKind(kind: PickKind): DialogSpec {
  switch (kind) {
    case "backup-root":
      return { mode: "folder", title: "Select your WhatsApp backup folder" };
    case "media":
      return { mode: "folder", title: "Select your WhatsApp Media folder" };
    case "msgstore":
      return { mode: "file", title: "Select msgstore.db.crypt15", filter: CRYPT_FILTER };
    case "wa":
      return { mode: "file", title: "Select wa.db.crypt15", filter: CRYPT_FILTER };
  }
}

// The PowerShell body is a constant. Every parameter (mode/title/filter/startIn)
// is delivered through environment variables, so no client-supplied string is
// ever concatenated into the launched command.
//
// A spawned child is not the foreground process, so a plain dialog opens behind
// the browser. We create a real (off-screen, 1x1) top-most owner window, force it
// to the foreground with SetForegroundWindow, and own the dialog with it — that
// reliably surfaces the dialog in front.
const POWERSHELL_SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -Namespace WappPick -Name Native -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr hWnd);'
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$owner = New-Object System.Windows.Forms.Form
$owner.StartPosition = 'Manual'
$owner.Location = New-Object System.Drawing.Point([int]($bounds.X + $bounds.Width / 2), [int]($bounds.Y + $bounds.Height / 2))
$owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
try {
  $owner.Show()
  $owner.Activate()
  [WappPick.Native]::SetForegroundWindow($owner.Handle) | Out-Null
  if ($env:WAPP_PICK_MODE -eq 'file') {
    $dialog = New-Object System.Windows.Forms.OpenFileDialog
    if ($env:WAPP_PICK_TITLE) { $dialog.Title = $env:WAPP_PICK_TITLE }
    if ($env:WAPP_PICK_FILTER) { $dialog.Filter = $env:WAPP_PICK_FILTER }
    if ($env:WAPP_PICK_STARTIN -and (Test-Path -LiteralPath $env:WAPP_PICK_STARTIN)) { $dialog.InitialDirectory = $env:WAPP_PICK_STARTIN }
    if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.FileName) }
  } else {
    $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
    if ($env:WAPP_PICK_TITLE) { $dialog.Description = $env:WAPP_PICK_TITLE }
    if ($env:WAPP_PICK_STARTIN -and (Test-Path -LiteralPath $env:WAPP_PICK_STARTIN)) { $dialog.SelectedPath = $env:WAPP_PICK_STARTIN }
    if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }
  }
} finally {
  $owner.Close()
  $owner.Dispose()
}
`.trim();

// Validate the caller's directory hint locally. A non-existent or non-directory
// hint is ignored (never blocks the pick), and it is passed to the script only
// as an environment variable, never inlined.
export function resolveStartIn(startIn: string | null | undefined): string | undefined {
  if (!startIn) return undefined;
  try {
    if (fs.existsSync(startIn) && fs.statSync(startIn).isDirectory()) {
      return startIn;
    }
  } catch {
    // ignore — a bad hint simply means "no initial directory".
  }
  return undefined;
}

export function buildDialogEnv(spec: DialogSpec, startIn?: string): Record<string, string> {
  const env: Record<string, string> = {
    WAPP_PICK_MODE: spec.mode,
    WAPP_PICK_TITLE: spec.title
  };
  if (spec.filter) env.WAPP_PICK_FILTER = spec.filter;
  if (startIn) env.WAPP_PICK_STARTIN = startIn;
  return env;
}

// A non-empty selection is a path; empty output means the user cancelled.
export function interpretPickOutput(stdout: string): PickResult {
  const selected = stdout.trim();
  return selected ? { path: selected } : { cancelled: true };
}

type PickRunner = (env: Record<string, string>, signal?: AbortSignal) => Promise<PickResult>;

let runnerOverride: PickRunner | null = null;

// Test seam: inject a fake runner (also treats the picker as available so
// platform-gated logic can be exercised off-Windows).
export function setPickRunnerForTests(runner: PickRunner | null): () => void {
  const previous = runnerOverride;
  runnerOverride = runner;
  return () => {
    runnerOverride = previous;
  };
}

// Cross-process test seam: WAPP_PICK_FAKE_MS makes picks resolve to a fixed
// fake path after a delay (abort → cancelled) so a spawned test server can
// exercise the pick route without opening a real dialog.
function fakeRunnerFromEnv(): PickRunner | null {
  const delayMs = Number(process.env.WAPP_PICK_FAKE_MS ?? "");
  if (!Number.isFinite(delayMs) || delayMs <= 0) return null;
  return (env, signal) =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ path: `fake-pick:${env.WAPP_PICK_MODE}` }), delayMs);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve({ cancelled: true });
        },
        { once: true }
      );
    });
}

function activeRunner(): PickRunner {
  return runnerOverride ?? fakeRunnerFromEnv() ?? runWindowsPicker;
}

function runWindowsPicker(env: Record<string, string>, signal?: AbortSignal): Promise<PickResult> {
  return new Promise<PickResult>((resolve) => {
    const encoded = Buffer.from(POWERSHELL_SCRIPT, "utf16le").toString("base64");
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-STA", "-EncodedCommand", encoded],
      { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    const onAbort = () => child.kill();
    if (signal) {
      if (signal.aborted) child.kill();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    child.on("error", (error) => {
      signal?.removeEventListener("abort", onAbort);
      resolve({ unavailable: true, reason: `Native picker could not launch: ${error.message}` });
    });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) {
        resolve({ cancelled: true });
        return;
      }
      if (code !== 0 && !stdout.trim()) {
        resolve({ unavailable: true, reason: stderr.trim() || `Native picker exited with code ${code}.` });
        return;
      }
      resolve(interpretPickOutput(stdout));
    });
  });
}

// Only one native dialog may be open at a time; a pending dialog awaits its
// spawned child, so the Node event loop keeps serving other requests.
let pickInFlight = false;

export async function pickImportPath(kind: PickKind, options: PickOptions = {}): Promise<PickResult> {
  if (!isPickerAvailable()) {
    return { unavailable: true, reason: `Native file picker is not available on ${process.platform} yet.` };
  }
  if (pickInFlight) {
    return { unavailable: true, reason: "busy" };
  }
  pickInFlight = true;
  try {
    const spec = dialogSpecForKind(kind);
    const env = buildDialogEnv(spec, resolveStartIn(options.startIn));
    return await activeRunner()(env, options.signal);
  } finally {
    pickInFlight = false;
  }
}

export function isPickerAvailable(): boolean {
  // macOS (`osascript` choose file/folder) and Linux (`zenity --file-selection
  // [--directory]`) seams go here later; today only Windows is implemented.
  return runnerOverride != null || fakeRunnerFromEnv() != null || process.platform === "win32";
}
