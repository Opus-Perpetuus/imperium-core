import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { format_report, parse_args } from '../../scripts/contar-recepciones-349.ts';
import { count_double_counted_receptions, order_drift } from './purchase-order-reception-drift.ts';
import type { ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';

const P1 = 'aaaaaaaaaaaaaaaaaaaaaaa1';
const P2 = 'aaaaaaaaaaaaaaaaaaaaaaa2';

function po(id: string, estado: string, articulos: Array<[string, number, number]>): ImperiumDoc {
	return {
		_id: id,
		name: `OC ${id}`,
		estado,
		articulos: articulos.map(([producto, cantidad, cantidad_recibida]) => ({
			producto,
			producto_nombre: producto === P1 ? 'Cemento' : 'Varilla',
			cantidad,
			cantidad_recibida,
		})),
	};
}

function reception(
	id: string,
	po_id: string,
	estado: string,
	articulos: Array<[string, number, number]>,
	extra: ImperiumDoc = {},
): ImperiumDoc {
	return {
		_id: id,
		estado,
		purchase_order: po_id,
		orden_compra: po_id,
		articulos: articulos.map(([producto, cantidad_esperada, cantidad_recibida]) => ({
			producto,
			cantidad_esperada,
			cantidad_recibida,
		})),
		...extra,
	};
}

/** Un store que solo deja leer: cualquier otro método truena. */
function read_only_store(receptions: ImperiumDoc[], orders: ImperiumDoc[]) {
	const calls: string[] = [];
	const impl = {
		async *scan(resource: string, opts: { where?: { estado?: { in?: string[] } } }) {
			calls.push(`scan:${resource}`);
			const states = opts.where?.estado?.in ?? [];
			yield receptions.filter((r) => states.includes(String(r.estado)));
		},
		async find_id(resource: string, id: string) {
			calls.push(`find_id:${resource}`);
			return orders.find((o) => o._id === id) ?? null;
		},
	};
	const store = new Proxy(impl, {
		get(target, prop) {
			if (prop in target) return target[prop as keyof typeof target];
			return () => {
				throw new Error(`el conteo no debe llamar store.${String(prop)}`);
			};
		},
	}) as unknown as ImperiumStore;
	return { store, calls };
}

describe('order_drift (conteo #349)', () => {
	test('orden confirmada con su recepción aún pendiente: todo lo pendiente cuenta de más', () => {
		const drift = order_drift(po('o1', 'confirmada', [[P1, 10, 10]]), [
			reception('r1', 'o1', 'pendiente', [[P1, 10, 0]]),
		]);
		expect(drift?.excedente).toBe(10);
		expect(drift?.recepciones).toEqual(['r1']);
		expect(drift?.lineas).toEqual([
			{ producto: P1, producto_nombre: 'Cemento', pendiente_orden: 0, pendiente_recepciones: 10, excedente: 10 },
		]);
	});

	test('orden parcialmente recibida por fuera de la recepción: solo cuenta lo ya recibido', () => {
		const drift = order_drift(po('o1', 'parcialmente_recibida', [[P1, 10, 4], [P2, 5, 0]]), [
			reception('r1', 'o1', 'parcial', [[P1, 10, 0], [P2, 5, 0]]),
		]);
		expect(drift?.excedente).toBe(4);
		expect(drift?.lineas.map((l) => l.producto)).toEqual([P1]);
	});

	test('una recepción alineada con la orden no cuenta', () => {
		expect(
			order_drift(po('o1', 'parcialmente_recibida', [[P1, 10, 4]]), [
				reception('r1', 'o1', 'parcial', [[P1, 10, 4]]),
			]),
		).toBeNull();
		expect(
			order_drift(po('o1', 'aprobada', [[P1, 10, 4]]), [reception('r1', 'o1', 'pendiente', [[P1, 6, 0]])]),
		).toBeNull();
	});

	test('recepciones cerradas o inactivas no cuentan', () => {
		const order = po('o1', 'confirmada', [[P1, 10, 10]]);
		expect(order_drift(order, [reception('r1', 'o1', 'recibida', [[P1, 10, 0]])])).toBeNull();
		expect(order_drift(order, [reception('r1', 'o1', 'pendiente', [[P1, 10, 0]], { is_active: false })])).toBeNull();
	});
});

describe('count_double_counted_receptions', () => {
	test('cuenta órdenes y recepciones afectadas usando solo lecturas', async () => {
		const { store, calls } = read_only_store(
			[
				reception('r1', 'o1', 'pendiente', [[P1, 10, 0]]),
				reception('r2', 'o2', 'parcial', [[P1, 8, 2]]),
				reception('r3', 'o3', 'pendiente', [[P2, 3, 0]]),
				reception('r4', 'o4', 'recibida', [[P1, 10, 0]]),
				reception('r5', 'borrada', 'pendiente', [[P1, 1, 0]]),
			],
			[
				po('o1', 'confirmada', [[P1, 10, 10]]),
				po('o2', 'parcialmente_recibida', [[P1, 8, 2]]),
				po('o3', 'confirmada', [[P2, 3, 3]]),
				po('o4', 'confirmada', [[P1, 10, 10]]),
			],
		);
		const report = await count_double_counted_receptions(store);
		expect(report.recepciones_abiertas).toBe(4);
		expect(report.ordenes_revisadas).toBe(4);
		expect(report.ordenes_afectadas).toBe(2);
		expect(report.recepciones_afectadas).toBe(2);
		expect(report.excedente_total).toBe(13);
		expect(report.afectadas.map((o) => o.orden_id)).toEqual(['o1', 'o3']);
		expect(report.recepciones_sin_orden).toEqual(['r5']);
		expect(new Set(calls)).toEqual(new Set(['scan:inventory-reception', 'find_id:purchase-order']));
	});
});

describe('script contar-recepciones-349', () => {
	const source = readFileSync(join(import.meta.dir, '../../scripts/contar-recepciones-349.ts'), 'utf8');

	test('corre en una transacción de solo lectura que se deshace', () => {
		expect(source).toContain(`sql.begin('read only'`);
		expect(source).toContain('SHOW transaction_read_only');
		expect(source).toContain('throw ROLLBACK');
	});

	test('no tiene modo de corrección ni llamadas de escritura', () => {
		expect(source).not.toMatch(/\.(insert|update|delete|upsert|soft_delete)\(/);
		expect(source).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP)\b/);
		expect(source).not.toMatch(/--(reparar|corregir|aplicar|fix)\b/);
	});

	test('sin confirmar el servidor no corre', () => {
		expect(parse_args([])).toMatchObject({ prueba: false, permiso: false });
		expect(parse_args(['--servidor-de-prueba', '--detalle'])).toMatchObject({ prueba: true, detalle: true });
	});

	test('el resumen dice que no se modificó nada', () => {
		const text = format_report(
			{
				recepciones_abiertas: 1,
				ordenes_revisadas: 1,
				ordenes_afectadas: 1,
				recepciones_afectadas: 1,
				excedente_total: 10,
				recepciones_sin_orden: [],
				afectadas: [
					{
						orden_id: 'o1',
						orden_nombre: 'OC 1',
						estado_orden: 'confirmada',
						recepciones: ['r1'],
						excedente: 10,
						lineas: [
							{ producto: P1, producto_nombre: 'Cemento', pendiente_orden: 0, pendiente_recepciones: 10, excedente: 10 },
						],
					},
				],
			},
			true,
		);
		expect(text).toContain('Órdenes afectadas:                        1');
		expect(text).toContain('OC 1 [o1] estado=confirmada recepciones=r1');
		expect(text).toContain('No se modificó nada');
	});
});
