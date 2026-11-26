/**
 * #292: la hoja impresa del pedido sacaba «Ruta:» en blanco. La ruta no se
 * guarda en el pedido (sale de delivery-route.contacts, #275); el reporte leía
 * el pedido crudo. Ahora iter_report_record_pages la agrega como el detalle.
 */
import { describe, expect, test } from 'bun:test';
import type { ImperiumDoc } from './envelope.ts';
import seeds from './pedido-report-seeds.json';
import { interpolate_report_template, iter_report_record_pages } from './reports-flow.ts';
import type { ImperiumStore } from './store.ts';

const CLIENTE = 'c0ffee000000000000000001';
const pedidos: ImperiumDoc[] = [
	{ _id: 'p1', name: 'CESAR GUERRERO-20261118-205347', folio_interno: '33331', contacto: { _id: CLIENTE, name: 'FAUSTO GONZALEZ MARIA CECILIA' }, articulos: [] },
	{ _id: 'p2', name: 'SIN RUTA-1', contacto: 'c0ffee00000000000000ffff', articulos: [] },
];

function fake_store(): ImperiumStore {
	return {
		has: () => true,
		is_resource_installed: () => true,
		async find_id(_resource: string, id: string) {
			return pedidos.find((p) => p._id === id) ?? null;
		},
		async populate_docs(_resource: string, rows: ImperiumDoc[]) {
			return rows;
		},
		async find_many(resource: string) {
			if (resource !== 'delivery-route') throw new Error(`consulta inesperada a ${resource}`);
			return {
				rows: [
					{ _id: 'r2', name: 'SANTA MARTHA', contacts: [CLIENTE] },
					{ _id: 'r1', name: 'CENTRO', contacts: JSON.stringify([CLIENTE]) },
				],
				total: 2,
			};
		},
	} as unknown as ImperiumStore;
}

async function records(resource: string, body: Record<string, unknown>) {
	const out: ImperiumDoc[] = [];
	for await (const page of iter_report_record_pages(fake_store(), resource, body)) out.push(...page);
	return out;
}

describe('hoja impresa del pedido: Ruta (#292)', () => {
	test('cada pedido trae la ruta de su cliente; sin ruta queda vacía', async () => {
		const out = await records('pedidos', { record_ids: ['p1', 'p2'] });
		expect(out.map((r) => r.ruta)).toEqual(['CENTRO, SANTA MARTHA', '']);
	});

	test('también al imprimir desde Por surtir (pedidos-surtir)', async () => {
		expect((await records('pedidos-surtir', { record_id: 'p1' }))[0]?.ruta).toBe('CENTRO, SANTA MARTHA');
	});

	test('el formato Pedido y la Hoja de surtido la imprimen', async () => {
		const [record] = await records('pedidos', { record_id: 'p1' });
		for (const seed of seeds) {
			const html = await interpolate_report_template(seed.doc.html_content, record!, 'test');
			expect(html).toMatch(/Ruta:<\/span>\s*CENTRO, SANTA MARTHA/);
		}
	});

	test('otros recursos no se tocan', async () => {
		const out = await records('products', { record_id: 'p1' });
		expect(out[0]?.ruta).toBeUndefined();
	});
});
