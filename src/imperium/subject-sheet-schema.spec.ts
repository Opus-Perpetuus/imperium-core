import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import type { ImperiumDoc } from './envelope.ts';
import {
	canonical_subject_sheet_id,
	dress_subject_sheet,
} from './subject-sheet-schema.ts';
import {
	load_state_fields_metadata,
	model_id_for_resource,
	schema_validation_for,
} from './state-fields.ts';
import type { ImperiumStore } from './store.ts';

const ORDERS = 'subject-tienda/orders';
const RETURNS = 'subject-tienda/order_returns';

function option(value: string, label: string) {
	return { value, label, field_name: 'status', type: 'success' };
}

function status_row(model_id: string, options: ReturnType<typeof option>[], column = true): ImperiumDoc {
	return {
		_id: model_id,
		type: 'status-options-by-module',
		...(column ? { model_id } : {}),
		value: {
			model_id,
			module_name: model_id,
			status_fields: ['status'],
			options,
		},
	};
}

function memory_store(rows: ImperiumDoc[]) {
	const data: Record<string, ImperiumDoc[]> = { configuration: rows.map((row) => ({ ...row })) };
	const store = {
		has(resource: string) {
			return Object.hasOwn(data, resource);
		},
		field_refs() {
			return {};
		},
		async find_where(resource: string, where: Record<string, unknown>) {
			return (
				(data[resource] ?? []).find((row) =>
					Object.entries(where).every(([key, value]) => row[key] === value),
				) ?? null
			);
		},
		async *scan(resource: string, opts?: { where?: Record<string, unknown> }) {
			let page = data[resource] ?? [];
			if (opts?.where) {
				page = page.filter((row) =>
					Object.entries(opts.where ?? {}).every(([key, value]) => row[key] === value),
				);
			}
			yield page;
		},
	};
	return store as unknown as ImperiumStore;
}

const seeded = () =>
	memory_store([
		status_row(ORDERS, [option('pagado', 'Pagado'), option('pendiente', 'Pendiente')]),
		status_row(RETURNS, [option('devuelto', 'Devuelto')]),
	]);

function status_of(metadata: { fields: Array<{ field_name: string; values: Array<{ value: string; display_leyend: string }> }> }) {
	return metadata.fields.find((field) => field.field_name === 'status');
}

describe('model_id canónico', () => {
	test('owner/table gana, y si no hay tabla vale technical_id/resource o el path', () => {
		expect(
			canonical_subject_sheet_id({
				owner: 'subject-tienda',
				table: 'orders',
				model_id: 'Orders',
			}),
		).toBe(ORDERS);
		expect(
			canonical_subject_sheet_id({ technical_id: 'subject-tienda', resource: 'orders' }),
		).toBe(ORDERS);
		expect(
			canonical_subject_sheet_id({ technical_id: 'subject-tienda', resource: 'order_returns' }),
		).toBe(RETURNS);
		expect(canonical_subject_sheet_id({ owner: 'subject-tienda', path: '/orders' })).toBe(ORDERS);
		expect(canonical_subject_sheet_id({ owner: 'subject-tienda', path: 'orders/nuevo' })).toBe(ORDERS);
		expect(canonical_subject_sheet_id({ model_id: ORDERS })).toBe(ORDERS);
		expect(canonical_subject_sheet_id({ model_id: 'Orders' })).toBe('Orders');
		expect(canonical_subject_sheet_id({})).toBe('');
	});

	test('un id con barra no se pasa a PascalCase; pedidos sigue igual', () => {
		expect(model_id_for_resource('pedidos')).toBe('Pedidos');
		expect(model_id_for_resource(ORDERS)).toBe(ORDERS);
		expect(model_id_for_resource(RETURNS)).toBe(RETURNS);
	});
});

describe('state_fields de una hoja subject', () => {
	test('con la siembra, status trae esos valores y no los de otra hoja', async () => {
		const metadata = await load_state_fields_metadata(seeded(), ORDERS);
		const status = status_of(metadata);
		expect(status?.values.map((value) => value.value)).toEqual(['pagado', 'pendiente']);
		expect(status?.values.map((value) => value.display_leyend)).toEqual(['Pagado', 'Pendiente']);
		expect(status?.values.map((value) => value.value)).not.toContain('devuelto');
		const schema = await schema_validation_for(seeded(), ORDERS);
		const meta = schema.metadata as {
			model_id: string;
			state_fields: { fields: Array<{ field_name: string; values: Array<{ value: string }> }> };
		};
		expect(meta.model_id).toBe(ORDERS);
		expect(status_of(meta.state_fields)?.values.map((value) => value.value)).toEqual([
			'pagado',
			'pendiente',
		]);
		const returns = await load_state_fields_metadata(seeded(), RETURNS);
		expect(status_of(returns)?.values.map((value) => value.value)).toEqual(['devuelto']);
	});

	test('el model_id guardado solo dentro de value también cuenta', async () => {
		const store = memory_store([
			status_row(ORDERS, [option('pagado', 'Pagado')], false),
		]);
		const metadata = await load_state_fields_metadata(store, ORDERS);
		expect(status_of(metadata)?.values.map((value) => value.value)).toEqual(['pagado']);
	});

	test('sin siembra no inventa estatus de pedidos ni de nadie', async () => {
		const metadata = await load_state_fields_metadata(memory_store([]), ORDERS);
		expect(metadata.fields).toEqual([]);
		expect(metadata.has_state_fields).toBe(false);
		const values = metadata.fields.flatMap((field) => field.values.map((value) => value.value));
		expect(values).not.toContain('borrador');
	});
});

