// (o==================================================================o)
//   #region MEMORY NOX SERVICES
// (o-----------------------------------------------------------\/-----o)

import { new_id, now_iso } from "./http.js";
import type {
  CounterNextOptions,
  HistoryAppendInput,
  HistoryEntry,
  HistoryListQuery,
  LogRecord,
  NoxFileRef,
  NoxServices,
  NotifyInput,
} from "./nox-services.js";
import {
  html_to_text,
  sanitize_nox_html,
  type NoxHtmlPurifier,
} from "../html/sanitize-html.js";

export type MemoryNoxServicesOptions = {
  /**
   * DOMPurify-compatible sanitizer for `html.*`. The kit ships no DOM, so
   * without one the fallback strips markup to plain text — safe, but not what
   * production does. Tests that assert on rendered HTML should inject
   * `isomorphic-dompurify` here.
   */
  html_purifier?: NoxHtmlPurifier;
};

/** Last-resort projection when no purifier is wired: text only, never markup. */
function strip_to_text(input: string | null | undefined): string {
  if (!input) return "";
  return String(input)
    .replace(/<\s*(script|style)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * In-process NoxServices for tests and KIRLET_AUTH=off standalone.
 */
export class MemoryNoxServices implements NoxServices {
  readonly history_entries: HistoryEntry[] = [];
  private readonly counter_values = new Map<string, number>();
  readonly params_map = new Map<string, unknown>();
  readonly notifications: Array<NotifyInput & { id: string }> = [];
  readonly log_buffer: LogRecord[] = [];
  readonly file_refs: NoxFileRef[] = [];
  readonly file_bytes = new Map<string, Uint8Array>();
  private readonly html_purifier: NoxHtmlPurifier | null;

  constructor(opts?: MemoryNoxServicesOptions) {
    this.html_purifier = opts?.html_purifier ?? null;
  }

  readonly history: NoxServices["history"] = {
    append: async (entry: HistoryAppendInput): Promise<HistoryEntry> => {
      const row: HistoryEntry = {
        ...entry,
        id: new_id("hist"),
        created_at: now_iso(),
      };
      this.history_entries.unshift(row);
      return row;
    },
    list: async (query?: HistoryListQuery): Promise<HistoryEntry[]> => {
      let rows = this.history_entries.slice();
      if (query?.resource) {
        rows = rows.filter((r) => r.resource === query.resource);
      }
      if (query?.resource_prefix) {
        const p = query.resource_prefix;
        rows = rows.filter((r) => r.resource.startsWith(p));
      }
      if (query?.entity_id) {
        rows = rows.filter((r) => r.entity_id === query.entity_id);
      }
      const offset = query?.offset ?? 0;
      const limit = query?.limit ?? 100;
      return rows.slice(offset, offset + limit);
    },
  };

  readonly counters: NoxServices["counters"] = {
    next: async (name: string, opts?: CounterNextOptions): Promise<string> => {
      const n = (this.counter_values.get(name) ?? 0) + 1;
      this.counter_values.set(name, n);
      const pad = opts?.pad_length ?? 0;
      const body = pad > 0 ? String(n).padStart(pad, "0") : String(n);
      return `${opts?.prefix ?? ""}${body}`;
    },
  };

  readonly params: NoxServices["params"] = {
    get: async (key: string): Promise<unknown> => {
      return this.params_map.has(key) ? this.params_map.get(key) : null;
    },
    set: async (key: string, value: unknown): Promise<void> => {
      this.params_map.set(key, value);
    },
  };

  readonly notify: NoxServices["notify"] = {
    create: async (input: NotifyInput): Promise<{ id: string }> => {
      const id = new_id("ntf");
      this.notifications.push({ ...input, id });
      return { id };
    },
  };

  readonly logs: NoxServices["logs"] = {
    record: (entry: LogRecord): void => {
      this.log_buffer.push(entry);
    },
    flush: async (): Promise<void> => {
      /* no-op in memory */
    },
  };

  readonly files: NoxServices["files"] = {
    save: async (input): Promise<NoxFileRef> => {
      const id = new_id("att").replace(/^att_/, "");
      const ref: NoxFileRef = {
        id,
        resource: input.resource,
        record_id: input.record_id,
        original_name: input.filename ?? "file",
        content_type: input.content_type ?? "application/octet-stream",
        size_bytes: input.data.byteLength,
        url: `/api/p/files/${id}`,
        created_at: now_iso(),
      };
      this.file_bytes.set(id, input.data);
      this.file_refs.push(ref);
      return ref;
    },
    list: async (query): Promise<NoxFileRef[]> =>
      this.file_refs.filter(
        (f) =>
          f.resource === query.resource &&
          (!query.record_id || f.record_id === query.record_id),
      ),
    remove: async (id: string): Promise<boolean> => {
      const i = this.file_refs.findIndex((f) => f.id === id);
      if (i < 0) return false;
      this.file_refs.splice(i, 1);
      this.file_bytes.delete(id);
      return true;
    },
  };

  readonly html: NoxServices["html"] = {
    sanitize: async (html: string | null | undefined): Promise<string> => {
      if (!this.html_purifier) return strip_to_text(html);
      return sanitize_nox_html(html, this.html_purifier);
    },
    to_text: async (
      html: string | null | undefined,
      max_length?: number,
    ): Promise<string> => {
      if (!this.html_purifier) {
        const text = strip_to_text(html);
        if (!max_length || text.length <= max_length) return text;
        return `${text.slice(0, max_length).replace(/\s+\S*$/, "")}…`;
      }
      return html_to_text(html, this.html_purifier, max_length);
    },
  };
}

// (o-----------------------------------------------------------/\-----o)
//   #endregion MEMORY NOX SERVICES
// (o==================================================================o)
