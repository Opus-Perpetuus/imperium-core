import { describe, expect, test } from 'bun:test';
import extra_routes from './extra-routes.json';
import schema_enum from './schema-enum.json';
import { pos_ticket_by_folio } from './pos-reprint.ts';
import type { ImperiumStore } from './store.ts';

const store = {
	async *scan(_r: string, o: { where?: Record<string, unknown> } = {}) {
		const rows = [
			{ _id: 't1', ticket_sequence: 'CAJA-1-7', items: '[{"item_name":"Codo","quantity":2}]' },
			{ _id: 't2', ticket_sequence: 'CAJA-1-8', items: [{ item_name: 'Tubo', quantity: 1 }] },
		];
		yield rows.filter((r) => !o.where || r.ticket_sequence === o.where.ticket_sequence);
	},
} as unknown as ImperiumStore;

describe('reimpresión POS por folio', () => {
	test('encuentra el ticket por folio y entrega sus artículos como lista', async () => {
		expect((await pos_ticket_by_folio(store, ' CAJA-1-7 ')).items).toEqual([{ item_name: 'Codo', quantity: 2 }]);
		expect((await pos_ticket_by_folio(store, 'CAJA-1-8'))._id).toBe('t2');
		await expect(pos_ticket_by_folio(store, 'X')).rejects.toThrow(/No se encontró/);
		await expect(pos_ticket_by_folio(store, '')).rejects.toThrow(/folio/);
	});

	test('ruta declarada y plantilla de remisión aceptada', () => {
		const routes = (extra_routes as { resource: string; method: string; path: string; action: string }[]).map(
			(r) => `${r.resource} ${r.method} ${r.path}:${r.action}`,
		);
		expect(routes).toContain('pos-tickets get /por-folio:read_ticket_by_folio');
		const keys = (schema_enum as { enum: Record<string, Record<string, { values?: string[] }>> }).enum['epson-ticket-template']?.template_key?.values ?? [];
		expect(keys).toContain('POS_REMISION');
		expect(keys).toContain('POS_SALE');
	});
});

describe('menú de reportes comerciales', () => {
	test('el subject POS declara la entrada a /reportes-comerciales', async () => {
		const catalog = (await import('../../catalog.json')).default as {
			subjects: { slug: string; menus?: { menu_ref: string; path: string }[] }[];
		};
		const pos = catalog.subjects.find((s) => s.slug === 'pos');
		expect(pos?.menus?.find((m) => m.menu_ref === 'pos-commercial-reports-menu-0')?.path).toBe('/reportes-comerciales');
	});
});
