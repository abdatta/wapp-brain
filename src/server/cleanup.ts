import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config";
import { PublicError } from "./privacy";

const SENTINEL = ".wapp-brain-managed";

export interface CleanupSummary {
  removedFiles: number;
  removedDirectories: number;
}

export async function ensureManagedWorkDir(workDirPath = config.workDir): Promise<string> {
  const workDir = path.resolve(workDirPath);
  await mkdir(workDir, { recursive: true });
  await writeFile(path.join(workDir, SENTINEL), "managed by Wapp Brain\n", { flag: "w" });
  return workDir;
}

export async function cleanupDecryptedWorkDir(workDirPath = config.workDir): Promise<CleanupSummary> {
  return cleanupManagedSubdir(workDirPath, "decrypted");
}

export async function cleanupImportStagingWorkDir(workDirPath = config.workDir): Promise<CleanupSummary> {
  return cleanupManagedSubdir(workDirPath, "import-staging");
}

export async function cleanupSensitiveWorkDirs(workDirPath = config.workDir): Promise<CleanupSummary> {
  const decrypted = await cleanupDecryptedWorkDir(workDirPath);
  const staging = await cleanupImportStagingWorkDir(workDirPath);
  return {
    removedFiles: decrypted.removedFiles + staging.removedFiles,
    removedDirectories: decrypted.removedDirectories + staging.removedDirectories
  };
}

async function cleanupManagedSubdir(workDirPath: string, subdir: "decrypted" | "import-staging"): Promise<CleanupSummary> {
  const workDir = path.resolve(workDirPath);
  const target = path.resolve(workDir, subdir);
  assertSafeManagedTarget(workDir, target, subdir);

  let targetExists = true;
  try {
    await stat(target);
  } catch {
    targetExists = false;
  }
  if (!targetExists) {
    return { removedFiles: 0, removedDirectories: 0 };
  }

  try {
    await stat(path.join(workDir, SENTINEL));
  } catch {
    throw new PublicError("CLEANUP_NOT_MANAGED", "Cleanup is only available for a Wapp Brain managed work directory.");
  }

  const summary = await countTree(target);
  await rm(target, { recursive: true, force: true });
  return summary;
}

function assertSafeManagedTarget(workDir: string, target: string, subdir: "decrypted" | "import-staging"): void {
  const relative = path.relative(workDir, target);
  if (relative.startsWith("..") || path.isAbsolute(relative) || path.basename(target) !== subdir) {
    throw new PublicError("CLEANUP_UNSAFE_TARGET", "Cleanup target was not inside the managed work directory.");
  }
  if (target === path.parse(target).root || workDir === path.parse(workDir).root) {
    throw new PublicError("CLEANUP_UNSAFE_TARGET", "Cleanup target was not safe.");
  }
}

async function countTree(target: string): Promise<CleanupSummary> {
  let removedFiles = 0;
  let removedDirectories = 0;
  let entries;
  try {
    entries = await readdir(target, { withFileTypes: true });
  } catch {
    return { removedFiles, removedDirectories };
  }
  removedDirectories += 1;
  for (const entry of entries) {
    const childPath = path.join(target, entry.name);
    if (entry.isDirectory()) {
      const child = await countTree(childPath);
      removedFiles += child.removedFiles;
      removedDirectories += child.removedDirectories;
    } else {
      removedFiles += 1;
    }
  }
  return { removedFiles, removedDirectories };
}