function json_response(body: unknown, status = 200, content_type = 'application/json') {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': content_type },
	});
}

describe('dress_subject_sheet', () => {
	test('la lista y field-values reciben los estatus sembrados', async () => {
		const list = json_response({ data: [], total_elementos: 0, message: 'Ruta encontrada' });
		const dressed = await dress_subject_sheet(seeded(), 'subject-tienda', '/orders', list);
		expect(dressed).not.toBe(list);
		const body = (await dressed.json()) as {
			data: unknown[];
			schema_validation: {
				metadata: { model_id: string; state_fields: { fields: Array<{ field_name: string; values: Array<{ value: string }> }> } };
			};
		};
		expect(body.data).toEqual([]);
		expect(body.schema_validation.metadata.model_id).toBe(ORDERS);
		expect(status_of(body.schema_validation.metadata.state_fields)?.values.map((value) => value.value)).toEqual([
			'pagado',
			'pendiente',
		]);

		const detail = json_response({ data: { id: '1' }, message: 'Ruta encontrada' });
		const dressed_detail = await dress_subject_sheet(
			seeded(),
			'subject-tienda',
			'/order_returns/1',
			detail,
		);
		const detail_body = (await dressed_detail.json()) as {
			schema_validation: { metadata: { model_id: string; state_fields: { fields: Array<{ values: Array<{ value: string }> }> } } };
		};
		expect(detail_body.schema_validation.metadata.model_id).toBe(RETURNS);
		expect(detail_body.schema_validation.metadata.state_fields.fields[0]?.values.map((value) => value.value)).toEqual([
			'devuelto',
		]);

		const values = json_response({
			data: [
				{ value: 'pagado', label: 'pagado' },
				{ value: 'raro', label: 'Raro' },
			],
			total_elementos: 2,
			message: 'Valores de campo',
		});
		const dressed_values = await dress_subject_sheet(
			seeded(),
			'subject-tienda',
			'/orders/field-values/status',
			values,
		);
		const values_body = (await dressed_values.json()) as {
			data: Array<{ value: string; label: string }>;
			total_elementos: number;
		};
		expect(values_body.data).toEqual([
			expect.objectContaining({ value: 'pagado', label: 'Pagado' }),
			{ value: 'raro', label: 'Raro' },
			expect.objectContaining({ value: 'pendiente', label: 'Pendiente' }),
		]);
		expect(values_body.total_elementos).toBe(3);
	});

	test('sin siembra la respuesta de la app no se toca', async () => {
		const list = json_response({ data: [{ id: '1' }], total_elementos: 1 });
		const dressed = await dress_subject_sheet(memory_store([]), 'subject-tienda', '/orders', list);
		expect(dressed).toBe(list);
		expect(await list.json()).toEqual({ data: [{ id: '1' }], total_elementos: 1 });

		const values = json_response({ data: [{ value: 'pagado', label: 'pagado' }], total_elementos: 1 });
		const dressed_values = await dress_subject_sheet(
			memory_store([]),
			'subject-tienda',
			'/orders/field-values/status',
			values,
		);
		expect(dressed_values).toBe(values);

		const page = json_response({ id: 'inicio' });
		expect(await dress_subject_sheet(seeded(), 'subject-tienda', '/pages/inicio', page)).toBe(page);
		const text = new Response('ok', { headers: { 'content-type': 'text/plain' } });
		expect(await dress_subject_sheet(seeded(), 'subject-tienda', '/orders', text)).toBe(text);
		const failed = json_response({ error: 'no' }, 500);
		expect(await dress_subject_sheet(seeded(), 'subject-tienda', '/orders', failed)).toBe(failed);
	});

	test('si la app ya mandó state_fields no se pisan; si el schema viene vacío se completa', async () => {
		const own = json_response({
			data: [],
			schema_validation: {
				metadata: {
					state_fields: { fields: [{ field_name: 'status', values: [{ value: 'propio' }] }] },
				},
			},
		});
		expect(await dress_subject_sheet(seeded(), 'subject-tienda', '/orders', own)).toBe(own);

		const partial = json_response({
			data: [],
			schema_validation: { type: 'object', properties: { name: { type: 'string' } }, metadata: {} },
		});
		const dressed = await dress_subject_sheet(seeded(), 'subject-tienda', '/orders', partial);
		const body = (await dressed.json()) as {
			schema_validation: {
				properties: { name: { type: string } };
				metadata: { model_id: string; state_fields: { fields: Array<{ field_name: string }> } };
			};
		};
		expect(body.schema_validation.properties.name.type).toBe('string');
		expect(body.schema_validation.metadata.model_id).toBe(ORDERS);
		expect(body.schema_validation.metadata.state_fields.fields.map((field) => field.field_name)).toContain(
			'status',
		);
	});
});

describe('server.ts: cableado', () => {
	const src = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');

	test('el GET de una hoja se viste después de la respuesta de la app', () => {
		const call = src.indexOf(
			'return await dress_subject_sheet(imperium.store, technical_id, rest, proxied);',
		);
		expect(call).toBeGreaterThan(0);
		const window = src.slice(call - 500, call);
		expect(window).toContain('subject_proxy_response(');
		expect(window).toContain("if (req.method !== 'GET') return proxied;");
	});
});
