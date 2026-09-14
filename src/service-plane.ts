/**
 * Service plane del núcleo — mismos paths que Kirel NOX
 * (`/api/kirlets/svc/:tid/...`) para que HttpNoxServices del kit no cambie.
 * Las apps no abren Postgres: history/counters/params viven aquí.
 */
export function service_plane_match(path: string): {
  tid: string;
  rest: string;
} | null {
  const m = path.match(/^\/api\/(?:kirlets|subjects)\/svc\/([^/]+)(\/.*)?$/);
  if (!m) return null;
  return { tid: decodeURIComponent(m[1]!), rest: m[2] ?? "/" };
}

export async function ensure_svc_tables(sql: Bun.SQL): Promise<void> {
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS public.subject_history (
      id TEXT PRIMARY KEY,
      technical_id TEXT NOT NULL,
      resource TEXT,
      action TEXT,
      entity_id TEXT,
      record_id TEXT,
      actor_id TEXT,
      actor_label TEXT,
      payload JSONB,
      summary TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS public.subject_params (
      technical_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value JSONB,
      PRIMARY KEY (technical_id, key)
    );
    CREATE TABLE IF NOT EXISTS public.subject_counters (
      technical_id TEXT NOT NULL,
      name TEXT NOT NULL,
      n INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (technical_id, name)
    );
  `);
  await unwrap_double_encoded_jsonb(sql);
}

/** Columnas jsonb del plano de servicios que llegaron a guardarse envueltas. */
const DOUBLE_ENCODED_COLUMNS = [
  ["public.subject_params", "value"],
  ["public.subject_history", "payload"],
] as const;

/**
 * Desenvuelve las filas que quedaron doble-codificadas mientras esta capa
 * pasaba `JSON.stringify(...)` a un parámetro jsonb —Bun.SQL ya codifica—:
 * el valor acabó siendo un jsonb de tipo `string` cuyo texto interior es a su
 * vez JSON (`provider` guardado como `"provider"`, un payload como su propio
 * texto). Se repite por columna porque cada guardado apilaba una capa más.
 *
 * Solo se toca si el texto interior empieza por `"`, `{` o `[` y es JSON
 * válido: así un `"1500"` legítimo no se convierte en número y un string
 * cualquiera que no parsee no tumba el arranque. El precio es que un valor que
 * de verdad fuera el texto `"hola"` —con comillas— también se desenvuelve.
 *
 * Corre en cada arranque a propósito: durante un despliegue escalonado un
 * núcleo viejo todavía puede escribir en el formato anterior.
 */
async function unwrap_double_encoded_jsonb(sql: Bun.SQL): Promise<void> {
  for (const [table, column] of DOUBLE_ENCODED_COLUMNS) {
    for (;;) {
      const unwrapped = await sql.unsafe(
        `UPDATE ${table}
            SET ${column} = (${column} #>> '{}')::jsonb
          WHERE jsonb_typeof(${column}) = 'string'
            AND left(ltrim(${column} #>> '{}'), 1) IN ('"', '{', '[')
            AND (${column} #>> '{}') IS JSON
          RETURNING 1`,
      );
      if (unwrapped.length === 0) break;
    }
  }
}

function nid(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function strip_tags(html: string, max?: number): string {
  const t = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return max && t.length > max ? t.slice(0, max) : t;
}

export type ServicePlaneDeps = {
  /** Sanitizador real del núcleo (Kirtexto). Sin él, se limpia a texto plano. */
  sanitize_html?: (html: string) => string;
  /** Envía el aviso por correo. Ausente ⇒ la app recibe `delivered: false`. */
  send_email?: (input: {
    to: string;
    title: string;
    body?: string;
  }) => Promise<void>;
};

export async function handle_service_plane(
  sql: Bun.SQL,
  secret: string,
  req: Request,
  tid: string,
  rest: string,
  url: URL,
  deps: ServicePlaneDeps = {},
): Promise<Response> {
  const got =
    req.headers.get("x-core-subject-gateway-secret") ??
    req.headers.get("x-nox-kirlet-gateway-secret") ??
    "";
  if (got !== secret) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  await ensure_svc_tables(sql);
  const path = rest.split("?")[0] ?? "/";
  const method = req.method;
  let body: Record<string, unknown> = {};
  if (method !== "GET" && method !== "HEAD" && method !== "DELETE") {
    try {
      body = ((await req.json()) as Record<string, unknown>) ?? {};
    } catch {
      body = {};
    }
  }

  if (path === "/history" && method === "POST") {
    const id = nid("hist");
    await sql.unsafe(
      `INSERT INTO public.subject_history
        (id, technical_id, resource, action, entity_id, record_id, actor_id, actor_label, payload, summary)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)`,
      [
        id,
        tid,
        body.resource ?? null,
        body.action ?? "update",
        body.entity_id ?? body.record_id ?? null,
        body.record_id ?? body.entity_id ?? null,
        body.actor_id ?? null,
        body.actor_label ?? null,
        // Bun.SQL ya codifica en JSON los parámetros de columnas jsonb: pasar
        // `JSON.stringify(...)` guardaba el texto JSON COMO string jsonb
        // (`jsonb_typeof` = string, no object) y cada relectura devolvía texto
        // en vez del objeto.
        body.payload ?? body,
        body.summary ?? null,
      ],
    );
    return Response.json({ data: { id } });
  }
  if (path === "/history" && method === "GET") {
    const resource = url.searchParams.get("resource");
    const entity_id =
      url.searchParams.get("entity_id") ?? url.searchParams.get("record_id");
    const limit = Number(url.searchParams.get("limit") ?? 50);
    const params: unknown[] = [tid];
    let w = "technical_id = $1";
    if (resource) {
      params.push(resource);
      w += ` AND resource = $${params.length}`;
    }
    if (entity_id) {
      params.push(entity_id);
      w += ` AND (entity_id = $${params.length} OR record_id = $${params.length})`;
    }
    const rows = await sql.unsafe(
      `SELECT * FROM public.subject_history WHERE ${w} ORDER BY created_at DESC LIMIT ${Number.isFinite(limit) ? limit : 50}`,
      params,
    );
    return Response.json({ data: rows });
  }

  const next = path.match(/^\/counters\/([^/]+)\/next$/);
  if (next && method === "POST") {
    const name = decodeURIComponent(next[1]!);
    const rows = await sql.unsafe(
      `INSERT INTO public.subject_counters (technical_id, name, n)
       VALUES ($1,$2,1)
       ON CONFLICT (technical_id, name) DO UPDATE SET n = public.subject_counters.n + 1
       RETURNING n`,
      [tid, name],
    );
    const n = Number(rows[0]?.n ?? 1);
    const pad = Number(body.pad_length ?? 0);
    const prefix = String(body.prefix ?? "");
    const token = pad > 0 ? String(n).padStart(pad, "0") : String(n);
    return Response.json({ data: `${prefix}${token}` });
  }

  const param = path.match(/^\/params\/([^/]+)$/);
  if (param && method === "GET") {
    const key = decodeURIComponent(param[1]!);
    const rows = await sql.unsafe(
      `SELECT value FROM public.subject_params WHERE technical_id = $1 AND key = $2`,
      [tid, key],
    );
    return Response.json({ data: rows[0]?.value ?? null });
  }
  if (param && method === "PUT") {
    const key = decodeURIComponent(param[1]!);
    await sql.unsafe(
      `INSERT INTO public.subject_params (technical_id, key, value)
       VALUES ($1,$2,$3::jsonb)
       ON CONFLICT (technical_id, key) DO UPDATE SET value = EXCLUDED.value`,
      // Mismo motivo que en `/history`: Bun.SQL codifica el jsonb. Con el
      // `JSON.stringify` extra, guardar `provider` dejaba `"provider"`, y el
      // siguiente guardado `"\"provider\""` — una capa de comillas por vuelta.
      [tid, key, body.value ?? null],
    );
    return Response.json({ data: { ok: true } });
  }

  if (path === "/notify" && method === "POST") {
    const id = nid("ntf");
    const to = String(body.email ?? "").trim();
    const title = String(body.title ?? "").trim();
    // Un aviso que no se puede entregar no tumba la operación que lo disparó:
    // un pedido se paga aunque el SMTP esté caído. La app ve `delivered` y
    // decide si reintenta.
    if (!deps.send_email || !to || !title) {
      return Response.json({ data: { id, delivered: false } });
    }
    try {
      await deps.send_email({ to, title, body: String(body.body ?? "") });
      return Response.json({ data: { id, delivered: true } });
    } catch (err) {
      return Response.json({
        data: { id, delivered: false, error: String(err) },
      });
    }
  }
  if (path === "/logs" && method === "POST") {
    const n = Array.isArray(body.entries) ? body.entries.length : 0;
    return Response.json({ data: { ingested: n } });
  }
  if (path === "/html/sanitize" && method === "POST") {
    // El contrato del kit dice que Kirtexto limpia HTML ajeno (descripciones de
    // mayoristas). Devolverlo tal cual convertía la promesa en un pasamanos:
    // la app lo pinta con innerHTML.
    const raw = String(body.html ?? "");
    const html = deps.sanitize_html
      ? deps.sanitize_html(raw)
      : strip_tags(raw);
    return Response.json({ data: { html } });
  }
  if (path === "/html/to-text" && method === "POST") {
    return Response.json({
      data: { text: strip_tags(String(body.html ?? ""), Number(body.max_length) || undefined) },
    });
  }
  if (path === "/files" && method === "POST") {
    return Response.json({
      data: {
        id: nid("file"),
        resource: body.resource ?? "",
        record_id: body.record_id ?? "",
        filename: body.filename ?? "file",
      },
    });
  }
  if (path === "/files" && method === "GET") {
    return Response.json({ data: [] });
  }
  const del = path.match(/^\/files\/([^/]+)$/);
  if (del && method === "DELETE") {
    return Response.json({ data: { removed: true } });
  }

  return Response.json({ error: `svc not found ${method} ${path}` }, { status: 404 });
}
