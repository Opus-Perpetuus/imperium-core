// (o==================================================================o)
//   #region KIRLET HTTP HELPERS
// (o-----------------------------------------------------------\/-----o)

/** JSON response with application/json charset. */
export function json_response(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** Error envelope: `{ error, message, ...extra }`. */
export function error_response(
  code: string,
  message: string,
  status = 400,
  extra?: Record<string, unknown>,
): Response {
  return json_response({ error: code, message, ...extra }, status);
}

export function not_found_response(path?: string): Response {
  return json_response({ error: "not_found", path }, 404);
}

export function method_not_allowed_response(allowed: string[]): Response {
  return new Response(
    JSON.stringify({ error: "method_not_allowed", allowed }),
    {
      status: 405,
      headers: {
        "content-type": "application/json; charset=utf-8",
        allow: allowed.join(", "),
      },
    },
  );
}

export type MultipartFile = {
  field: string;
  name: string;
  type: string;
  size: number;
  data: Uint8Array;
};

export type MultipartResult = {
  fields: Record<string, string>;
  files: MultipartFile[];
};

/**
 * Parse multipart/form-data via Request.formData().
 * Works under Bun and undici; no Bun-specific types in the public surface.
 */
export async function read_multipart(req: Request): Promise<MultipartResult> {
  const form = await req.formData();
  const fields: Record<string, string> = {};
  const files: MultipartFile[] = [];

  for (const [key, value] of form.entries()) {
    if (typeof value === "string") {
      fields[key] = value;
      continue;
    }
    const blob = value as Blob & { name?: string };
    const buf = new Uint8Array(await blob.arrayBuffer());
    files.push({
      field: key,
      name: (typeof blob.name === "string" && blob.name) || "upload",
      type: blob.type || "application/octet-stream",
      size: buf.byteLength,
      data: buf,
    });
  }

  return { fields, files };
}

export function new_id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

export function now_iso(): string {
  return new Date().toISOString();
}

export function today_iso(): string {
  return new Date().toISOString().slice(0, 10);
}

// (o-----------------------------------------------------------/\-----o)
//   #endregion KIRLET HTTP HELPERS
// (o==================================================================o)
