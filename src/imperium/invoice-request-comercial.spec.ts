import { describe, expect, test } from 'bun:test';
import type { ImperiumDoc } from './envelope.ts';
import {
	claim_envios,
	COMERCIAL_CONCEPTO_PENDIENTE,
	CONFIG_COMERCIAL_COLA_ACTIVA,
	CONFIG_COMERCIAL_PEDIDO_CONCEPTO,
	CONFIG_COMERCIAL_PEDIDO_SERIE,
	DOCUMENTO_COMERCIAL_DEFAULT,
	report_envio,
	retry_envio,
} from './comercial-envio-flow.ts';
import {
	cancel_invoice_request,
	generate_invoice_from_order,
	IR_CANCELED,
	IR_PENDING,
	IR_READY,
	IR_SENDING,
	IR_SENT,
	on_invoice_request_envio_change,
	precio_sin_iva,
	send_invoice_to_commercial,
} from './invoice-request-flow.ts';
import type { ImperiumStore } from './store.ts';

type Row = ImperiumDoc;

function memory_store(seed: Record<string, Row[]> = {}) {
	const data: Record<string, Row[]> = {
		pedidos: [],
		contacto: [],
		'invoice-request': [],
		'comercial-envio': [],
		configuration: [],
		'lista-de-precios': [],
	};
	for (const [key, rows] of Object.entries(seed)) data[key] = rows.map((row) => ({ ...row }));
	let n = 0;
	const matches = (row: Row, where?: Record<string, unknown>) =>
		!where ||
		Object.entries(where).every(([key, value]) => value === undefined || row[key] === value);
	const store = {
		data,
		has(resource: string) {
			return Object.prototype.hasOwnProperty.call(data, resource);
		},
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
				include_inactive?: boolean;
				sort?: string;
				take?: number;
			} = {},
		) {
			let rows = (data[resource] ?? []).filter((row) => matches(row, opts.where));
			if (!opts.include_inactive) rows = rows.filter((row) => row.is_active !== false);
			if (opts.sort) {
				const [field, dir] = opts.sort.split(':');
				const sign = dir === 'desc' ? -1 : 1;
				rows = [...rows].sort(
					(a, b) => String(a[field] ?? '').localeCompare(String(b[field] ?? '')) * sign,
				);
			}
			const total = rows.length;
			if (opts.take != null) rows = rows.slice(0, opts.take);
			return { rows, total };
		},
		async *scan(
			resource: string,
			opts: { where?: Record<string, unknown>; include_inactive?: boolean } = {},
		) {
			let rows = (data[resource] ?? []).filter((row) => matches(row, opts.where));
			if (!opts.include_inactive) rows = rows.filter((row) => row.is_active !== false);
			yield rows;
		},
		async insert(resource: string, doc: Row) {
			n += 1;
			const row = { ...doc, _id: doc._id ?? `row-${String(n).padStart(4, '0')}` };
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
	};
	return store as unknown as ImperiumStore & { data: Record<string, Row[]> };
}

function reloj(inicio: string) {
	const current = new Date(inicio);
	return { now: () => current };
}

function solicitud(id: string, estado: string, subs = 3): Row {
	return {
		_id: id,
		name: `SOL-FAC-${id}`,
		estado,
		is_active: true,
		pedido: 'ped-1',
		contacto: 'cte-1',
		contacto_nombre: 'Ana López',
		contacto_rfc: 'XAXX010101000',
		monto_total: subs * 100,
		monto_umbral: 2000,
		iva_tasa: 16,
		base_calculo: 'total_con_iva',
		subpedidos: Array.from({ length: subs }, (_, index) => ({
			index: index + 1,
			name: `SUB-${index + 1}`,
			monto_total: 100,
			iva: 16,
			total_con_iva: 116,
			articulos_count: 1,
			articulos: [
				{
					pedido_articulo_index: 0,
					product: 'prod-1',
					product_code: 'SKU-1',
					cantidad_facturable: 2,
					precio_unitario: 50,
					monto_total: 100,
					...(index === 0 ? { observaciones: 'Nota de sub' } : {}),
				},
			],
		})),
	};
}

