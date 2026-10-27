import { describe, expect, test } from 'bun:test';
import type { ImperiumDoc } from './envelope.ts';
import {
	list_general_option_list_control,
	read_general_option_list_options,
	seed_general_option_lists,
} from './general-option-lists.ts';
import { seed_status_defaults } from './status-options.ts';
import type { ImperiumStore } from './store.ts';

type Row = ImperiumDoc;

function memory_store(seed: Record<string, Row[]> = {}) {
	const data: Record<string, Row[]> = {};
	for (const [key, rows] of Object.entries(seed)) data[key] = rows.map((row) => ({ ...row }));
	let n = 0;
	let updates = 0;
	const store = {
		data,
		updates: () => updates,
		has(resource: string) {
			return Object.hasOwn(data, resource);
		},
		async find_id(resource: string, id: string) {
			return (data[resource] ?? []).find((row) => String(row._id) === String(id)) ?? null;
		},
		async find_where(resource: string, where: Record<string, unknown>) {
			return (
				(data[resource] ?? []).find((row) =>
					Object.entries(where).every(([key, value]) => row[key] === value),
				) ?? null
			);
		},
		async *scan(
			resource: string,
			opts?: { where?: Record<string, unknown> },
		) {
			let rows = data[resource] ?? [];
			if (opts?.where) {
				rows = rows.filter((row) =>
					Object.entries(opts.where ?? {}).every(([key, value]) => row[key] === value),
				);
			}
			yield rows;
		},
		async insert(resource: string, doc: Row) {
			n += 1;
			const row = {
				...doc,
				_id: doc._id ?? `507f1f77bcf86cd7994${String(n).padStart(5, '0')}`,
			};
			data[resource] = data[resource] ?? [];
			data[resource].push(row);
			return row;
		},
		async update(resource: string, id: string, patch: Row) {
			updates += 1;
			const row = (data[resource] ?? []).find((item) => String(item._id) === String(id));
			if (!row) return null;
			Object.assign(row, patch);
			return row;
		},
	};
	return store as unknown as ImperiumStore & {
		data: Record<string, Row[]>;
		updates: () => number;
	};
}

function ctx(store: ImperiumStore, body: Record<string, unknown> = {}, url = 'http://test/api/general-option-list-control') {
	return { store, params: {}, actor: null, body, url: new URL(url) };
}

const EFECTIVO = {
	value: 'efectivo',
	label: 'Efectivo de caja',
	color: '#198754',
	is_user_defined: true,
	note: 'no tocar',
};

function general_config(options: ImperiumDoc[]): Row {
	return {
		_id: '507f1f77bcf86cd7994390aa',
		_ref: 'configuration-general-option-lists-pos-tickets',
		type: 'general-option-lists-by-module',
		module_id: 'PosTickets',
		model_id: 'PosTickets',
		value: {
			module_id: 'PosTickets',
			model_id: 'PosTickets',
			module_name: 'pos-tickets',
			lists: [
				{
					list_key: 'metodo_pago',
					label: 'Método de pago',
					field_name: 'metodo_pago',
					options,
				},
			],
		},
	};
}

const pago_seed = {
	model_id: 'PosTickets',
	module_name: 'pos-tickets',
	lists: [
		{
			list_key: 'metodo_pago',
			label: 'Método de pago (no debe pisar)',
			field_name: 'metodo_pago',
			options: [
				{ value: 'efectivo', label: 'Efectivo', color: '#000000' },
				{ value: 'tarjeta', label: 'Tarjeta' },
			],
		},
	],
};

