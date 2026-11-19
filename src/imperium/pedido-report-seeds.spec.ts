import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { module_seed_records } from './module-data.ts';
import { interpolate_report_template } from './reports-flow.ts';
import seeds from './pedido-report-seeds.json';

describe('bundled canonical pedido reports', () => {
  test('install-data resolves both reports without backend sources', () => {
    const previous = process.env.IMPERIUM_BACKEND_SRC;
    process.env.IMPERIUM_BACKEND_SRC = mkdtempSync(join(tmpdir(), 'no-backend-'));
    try {
    const records = module_seed_records({ model_id: 'Reports', module_name: 'no-backend-module', module_location: 'missing' });
    expect(records.map((r) => r.doc._ref)).toEqual(seeds.map((r) => r.doc._ref));
    expect(records.every((r) => r.override)).toBe(true);
    expect(module_seed_records({ model_id: 'UnrelatedMissingModule', module_name: 'no-backend-module' })).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.IMPERIUM_BACKEND_SRC;
      else process.env.IMPERIUM_BACKEND_SRC = previous;
    }
  });

  test('bundled reports render line numbers and only their own notes', async () => {
    for (const seed of seeds) {
      const rendered = await interpolate_report_template(seed.doc.html_content, {
        observaciones: 'ORDER-NOTE', articulos: [
          { cantidad: 1, product: { name: 'A' }, observaciones: 'LINE-NOTE' },
          { cantidad: 2, product: { name: 'B' } },
        ],
      }, 'test');
      expect(rendered.match(/ORDER-NOTE/g)).toHaveLength(1);
      expect(rendered.match(/LINE-NOTE/g)).toHaveLength(1);
      expect([...rendered.matchAll(/class="text-center report-partida">(\d+)</g)].map((m) => m[1])).toEqual(['1', '2']);
    }
  });

  const source = `${import.meta.dir}/../../../../backend/src/components/reports/pedido-report-templates.ts`;
  test.skipIf(!existsSync(source))('bundle matches backend canonical HTML', async () => {
    const templates = await import(source);
    expect(seeds[0]!.doc.html_content).toBe(templates.PEDIDO_REPORT_HTML);
    expect(seeds[1]!.doc.html_content).toBe(templates.PEDIDO_SURTIDO_REPORT_HTML);
  });
});
