import fs from "node:fs";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { createInflate, deflateSync } from "node:zlib";
import protobuf from "protobufjs";
import { PublicError } from "../privacy";
import type { ImportProgressHandler } from "./progress";

const SQLITE_MAGIC = Buffer.from("SQLite format 3");
const JAVA_SERIALIZED_MAGIC = Buffer.from([0xac, 0xed, 0x00, 0x05]);

const protoRoot = protobuf.parse(`
syntax = "proto3";

enum Key_Type {
  KEY_TYPE_UNKNOWN = 0;
  HSM_CONTROLLED = 1;
}

message C15_IV {
  bytes IV = 1;
}

message BackupExpiry {
  string app_version = 1;
  string device_model = 2;
  string jidSuffix = 3;
  int32 backup_version = 4;
  bool f_5 = 5;
  bool f_6 = 6;
  bool f_7 = 7;
  bool f_8 = 8;
  bool f_9 = 9;
  bool f_10 = 10;
  bool f_11 = 11;
  bool f_12 = 12;
  bool f_13 = 13;
  bool f_14 = 14;
  bool f_15 = 15;
  bool f_16 = 16;
  bool f_17 = 17;
  bool f_18 = 18;
  bool f_19 = 19;
  bool f_20 = 20;
  bool f_21 = 21;
  bool f_22 = 22;
  bool f_23 = 23;
  bool f_24 = 24;
  bool f_25 = 25;
  bool f_26 = 26;
  bool f_27 = 27;
  bool f_28 = 28;
  bool f_29 = 29;
  bool f_30 = 30;
  bool f_31 = 31;
  bool f_32 = 32;
  bool f_33 = 33;
  bool f_34 = 34;
  bool f_35 = 35;
  bool f_36 = 36;
  bool f_37 = 37;
  int32 backup_export_file_size = 38;
  bool f_39 = 39;
}

message BackupPrefix {
  Key_Type key_type = 1;
  C15_IV c15_iv = 3;
  BackupExpiry info = 4;
}
`).root;

const BackupPrefix = protoRoot.lookupType("BackupPrefix");

export interface DecryptOptions {
  encryptedPath: string;
  key?: string | null;
  keyPath?: string | null;
  outputDir: string;
  keepDecrypted?: boolean;
  onProgress?: ImportProgressHandler;
  signal?: AbortSignal;
}

export interface DecryptResult {
  sqlitePath: string;
  createdByDecryption: boolean;
  cleanup: () => Promise<void>;
}

interface Crypt15Header {
  iv: Buffer;
  dataOffset: number;
  headerBytes: Buffer;
}

export async function prepareMsgstore(options: DecryptOptions): Promise<DecryptResult> {
  throwIfAborted(options.signal);
  if (!fs.existsSync(options.encryptedPath)) {
    throw new PublicError("INPUT_MISSING", "msgstore file was not found.");
  }
  const lowerPath = options.encryptedPath.toLowerCase();
  if (lowerPath.endsWith(".crypt15")) {
    return decryptCrypt15(options);
  }
  if (/\.(crypt\d+|mcrypt\d+)$/i.test(options.encryptedPath)) {
    throw new PublicError("CRYPT_UNSUPPORTED", "Only msgstore.db.crypt15 encrypted backups are supported right now.");
  }
  {
    return {
      sqlitePath: options.encryptedPath,
      createdByDecryption: false,
      cleanup: async () => undefined
    };
  }
}

