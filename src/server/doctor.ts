import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { config } from "./config";
import { publicErrorMessage } from "./privacy";
import { isSqliteArchiveInitialized } from "./db/sqliteRepository";
import { getLiveDependencyStatus } from "./live/dependency";
import { getMemoryProviderStatus } from "./memory/provider";

export interface DoctorCheck {
  name: string;
  status: "pass" | "warn" | "fail";
  message: string;
}

const requiredIgnorePatterns = [
  ".env",
  "msgstore*",
  "*.crypt*",
  "wa.db",
  "*decrypted*.db",
  "*.sqlite",
  "*.sqlite-wal",
  "*.sqlite-shm",
  "*.sqlite-journal",
  "encrypted_backup.key",
  "keys/",
  "media/",
  "exports/",
  ".wapp-brain/",
  ".wapp-brain/memory/",
  ".second-brain/"
];

export async function runDoctor(): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  checks.push(checkHostBinding());
  checks.push(checkGitIgnore());
  checks.push(await checkPort(config.app.host, config.app.port));
  checks.push(checkSqliteArchive());
  checks.push(checkImportStaging());
  checks.push(checkLiveDependency());
  checks.push(await checkMemoryStore());
  return checks;
}

function checkHostBinding(): DoctorCheck {
  if (config.app.host === "127.0.0.1" || config.app.host === "localhost") {
    return { name: "Local UI binding", status: "pass", message: "Server is configured for localhost." };
  }
  return {
    name: "Local UI binding",
    status: "warn",
    message: "Server host is not localhost; use this only if you intentionally want network exposure."
  };
}

function checkGitIgnore(): DoctorCheck {
  if (!fs.existsSync(".gitignore")) {
    return { name: "Sensitive file ignores", status: "fail", message: ".gitignore is missing." };
  }
  const content = fs.readFileSync(".gitignore", "utf8");
  const missing = requiredIgnorePatterns.filter((pattern) => !content.includes(pattern));
  if (missing.length === 0) {
    return { name: "Sensitive file ignores", status: "pass", message: "Sensitive WhatsApp inputs and local outputs are ignored." };
  }
  return {
    name: "Sensitive file ignores",
    status: "fail",
    message: `Missing ignore patterns: ${missing.join(", ")}`
  };
}

function checkSqliteArchive(): DoctorCheck {
  try {
    if (isSqliteArchiveInitialized(config.archive.sqlitePath)) {
      return { name: "SQLite archive", status: "pass", message: "Local archive file is initialized." };
    }
    return {
      name: "SQLite archive",
      status: "warn",
      message: "Local archive file is not initialized yet; run npm run init-db or import an archive."
    };
  } catch (error) {
    return {
      name: "SQLite archive",
      status: "fail",
      message: publicErrorMessage(error)
    };
  }
}

function checkImportStaging(): DoctorCheck {
  const stagingPath = path.join(config.workDir, "import-staging");
  if (!fs.existsSync(stagingPath)) {
    return { name: "Import staging", status: "pass", message: "No staged import files are present." };
  }
  return {
    name: "Import staging",
    status: "warn",
    message: "Sensitive staged import files are present; run npm run cleanup after any cancelled import."
  };
}

function checkLiveDependency(): DoctorCheck {
  const status = getLiveDependencyStatus();
  if (!status.installed) {
    return {
      name: "Live WhatsApp dependency",
      status: "warn",
      message: status.message
    };
  }
  return {
    name: "Live WhatsApp dependency",
    status: status.safe ? "pass" : "fail",
    message: status.message
  };
}

async function checkMemoryStore(): Promise<DoctorCheck> {
  const provider = await getMemoryProviderStatus();
  const rootIsPrivate = path.resolve(config.memory.rootDir).startsWith(path.resolve(config.workDir));
  if (!rootIsPrivate && !path.resolve(config.memory.rootDir).includes(".second-brain")) {
    return {
      name: "Second-brain memory",
      status: "warn",
      message: "Memory root is outside the default private workspace; use only an intentional local vault path."
    };
  }
  if (provider.provider === "codex" && provider.remoteModelEnabled && !provider.codexPackageAvailable) {
    return {
      name: "Second-brain memory",
      status: "warn",
      message: "Codex provider is enabled, but the optional gpt-oauth-client package is not available."
    };
  }
  return {
    name: "Second-brain memory",
    status: "pass",
    message: provider.message
  };
}

function checkPort(host: string, port: number): Promise<DoctorCheck> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    socket.once("connect", () => {
      socket.destroy();
      resolve({ name: "Local server port", status: "pass", message: `A local server is listening on ${host}:${port}.` });
    });
    socket.once("error", () => {
      resolve({ name: "Local server port", status: "warn", message: `No server is listening on ${host}:${port}.` });
    });
    socket.setTimeout(1500, () => {
      socket.destroy();
      resolve({ name: "Local server port", status: "warn", message: `No server responded on ${host}:${port}.` });
    });
  });
}
