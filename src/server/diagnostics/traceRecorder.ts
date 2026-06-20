import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, copyFile, mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../config";

interface TraceManifest {
  traceVersion: 1;
  name: string;
  startedAt: string;
  directory: string;
  eventsFile: string;
  snapshotsDir: string;
  note: string;
}

interface TraceEntry {
  sequence: number;
  recordedAt: string;
  kind: string;
  data: unknown;
}

export class ExactTraceRecorder {
  private readonly startedAt = new Date().toISOString();
  private readonly directoryName: string;
  private initPromise: Promise<void> | null = null;
  private writeQueue: Promise<void> = Promise.resolve();
  private sequence = 0;

  readonly directory: string;
  readonly eventsPath: string;
  readonly snapshotsDir: string;

  constructor(
    readonly name: string,
    rootDir: string
  ) {
    const stamp = this.startedAt.replace(/[:.]/g, "-");
    this.directoryName = `${stamp}-${safeTraceName(name)}-${randomBytes(3).toString("hex")}`;
    this.directory = path.resolve(rootDir, this.directoryName);
    this.eventsPath = path.join(this.directory, "events.ndjson");
    this.snapshotsDir = path.join(this.directory, "snapshots");
  }

  async record(kind: string, data?: unknown): Promise<void> {
    const entry: TraceEntry = {
      sequence: this.sequence++,
      recordedAt: new Date().toISOString(),
      kind,
      data: toTraceValue(data ?? null)
    };
    await this.enqueue(async () => {
      await this.ensureInitialized();
      await appendFile(this.eventsPath, `${JSON.stringify(entry)}\n`, "utf8");
    });
  }

  async snapshotArchive(label: string, archivePath: string): Promise<string | null> {
    const resolvedArchivePath = path.resolve(archivePath);
    const snapshotName = `${String(this.sequence).padStart(6, "0")}-${safeTraceName(label)}.sqlite`;
    const snapshotPath = path.join(this.snapshotsDir, snapshotName);
    return this.enqueue(async () => {
      await this.ensureInitialized();
      try {
        const archiveStat = await stat(resolvedArchivePath);
        await copyFile(resolvedArchivePath, snapshotPath);
        await this.writeEntry({
          sequence: this.sequence++,
          recordedAt: new Date().toISOString(),
          kind: "archive.snapshot",
          data: {
            label,
            archivePath: resolvedArchivePath,
            snapshotPath,
            sizeBytes: archiveStat.size,
            sha256: await sha256File(snapshotPath)
          }
        });
        return snapshotPath;
      } catch (error) {
        await this.writeEntry({
          sequence: this.sequence++,
          recordedAt: new Date().toISOString(),
          kind: "archive.snapshot_failed",
          data: {
            label,
            archivePath: resolvedArchivePath,
            error: error instanceof Error ? error.message : String(error)
          }
        });
        return null;
      }
    });
  }

  async close(): Promise<void> {
    await this.writeQueue;
  }

  private async enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.then(work, work);
    this.writeQueue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  private async ensureInitialized(): Promise<void> {
    this.initPromise ??= this.initialize();
    await this.initPromise;
  }

  private async initialize(): Promise<void> {
    await mkdir(this.snapshotsDir, { recursive: true });
    const manifest: TraceManifest = {
      traceVersion: 1,
      name: this.name,
      startedAt: this.startedAt,
      directory: this.directory,
      eventsFile: this.eventsPath,
      snapshotsDir: this.snapshotsDir,
      note: "Exact local diagnostic trace. It may contain WhatsApp identifiers, message bodies, and raw event payloads. Do not commit or upload it unless you intentionally opt in."
    };
    await writeFile(path.join(this.directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await this.writeEntry({
      sequence: this.sequence++,
      recordedAt: new Date().toISOString(),
      kind: "trace.started",
      data: manifest
    });
  }

  private async writeEntry(entry: TraceEntry): Promise<void> {
    await appendFile(this.eventsPath, `${JSON.stringify(entry)}\n`, "utf8");
  }
}

export const configuredTraceRecorder = config.diagnostics.traceName
  ? new ExactTraceRecorder(config.diagnostics.traceName, config.diagnostics.traceRootDir)
  : null;

export function getTraceRecorderSummary(): { enabled: boolean; name: string | null; directory: string | null; eventsPath: string | null } {
  return {
    enabled: Boolean(configuredTraceRecorder),
    name: configuredTraceRecorder?.name ?? null,
    directory: configuredTraceRecorder?.directory ?? null,
    eventsPath: configuredTraceRecorder?.eventsPath ?? null
  };
}

function safeTraceName(value: string): string {
  return value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "trace";
}

function toTraceValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value == null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") {
    return { __type: "bigint", value: value.toString() };
  }
  if (typeof value === "function") {
    return { __type: "function", name: value.name || null };
  }
  if (typeof value === "symbol") {
    return { __type: "symbol", value: String(value) };
  }
  if (Buffer.isBuffer(value)) {
    return { __type: "Buffer", encoding: "base64", value: value.toString("base64") };
  }
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return {
      __type: value.constructor.name,
      encoding: "base64",
      byteOffset: view.byteOffset,
      byteLength: view.byteLength,
      value: Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString("base64")
    };
  }
  if (value instanceof ArrayBuffer) {
    return { __type: "ArrayBuffer", encoding: "base64", value: Buffer.from(value).toString("base64") };
  }
  if (value instanceof Date) {
    return { __type: "Date", value: value.toISOString() };
  }
  if (value instanceof Error) {
    return {
      __type: value.name,
      message: value.message,
      stack: value.stack ?? null
    };
  }
  if (typeof value === "object") {
    if (seen.has(value)) {
      return { __type: "CircularReference" };
    }
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        return value.map((item) => toTraceValue(item, seen));
      }
      if (value instanceof Map) {
        return {
          __type: "Map",
          entries: [...value.entries()].map(([key, nested]) => [toTraceValue(key, seen), toTraceValue(nested, seen)])
        };
      }
      if (value instanceof Set) {
        return { __type: "Set", values: [...value.values()].map((nested) => toTraceValue(nested, seen)) };
      }
      const objectValue = value as Record<string, unknown>;
      const output: Record<string, unknown> = {};
      const constructorName = value.constructor?.name;
      if (constructorName && constructorName !== "Object") {
        output.__type = constructorName;
      }
      for (const key of Reflect.ownKeys(objectValue)) {
        output[typeof key === "symbol" ? key.toString() : key] = toTraceValue(objectValue[key as keyof typeof objectValue], seen);
      }
      return output;
    } finally {
      seen.delete(value);
    }
  }
  return String(value);
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}