export async function decryptCrypt15(options: DecryptOptions): Promise<DecryptResult> {
  throwIfAborted(options.signal);
  await mkdir(options.outputDir, { recursive: true });
  const rootKey = await loadCrypt15RootKey(options.key, options.keyPath);
  const derivedKey = deriveCrypt15BackupKey(rootKey);
  const header = await readCrypt15Header(options.encryptedPath);
  const stats = await stat(options.encryptedPath);
  if (stats.size <= header.dataOffset + 32) {
    throw new PublicError("CRYPT15_TRUNCATED", "Encrypted backup is too small or truncated.");
  }

  const footer = await readTail(options.encryptedPath, 32);
  const normalEncryptedEnd = stats.size - 32;
  const normalAuthTag = footer.subarray(0, 16);
  const normalChecksum = footer.subarray(16, 32);
  const normalMd5 = await md5Range(
    options.encryptedPath,
    header.headerBytes,
    header.dataOffset,
    normalEncryptedEnd,
    normalAuthTag,
    options.onProgress,
    options.signal
  );
  throwIfAborted(options.signal);
  const isNormalBackup = normalMd5.equals(normalChecksum);
  const authTag = isNormalBackup ? normalAuthTag : footer.subarray(16, 32);
  const encryptedEnd = isNormalBackup ? normalEncryptedEnd : stats.size - 16;

  const suffix = cryptoSafeSuffix(options.encryptedPath);
  const rawPath = path.join(options.outputDir, `msgstore-${suffix}.raw`);
  const sqlitePath = path.join(options.outputDir, `msgstore-${suffix}.db`);

  try {
    options.onProgress?.({
      type: "step",
      step: "decrypting",
      message: "Decrypting crypt15 payload."
    });
    await decryptRangeToFile(
      options.encryptedPath,
      rawPath,
      header.dataOffset,
      encryptedEnd,
      derivedKey,
      header.iv,
      authTag,
      options.onProgress,
      options.signal
    );
    throwIfAborted(options.signal);
    options.onProgress?.({
      type: "step",
      step: "decrypting",
      message: "Materializing decrypted SQLite database."
    });
    await materializeSqlite(rawPath, sqlitePath, options.onProgress, options.signal);
    throwIfAborted(options.signal);
    await assertSqliteMagic(sqlitePath, "CRYPT15_SQLITE_INVALID");
  } catch (error) {
    await rm(rawPath, { force: true });
    await rm(sqlitePath, { force: true });
    if (error instanceof PublicError) {
      throw error;
    }
    throw new PublicError("CRYPT15_DECRYPT_FAILED", "Could not decrypt backup with the provided key or supported crypt15 format.");
  } finally {
    await rm(rawPath, { force: true });
  }

  return {
    sqlitePath,
    createdByDecryption: true,
    cleanup: async () => {
      if (!options.keepDecrypted) {
        await rm(sqlitePath, { force: true });
      }
    }
  };
}

export function deriveCrypt15BackupKey(rootKey: Buffer): Buffer {
  if (rootKey.length !== 32) {
    throw new PublicError("KEY_INVALID", "Backup key must be 32 bytes or 64 hex characters.");
  }
  const privateKey = createHmac("sha256", Buffer.alloc(32)).update(rootKey).digest();
  return createHmac("sha256", privateKey).update(Buffer.from("backup encryption")).update(Buffer.from([1])).digest();
}

export async function loadCrypt15RootKey(keyText?: string | null, keyPath?: string | null): Promise<Buffer> {
  return loadBackupKey(keyText, keyPath);
}

async function loadBackupKey(keyText: string | null | undefined, keyPath: string | null | undefined): Promise<Buffer> {
  if (keyText?.trim()) {
    return parseKeyBytes(Buffer.from(keyText.trim(), "utf8"));
  }
  if (!keyPath) {
    throw new PublicError("KEY_REQUIRED", "A 64-character key or encrypted_backup.key file is required for crypt15 decryption.");
  }
  if (!fs.existsSync(keyPath)) {
    throw new PublicError("KEY_MISSING", "Backup key file was not found.");
  }
  return parseKeyBytes(await readFile(keyPath));
}

function parseKeyBytes(input: Buffer): Buffer {
  const asText = input.toString("utf8").trim().replace(/\s+/g, "");
  if (/^[A-Fa-f0-9]{64}$/.test(asText)) {
    return Buffer.from(asText, "hex");
  }
  if (input.length === 32) {
    return input;
  }
  if (input.subarray(0, 4).equals(JAVA_SERIALIZED_MAGIC) && input.length >= 32) {
    return input.subarray(input.length - 32);
  }
  throw new PublicError("KEY_INVALID", "Backup key must be a 64-character key, raw 32-byte key, legacy key file, or encrypted_backup.key file.");
}

