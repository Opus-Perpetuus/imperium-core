import { describe, expect, test } from 'bun:test';
import type { ImperiumDoc } from './envelope.ts';
import { ImperiumStore, load_catalog_path } from './store.ts';
import {
	format_turn_code,
	prepare_ticketing_turn_create,
	turn_code_number,
	turn_code_prefix,
} from './ticketing-turn-flow.ts';

// Odoo #232: el prefijo del turno puede llevar más de una letra (AP001).

function store_with(seed: Record<string, ImperiumDoc[]>): ImperiumStore {
	const data: Record<string, ImperiumDoc[]> = {};
	for (const [key, rows] of Object.entries(seed)) data[key] = rows.map((row) => ({ ...row }));
	let seq = 0;
	const store = new ImperiumStore(null as unknown as Bun.SQL, load_catalog_path());
	store.has = (resource: string) => Object.hasOwn(data, resource);
	store.find_id = async (resource: string, id: string) =>
		(data[resource] ?? []).find((row) => String(row._id) === String(id)) ?? null;
	store.find_where = (async (resource: string, where: Record<string, unknown>) =>
		(data[resource] ?? []).find((row) =>
			Object.entries(where).every(([k, v]) => row[k] === v),
		) ?? null) as ImperiumStore['find_where'];
	store.insert = (async (resource: string, doc: ImperiumDoc) => {
		const row = { _id: `new-${++seq}`, ...doc };
		(data[resource] ??= []).push(row);
		return row;
	}) as ImperiumStore['insert'];
	store.update = (async (resource: string, id: string, patch: ImperiumDoc) => {
		const rows = data[resource] ?? [];
		const i = rows.findIndex((row) => String(row._id) === String(id));
		if (i < 0) return null;
		rows[i] = { ...rows[i], ...patch };
		return rows[i]!;
	}) as ImperiumStore['update'];
	store.scan = async function* (resource: string) {
		yield data[resource] ?? [];
	} as ImperiumStore['scan'];
	return store;
}

function catalog(extra: Record<string, ImperiumDoc[]> = {}) {
	return {
		'ticketing-system-customer-type': [
			{ _id: 'general', name: 'General', letter: 'G', priority_level: 0 },
		],
		'ticketing-system-service-type': [
			{ _id: 'agua', name: 'Agua Potable', letter: 'ap', priority_level: 2 },
			{ _id: 'actas', name: 'Actas', letter: 'A', priority_level: 1 },
		],
		...extra,
	};
}

describe('prefijo del turno', () => {
	test('acepta de 1 a 3 letras, en mayúsculas y sin acentos', () => {
		expect(turn_code_prefix('A')).toBe('A');
		expect(turn_code_prefix('ap')).toBe('AP');
		expect(turn_code_prefix(' Agp ')).toBe('AGP');
		expect(turn_code_prefix('Agua')).toBe('AGU');
		expect(turn_code_prefix('Ñu')).toBe('ÑU');
		expect(turn_code_prefix('Á-1')).toBe('A');
	});

	test('sin letras usa la de respaldo', () => {
		expect(turn_code_prefix('')).toBe('M');
		expect(turn_code_prefix(null)).toBe('M');
		expect(turn_code_prefix('12', 'G')).toBe('G');
	});

	test('el código conserva los 3 dígitos de siempre', () => {
		expect(format_turn_code('A', 1)).toBe('A001');
		expect(format_turn_code('AP', 7)).toBe('AP007');
		expect(format_turn_code('G', 1234)).toBe('G1234');
	});

	test('el número solo cuenta si el prefijo es exacto', () => {
		expect(turn_code_number('AP012', 'AP')).toBe(12);
		expect(turn_code_number('AP012', 'A')).toBeNull();
		expect(turn_code_number('A012', 'AP')).toBeNull();
		expect(turn_code_number('a003', 'A')).toBe(3);
	});
});

describe('crear turno con prefijo de varias letras', () => {
	test('Agua Potable sale AP000 y lleva su propio consecutivo', async () => {
		const store = store_with(catalog({ 'ticketing-system-consecutive': [] }));
		const first = await prepare_ticketing_turn_create(store, {
			customer_type: 'general',
			services: ['agua'],
		});
		const second = await prepare_ticketing_turn_create(store, {
			customer_type: 'general',
			services: ['agua'],
		});
		const actas = await prepare_ticketing_turn_create(store, {
			customer_type: 'general',
			services: ['actas'],
		});
		const general = await prepare_ticketing_turn_create(store, {
			customer_type: 'general',
			services: [],
		}).catch((e: Error) => e.message);
		expect(first.name).toBe('AP000');
		expect(second.name).toBe('AP001');
		expect(actas.name).toBe('A000');
		expect(general).toBe('Se necesita al menos un servicio para crear un turno');
	});

	test('los consecutivos de una letra siguen donde iban', async () => {
		const store = store_with(
			catalog({
				'ticketing-system-consecutive': [
					{ _id: 'c-a', name: 'A', consecutive: 41, is_active: true },
				],
			}),
		);
		const actas = await prepare_ticketing_turn_create(store, {
			customer_type: 'general',
			services: ['actas'],
		});
		const agua = await prepare_ticketing_turn_create(store, {
			customer_type: 'general',
			services: ['agua'],
		});
		expect(actas.name).toBe('A041');
		expect(agua.name).toBe('AP000');
	});

	test('sin tabla de consecutivos, «A» no cuenta los turnos AP', async () => {
		const store = store_with(
			catalog({
				'ticketing-system-turn': [
					{ _id: 't1', name: 'AP050' },
					{ _id: 't2', name: 'A004' },
				],
			}),
		);
		const actas = await prepare_ticketing_turn_create(store, {
			customer_type: 'general',
			services: ['actas'],
		});
		const agua = await prepare_ticketing_turn_create(store, {
			customer_type: 'general',
			services: ['agua'],
		});
		expect(actas.name).toBe('A005');
		expect(agua.name).toBe('AP051');
	});
});
