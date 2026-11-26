import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { interpolate_report_template } from "./reports-flow.ts";

// #273: las observaciones del pedido salen una vez, aparte; cada partida
// muestra solo la suya (sin heredar la del pedido) y va numerada desde 1.
const SEED = `${import.meta.dir}/../../../../backend/src/components/reports/pedido-report-templates.ts`;
const hay_seed = existsSync(SEED);
const { PEDIDO_REPORT_HTML = "", PEDIDO_SURTIDO_REPORT_HTML = "" } = hay_seed
  ? await import(SEED)
  : {};

const PEDIDO = {
  name: "PEDIDO-1",
  folio: "f-1",
  estado: "por_surtir",
  observaciones: "ENTREGAR ANTES DE LAS 10",
  contacto: { codigo: "C-1", name: "Cliente Uno" },
  articulos: [
    {
      cantidad: 2,
      product: { codigo: "P-1", name: "Uno" },
      observaciones: "sin cebolla",
    },
    { cantidad: 1, product: { codigo: "P-2", name: "Dos" } },
    {
      cantidad: 3,
      product: { codigo: "P-3", name: "Tres" },
      observaciones: "",
    },
  ],
};

/** Celdas `<td>` con la clase (el encabezado «No.» también la lleva desde #293). */
function celdas(html: string, clase: string): string[] {
  return [
    ...html.matchAll(
      new RegExp(
        `<td[^>]*\\sclass="(?:[^"]*\\s)?${clase}(?:\\s[^"]*)?"[^>]*>([^<]*)<`,
        "g",
      ),
    ),
  ].map((m) => m[1]!.trim());
}

const render = (plantilla: string, pedido: Record<string, unknown>) =>
  interpolate_report_template(plantilla, pedido, "Ana", new Date(2026, 10, 18));

describe("formatos de pedido: observaciones y número de partida (#273)", () => {
  for (const [nombre, plantilla] of [
    ["reports-pedido-tablero-0", PEDIDO_REPORT_HTML],
    ["reports-pedido-surtido-0", PEDIDO_SURTIDO_REPORT_HTML],
  ] as [string, string][]) {
    test.skipIf(!hay_seed)(
      `${nombre}: observaciones del pedido una vez, cada partida la suya`,
      async () => {
        const html = await render(plantilla, PEDIDO);
        expect(html.split("ENTREGAR ANTES DE LAS 10").length - 1).toBe(1);
        expect(html).toContain("Observaciones del pedido");
        expect(celdas(html, "report-partida-observaciones")).toEqual([
          "sin cebolla",
          "",
          "",
        ]);
      },
    );

    test.skipIf(!hay_seed)(
      `${nombre}: partidas numeradas desde 1`,
      async () => {
        const html = await render(plantilla, PEDIDO);
        expect(html).toMatch(/<th[^>]*>No\.<\/th>/);
        expect(celdas(html, "report-partida")).toEqual(["1", "2", "3"]);
      },
    );

    test.skipIf(!hay_seed)(
      `${nombre}: sin contacto dice «Sin cliente», no «[]»`,
      async () => {
        const html = await render(plantilla, { ...PEDIDO, contacto: null });
        expect(html).toContain("Sin cliente");
        expect(html).not.toContain("[]");
      },
    );
  }
});
