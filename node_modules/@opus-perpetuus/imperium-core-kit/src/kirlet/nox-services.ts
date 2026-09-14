// (o==================================================================o)
//   #region NOX SERVICES (capabilities plane for kirlets)
// (o-----------------------------------------------------------\/-----o)

export type HistoryAppendInput = {
  resource: string;
  action: string;
  entity_id?: string | null;
  actor_id?: string | null;
  actor_label?: string | null;
  payload?: Record<string, unknown> | null;
};

export type HistoryEntry = HistoryAppendInput & {
  id: string;
  created_at: string;
};

export type HistoryListQuery = {
  resource?: string;
  resource_prefix?: string;
  entity_id?: string;
  limit?: number;
  offset?: number;
};

export type CounterNextOptions = {
  prefix?: string;
  pad_length?: number;
};

export type NotifyInput = {
  title: string;
  body?: string;
  user_id?: string;
  email?: string;
  channel?: string;
  payload?: Record<string, unknown>;
};

export type LogRecord = {
  level?: string;
  message: string;
  path?: string;
  method?: string;
  status?: number;
  duration_ms?: number;
  meta?: Record<string, unknown>;
};

export type NoxFileSaveInput = {
  /**
   * Logical owner of the file. NOX forces the `kirlet.<slug>.` prefix, the same
   * way it does for history, so one kirlet cannot write into another's files.
   */
  resource: string;
  record_id: string;
  /** Raw bytes. Base64 on the wire; callers pass bytes. */
  data: Uint8Array;
  filename?: string;
  content_type?: string;
};

export type NoxFileRef = {
  id: string;
  resource: string;
  record_id: string;
  original_name: string;
  content_type: string;
  size_bytes: number;
  /**
   * Path to render the file at. Public when the manifest declares the resource
   * under `public.files`, otherwise the staff-only attachment route.
   */
  url: string;
  created_at: string;
};

/**
 * Platform capabilities NOX exposes to kirlets (history, counters, params, …).
 * Implementations: Memory (tests/dev) and HTTP (production service plane).
 */
export interface NoxServices {
  history: {
    append(entry: HistoryAppendInput): Promise<HistoryEntry>;
    list(query?: HistoryListQuery): Promise<HistoryEntry[]>;
  };
  counters: {
    next(name: string, opts?: CounterNextOptions): Promise<string>;
  };
  params: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
  };
  notify: {
    create(input: NotifyInput): Promise<{ id: string }>;
  };
  logs: {
    record(entry: LogRecord): void;
    flush(): Promise<void>;
  };
  /**
   * Platform attachments. Distinct from `ctx.files`, which is a volume local
   * to the container: these rows live in NOX's `attachments` table, survive a
   * redeploy, and can be served publicly when the manifest declares the
   * resource under `public.files`.
   */
  files: {
    save(input: NoxFileSaveInput): Promise<NoxFileRef>;
    list(query: { resource: string; record_id?: string }): Promise<NoxFileRef[]>;
    remove(id: string): Promise<boolean>;
  };
  /**
   * Kirtexto — NOX-owned HTML pipeline for untrusted rich text (supplier
   * product descriptions and the like). Centralised here so a kirlet needs no
   * DOM, no DOMPurify and no policy of its own: one call, always the same
   * profile, upgraded platform-side.
   */
  html: {
    /** Sanitize + normalize untrusted HTML. Returns "" for empty input. */
    sanitize(html: string | null | undefined): Promise<string>;
    /** Flatten HTML to plain text (search, excerpts, meta descriptions). */
    to_text(html: string | null | undefined, max_length?: number): Promise<string>;
  };
}

// (o-----------------------------------------------------------/\-----o)
//   #endregion NOX SERVICES
// (o==================================================================o)
