import type { WaContactRow } from "../../shared/types";

export type WaContactsStatusFilter = "all" | "resolved" | "unresolved";

export interface WaContactsFilterOptions {
  query?: string;
  status?: WaContactsStatusFilter;
}

export function filterWaContacts(contacts: WaContactRow[], options: WaContactsFilterOptions = {}): WaContactRow[] {
  const status = options.status ?? "all";
  const query = options.query?.trim().toLowerCase() ?? "";
  return contacts.filter((contact) => {
    if (status === "resolved" && !contact.resolved) return false;
    if (status === "unresolved" && contact.resolved) return false;
    if (!query) return true;
    return (
      contact.jid.toLowerCase().includes(query) ||
      Boolean(contact.number?.toLowerCase().includes(query)) ||
      Boolean(contact.displayName?.toLowerCase().includes(query)) ||
      Boolean(contact.lid?.toLowerCase().includes(query))
    );
  });
}

export interface WaContactsPage {
  rows: WaContactRow[];
  page: number;
  pageCount: number;
  total: number;
  pageSize: number;
}

export function paginateWaContacts(contacts: WaContactRow[], page: number, pageSize: number): WaContactsPage {
  const total = contacts.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const clampedPage = Math.min(Math.max(1, page), pageCount);
  const start = (clampedPage - 1) * pageSize;
  return {
    rows: contacts.slice(start, start + pageSize),
    page: clampedPage,
    pageCount,
    total,
    pageSize
  };
}
