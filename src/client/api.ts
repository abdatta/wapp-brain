import type { ChatListItem, ChatListOptions, ImportRequest, ImportTotals, MessageListItem, MessageListOrder, StatusSummary } from "../shared/types";

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options?.headers ?? {})
    }
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error ?? "Local request failed.");
  }
  return payload as T;
}

export function getStatus(): Promise<StatusSummary> {
  return request<StatusSummary>("/api/status");
}

export function initDatabase(): Promise<{ ok: boolean; status: StatusSummary }> {
  return request<{ ok: boolean; status: StatusSummary }>("/api/init-db", { method: "POST", body: "{}" });
}

export function runImport(requestBody: ImportRequest): Promise<{ ok: boolean; totals: ImportTotals }> {
  return request<{ ok: boolean; totals: ImportTotals }>("/api/import", {
    method: "POST",
    body: JSON.stringify(requestBody)
  });
}

export function cleanupTempFiles(): Promise<{ ok: boolean; summary: { removedFiles: number; removedDirectories: number } }> {
  return request<{ ok: boolean; summary: { removedFiles: number; removedDirectories: number } }>("/api/cleanup", {
    method: "POST",
    body: "{}"
  });
}

export function listChats(params: Partial<ChatListOptions>): Promise<ChatListItem[]> {
  const query = new URLSearchParams();
  if (params.search) query.set("search", params.search);
  if (params.type) query.set("type", params.type);
  if (params.includeEventOnly) query.set("includeEventOnly", "true");
  query.set("limit", String(params.limit ?? 60));
  query.set("offset", String(params.offset ?? 0));
  return request<ChatListItem[]>(`/api/chats?${query}`);
}

export function listMessages(
  chatId: number,
  params: { limit?: number; offset?: number; sender?: string; query?: string; order?: MessageListOrder }
): Promise<MessageListItem[]> {
  const query = new URLSearchParams();
  query.set("limit", String(params.limit ?? 150));
  query.set("offset", String(params.offset ?? 0));
  if (params.sender) query.set("sender", params.sender);
  if (params.query) query.set("query", params.query);
  if (params.order) query.set("order", params.order);
  return request<MessageListItem[]>(`/api/chats/${chatId}/messages?${query}`);
}