function cola_row(value: unknown): Row {
	return { _id: 'cfg-cola', _ref: CONFIG_COMERCIAL_COLA_ACTIVA, value };
}

function base_seed(extra: Record<string, Row[]> = {}, cola_activa = true): Record<string, Row[]> {
	const { configuration: extra_config = [], ...rest } = extra;
	return {
		pedidos: [
			{
				_id: 'ped-1',
				folio: 'PED-99',
				fecha: '2026-10-10',
				contacto: 'cte-1',
				articulos: [{ precio: 10.98765, cantidad: 2, importe: 21.98 }],
			},
		],
		contacto: [{ _id: 'cte-1', name: 'Ana López', rfc: 'XAXX010101000', codigo: 'C-01' }],
		'invoice-request': [],
		configuration: [...(cola_activa ? [cola_row(true)] : []), ...extra_config],
		...rest,
	};
}

function payloads(store: ImperiumStore & { data: Record<string, Row[]> }, id: string) {
	return (store.data['comercial-envio'] ?? [])
		.filter((row) => row.origen_id === id)
		.sort((a, b) => Number(a.sub_index) - Number(b.sub_index))
		.map((row) => row.payload as Record<string, unknown>);
}

describe('precio_sin_iva', () => {
	test('redondea a 4 decimales y solo quita el IVA cuando el precio lo trae', () => {
		expect(precio_sin_iva(10.98765, { iva_tasa: 16, incluye_iva: false })).toBe(10.9877);
		expect(precio_sin_iva(116, { iva_tasa: 16, incluye_iva: false })).toBe(116);
		expect(precio_sin_iva(116, { iva_tasa: 16, incluye_iva: true })).toBe(100);
		expect(precio_sin_iva(10.5, { iva_tasa: 16, incluye_iva: true })).toBe(9.0517);
		expect(precio_sin_iva(10, { iva_tasa: 0, incluye_iva: true })).toBe(10);
	});
});

