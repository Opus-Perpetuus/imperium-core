import { describe, expect, test } from 'bun:test';
import { apply_cobranza_payment } from './cobranza-payment-flow.ts';
import { lookup_cobranza } from './cobranza-lookup-flow.ts';
import type { ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';

type Row = ImperiumDoc;

const CONTRATO_ID = '507f1f77bcf86cd799439011';
const METHOD_ID = '507f1f77bcf86cd799439012';
const NUMERO = '12345678';
const ADMIN: ImperiumDoc = {
	_id: '507f1f77bcf86cd799439013',
	_ref: 'user-menu-management-0',
};

function memory_store(seed: Record<string, Row[]>) {
	const data: Record<string, Row[]> = {};
	for (const [key, rows] of Object.entries(seed)) data[key] = rows.map((row) => ({ ...row }));
	let n = 0;
	const matches = (row: Row, where?: Record<string, unknown>) =>
		!where || Object.entries(where).every(([key, value]) => value === undefined || row[key] === value);
	const store = {
		data,
		has: (resource: string) => Object.hasOwn(data, resource),
		is_resource_installed: () => false,
		available_mongoose_models: () => [],
		is_model_installed: () => true,
		async find_id(resource: string, id: string) {
			return (data[resource] ?? []).find((row) => String(row._id) === String(id)) ?? null;
		},
		async find_where(resource: string, where: Record<string, unknown>) {
			return (data[resource] ?? []).find((row) => matches(row, where)) ?? null;
		},
		async find_many(
			resource: string,
			opts: {
				where?: Record<string, unknown>;
				ids?: string[];
				include_inactive?: boolean;
				sort?: string;
				take?: number;
			} = {},
		) {
			let rows = (data[resource] ?? []).filter((row) => matches(row, opts.where));
			if (!opts.include_inactive) rows = rows.filter((row) => row.is_active !== false);
			if (opts.ids?.length) {
				const wanted = new Set(opts.ids.map(String));
				rows = rows.filter((row) => wanted.has(String(row._id)));
			}
			if (opts.sort) {
				const [field, dir] = opts.sort.split(':');
				const sign = dir === 'desc' ? -1 : 1;
				rows = [...rows].sort(
					(a, b) => String(a[field] ?? '').localeCompare(String(b[field] ?? '')) * sign,
				);
			}
			if (opts.take != null) rows = rows.slice(0, opts.take);
			return { rows, total: rows.length };
		},
		async *scan(resource: string, opts: { where?: Record<string, unknown> } = {}) {
			yield (data[resource] ?? []).filter((row) => matches(row, opts.where));
		},
		async insert(resource: string, doc: Row) {
			n += 1;
			const row = {
				...doc,
				_id: doc._id ?? `507f1f77bcf86cd79943${String(n).padStart(4, '0')}`,
			};
			data[resource] = data[resource] ?? [];
			data[resource].push(row);
			return row;
		},
		async update(resource: string, id: string, patch: Row) {
			const rows = data[resource] ?? [];
			const index = rows.findIndex((row) => String(row._id) === String(id));
			if (index < 0) return null;
			rows[index] = { ...rows[index], ...patch, _id: id };
			return rows[index];
		},
		async next_auto_increment() {
			n += 1;
			return n;
		},
	};
	return store as unknown as ImperiumStore & { data: Record<string, Row[]> };
}

function agua_store(adeudo: number) {
	return memory_store({
		'module-management': [
			{ _id: 'mod-agua', module_name: 'agua', is_enable: true, is_active: true },
		],
		contrato: [
			{
				_id: CONTRATO_ID,
				contrato: NUMERO,
				contribuyente: 'Juan Perez',
				adeudo,
				is_active: true,
			},
		],
		lectura: [
			{
				_id: '507f1f77bcf86cd799439021',
				contrato: NUMERO,
				importe: 500,
				fecha_lectura: '2026-01-15',
				is_active: true,
			},
		],
		cobranza: [],
		'cobranza-payment': [],
	});
}

async function lookup(store: ImperiumStore) {
	const res = await lookup_cobranza(store, ADMIN, NUMERO);
	const row = res.data[0] as { charge: ImperiumDoc };
	return row.charge;
}

function pay(store: ImperiumStore, charge_id: unknown, amount: number) {
	return apply_cobranza_payment({
		store,
		actor: ADMIN,
		params: {},
		body: { charge_id, method_id: METHOD_ID, amount },
	});
}

describe('cobro de agua', () => {
	test('pagar, lectura nueva, consultar y volver a cobrar', async () => {
		const store = agua_store(500);
		const first = await lookup(store);
		expect(first).toMatchObject({ total_amount: 500, paid_amount: 0, balance: 500, status: 'PENDIENTE' });
		const paid = await pay(store, first._id, 500);
		expect(paid.charge).toMatchObject({ paid_amount: 500, balance: 0, status: 'PAGADO' });

		await store.update('contrato', CONTRATO_ID, { adeudo: 300 });
		store.data.lectura.push({
			_id: '507f1f77bcf86cd799439022',
			contrato: NUMERO,
			importe: 300,
			fecha_lectura: '2026-02-15',
			is_active: true,
		});

		const again = await lookup(store);
		expect(again).toMatchObject({
			total_amount: 800,
			paid_amount: 500,
			balance: 300,
			status: 'PARCIAL',
		});
		const second = await pay(store, again._id, 300);
		expect(second.message).toBe('Pago aplicado correctamente.');
		expect(second.charge).toMatchObject({
			total_amount: 800,
			paid_amount: 800,
			balance: 0,
			status: 'PAGADO',
		});
	});

	test('sin pagos, adeudo en cero toma el importe de la última lectura', async () => {
		const store = agua_store(0);
		const charge = await lookup(store);
		expect(charge).toMatchObject({
			total_amount: 500,
			paid_amount: 0,
			balance: 500,
			status: 'PENDIENTE',
		});
	});

	test('contrato pagado sin lectura nueva queda en saldo 0 con el total cobrado', async () => {
		const store = agua_store(500);
		const first = await lookup(store);
		await pay(store, first._id, 500);
		const again = await lookup(store);
		expect(again).toMatchObject({
			total_amount: 500,
			paid_amount: 500,
			balance: 0,
			status: 'PAGADO',
		});
		const err = await pay(store, again._id, 500).catch((error: Error) => error);
		expect(err).toBeInstanceOf(Error);
		expect((err as Error).message).toBe('El cargo ya está pagado.');
	});
});
