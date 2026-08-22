import { describe, expect, test } from "bun:test";
import { KirletRepository } from "./data-client.js";
import { MemoryKirletDataClient } from "./memory-data-client.js";
import type { KirletSchemaBundle } from "./schema.js";

const schema: KirletSchemaBundle = {
  technicalId: "kirlet-test",
  version: 1,
  tables: [
    {
      name: "items",
      columns: [
        { name: "id", type: "text", primaryKey: true },
        { name: "name", type: "text", notNull: true },
        { name: "is_active", type: "integer", default: 1 },
      ],
    },
  ],
};

describe("MemoryKirletDataClient + KirletRepository", () => {
  test("CRUD and filters without any SQL", async () => {
    const client = new MemoryKirletDataClient(schema);
    const repo = new KirletRepository(client, "items");

    await repo.insert({ id: "1", name: "Alpha", is_active: 1 });
    await repo.insert({ id: "2", name: "Beta", is_active: 0 });
    await repo.insert({ id: "3", name: "Alpine", is_active: 1 });

    const active = await repo.findMany({ where: { is_active: 1 } });
    expect(active).toHaveLength(2);

    const search = await repo.findMany({
      search: { fields: ["name"], q: "alp" },
    });
    expect(search.map((r) => r.id).sort()).toEqual(["1", "3"]);

    await repo.updateById("1", { name: "Alpha2" });
    const one = await repo.findById("1");
    expect(one?.name).toBe("Alpha2");

    expect(await repo.count({ is_active: 1 })).toBe(2);
    await repo.deleteById("2");
    expect(await repo.count()).toBe(2);
  });

  test("transaction rolls back on error", async () => {
    const client = new MemoryKirletDataClient(schema);
    await client.insert("items", { id: "x", name: "keep" });
    try {
      await client.transaction(async (tx) => {
        await tx.insert("items", { id: "y", name: "tmp" });
        throw new Error("boom");
      });
    } catch {
      /* expected */
    }
    expect(await client.count("items")).toBe(1);
    expect(await client.findOne("items", { id: "y" })).toBeNull();
    const keep = await client.findOne("items", { id: "x" });
    expect(keep?.name).toBe("keep");
  });
});