describe('general-option-list-control', () => {
	test('la lista vacía trae tipo_de_instancia para la tabla', async () => {
		const store = memory_store();
		const result = await list_general_option_list_control(ctx(store) as never);
		expect(Object.keys(result.tipo_de_instancia ?? {})).toEqual([
			'name',
			'module_name',
			'model_id',
			'lists_count',
			'options_count',
			'has_configuration',
		]);
	});

	test('BD vacía: seed-defaults crea las opciones del subject', async () => {
		const store = memory_store({ configuration: [] });
		const result = await seed_general_option_lists(ctx(store, pago_seed) as never);
		expect(result.data[0]?.inserted).toBe(2);
		const lists = (store.data.configuration[0]?.value as { lists: Array<{ options: ImperiumDoc[] }> }).lists;
		expect(lists[0]?.options.map((option) => option.value)).toEqual(['efectivo', 'tarjeta']);
	});

	test('BD con un subconjunto: solo agrega la que falta', async () => {
		const efectivo = { value: 'efectivo', label: 'Efectivo ya guardado', color: '#111111' };
		const store = memory_store({ configuration: [general_config([efectivo])] });
		const result = await seed_general_option_lists(ctx(store, pago_seed) as never);
		expect(result.data[0]?.inserted).toBe(1);
		expect(result.data[0]?.skipped).toBe(1);
		const options = (
			store.data.configuration[0]?.value as { lists: Array<{ label: string; options: ImperiumDoc[] }> }
		).lists[0];
		expect(options?.label).toBe('Método de pago');
		expect(options?.options[0]).toBe(efectivo);
		expect(options?.options.map((option) => option.value)).toEqual(['efectivo', 'tarjeta']);
		expect(efectivo.label).toBe('Efectivo ya guardado');
		expect(efectivo.color).toBe('#111111');
	});

	test('opciones de usuario quedan intactas y el re-seed no escribe', async () => {
		const store = memory_store({
			configuration: [general_config([EFECTIVO, { value: 'vale', label: 'Vale del usuario', is_user_defined: true }])],
		});
		const first = await seed_general_option_lists(ctx(store, pago_seed) as never);
		expect(first.data[0]?.inserted).toBe(1);
		const options = (
			store.data.configuration[0]?.value as { lists: Array<{ options: ImperiumDoc[] }> }
		).lists[0]?.options;
		expect(options?.[0]).toBe(EFECTIVO);
		expect(options?.map((option) => option.value)).toEqual(['efectivo', 'vale', 'tarjeta']);
		const writes = store.updates();
		const second = await seed_general_option_lists(ctx(store, pago_seed) as never);
		expect(second.data[0]?.inserted).toBe(0);
		expect(second.message).toContain('se dejaron igual');
		expect(store.updates()).toBe(writes);
		expect(options?.[0]).toEqual(EFECTIVO);
	});

	test('optionsSource lee value y label sin reescribir la lista', async () => {
		const store = memory_store({ configuration: [general_config([EFECTIVO])] });
		const result = await read_general_option_list_options(
			ctx(
				store,
				{},
				'http://test/api/general-option-list-control/options?model_id=PosTickets&list_key=metodo_pago&as=options',
			) as never,
		);
		expect(result.data).toEqual([
			{ value: 'efectivo', label: 'Efectivo de caja', color: '#198754' },
		]);
		expect(store.updates()).toBe(0);
	});
});

const abierto = {
	value: 'abierto',
	label: 'Abierto por el usuario',
	color: '#abcdef',
	field_name: 'status',
	is_user_defined: true,
	note: 'custom',
};

const ticket_seed = {
	model_id: 'Ticket',
	module_name: 'tickets',
	status_fields: ['status'],
	options: [
		{ value: 'abierto', label: 'Abierto', field_name: 'status', type: 'info', color: '#000000' },
		{ value: 'cerrado', label: 'Cerrado', field_name: 'status', type: 'success' },
	],
};

function status_config(options: ImperiumDoc[]): Row {
	return {
		_id: '507f1f77bcf86cd7994390bb',
		type: 'status-options-by-module',
		module_id: 'Ticket',
		model_id: 'Ticket',
		value: {
			module_id: 'Ticket',
			model_id: 'Ticket',
			module_name: 'tickets',
			status_fields: ['status'],
			options,
		},
	};
}