async function readCrypt15Header(filePath: string): Promise<Crypt15Header> {
  const fd = await fs.promises.open(filePath, "r");
  try {
    const first = Buffer.alloc(2);
    const { bytesRead } = await fd.read(first, 0, 2, 0);
    if (bytesRead < 2) {
      throw new PublicError("CRYPT15_TRUNCATED", "Encrypted backup header is truncated.");
    }
    const protobufSize = first[0];
    let offset = 1;
    const headerParts = [first.subarray(0, 1)];
    if (first[1] === 1) {
      headerParts.push(first.subarray(1, 2));
      offset = 2;
    }
    const protoBytes = Buffer.alloc(protobufSize);
    const protoRead = await fd.read(protoBytes, 0, protobufSize, offset);
    if (protoRead.bytesRead !== protobufSize) {
      throw new PublicError("CRYPT15_TRUNCATED", "Encrypted backup protobuf header is truncated.");
    }
    headerParts.push(protoBytes);
    const decoded = BackupPrefix.decode(protoBytes) as unknown as { c15Iv?: { IV?: Uint8Array; iv?: Uint8Array }; c15_iv?: { IV?: Uint8Array; iv?: Uint8Array } };
    const c15 = decoded.c15Iv ?? decoded.c15_iv;
    const ivBytes = c15?.IV ?? c15?.iv;
    const iv = Buffer.from(ivBytes ?? []);
    if (iv.length !== 16) {
      throw new PublicError("CRYPT15_UNSUPPORTED", "Encrypted backup header does not contain a supported crypt15 IV.");
    }
    return {
      iv,
      dataOffset: offset + protobufSize,
      headerBytes: Buffer.concat(headerParts)
    };
  } finally {
    await fd.close();
  }
}

async function readTail(filePath: string, bytes: number): Promise<Buffer> {
  const stats = await stat(filePath);
  if (stats.size < bytes) {
    throw new PublicError("CRYPT15_TRUNCATED", "Encrypted backup is truncated.");
  }
  const fd = await fs.promises.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    await fd.read(buffer, 0, bytes, stats.size - bytes);
    return buffer;
  } finally {
    await fd.close();
  }
}

async function md5Range(
  filePath: string,
  headerBytes: Buffer,
  start: number,
  end: number,
  authTag: Buffer,
  onProgress?: ImportProgressHandler,
  signal?: AbortSignal
): Promise<Buffer> {
  const hash = createHash("md5").update(headerBytes);
  const totalBytes = Math.max(0, end - start);
  let processedBytes = 0;
  await pipeline(createReadStream(filePath, { start, end: end - 1 }), async function (source) {
    for await (const chunk of source) {
      throwIfAborted(signal);
      const buffer = chunk as Buffer;
      hash.update(buffer);
      processedBytes += buffer.length;
      onProgress?.({
        type: "file-progress",
        phase: "verify",
        message: "Verifying encrypted backup checksum.",
        processedBytes,
        totalBytes
      });
    }
  });
  hash.update(authTag);
  return hash.digest();
}

async function decryptRangeToFile(
  inputPath: string,
  outputPath: string,
  start: number,
  end: number,
  key: Buffer,
  iv: Buffer,
  authTag: Buffer,
  onProgress?: ImportProgressHandler,
  signal?: AbortSignal
): Promise<void> {
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  const totalBytes = Math.max(0, end - start);
  let processedBytes = 0;
  await pipeline(
    createReadStream(inputPath, { start, end: end - 1 }),
    async function* (source) {
      for await (const chunk of source) {
        throwIfAborted(signal);
        const buffer = chunk as Buffer;
        processedBytes += buffer.length;
        onProgress?.({
          type: "file-progress",
          phase: "decrypt",
          message: "Decrypting crypt15 payload.",
          processedBytes,
          totalBytes
        });
        yield buffer;
      }
    },
    decipher,
    createWriteStream(outputPath)
  );
}

