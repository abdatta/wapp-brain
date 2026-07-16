import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ArchiveRepository } from "../src/server/db/repository";
import type { PersonRecord, PersonSuggestionRecord } from "../src/shared/types";
import { SqliteArchiveRepository } from "../src/server/db/sqliteRepository";
import { messageKey } from "../src/server/identity/keys";

const A = "919000000001@s.whatsapp.net";
const B = "919000000002@s.whatsapp.net";
const C = "919000000003@s.whatsapp.net";

// Same-name suggestions require unifiable history (the zero-value rule), so
// the seeded world gives one side a message.
async function seedMessageFrom(repository: ArchiveRepository, runId: string, jid: string): Promise<void> {
  await repository.upsertChats(runId, [{ sourceChatId: jid, jid, chatType: "dm" }]);
  await repository.upsertMessages([
    {
      sourceMessageId: "api-m1",
      sourceMessageKey: messageKey(jid, "api-m1"),
      sourceTable: "message",
      sourceRowId: "1",
      chatSourceId: jid,
      senderSourceJid: jid,
      timestampMs: 1_710_000_000_000,
      sentAtIso: "2024-03-09T16:00:00.000Z",
      fromMe: false,
      direction: "incoming",
      messageType: "text",
      body: "hello",
      caption: null,
      hasMedia: false,
      isDeleted: false,
      isForwarded: false,
      isStarred: false
    }
  ]);
}

