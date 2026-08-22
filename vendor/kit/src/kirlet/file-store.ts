// (o==================================================================o)
//   #region KIRLET FILE STORE (blobs under DATA_DIR/files)
// (o-----------------------------------------------------------\/-----o)

import { mkdir, writeFile, readFile, unlink, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";

export type StoredFileMeta = {
  id: string;
  name: string;
  type: string;
  size: number;
  /** Relative path under the store root (for persistence in domain rows). */
  relative_path: string;
};

export interface KirletFileStore {
  /** Persist bytes; returns metadata including relative_path. */
  save(
    data: Uint8Array,
    opts?: { name?: string; type?: string; id?: string },
  ): Promise<StoredFileMeta>;
  /** Read file by relative_path or id. */
  read(relative_path_or_id: string): Promise<Uint8Array | null>;
  /** Delete if present; returns true when removed. */
  remove(relative_path_or_id: string): Promise<boolean>;
  /** Absolute path for a relative path (fs store only; memory returns null). */
  absolute_path?(relative_path: string): string | null;
}

function safe_name(name: string): string {
  const base = name.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120);
  return base || "file";
}

/**
 * Filesystem-backed store under `root` (typically DATA_DIR/files).
 */
export class FsKirletFileStore implements KirletFileStore {
  constructor(private readonly root: string) {}

  absolute_path(relative_path: string): string {
    const clean = relative_path.replace(/^\/+/, "").replace(/\.\./g, "");
    return join(this.root, clean);
  }

  async save(
    data: Uint8Array,
    opts?: { name?: string; type?: string; id?: string },
  ): Promise<StoredFileMeta> {
    const id = opts?.id ?? randomUUID().replace(/-/g, "").slice(0, 16);
    const name = safe_name(opts?.name ?? "upload");
    const relative_path = `${id}_${name}`;
    const abs = this.absolute_path(relative_path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, data);
    return {
      id,
      name: opts?.name ?? name,
      type: opts?.type ?? "application/octet-stream",
      size: data.byteLength,
      relative_path,
    };
  }

  async read(relative_path_or_id: string): Promise<Uint8Array | null> {
    const abs = this.absolute_path(relative_path_or_id);
    try {
      await access(abs);
      const buf = await readFile(abs);
      return new Uint8Array(buf);
    } catch {
      // Try prefix match by id when only id is stored
      return null;
    }
  }

  async remove(relative_path_or_id: string): Promise<boolean> {
    const abs = this.absolute_path(relative_path_or_id);
    try {
      await unlink(abs);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * In-memory store for tests and KIRLET_AUTH=off standalone without DATA_DIR.
 */
export class MemoryKirletFileStore implements KirletFileStore {
  private readonly files = new Map<
    string,
    { data: Uint8Array; meta: StoredFileMeta }
  >();

  async save(
    data: Uint8Array,
    opts?: { name?: string; type?: string; id?: string },
  ): Promise<StoredFileMeta> {
    const id = opts?.id ?? randomUUID().replace(/-/g, "").slice(0, 16);
    const name = safe_name(opts?.name ?? "upload");
    const relative_path = `${id}_${name}`;
    const meta: StoredFileMeta = {
      id,
      name: opts?.name ?? name,
      type: opts?.type ?? "application/octet-stream",
      size: data.byteLength,
      relative_path,
    };
    this.files.set(relative_path, { data: new Uint8Array(data), meta });
    this.files.set(id, { data: new Uint8Array(data), meta });
    return meta;
  }

  async read(relative_path_or_id: string): Promise<Uint8Array | null> {
    const hit = this.files.get(relative_path_or_id);
    return hit ? new Uint8Array(hit.data) : null;
  }

  async remove(relative_path_or_id: string): Promise<boolean> {
    const hit = this.files.get(relative_path_or_id);
    if (!hit) return false;
    this.files.delete(relative_path_or_id);
    this.files.delete(hit.meta.id);
    this.files.delete(hit.meta.relative_path);
    return true;
  }

  absolute_path(): string | null {
    return null;
  }
}

// (o-----------------------------------------------------------/\-----o)
//   #endregion KIRLET FILE STORE
// (o==================================================================o)
