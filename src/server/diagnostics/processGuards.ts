// Last line of defense for live-sync longevity. The media path guards its own
// downloads (see media/downloader.ts collectMediaStream), but undici and
// Baileys construct sockets and streams no caller can reach, and an unhandled
// 'error' event on any of them kills the whole archive server (observed
// 2026-07-20: Fetch.onAborted → TypeError: terminated, cause read ECONNRESET,
// emitted on an internal Readable during a live media pass — exit 1 mid-sync).
// Survivable network teardowns get logged and absorbed; everything else keeps
// the default fatal behavior, because swallowing unknown exceptions would
// leave the archive in an unknowable state.

const SURVIVABLE_SOCKET_CODES = new Set([
  "ECONNRESET",
  "ECONNABORTED",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETRESET",
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_ABORTED",
  "UND_ERR_CLOSED",
  "UND_ERR_DESTROYED"
]);

// A connection/stream teardown the server can outlive: any error whose cause
// chain carries a socket error code, or undici's bare fetch-body termination.
export function isSurvivableStreamTeardown(error: unknown): boolean {
  for (let cursor = error, depth = 0; cursor != null && depth < 8; cursor = (cursor as { cause?: unknown }).cause, depth += 1) {
    const code = (cursor as { code?: unknown }).code;
    if (typeof code === "string" && SURVIVABLE_SOCKET_CODES.has(code)) {
      return true;
    }
    // undici raises TypeError("terminated") / TypeError("aborted") for fetch
    // bodies torn down without a more specific cause attached.
    if (cursor instanceof TypeError && (cursor.message === "terminated" || cursor.message === "aborted")) {
      return true;
    }
  }
  return false;
}

export function createUncaughtExceptionGuard(hooks: {
  log: (line: string) => void;
  fatal: (error: Error) => void;
}): (error: Error, origin: string) => void {
  return (error, origin) => {
    if (isSurvivableStreamTeardown(error)) {
      hooks.log(`[guard] Survived ${origin}: ${describeErrorChain(error)} — a network stream died outside any handler; live sync continues.`);
      return;
    }
    hooks.fatal(error);
  };
}

export function installLiveProcessGuards(): void {
  // Installing any 'uncaughtException' listener disables Node's default
  // crash, so the guard must re-crash explicitly for everything it does not
  // recognize. In the default unhandled-rejections=throw mode, escaped
  // rejections also arrive here (origin "unhandledRejection").
  process.on(
    "uncaughtException",
    createUncaughtExceptionGuard({
      log: (line) => console.error(line),
      fatal: (error) => {
        console.error(error);
        process.exit(1);
      }
    })
  );
}

function describeErrorChain(error: unknown): string {
  const parts: string[] = [];
  for (let cursor = error, depth = 0; cursor != null && depth < 8; cursor = (cursor as { cause?: unknown }).cause, depth += 1) {
    parts.push(cursor instanceof Error ? cursor.message : String(cursor));
  }
  return parts.join(" ← ").slice(0, 500);
}