describe("person management API", () => {
  it("covers connect/disconnect with suppression, suggestion accept/reject, scan, and redirect resolution", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-person-api-"));
    const archivePath = path.join(directory, "archive.sqlite");
    const workDir = path.join(directory, "work");
    const repository = new SqliteArchiveRepository(archivePath);
    let child: ReturnType<typeof spawn> | null = null;
    try {
      const runId = await repository.startImportRun({ source: "person-api" });
      await repository.upsertContacts(runId, [
        { sourceJid: A, phoneNumber: A.split("@")[0], displayName: "Rohit" },
        { sourceJid: B, phoneNumber: B.split("@")[0], displayName: "Rohit" },
        { sourceJid: C, phoneNumber: C.split("@")[0], displayName: "Priya" }
      ]);
      await seedMessageFrom(repository, runId, A);
      // A same-contact grouping so the scan route has something to auto-connect.
      await repository.replaceGoogleContactGroups([
        { resourceName: "people/c1", phoneE164: A.split("@")[0], displayName: "Rohit" },
        { resourceName: "people/c1", phoneE164: C.split("@")[0], displayName: "Rohit" }
      ]);
      await repository.close();

      const port = 6500 + Math.floor(Math.random() * 500);
      child = spawn(process.execPath, ["--import", "tsx", "src/server/server.ts"], {
        cwd: path.resolve(__dirname, ".."),
        env: { ...process.env, APP_HOST: "127.0.0.1", APP_PORT: String(port), ARCHIVE_DB_PATH: archivePath, WAPP_WORK_DIR: workDir, LIVE_AUTO_RESUME: "0" },
        stdio: "ignore"
      });
      const base = `http://127.0.0.1:${port}`;
      await waitForHttp(`${base}/api/status`);

      // Scan: auto-connects the google grouping and produces the same-name suggestion.
      const scan = await postJson<{ ok: boolean; autoConnect: { googleConnected: number }; detectors: { created: number } }>(`${base}/api/persons/scan`, {});
      expect(scan.ok).toBe(true);
      expect(scan.autoConnect.googleConnected).toBe(1);
      expect(scan.detectors.created).toBeGreaterThan(0);

      const persons = (await fetchJson<{ persons: PersonRecord[] }>(`${base}/api/persons`)).persons;
      expect(persons).toHaveLength(1);
      const googlePerson = persons[0];
      expect(googlePerson.members.map((member) => member.identityJid).sort()).toEqual([A, C].sort());
      expect(googlePerson.members.every((member) => member.source === "google")).toBe(true);
      expect(googlePerson.members[0].evidence).toEqual({ resourceName: "people/c1" });

      // Suggestions carry evidence and rank; reject one → it never returns.
      const suggestions = (await fetchJson<{ suggestions: PersonSuggestionRecord[] }>(`${base}/api/persons/suggestions`)).suggestions;
      const sameName = suggestions.find((suggestion) => suggestion.kind === "same_name");
      expect(sameName).toBeTruthy();
      expect(sameName!.evidence.name).toBe("Rohit");
      const reject = await postJson<{ ok: boolean }>(`${base}/api/persons/suggestions/${sameName!.id}/reject`, {});
      expect(reject.ok).toBe(true);
      const rescan = await postJson<{ ok: boolean; detectors: { created: number; updated: number } }>(`${base}/api/persons/scan`, {});
      expect(rescan.ok).toBe(true);
      const pendingAfter = (await fetchJson<{ suggestions: PersonSuggestionRecord[] }>(`${base}/api/persons/suggestions`)).suggestions;
      expect(pendingAfter.filter((suggestion) => suggestion.kind === "same_name")).toHaveLength(0);
      // Rejecting again is a clean 404, not an error.
      expect((await postRaw(`${base}/api/persons/suggestions/${sameName!.id}/reject`, {})).status).toBe(404);

      // Manual connect (clears nothing here, new pair) and disconnect with suppression.
      const connect = await postJson<{ ok: boolean; result: { outcome: string; personId: string }; person: PersonRecord }>(`${base}/api/persons/connect`, { jidA: A, jidB: B });
      expect(connect.result.outcome).toBe("connected");
      expect(connect.person.members).toHaveLength(3);
      const disconnect = await postJson<{ ok: boolean; result: { disconnected: boolean; personId: string; dissolved: boolean } }>(`${base}/api/persons/disconnect`, { jid: B });
      expect(disconnect.result).toMatchObject({ disconnected: true, dissolved: false });
      const suppressions = (await fetchJson<{ suppressions: Array<{ jidLow: string; jidHigh: string; reason: string }> }>(`${base}/api/persons/suppressions`)).suppressions;
      expect(suppressions.length).toBeGreaterThanOrEqual(2);
      expect(suppressions.every((row) => row.reason === "disconnected" || row.reason === "suggestion_rejected")).toBe(true);

      // Disconnect down to a singleton dissolves; the held person id resolves
      // through a redirect instead of erroring.
      const personId = connect.result.personId;
      await postJson(`${base}/api/persons/disconnect`, { jid: C });
      const lookup = await fetchJson<{ person: PersonRecord | null; redirect: { survivingJid: string | null } | null }>(`${base}/api/persons/${personId}`);
      expect(lookup.person).toBeNull();
      expect(lookup.redirect?.survivingJid).toBe(A);
      // A truly unknown id is a 404.
      expect((await fetch(`${base}/api/persons/person_does_not_exist`)).status).toBe(404);

      // Accept flow: re-create a pending suggestion for a fresh pair via scan
      // is suppressed now, so upsert directly through connect+API instead:
      // reuse the pending list — the shared_vcard/succession detectors made
      // nothing here, so drive accept through a fresh same-name pair.
      const disconnectA = await postJson<{ ok: boolean }>(`${base}/api/persons/disconnect`, { jid: A }).catch(() => null);
      expect(disconnectA).toBeNull(); // A is no longer a member (person dissolved above)
    } finally {
      if (child) {
        child.kill();
        await new Promise<void>((resolve) => child!.once("exit", () => resolve()));
      }
      await rm(directory, { recursive: true, force: true });
    }
  }, 90_000);

  it("accepts a pending suggestion end-to-end with user provenance", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-person-api2-"));
    const archivePath = path.join(directory, "archive.sqlite");
    const workDir = path.join(directory, "work");
    const repository = new SqliteArchiveRepository(archivePath);
    let child: ReturnType<typeof spawn> | null = null;
    try {
      const runId = await repository.startImportRun({ source: "person-api" });
      await repository.upsertContacts(runId, [
        { sourceJid: A, phoneNumber: A.split("@")[0], displayName: "Rohit" },
        { sourceJid: B, phoneNumber: B.split("@")[0], displayName: "Rohit" }
      ]);
      await seedMessageFrom(repository, runId, A);
      await repository.close();

      const port = 6500 + Math.floor(Math.random() * 500);
      child = spawn(process.execPath, ["--import", "tsx", "src/server/server.ts"], {
        cwd: path.resolve(__dirname, ".."),
        env: { ...process.env, APP_HOST: "127.0.0.1", APP_PORT: String(port), ARCHIVE_DB_PATH: archivePath, WAPP_WORK_DIR: workDir, LIVE_AUTO_RESUME: "0" },
        stdio: "ignore"
      });
      const base = `http://127.0.0.1:${port}`;
      await waitForHttp(`${base}/api/status`);

      await postJson(`${base}/api/persons/scan`, {});
      const [pending] = (await fetchJson<{ suggestions: PersonSuggestionRecord[] }>(`${base}/api/persons/suggestions`)).suggestions;
      expect(pending.kind).toBe("same_name");
      const accept = await postJson<{ ok: boolean; result: { outcome: string }; person: PersonRecord }>(`${base}/api/persons/suggestions/${pending.id}/accept`, {});
      expect(accept.result.outcome).toBe("connected");
      expect(accept.person.members.every((member) => member.source === "user")).toBe(true);
      expect(accept.person.members[0].evidence).toMatchObject({ suggestionId: pending.id });
      // Accepting twice is a clean client error.
      expect((await postRaw(`${base}/api/persons/suggestions/${pending.id}/accept`, {})).status).toBe(400);
    } finally {
      if (child) {
        child.kill();
        await new Promise<void>((resolve) => child!.once("exit", () => resolve()));
      }
      await rm(directory, { recursive: true, force: true });
    }
  }, 90_000);
});

async function waitForHttp(url: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // The loopback TypeScript server may take a few seconds to start.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}

async function postRaw(url: string, body: unknown): Promise<Response> {
  return fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await postRaw(url, body);
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}
