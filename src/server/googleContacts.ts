import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ArchiveRepository } from "./db/repository";
import type { GoogleContactCandidate, GoogleContactsStatus, GoogleContactsSyncResult } from "../shared/types";
import { PublicError } from "./privacy";

const CONTACTS_SCOPE = "https://www.googleapis.com/auth/contacts.readonly";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const PEOPLE_URL = "https://people.googleapis.com/v1/people/me/connections";

interface GoogleContactsOptions {
  clientId: string | null;
  clientSecret: string | null;
  callbackUrl: string;
  credentialsPath: string;
  fetch?: typeof fetch;
  now?: () => number;
}

interface StoredAuth {
  accessToken: string;
  refreshToken: string | null;
  expiresAtMs: number;
  accountLabel: string | null;
  lastSync: GoogleContactsSyncResult | null;
}

interface GooglePerson {
  metadata?: { deleted?: boolean };
  names?: Array<{ displayName?: string }>;
  phoneNumbers?: Array<{ value?: string; canonicalForm?: string }>;
}

export class GoogleContactsService {
  private pendingState: { value: string; expiresAtMs: number } | null = null;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: GoogleContactsOptions) {
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async status(): Promise<GoogleContactsStatus> {
    const auth = await this.readAuth();
    return {
      configured: this.configured(),
      connected: Boolean(auth?.refreshToken || (auth?.accessToken && auth.expiresAtMs > this.now())),
      accountLabel: auth?.accountLabel ?? null,
      callbackUrl: this.options.callbackUrl,
      lastSync: auth?.lastSync ?? null
    };
  }

  createAuthorizationUrl(): string {
    this.assertConfigured();
    const state = crypto.randomBytes(32).toString("base64url");
    this.pendingState = { value: state, expiresAtMs: this.now() + 10 * 60_000 };
    const url = new URL(AUTH_URL);
    url.search = new URLSearchParams({
      client_id: this.options.clientId!, response_type: "code", redirect_uri: this.options.callbackUrl,
      scope: CONTACTS_SCOPE, state, access_type: "offline", prompt: "consent", include_granted_scopes: "true"
    }).toString();
    return url.toString();
  }

  async handleCallback(code: string, state: string): Promise<void> {
    this.assertConfigured();
    const pending = this.pendingState;
    this.pendingState = null;
    if (!pending || pending.expiresAtMs < this.now() || !safeEqual(pending.value, state)) {
      throw new PublicError("GOOGLE_OAUTH_STATE", "Google authorization expired or could not be verified. Please try connecting again.");
    }
    if (!code) throw new PublicError("GOOGLE_OAUTH_CODE", "Google did not return an authorization code.");
    const response = await this.fetcher(TOKEN_URL, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code, client_id: this.options.clientId!, client_secret: this.options.clientSecret!, redirect_uri: this.options.callbackUrl, grant_type: "authorization_code" })
    });
    const token = await safeJson(response);
    if (!response.ok || typeof token.access_token !== "string") throw providerError("Google authorization could not be completed.");
    const previous = await this.readAuth();
    await this.writeAuth({
      accessToken: token.access_token,
      refreshToken: typeof token.refresh_token === "string" ? token.refresh_token : previous?.refreshToken ?? null,
      expiresAtMs: this.now() + Number(token.expires_in ?? 3600) * 1000,
      accountLabel: previous?.accountLabel ?? null,
      lastSync: previous?.lastSync ?? null
    });
  }

  async sync(repository: ArchiveRepository): Promise<GoogleContactsSyncResult> {
    const auth = await this.requireAccessToken();
    let pageToken: string | null = null;
    const people: GooglePerson[] = [];
    do {
      const url = new URL(PEOPLE_URL);
      url.searchParams.set("personFields", "names,phoneNumbers,metadata");
      url.searchParams.set("sources", "READ_SOURCE_TYPE_CONTACT");
      url.searchParams.set("pageSize", "1000");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const response = await this.fetcher(url, { headers: { Authorization: `Bearer ${auth.accessToken}` } });
      const payload = await safeJson(response);
      if (!response.ok) throw providerError(response.status === 401 ? "Google Contacts authorization expired. Reconnect the account." : "Google Contacts could not be read right now.");
      if (Array.isArray(payload.connections)) people.push(...payload.connections as GooglePerson[]);
      pageToken = typeof payload.nextPageToken === "string" ? payload.nextPageToken : null;
    } while (pageToken);

    const normalized = buildCandidates(people);
    const enrichment = await repository.enrichContactsFromGoogle(normalized.candidates);
    const result: GoogleContactsSyncResult = {
      fetchedPeople: people.length, usableNumbers: normalized.candidates.length,
      matchedIdentities: enrichment.matchedIdentities, improvedNames: enrichment.improvedNames,
      ambiguousNumbers: normalized.ambiguousNumbers, skippedNumbers: normalized.skippedNumbers,
      syncedAt: new Date(this.now()).toISOString()
    };
    await this.writeAuth({ ...auth, lastSync: result });
    return result;
  }

  async disconnect(): Promise<{ revoked: boolean }> {
    const auth = await this.readAuth();
    let revoked = false;
    try {
      const token = auth?.refreshToken ?? auth?.accessToken;
      if (token) revoked = (await this.fetcher(REVOKE_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }) })).ok;
    } finally {
      await fs.promises.rm(this.options.credentialsPath, { force: true });
    }
    return { revoked };
  }

  private configured(): boolean { return Boolean(this.options.clientId && this.options.clientSecret); }
  private assertConfigured(): void { if (!this.configured()) throw new PublicError("GOOGLE_NOT_CONFIGURED", "Google Contacts is not configured on this local server."); }

  private async requireAccessToken(): Promise<StoredAuth> {
    this.assertConfigured();
    const auth = await this.readAuth();
    if (!auth) throw new PublicError("GOOGLE_NOT_CONNECTED", "Connect a Google account before syncing contacts.");
    if (auth.expiresAtMs > this.now() + 30_000) return auth;
    if (!auth.refreshToken) throw new PublicError("GOOGLE_RECONNECT", "Google Contacts authorization expired. Reconnect the account.");
    const response = await this.fetcher(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: this.options.clientId!, client_secret: this.options.clientSecret!, refresh_token: auth.refreshToken, grant_type: "refresh_token" }) });
    const token = await safeJson(response);
    if (!response.ok || typeof token.access_token !== "string") throw new PublicError("GOOGLE_RECONNECT", "Google Contacts authorization expired. Reconnect the account.");
    const refreshed = { ...auth, accessToken: token.access_token, expiresAtMs: this.now() + Number(token.expires_in ?? 3600) * 1000 };
    await this.writeAuth(refreshed);
    return refreshed;
  }

  private async readAuth(): Promise<StoredAuth | null> {
    try { return JSON.parse(await fs.promises.readFile(this.options.credentialsPath, "utf8")) as StoredAuth; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }

  private async writeAuth(auth: StoredAuth): Promise<void> {
    await fs.promises.mkdir(path.dirname(this.options.credentialsPath), { recursive: true });
    const temp = `${this.options.credentialsPath}.tmp`;
    await fs.promises.writeFile(temp, JSON.stringify(auth), { encoding: "utf8", mode: 0o600 });
    await fs.promises.rename(temp, this.options.credentialsPath);
  }
}

