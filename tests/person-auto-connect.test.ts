import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { ArchiveRepository } from "../src/server/db/repository";
import { MemoryArchiveRepository } from "../src/server/db/memoryRepository";
import { SqliteArchiveRepository } from "../src/server/db/sqliteRepository";
import { runPersonAutoConnectPass } from "../src/server/persons/autoConnect";

const A = "919000000001@s.whatsapp.net";
const B = "919000000002@s.whatsapp.net";
const C = "919000000003@s.whatsapp.net";

async function withRepository<T>(
  kind: "memory" | "sqlite",
  run: (repository: ArchiveRepository) => Promise<T>
): Promise<T> {
  if (kind === "memory") {
    return run(new MemoryArchiveRepository());
  }
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-person-auto-"));
  const repository = new SqliteArchiveRepository(path.join(tempDir, "archive.sqlite"));
  try {
    return await run(repository);
  } finally {
    await repository.close();
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function seedContacts(repository: ArchiveRepository, jids: string[]): Promise<void> {
  const runId = await repository.startImportRun({ source: "person-auto-connect-test" });
  await repository.upsertContacts(
    runId,
    jids.map((jid) => ({ sourceJid: jid, phoneNumber: jid.split("@")[0] }))
  );
}

async function seedNumberChange(repository: ArchiveRepository, oldJid: string, newJid: string, eventKey: string): Promise<void> {
  await repository.upsertArchiveSignals({
    numberChanges: [
      {
        eventKey,
        chatSourceId: oldJid,
        sourceMessageKey: null,
        oldJid,
        newJid,
        actorJid: null,
        source: "backup",
        sourceEventKey: eventKey,
        observedAtMs: 1_710_000_000_000,
        captureVersion: 1
      }
    ]
  });
}

for (const kind of ["memory", "sqlite"] as const) {
  describe(`person auto-connect pass (${kind})`, () => {
    it("connects same-Google-contact identities with provenance and is idempotent", async () => {
      await withRepository(kind, async (repository) => {
        await seedContacts(repository, [A, B, C]);
        await repository.replaceGoogleContactGroups([
          { resourceName: "people/c1", phoneE164: A.split("@")[0], displayName: "Asha" },
          { resourceName: "people/c1", phoneE164: B.split("@")[0], displayName: "Asha" },
          // A contact whose numbers match fewer than two archived identities
          // never connects anything.
          { resourceName: "people/c2", phoneE164: "10000000000", displayName: "Stranger" }
        ]);
        const first = await runPersonAutoConnectPass(repository);
        expect(first.googleConnected).toBe(1);
        expect(first.numberChangeConnected).toBe(0);
        const person = await repository.resolvePersonForJid(A);
        expect(person?.members.map((member) => member.identityJid).sort()).toEqual([A, B]);
        expect(person?.members.every((member) => member.source === "google")).toBe(true);
        expect(person?.members[0]?.evidence).toEqual({ resourceName: "people/c1" });

        const second = await runPersonAutoConnectPass(repository);
        expect(second.googleConnected + second.numberChangeConnected + second.unions).toBe(0);
      });
    });

    it("consumes the number-change backlog on first pass, idempotently, with event-key provenance", async () => {
      await withRepository(kind, async (repository) => {
        await seedContacts(repository, [A, B]);
        await seedNumberChange(repository, A, B, "backup:number-change:1");

        const first = await runPersonAutoConnectPass(repository);
        expect(first.numberChangeConnected).toBe(1);
        const person = await repository.resolvePersonForJid(B);
        expect(person?.members).toHaveLength(2);
        expect(person?.members.every((member) => member.source === "number_change")).toBe(true);
        // Evidence carries the stored record's stable event key (the batch
        // writer derives it; the supplied key lands in source_event_key).
        const [storedChange] = await repository.listIdentityNumberChanges({ oldJid: A });
        expect(storedChange?.eventKey).toBeTruthy();
        expect(person?.members[0]?.evidence).toEqual({ eventKey: storedChange.eventKey });

        const second = await runPersonAutoConnectPass(repository);
        expect(second.googleConnected + second.numberChangeConnected + second.unions).toBe(0);
      });
    });

    it("skips suppressed pairs for both sources and never reconnects after a disconnect", async () => {
      await withRepository(kind, async (repository) => {
        await seedContacts(repository, [A, B]);
        await repository.replaceGoogleContactGroups([
          { resourceName: "people/c1", phoneE164: A.split("@")[0], displayName: "Asha" },
          { resourceName: "people/c1", phoneE164: B.split("@")[0], displayName: "Asha" }
        ]);
        await seedNumberChange(repository, A, B, "backup:number-change:2");

        const first = await runPersonAutoConnectPass(repository);
        expect(first.googleConnected + first.numberChangeConnected).toBeGreaterThan(0);

        await repository.disconnectIdentities(A);
        const after = await runPersonAutoConnectPass(repository);
        expect(after.googleConnected + after.numberChangeConnected).toBe(0);
        expect(after.skippedSuppressed).toBeGreaterThan(0);
        expect(await repository.resolvePersonForJid(A)).toBeNull();
      });
    });

    it("grouping disappearance never disconnects previously connected identities", async () => {
      await withRepository(kind, async (repository) => {
        await seedContacts(repository, [A, B]);
        await repository.replaceGoogleContactGroups([
          { resourceName: "people/c1", phoneE164: A.split("@")[0], displayName: "Asha" },
          { resourceName: "people/c1", phoneE164: B.split("@")[0], displayName: "Asha" }
        ]);
        await runPersonAutoConnectPass(repository);
        expect((await repository.resolvePersonForJid(A))?.members).toHaveLength(2);

        // The provider stops asserting the grouping entirely.
        await repository.replaceGoogleContactGroups([]);
        const after = await runPersonAutoConnectPass(repository);
        expect(after.googleConnected + after.numberChangeConnected).toBe(0);
        expect((await repository.resolvePersonForJid(A))?.members).toHaveLength(2);
      });
    });

    it("number-change auto-connect unions existing persons that share the human", async () => {
      await withRepository(kind, async (repository) => {
        await seedContacts(repository, [A, B, C]);
        await repository.connectIdentities(A, C, "user");
        await seedNumberChange(repository, A, B, "backup:number-change:3");
        const summary = await runPersonAutoConnectPass(repository);
        expect(summary.numberChangeConnected).toBe(1);
        const keys = await repository.personKeyForJids([A, B, C]);
        expect(new Set(keys.values()).size).toBe(1);
      });
    });
  });
}