describe('envío de la solicitud a la cola', () => {
	test('tres subpedidos encolan tres envíos y el segundo envío no duplica', async () => {
		const store = memory_store(base_seed({ 'invoice-request': [solicitud('sol-1', IR_READY)] }));
		const clock = reloj('2026-10-10T18:00:00.000Z');
		const actor = { name: 'Rafa' };
		const sent = await send_invoice_to_commercial(store, 'sol-1', actor, 'REF-MANUAL');
		expect(sent.estado).toBe(IR_SENDING);
		expect(sent.comercial_envio_estado).toBe('pendiente');
		expect(sent.comercial_envio_error).toBeNull();
		expect(sent.enviado_a_comercial_usuario_nombre).toBe('Rafa');
		expect(sent.comercial_referencia).toBe('REF-MANUAL');
		expect(store.data['comercial-envio']).toHaveLength(3);
		expect(store.data['comercial-envio']?.map((row) => row.sub_index)).toEqual([0, 1, 2]);

		const again = await send_invoice_to_commercial(store, 'sol-1', actor);
		expect(again).toBe(sent);
		expect(store.data['comercial-envio']).toHaveLength(3);

		const snaps = payloads(store, 'sol-1');
		expect(snaps).toHaveLength(3);
		expect(snaps[0]).toMatchObject({
			cliente: {
				contacto: 'cte-1',
				nombre: 'Ana López',
				rfc: 'XAXX010101000',
				codigo: 'C-01',
			},
			fecha: '2026-10-10',
			documento_comercial: DOCUMENTO_COMERCIAL_DEFAULT,
			texto_extra3: 'SOL-FAC-sol-1 sub 1/3',
			referencia: {
				solicitud_id: 'sol-1',
				solicitud_name: 'SOL-FAC-sol-1',
				sub_index: 0,
				sub_total: 116,
			},
		});
		expect(snaps[1]).toMatchObject({ texto_extra3: 'SOL-FAC-sol-1 sub 2/3' });
		expect(snaps[2]).toMatchObject({ texto_extra3: 'SOL-FAC-sol-1 sub 3/3' });
		const lineas = snaps[0]?.lineas as Array<Record<string, unknown>>;
		expect(lineas[0]).toMatchObject({
			product: 'prod-1',
			product_code: 'SKU-1',
			descripcion: 'Nota de sub',
			cantidad: 2,
			precio_unitario_sin_iva: 10.9877,
			importe_sin_iva: 100,
		});
		expect((snaps[1]?.lineas as Array<Record<string, unknown>>)[0]?.descripcion).toBeUndefined();
		for (const snap of snaps) {
			const crudo = JSON.stringify(snap);
			expect(crudo).not.toContain('pedido_origen');
			expect(crudo).not.toContain('PED-99');
			expect(snap.documento_comercial).toEqual(DOCUMENTO_COMERCIAL_DEFAULT);
		}
		expect(DOCUMENTO_COMERCIAL_DEFAULT.concepto).toBe(COMERCIAL_CONCEPTO_PENDIENTE);
	});

	test('el documento sale de la configuración y el override de la llamada gana', async () => {
		const store = memory_store(
			base_seed({
				'invoice-request': [solicitud('sol-cfg', IR_READY, 1), solicitud('sol-over', IR_READY, 1)],
				configuration: [
					{
						_id: 'cfg-concepto',
						_ref: CONFIG_COMERCIAL_PEDIDO_CONCEPTO,
						value: '2',
					},
					{ _id: 'cfg-serie', _ref: CONFIG_COMERCIAL_PEDIDO_SERIE, value: 'LAB' },
				],
			}),
		);
		await send_invoice_to_commercial(store, 'sol-cfg', { name: 'Rafa' });
		expect(payloads(store, 'sol-cfg')[0]?.documento_comercial).toEqual({
			tipo_documento: 'pedido',
			concepto: '2',
			serie: 'LAB',
		});
		await send_invoice_to_commercial(store, 'sol-over', { name: 'Rafa' }, undefined, {
			documento_comercial: { serie: 'Z' },
		});
		expect(payloads(store, 'sol-over')[0]?.documento_comercial).toEqual({
			tipo_documento: 'pedido',
			concepto: '2',
			serie: 'Z',
		});
	});

	test('dos de tres enviados no cierran; el tercero llena la referencia en orden', async () => {
		const store = memory_store(base_seed({ 'invoice-request': [solicitud('sol-3', IR_READY)] }));
		const clock = reloj('2026-10-10T18:00:00.000Z');
		const hook = on_invoice_request_envio_change(store, clock.now);
		await send_invoice_to_commercial(store, 'sol-3', { name: 'Rafa' });
		const tomados = await claim_envios(store, { worker_id: 'w1', max: 3 }, clock.now);
		expect(tomados).toHaveLength(3);
		const por_sub = [...tomados].sort((a, b) => Number(a.sub_index) - Number(b.sub_index));
		await report_envio(
			store,
			String(por_sub[0]?._id),
			{ worker_id: 'w1', resultado: 'enviado', serie: 'A', folio: '10', id_doc: 'd0' },
			clock.now,
			hook,
		);
		await report_envio(
			store,
			String(por_sub[1]?._id),
			{ worker_id: 'w1', resultado: 'enviado', folio: '11', id_doc: 'd1' },
			clock.now,
			hook,
		);
		const a_medias = await store.find_id('invoice-request', 'sol-3');
		expect(a_medias?.estado).toBe(IR_SENDING);
		expect(a_medias?.comercial_envio_estado).toBe('enviando');
		expect(a_medias?.comercial_referencia).toBeUndefined();

		const cerrado = await report_envio(
			store,
			String(por_sub[2]?._id),
			{ worker_id: 'w1', resultado: 'enviado', serie: 'B', folio: '12', id_doc: 'd2' },
			clock.now,
			hook,
		);
		expect(cerrado.estado).toBe('enviado');
		const lista = await store.find_id('invoice-request', 'sol-3');
		expect(lista?.estado).toBe(IR_SENT);
		expect(lista?.comercial_envio_estado).toBe('enviado');
		expect(lista?.comercial_envio_error).toBeNull();
		expect(lista?.comercial_referencia).toBe('A-10, 11, B-12');
		expect(lista?.comercial_id_doc).toEqual(['d0', 'd1', 'd2']);
		expect(lista?.enviado_a_comercial_fecha).toBe('2026-10-10T18:00:00.000Z');
		expect(store.data.pedidos?.[0]?.invoice_request_estado).toBe(IR_SENT);

		await report_envio(
			store,
			String(por_sub[2]?._id),
			{ worker_id: 'w1', resultado: 'enviado', serie: 'B', folio: '12', id_doc: 'd2' },
			() => new Date('2026-10-11T00:00:00.000Z'),
			hook,
		);
		const otra = await store.find_id('invoice-request', 'sol-3');
		expect(otra?.enviado_a_comercial_fecha).toBe('2026-10-10T18:00:00.000Z');
		expect(otra?.comercial_referencia).toBe('A-10, 11, B-12');
	});

	test('un error no cierra; el reintento manual y el enviado sí', async () => {
		const store = memory_store(base_seed({ 'invoice-request': [solicitud('sol-err', IR_READY, 1)] }));
		const clock = reloj('2026-10-10T18:00:00.000Z');
		const hook = on_invoice_request_envio_change(store, clock.now);
		await send_invoice_to_commercial(store, 'sol-err', { name: 'Rafa' });
		const [tomado] = await claim_envios(store, { worker_id: 'w1', max: 1 }, clock.now);
		await report_envio(
			store,
			String(tomado?._id),
			{ worker_id: 'w1', resultado: 'error', reintentable: false, mensaje: 'cliente inexistente' },
			clock.now,
			hook,
		);
		const con_error = await store.find_id('invoice-request', 'sol-err');
		expect(con_error?.estado).toBe(IR_SENDING);
		expect(con_error?.comercial_envio_estado).toBe('error');
		expect(con_error?.comercial_envio_error).toBe('cliente inexistente');

		await retry_envio(store, String(tomado?._id), clock.now, hook);
		const reintentado = await store.find_id('invoice-request', 'sol-err');
		expect(reintentado?.estado).toBe(IR_SENDING);
		expect(reintentado?.comercial_envio_estado).toBe('pendiente');
		expect(reintentado?.comercial_envio_error).toBeNull();

		const [otra] = await claim_envios(store, { worker_id: 'w1', max: 1 }, clock.now);
		await report_envio(
			store,
			String(otra?._id),
			{ worker_id: 'w1', resultado: 'enviado', serie: 'A', folio: '7', id_doc: 'doc-7' },
			clock.now,
			hook,
		);
		const cerrado = await store.find_id('invoice-request', 'sol-err');
		expect(cerrado?.estado).toBe(IR_SENT);
		expect(cerrado?.comercial_referencia).toBe('A-7');
		expect(cerrado?.comercial_id_doc).toEqual(['doc-7']);
	});

	test('no envía una solicitud pendiente de cobranza y sí cancela una que se está enviando', async () => {
		const store = memory_store(
			base_seed({
				'invoice-request': [
					solicitud('sol-pend', IR_PENDING, 1),
					solicitud('sol-send', IR_SENDING, 1),
				],
			}),
		);
		await expect(send_invoice_to_commercial(store, 'sol-pend', { name: 'Rafa' })).rejects.toThrow(
			/lista para comercial/,
		);
		expect(store.data['comercial-envio']).toHaveLength(0);
		const canceled = await cancel_invoice_request(store, 'sol-send', 'ya no');
		expect(canceled.estado).toBe(IR_CANCELED);
	});
});

