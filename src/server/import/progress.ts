import * as cliProgress from "cli-progress";
import ora, { type Ora } from "ora";
import type { ImportProgressEvent } from "../../shared/types";

export type { ImportProgressEvent } from "../../shared/types";

export type ImportProgressHandler = (event: ImportProgressEvent) => void;

type FileProgressPhase = Extract<ImportProgressEvent, { type: "file-progress" }>["phase"];

export class ImportTerminalProgress {
  private spinner: Ora;
  private fileBar: cliProgress.SingleBar | null = null;
  private messageBar: cliProgress.SingleBar | null = null;
  private filePhase: FileProgressPhase | null = null;
  private lastFileUpdateAt = 0;
  private lastMessageUpdateAt = 0;

  constructor(label = "Starting import.") {
    this.spinner = ora({ text: label, stream: process.stderr });
  }

  handle(event: ImportProgressEvent): void {
    switch (event.type) {
      case "step":
        if (event.step !== "messages") {
          this.stopMessageBar();
        }
        if (event.step !== "decrypting") {
          this.stopFileBar();
        }
        this.setSpinner(event.message);
        break;
      case "file-progress":
        this.handleFileProgress(event);
        break;
      case "message-progress":
        this.handleMessageProgress(event);
        break;
      case "warnings":
        if (event.count > 0) {
          this.setSpinner(`Recorded ${event.count.toLocaleString()} import warning(s).`);
        }
        break;
      case "complete":
        this.complete(event.totals);
        break;
    }
  }

  complete(totals: { messages: number; warnings: number }): void {
    this.stopFileBar();
    this.stopMessageBar();
    if (this.spinner.isSpinning) {
      this.spinner.succeed(`Import complete: ${totals.messages.toLocaleString()} messages, ${totals.warnings.toLocaleString()} warning(s).`);
    }
  }

  fail(message: string): void {
    this.stopFileBar();
    this.stopMessageBar();
    if (this.spinner.isSpinning) {
      this.spinner.fail(message);
    } else {
      process.stderr.write(`Import failed: ${message}\n`);
    }
  }

  stop(message?: string): void {
    this.stopFileBar();
    this.stopMessageBar();
    if (this.spinner.isSpinning) {
      if (message) {
        this.spinner.warn(message);
      } else {
        this.spinner.stop();
      }
    }
  }

  private handleFileProgress(event: Extract<ImportProgressEvent, { type: "file-progress" }>): void {
    const now = Date.now();
    const done = event.processedBytes >= event.totalBytes;
    if (!done && now - this.lastFileUpdateAt < 100) {
      return;
    }
    this.lastFileUpdateAt = now;
    if (this.filePhase !== event.phase) {
      this.stopFileBar();
      this.stopMessageBar();
      if (this.spinner.isSpinning) {
        this.spinner.stop();
      }
      this.filePhase = event.phase;
      this.fileBar = new cliProgress.SingleBar(
        {
          format: "{task} |{bar}| {percentage}% | {done}/{size} | ETA {eta_formatted}",
          barsize: 28,
          clearOnComplete: false,
          hideCursor: true,
          stream: process.stderr
        },
        cliProgress.Presets.shades_classic
      );
      this.fileBar.start(event.totalBytes, 0, {
        task: event.message,
        done: "0 B",
        size: formatBytes(event.totalBytes)
      });
    }
    this.fileBar?.update(event.processedBytes, {
      task: event.message,
      done: formatBytes(event.processedBytes),
      size: formatBytes(event.totalBytes)
    });
    if (done) {
      this.stopFileBar();
      this.setSpinner(event.phase === "verify" ? "Encrypted backup verified." : "Encrypted payload decrypted.");
    }
  }

  private handleMessageProgress(event: Extract<ImportProgressEvent, { type: "message-progress" }>): void {
    const now = Date.now();
    const total = event.totalMessages;
    if (total == null || total <= 0) {
      if (now - this.lastMessageUpdateAt >= 1000 || event.processedMessages === 0) {
        this.setSpinner(`Imported ${event.persistedMessages.toLocaleString()} messages...`);
        this.lastMessageUpdateAt = now;
      }
      return;
    }
    const done = event.processedMessages >= total;
    if (!done && now - this.lastMessageUpdateAt < 100) {
      return;
    }
    this.lastMessageUpdateAt = now;
    this.stopFileBar();
    if (!this.messageBar) {
      if (this.spinner.isSpinning) {
        this.spinner.stop();
      }
      this.messageBar = new cliProgress.SingleBar(
        {
          format: "Importing messages |{bar}| {percentage}% | {value}/{total} | ETA {eta_formatted}",
          barsize: 28,
          clearOnComplete: false,
          hideCursor: true,
          stream: process.stderr
        },
        cliProgress.Presets.shades_classic
      );
      this.messageBar.start(total, 0);
    }
    this.messageBar.update(Math.min(event.processedMessages, total));
    if (done) {
      this.stopMessageBar();
      this.setSpinner(`Persisted ${event.persistedMessages.toLocaleString()} messages.`);
    }
  }

  private setSpinner(message: string): void {
    this.spinner.text = message;
    if (!this.spinner.isSpinning) {
      this.spinner.start();
    }
  }

  private stopFileBar(): void {
    if (this.fileBar) {
      this.fileBar.stop();
      this.fileBar = null;
      this.filePhase = null;
    }
  }

  private stopMessageBar(): void {
    if (this.messageBar) {
      this.messageBar.stop();
      this.messageBar = null;
    }
  }
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}