describe('status-option-control seed-defaults', () => {
	test('BD vacía: la siembra deja los defaults pedidos', async () => {
		const store = memory_store({ configuration: [] });
		const result = await seed_status_defaults(ctx(store, ticket_seed) as never);
		expect(result.data[0]?.inserted).toBe(2);
		const value = store.data.configuration[0]?.value as { options: Array<{ value: string }> };
		expect(value.options.map((option) => option.value)).toEqual(['abierto', 'cerrado']);
	});

	test('BD con un subconjunto: no pisa la etiqueta existente', async () => {
		const kept = { value: 'abierto', label: 'Sigue abierto', field_name: 'status', type: 'info', color: '#123456' };
		const store = memory_store({ configuration: [status_config([kept])] });
		const result = await seed_status_defaults(ctx(store, ticket_seed) as never);
		expect(result.data[0]?.inserted).toBe(1);
		const options = (store.data.configuration[0]?.value as { options: ImperiumDoc[] }).options;
		expect(options[0]).toBe(kept);
		expect(kept.label).toBe('Sigue abierto');
		expect(kept.color).toBe('#123456');
		expect(options.map((option) => option.value)).toEqual(['abierto', 'cerrado']);
	});

	test('una opción de usuario y un re-seed son no-op sobre lo ya guardado', async () => {
		const store = memory_store({
			configuration: [status_config([abierto, { value: 'espera', label: 'En espera', field_name: 'status', is_user_defined: true }])],
		});
		const first = await seed_status_defaults(ctx(store, ticket_seed) as never);
		expect(first.data[0]?.inserted).toBe(1);
		const options = (store.data.configuration[0]?.value as { options: ImperiumDoc[] }).options;
		expect(options[0]).toBe(abierto);
		expect(options.map((option) => option.value)).toEqual(['abierto', 'espera', 'cerrado']);
		const writes = store.updates();
		const second = await seed_status_defaults(ctx(store, ticket_seed) as never);
		expect(second.data[0]?.inserted).toBe(0);
		expect(store.updates()).toBe(writes);
		expect(abierto).toEqual({
			value: 'abierto',
			label: 'Abierto por el usuario',
			color: '#abcdef',
			field_name: 'status',
			is_user_defined: true,
			note: 'custom',
		});
	});

	test('sin cuerpo, la siembra del núcleo agrega faltantes y el segundo pase no escribe', async () => {
		const store = memory_store({ configuration: [] });
		const first = await seed_status_defaults(ctx(store, {}) as never);
		expect(Number(first.data[0]?.inserted)).toBeGreaterThan(0);
		const pedidos = store.data.configuration.find((row) => row.model_id === 'Pedidos');
		const values = (pedidos?.value as { options: Array<{ value: string }> }).options.map((option) => option.value);
		expect(values).toContain('borrador');
		const writes = store.updates();
		const second = await seed_status_defaults(ctx(store, {}) as never);
		expect(second.data[0]?.inserted).toBe(0);
		expect(store.updates()).toBe(writes);
	});
});

describe('seed fill-empty color/icon', () => {
	test('rellena color vacío en opción general ya guardada sin tocar etiqueta', async () => {
		const existing = { value: 'efectivo', label: 'Efectivo custom', color: '' };
		const store = memory_store({ configuration: [general_config([existing])] });
		const result = await seed_general_option_lists(
			ctx(store, {
				model_id: 'PosTickets',
				lists: [
					{
						list_key: 'metodo_pago',
						options: [
							{ value: 'efectivo', label: 'Efectivo', color: '#198754', icon: 'fas fa-coins' },
						],
					},
				],
			}) as never,
		);
		expect(result.data[0]?.filled).toBe(1);
		expect(result.data[0]?.inserted).toBe(0);
		const options = (
			store.data.configuration[0]?.value as { lists: Array<{ options: ImperiumDoc[] }> }
		).lists[0]?.options;
		expect(options?.[0]?.label).toBe('Efectivo custom');
		expect(options?.[0]?.color).toBe('#198754');
		expect(options?.[0]?.icon).toBe('fas fa-coins');
	});
});