describe('envío manual con la cola apagada', () => {
	test('sin parámetro marca enviado a comercial y no encola', async () => {
		const store = memory_store(
			base_seed({ 'invoice-request': [solicitud('sol-off', IR_READY)] }, false),
		);
		const sent = await send_invoice_to_commercial(store, 'sol-off', { name: 'Rafa' }, 'REF-MANUAL');
		expect(sent.estado).toBe(IR_SENT);
		expect(sent.enviado_a_comercial_usuario_nombre).toBe('Rafa');
		expect(sent.comercial_referencia).toBe('REF-MANUAL');
		expect(sent.enviado_a_comercial_fecha).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(sent.comercial_envio_estado).toBeUndefined();
		expect(store.data['comercial-envio']).toHaveLength(0);
		expect(store.data.pedidos?.[0]?.invoice_request_estado).toBe(IR_SENT);
		await expect(send_invoice_to_commercial(store, 'sol-off', { name: 'Rafa' })).rejects.toThrow(
			/lista para comercial/,
		);
		expect(store.data['comercial-envio']).toHaveLength(0);
	});

	test('false y la cadena false dejan el camino manual', async () => {
		for (const value of [false, 'false', 0]) {
			const store = memory_store(
				base_seed(
					{
						'invoice-request': [solicitud('sol-off', IR_READY, 1)],
						configuration: [cola_row(value)],
					},
					false,
				),
			);
			const sent = await send_invoice_to_commercial(store, 'sol-off', { name: 'Rafa' });
			expect(sent.estado).toBe(IR_SENT);
			expect(sent.comercial_referencia).toBeUndefined();
			expect(store.data['comercial-envio']).toHaveLength(0);
		}
	});

	test('una solicitud que ya se está enviando no se encola si la cola está apagada', async () => {
		const store = memory_store(
			base_seed({ 'invoice-request': [solicitud('sol-send', IR_SENDING, 1)] }, false),
		);
		await expect(send_invoice_to_commercial(store, 'sol-send', { name: 'Rafa' })).rejects.toThrow(
			/lista para comercial/,
		);
		expect(store.data['comercial-envio']).toHaveLength(0);
		expect((await store.find_id('invoice-request', 'sol-send'))?.estado).toBe(IR_SENDING);
	});
});