async function materializeSqlite(rawPath: string, sqlitePath: string, onProgress?: ImportProgressHandler, signal?: AbortSignal): Promise<void> {
  const head = await readHead(rawPath, 16);
  const rawSize = (await stat(rawPath)).size;
  if (head.subarray(0, SQLITE_MAGIC.length).equals(SQLITE_MAGIC)) {
    await copyWithProgress(rawPath, sqlitePath, rawSize, "Materializing decrypted SQLite database.", onProgress, signal);
    return;
  }
  try {
    let processedBytes = 0;
    await pipeline(
      createReadStream(rawPath),
      async function* (source) {
        for await (const chunk of source) {
          throwIfAborted(signal);
          const buffer = chunk as Buffer;
          processedBytes += buffer.length;
          onProgress?.({
            type: "file-progress",
            phase: "materialize",
            message: "Inflating decrypted SQLite database.",
            processedBytes,
            totalBytes: rawSize
          });
          yield buffer;
        }
      },
      createInflate(),
      createWriteStream(sqlitePath)
    );
  } catch {
    throw new PublicError("CRYPT15_DECOMPRESS_FAILED", "Decrypted backup was not a recognized SQLite database.");
  }
}

async function copyWithProgress(
  inputPath: string,
  outputPath: string,
  totalBytes: number,
  message: string,
  onProgress?: ImportProgressHandler,
  signal?: AbortSignal
): Promise<void> {
  let processedBytes = 0;
  await pipeline(
    createReadStream(inputPath),
    async function* (source) {
      for await (const chunk of source) {
        throwIfAborted(signal);
        const buffer = chunk as Buffer;
        processedBytes += buffer.length;
        onProgress?.({
          type: "file-progress",
          phase: "materialize",
          message,
          processedBytes,
          totalBytes
        });
        yield buffer;
      }
    },
    createWriteStream(outputPath)
  );
}

async function assertSqliteMagic(filePath: string, code = "CRYPT_SQLITE_INVALID"): Promise<void> {
  const head = await readHead(filePath, SQLITE_MAGIC.length);
  if (!head.equals(SQLITE_MAGIC)) {
    throw new PublicError(code, "Decrypted backup was not a valid SQLite database.");
  }
}

async function readHead(filePath: string, bytes: number): Promise<Buffer> {
  const fd = await fs.promises.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const result = await fd.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, result.bytesRead);
  } finally {
    await fd.close();
  }
}

function cryptoSafeSuffix(inputPath: string): string {
  const base = path.basename(inputPath).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 32);
  const random = randomBytes(6).toString("hex");
  return `${base}-${random}`;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new PublicError("IMPORT_CANCELLED", "Import stopped by user request.");
  }
}

export function createCrypt15Fixture(rootKey: Buffer, sqliteBytes: Buffer): Buffer {
  const iv = randomBytes(16);
  const derivedKey = deriveCrypt15BackupKey(rootKey);
  const Prefix = BackupPrefix;
  const prefixBytes = Buffer.from(
    Prefix.encode(
      Prefix.create({
        keyType: 1,
        c15Iv: { IV: iv },
        info: { appVersion: "2.26.1.1", jidSuffix: "00", backupVersion: 1, f10: true, f11: true }
      })
    ).finish()
  );
  const header = Buffer.concat([Buffer.from([prefixBytes.length, 1]), prefixBytes]);
  const cipher = createCipheriv("aes-256-gcm", derivedKey, iv);
  const encrypted = Buffer.concat([cipher.update(deflateSync(sqliteBytes)), cipher.final()]);
  const tag = cipher.getAuthTag();
  const checksum = createHash("md5").update(header).update(encrypted).update(tag).digest();
  return Buffer.concat([header, encrypted, tag, checksum]);
}
