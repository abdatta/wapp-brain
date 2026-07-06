import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { config } from "../config";
import type { MemoryProviderName, MemoryProviderStatus } from "../../shared/types";

interface ProviderFile {
  provider?: MemoryProviderName;
  remoteModelEnabled?: boolean;
}

export async function getMemoryProviderStatus(): Promise<MemoryProviderStatus> {
  const providerFile = readProviderFile();
  const provider = providerFile.provider ?? config.memory.provider;
  const remoteModelEnabled = Boolean(config.memory.remoteModelEnabled || providerFile.remoteModelEnabled);
  const codexPackageAvailable = await hasCodexPackage();
  const codexSessionExists = fs.existsSync(config.memory.codexSessionPath);
  const message =
    provider === "codex"
      ? remoteModelEnabled
        ? codexPackageAvailable
          ? codexSessionExists
            ? "Codex provider is enabled with a local session."
            : "Codex provider is enabled but no local session exists yet."
          : "Codex provider is enabled but gpt-oauth-client is not available."
        : "Codex provider is configured but remote model use is disabled."
      : "Local extractive memory is enabled. Remote model use is disabled.";
  return {
    provider,
    remoteModelEnabled,
    codexPackageAvailable,
    codexSessionExists,
    message
  };
}

export async function enableCodexProvider(): Promise<MemoryProviderStatus> {
  writeProviderFile({ provider: "codex", remoteModelEnabled: true });
  return getMemoryProviderStatus();
}

export async function disableRemoteMemoryProvider(): Promise<MemoryProviderStatus> {
  writeProviderFile({ provider: "local", remoteModelEnabled: false });
  return getMemoryProviderStatus();
}

export async function connectCodexProvider(): Promise<MemoryProviderStatus> {
  const clientModule = await importCodexClient();
  const Client = clientModule.GPTOAuthClient as new (options: { storagePath: string }) => { connect: () => Promise<unknown> };
  fs.mkdirSync(path.dirname(config.memory.codexSessionPath), { recursive: true });
  const client = new Client({ storagePath: config.memory.codexSessionPath });
  await client.connect();
  writeProviderFile({ provider: "codex", remoteModelEnabled: true });
  return getMemoryProviderStatus();
}

export async function sendCodexMemoryPrompt(prompt: string, instructions: string): Promise<string> {
  const status = await getMemoryProviderStatus();
  if (status.provider !== "codex" || !status.remoteModelEnabled) {
    throw new Error("Codex memory provider is not enabled.");
  }
  const clientModule = await importCodexClient();
  const Client = clientModule.GPTOAuthClient as new (options: { storagePath: string }) => {
    connect: () => Promise<unknown>;
    sendMessage: (prompt: string, options?: Record<string, unknown>) => Promise<{ content: string }>;
  };
  const client = new Client({ storagePath: config.memory.codexSessionPath });
  await client.connect();
  const response = await client.sendMessage(prompt, {
    model: "gpt-5.2",
    instructions,
    reasoning: { effort: "high", summary: "auto" },
    text: { verbosity: "medium" },
    store: false
  });
  return response.content;
}

async function hasCodexPackage(): Promise<boolean> {
  try {
    await importCodexClient();
    return true;
  } catch {
    return fs.existsSync(path.resolve(process.cwd(), "..", "gpt-oauth-client"));
  }
}

async function importCodexClient(): Promise<Record<string, unknown>> {
  try {
    return (await dynamicImport("gpt-oauth-client")) as Record<string, unknown>;
  } catch {
    const siblingDist = path.resolve(process.cwd(), "..", "gpt-oauth-client", "dist", "index.js");
    if (fs.existsSync(siblingDist)) {
      return (await dynamicImport(pathToFileURL(siblingDist).href)) as Record<string, unknown>;
    }
    throw new Error("gpt-oauth-client is not available. Install or build the sibling OAuth client first.");
  }
}

function readProviderFile(): ProviderFile {
  try {
    if (!fs.existsSync(config.memory.providerConfigPath)) {
      return {};
    }
    return JSON.parse(fs.readFileSync(config.memory.providerConfigPath, "utf8")) as ProviderFile;
  } catch {
    return {};
  }
}

function writeProviderFile(value: ProviderFile): void {
  fs.mkdirSync(path.dirname(config.memory.providerConfigPath), { recursive: true });
  fs.writeFileSync(config.memory.providerConfigPath, `${JSON.stringify(value, null, 2)}\n`);
}

function dynamicImport(specifier: string): Promise<unknown> {
  return new Function("specifier", "return import(specifier)")(specifier) as Promise<unknown>;
}
