import { describe, expect, test } from "bun:test";
import { MemoryNoxServices } from "./memory-nox-services.js";

// (o==================================================================o)
//   #region NOX FILES (platform attachments)
// (o-----------------------------------------------------------\/-----o)

const bytes = (s: string) => new TextEncoder().encode(s);

describe("NoxServices.files", () => {
  test("save returns a ref with a servable url", async () => {
    const nox = new MemoryNoxServices();
    const ref = await nox.files.save({
      resource: "kirlet.tienda.product",
      record_id: "prod_1",
      data: bytes("jpeg-bytes"),
      filename: "router.jpg",
      content_type: "image/jpeg",
    });
    expect(ref.id).toBeTruthy();
    expect(ref.original_name).toBe("router.jpg");
    expect(ref.content_type).toBe("image/jpeg");
    expect(ref.size_bytes).toBe(10);
    expect(ref.url).toContain(ref.id);
  });

  test("list filters by resource and record", async () => {
    const nox = new MemoryNoxServices();
    await nox.files.save({
      resource: "kirlet.tienda.product",
      record_id: "prod_1",
      data: bytes("a"),
    });
    await nox.files.save({
      resource: "kirlet.tienda.product",
      record_id: "prod_2",
      data: bytes("b"),
    });
    await nox.files.save({
      resource: "kirlet.tienda.invoice",
      record_id: "prod_1",
      data: bytes("c"),
    });

    expect(
      (await nox.files.list({ resource: "kirlet.tienda.product" })).length,
    ).toBe(2);
    expect(
      (
        await nox.files.list({
          resource: "kirlet.tienda.product",
          record_id: "prod_1",
        })
      ).length,
    ).toBe(1);
    expect(
      (await nox.files.list({ resource: "kirlet.tienda.nothing" })).length,
    ).toBe(0);
  });

  test("remove drops the ref and reports whether anything went", async () => {
    const nox = new MemoryNoxServices();
    const ref = await nox.files.save({
      resource: "kirlet.tienda.product",
      record_id: "prod_1",
      data: bytes("a"),
    });
    expect(await nox.files.remove(ref.id)).toBe(true);
    expect(await nox.files.remove(ref.id)).toBe(false);
    expect(
      (await nox.files.list({ resource: "kirlet.tienda.product" })).length,
    ).toBe(0);
  });

  test("the same bytes can back several records (seeder reuse)", async () => {
    const nox = new MemoryNoxServices();
    const data = bytes("shared-image");
    const refs = await Promise.all(
      ["prod_1", "prod_2", "prod_3"].map((record_id) =>
        nox.files.save({ resource: "kirlet.tienda.product", record_id, data }),
      ),
    );
    expect(new Set(refs.map((r) => r.id)).size).toBe(3);
    expect(
      (await nox.files.list({ resource: "kirlet.tienda.product" })).length,
    ).toBe(3);
  });
});

// (o-----------------------------------------------------------/\-----o)
//   #endregion NOX FILES
// (o==================================================================o)
