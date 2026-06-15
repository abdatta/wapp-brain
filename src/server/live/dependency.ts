import fs from "node:fs";
import path from "node:path";

export const BAILEYS_PACKAGE = "@whiskeysockets/baileys";
export const BAILEYS_PINNED_VERSION = "7.0.0-rc13";
export const BAILEYS_MIN_SAFE_6 = "6.7.22";
export const BAILEYS_MIN_SAFE_7_RC = "7.0.0-rc12";

export interface LiveDependencyStatus {
  installed: boolean;
  packageName: string;
  version: string | null;
  safe: boolean;
  message: string;
}

export function getLiveDependencyStatus(rootDir = process.cwd()): LiveDependencyStatus {
  const packageJsonPath = path.join(rootDir, "node_modules", "@whiskeysockets", "baileys", "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    return {
      installed: false,
      packageName: BAILEYS_PACKAGE,
      version: null,
      safe: false,
      message: "Baileys is not installed; live maintainer commands are unavailable."
    };
  }
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { version?: string };
  const version = pkg.version ?? null;
  const safe = version ? isSafeBaileysVersion(version) : false;
  return {
    installed: true,
    packageName: BAILEYS_PACKAGE,
    version,
    safe,
    message: safe
      ? `Baileys ${version} is installed and passes the project safety floor.`
      : `Baileys ${version ?? "unknown"} is below the project safety floor (${BAILEYS_MIN_SAFE_6} or ${BAILEYS_MIN_SAFE_7_RC}).`
  };
}

export function assertLiveDependencySafe(): void {
  const status = getLiveDependencyStatus();
  if (!status.installed || !status.safe) {
    throw new Error(status.message);
  }
}

export function isSafeBaileysVersion(version: string): boolean {
  if (version.startsWith("7.0.0-rc")) {
    return compareVersions(version, BAILEYS_MIN_SAFE_7_RC) >= 0;
  }
  if (version.startsWith("6.")) {
    return compareVersions(version, BAILEYS_MIN_SAFE_6) >= 0;
  }
  return compareVersions(version, "7.0.0") >= 0;
}

function compareVersions(left: string, right: string): number {
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

function versionParts(value: string): number[] {
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)(?:-rc\.?(\d+))?/);
  if (!match) {
    return [0, 0, 0, 0];
  }
  const rc = match[4] ? Number(match[4]) : 9999;
  return [Number(match[1]), Number(match[2]), Number(match[3]), rc];
}