export function normalizeGooglePhone(phone: { value?: string; canonicalForm?: string }): string | null {
  const source = phone.canonicalForm?.trim() || phone.value?.trim() || "";
  if (!source.startsWith("+")) return null;
  const digits = source.replace(/\D/g, "");
  return /^[1-9]\d{7,14}$/.test(digits) ? digits : null;
}

export function buildCandidates(people: GooglePerson[]): { candidates: GoogleContactCandidate[]; ambiguousNumbers: number; skippedNumbers: number } {
  const namesByPhone = new Map<string, Set<string>>();
  let skippedNumbers = 0;
  for (const person of people) {
    if (person.metadata?.deleted) continue;
    const name = person.names?.map((item) => item.displayName?.trim()).find(Boolean);
    for (const phone of person.phoneNumbers ?? []) {
      const normalized = normalizeGooglePhone(phone);
      if (!name || !normalized) { skippedNumbers += 1; continue; }
      const names = namesByPhone.get(normalized) ?? new Set<string>(); names.add(name); namesByPhone.set(normalized, names);
    }
  }
  const candidates: GoogleContactCandidate[] = [];
  let ambiguousNumbers = 0;
  for (const [phoneNumber, names] of namesByPhone) {
    if (names.size !== 1) { ambiguousNumbers += 1; continue; }
    candidates.push({ phoneNumber, displayName: [...names][0] });
  }
  return { candidates, ambiguousNumbers, skippedNumbers };
}

function safeEqual(left: string, right: string): boolean { const a = Buffer.from(left); const b = Buffer.from(right); return a.length === b.length && crypto.timingSafeEqual(a, b); }
async function safeJson(response: Response): Promise<Record<string, unknown>> { try { return await response.json() as Record<string, unknown>; } catch { return {}; } }
function providerError(message: string): PublicError { return new PublicError("GOOGLE_PROVIDER", message); }
