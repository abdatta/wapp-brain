import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config";
import { cleanupDecryptedWorkDir } from "./cleanup";
import { createArchiveRepository, initializeArchiveDatabase } from "./db/archive";
import { runImport } from "./import/importer";
import { isLocalDatabaseError, publicErrorMessage } from "./privacy";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.disable("x-powered-by");
app.use(express.json({ limit: "64kb" }));

const repository = createArchiveRepository();

app.get("/api/status", async (_req, res) => {
  try {
    res.json(await repository.getStatus());
  } catch {
    res.json({
      database: {
        configured: true,
        initialized: false,
        adapter: config.archive.adapter,
        error: "Local archive database is not initialized or not reachable."
      },
      counts: { chats: 0, contacts: 0, participants: 0, messages: 0, warnings: 0 },
      latestImport: null,
      latestWarnings: []
    });
  }
});

app.post("/api/init-db", async (_req, res) => {
  try {
    await initializeArchiveDatabase();
    res.json({ ok: true, status: await repository.getStatus() });
  } catch (error) {
    res.status(400).json({ ok: false, error: publicErrorMessage(error) });
  }
});

app.post("/api/import", async (req, res) => {
  try {
    const totals = await runImport(repository, {
      msgstorePath: String(req.body?.msgstorePath ?? ""),
      waPath: req.body?.waPath ? String(req.body.waPath) : null,
      mediaPath: req.body?.mediaPath ? String(req.body.mediaPath) : null,
      key: req.body?.key ? String(req.body.key) : null,
      keyPath: req.body?.keyPath ? String(req.body.keyPath) : null,
      keepDecrypted: Boolean(req.body?.keepDecrypted)
    });
    res.json({ ok: true, totals });
  } catch (error) {
    res.status(400).json({ ok: false, error: publicErrorMessage(error) });
  }
});

app.post("/api/cleanup", async (_req, res) => {
  try {
    res.json({ ok: true, summary: await cleanupDecryptedWorkDir() });
  } catch (error) {
    res.status(400).json({ ok: false, error: publicErrorMessage(error) });
  }
});

app.get("/api/chats", async (req, res) => {
  try {
    const limit = clampNumber(req.query.limit, 25, 200, 60);
    const offset = clampNumber(req.query.offset, 0, 1_000_000, 0);
    res.json(
      await repository.listChats({
        search: stringQuery(req.query.search),
        type: stringQuery(req.query.type),
        includeEventOnly: booleanQuery(req.query.includeEventOnly),
        limit,
        offset
      })
    );
  } catch (error) {
    if (error instanceof Error && isLocalDatabaseError(error.message)) {
      res.json([]);
      return;
    }
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

app.get("/api/chats/:id/messages", async (req, res) => {
  try {
    const chatId = Number(req.params.id);
    const limit = clampNumber(req.query.limit, 25, 300, 150);
    const offset = clampNumber(req.query.offset, 0, 5_000_000, 0);
    res.json(
      await repository.listMessages(chatId, {
        limit,
        offset,
        sender: stringQuery(req.query.sender),
        query: stringQuery(req.query.query),
        order: req.query.order === "desc" ? "desc" : "asc"
      })
    );
  } catch (error) {
    if (error instanceof Error && isLocalDatabaseError(error.message)) {
      res.json([]);
      return;
    }
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

const distDir = path.resolve(__dirname, "../../dist");
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get(/.*/, (_req, res) => {
    res.sendFile(path.join(distDir, "index.html"));
  });
}

app.listen(config.app.port, config.app.host, () => {
  console.log(`Wapp Brain listening on http://${config.app.host}:${config.app.port}`);
});

function stringQuery(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function booleanQuery(value: unknown): boolean {
  return value === true || value === "true" || value === "1";
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(number)));
}
