import { describe, expect, test } from 'bun:test';
import type { ImperiumDoc } from './envelope.ts';
import { ImperiumStore, load_catalog_path } from './store.ts';

type Row = ImperiumDoc;

/**
 * Store en memoria con la forma que devuelve Postgres: el barrido de turnos
 * trae solo los ids de caja, servicios y tipo de usuario, sin poblar.
 */
function stats_store(seed: Record<string, Row[]>): ImperiumStore {
	const store = new ImperiumStore(null as unknown as Bun.SQL, load_catalog_path());
	store.has = (resource: string) => Object.hasOwn(seed, resource);
	store.count_by_created_day = (async () => {
		const counts = new Map<string, number>();
		for (const row of seed['ticketing-system-turn'] ?? []) {
			const key = String(row.createdAt).slice(0, 10);
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
		return counts;
	}) as ImperiumStore['count_by_created_day'];
	store.scan = async function* (resource: string) {
		yield seed[resource] ?? [];
	} as ImperiumStore['scan'];
	store.find_many = (async (resource: string, opts: { ids?: string[] } = {}) => {
		let rows = seed[resource] ?? [];
		if (opts.ids?.length) {
			const wanted = new Set(opts.ids.map(String));
			rows = rows.filter((row) => wanted.has(String(row._id)));
		}
		return { rows, total: rows.length };
	}) as ImperiumStore['find_many'];
	return store;
}

const today = new Date().toISOString().slice(0, 10);
const at = (hh: string) => `${today}T${hh}:00.000Z`;

function seed(): Record<string, Row[]> {
	return {
		'ticketing-system-box-config': [
			{ _id: 'box-1', name: 'CAJA_PRUEBAS_1', is_active: true },
			{ _id: 'box-old', name: 'CAJA_VIEJA', is_active: false },
		],
		'ticketing-system-service-type': [
			{ _id: 'svc-actas', name: 'ACTAS', is_active: true },
			{ _id: 'svc-agua', name: 'AGUA POTABLE', is_active: true },
		],
		'ticketing-system-customer-type': [
			{ _id: 'type-1', name: 'General', is_active: true },
		],
		'ticketing-system-turn': [
			{
				_id: 't1',
				status: 'completado',
				assigned_box: 'box-1',
				services: ['svc-actas', 'svc-agua'],
				customer_type: 'type-1',
				time_box: [at('15:00'), at('15:04')],
				createdAt: at('14:59'),
			},
			{
				_id: 't2',
				status: 'completado',
				assigned_box: 'box-1',
				services: ['svc-actas'],
				customer_type: 'type-1',
				time_box: JSON.stringify([at('16:00'), at('16:06')]),
				createdAt: at('15:58'),
			},
			{
				_id: 't3',
				status: 'completado',
				assigned_box: 'box-old',
				services: ['svc-agua'],
				customer_type: 'type-1',
				time_box: [at('17:00'), at('17:02')],
				createdAt: at('16:59'),
			},
		],
	};
}

describe('Estadísticas de turnos (#185, subtarea 284)', () => {
	test('la dona y las líneas muestran el nombre de la caja, no «Sin nombre»', async () => {
		const stats = (await stats_store(seed()).turn_stats()) as Record<string, any>;
		const daily = stats.daily_stats as Array<Record<string, any>>;
		expect(daily.map((d) => [d.box_name, d.box_id.name, d.turns_attended]).sort()).toEqual([
			['CAJA_PRUEBAS_1', 'CAJA_PRUEBAS_1', 2],
			['CAJA_VIEJA', 'CAJA_VIEJA', 1],
		]);
		const seven = stats.seven_days_stats as Array<Record<string, any>>;
		const caja = seven.find((b) => b.box_name === 'CAJA_PRUEBAS_1')!;
		expect(caja.box_id.name).toBe('CAJA_PRUEBAS_1');
		const hoy = caja.daily_stats.find((d: any) => d.day === today);
		expect(hoy.total_turns).toBe(2);
		expect(hoy.avg_time_minutes).toBe(5);
		expect(JSON.stringify(stats)).not.toContain('Sin nombre');
	});

	test('servicios y tipos de usuario llevan nombre y cuentan cada servicio del turno', async () => {
		const stats = (await stats_store(seed()).turn_stats()) as Record<string, any>;
		const services = Object.fromEntries(
			(stats.services_stats as Array<Record<string, any>>).map((s) => [
				s.service_name,
				[s.turn_count, s.average_time_minutes],
			]),
		);
		expect(services).toEqual({ ACTAS: [2, 5], 'AGUA POTABLE': [2, 3] });
		const types = stats.customer_types_stats as Array<Record<string, any>>;
		expect(types.map((t) => [t.customer_type_name, t.turn_count, t.average_time_minutes])).toEqual([
			['General', 3, 4],
		]);
	});

	test('un turno archivado (prueba) no cuenta en las estadísticas (#183)', async () => {
		const data = seed();
		data['ticketing-system-turn'].push({
			_id: 't-prueba',
			name: 'G999',
			description: 'pruebaIMPERIUM',
			is_active: false,
			status: 'completado',
			assigned_box: 'box-1',
			services: ['svc-actas'],
			customer_type: 'type-1',
			time_box: [at('18:00'), at('18:30')],
			createdAt: at('17:59'),
		});
		const stats = (await stats_store(data).turn_stats()) as Record<string, any>;
		const caja = (stats.daily_stats as Array<Record<string, any>>).find(
			(d) => d.box_name === 'CAJA_PRUEBAS_1',
		)!;
		expect(caja.turns_attended).toBe(2);
		expect(JSON.stringify(stats)).not.toContain('t-prueba');
	});
});
