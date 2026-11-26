import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { interpolate_report_template } from './reports-flow.ts';

// Las plantillas viven en el seed del backend (override=true). El espejo
// imperium-core no trae backend/: ahí la prueba se omite.
const SEED = `${import.meta.dir}/../../../../backend/src/components/reports/pedido-report-templates.ts`;
const hay_seed = existsSync(SEED);
const { PEDIDO_REPORT_HTML = '', PEDIDO_SURTIDO_REPORT_HTML = '' } = hay_seed ? await import(SEED) : {};

// #263: el nombre del pedido (folio automático, «PEDIDO-<folio>») sale en la
// cabecera del formato de impresión y de la hoja de surtido.
const PEDIDO = {
	name: 'PEDIDO-admin-20261118-122825',
	folio: 'admin-20261118-122825',
	folio_interno: 41,
	estado: 'por_surtir',
	contacto: { name: 'QA-IA Cliente Crédito' },
	articulos: [],
};

describe('formatos de pedido: nombre del pedido (#263)', () => {
	for (const [nombre, plantilla] of [
		['reports-pedido-tablero-0', PEDIDO_REPORT_HTML],
		['reports-pedido-surtido-0', PEDIDO_SURTIDO_REPORT_HTML],
	] as [string, string][]) {
		test.skipIf(!hay_seed)(`${nombre} lleva el nombre y los folios del pedido`, async () => {
			const html = await interpolate_report_template(plantilla, PEDIDO, 'Ana', new Date(2026, 10, 18));
			expect(html).toMatch(/class="report-pedido-name"[^>]*>PEDIDO-admin-20261118-122825</);
			expect(html).toContain('Folio: admin-20261118-122825');
			expect(html).toContain('Folio interno: 41');
		});
	}
});