describe('umbral de división con IVA', () => {
	test('un conjunto de $1,800 sin IVA con tasa 16 se parte para no pasar de $2,000 con IVA', async () => {
		const store = memory_store({
			pedidos: [
				{
					_id: 'ped-iva',
					estado: 'confirmado',
					folio: 'F18',
					contacto: 'cte-iva',
					listaDePreciosId: 'lista-16',
					articulos: [
						{ cantidad: 1, precio: 900, importe: 900, product: 'p1' },
						{ cantidad: 1, precio: 900, importe: 900, product: 'p2' },
					],
				},
			],
			contacto: [
				{
					_id: 'cte-iva',
					name: 'Cliente IVA',
					rfc: 'XAXX010101000',
					facturacion_dividida_habilitada: true,
					facturacion_dividida_monto_maximo: 2000,
				},
			],
			'lista-de-precios': [{ _id: 'lista-16', name: 'Lista 16', iva: 16 }],
			'invoice-request': [],
		});
		const { record } = await generate_invoice_from_order(store, 'ped-iva');
		expect(record.base_calculo).toBe('total_con_iva');
		expect(record.iva_tasa).toBe(16);
		expect(record.monto_umbral).toBe(2000);
		const subpedidos = record.subpedidos as Array<Record<string, unknown>>;
		expect(subpedidos).toHaveLength(2);
		for (const sub of subpedidos) {
			expect(Number(sub.total_con_iva)).toBeLessThanOrEqual(2000);
			expect(Number(sub.monto_total) + Number(sub.iva)).toBe(Number(sub.total_con_iva));
		}
		expect(subpedidos.reduce((acc, sub) => acc + Number(sub.monto_total), 0)).toBe(1800);
	});
});
