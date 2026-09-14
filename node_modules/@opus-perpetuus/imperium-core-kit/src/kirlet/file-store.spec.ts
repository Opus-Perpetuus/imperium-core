import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsKirletFileStore, MemoryKirletFileStore } from "./file-store.js";

describe("MemoryKirletFileStore", () => {
  test("save/read/remove", async () => {
    const store = new MemoryKirletFileStore();
    const meta = await store.save(new Uint8Array([1, 2, 3]), {
      name: "a.txt",
      type: "text/plain",
    });
    expect(meta.size).toBe(3);
    const data = await store.read(meta.relative_path);
    expect(data).toEqual(new Uint8Array([1, 2, 3]));
    expect(await store.read(meta.id)).toEqual(new Uint8Array([1, 2, 3]));
    expect(await store.remove(meta.relative_path)).toBe(true);
    expect(await store.read(meta.relative_path)).toBeNull();
  });
});

describe("FsKirletFileStore", () => {
  test("roundtrip under temp dir", async () => {
    const root = await mkdtemp(join(tmpdir(), "kirlet-fs-"));
    try {
      const store = new FsKirletFileStore(root);
      const meta = await store.save(new TextEncoder().encode("hi"), {
        name: "doc.pdf",
        type: "application/pdf",
      });
      const data = await store.read(meta.relative_path);
      expect(new TextDecoder().decode(data!)).toBe("hi");
      expect(store.absolute_path(meta.relative_path)).toContain(root);
      expect(await store.remove(meta.relative_path)).toBe(true);
      expect(await store.read(meta.relative_path)).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
