import { describe, expect, test } from 'bun:test';
import type { ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';
import {
	ComercialEnvioError,
	ESTADO_ENVIADO,
	ESTADO_ENVIANDO,
	ESTADO_ERROR,
	ESTADO_PENDIENTE,
	ESTADO_REINTENTO,
	LEASE_MS,
	claim_envios,
	COMERCIAL_CONCEPTO_PENDIENTE,
	DOCUMENTO_COMERCIAL_DEFAULT,
	enqueue_envio,
	envios_by_origen,
	llave_ref,
	report_envio,
	retry_envio,
} from './comercial-envio-flow.ts';

type Row = ImperiumDoc;

function memory_store(seed: Record<string, Row[]> = {}) {
	const data: Record<string, Row[]> = {};
	for (const [key, rows] of Object.entries(seed)) data[key] = rows.map((row) => ({ ...row }));
	let n = 0;
	const matches = (row: Row, where?: Record<string, unknown>) =>
		!where ||
		Object.entries(where).every(([key, value]) => value === undefined || row[key] === value);
	const store = {
		data,
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
		async insert(resource: string, doc: Row) {
			n += 1;
			const row = { ...doc, _id: doc._id ?? `envio-${String(n).padStart(4, '0')}` };
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
	let current = new Date(inicio);
	return {
		now: () => current,
		set(at: Date) {
			current = at;
		},
		advance(ms: number) {
			current = new Date(current.getTime() + ms);
		},
	};
}

const ALFABETO = /^IMP[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{17}$/;

describe('llave_ref', () => {
	test('mide 20, empieza con IMP, es determinista y usa Crockford', () => {
		const uuid = 'f8000000-0000-0000-0000-000000000000';
		const llave = llave_ref(uuid);
		expect(llave).toHaveLength(20);
		expect(llave.startsWith('IMP')).toBe(true);
		expect(llave).toBe('IMPZ0000000000000000');
		expect(llave_ref(uuid)).toBe(llave);
		expect(llave_ref(uuid.toUpperCase())).toBe(llave);
		expect(llave_ref('00000000-0000-0000-0000-000000000000')).toBe('IMP00000000000000000');
		expect(llave_ref('ffffffff-ffff-ffff-ffff-ffffffffffff')).toBe('IMPZZZZZZZZZZZZZZZZZ');
		expect(llave.slice(3)).not.toMatch(/[ILOU]/);
		expect(llave_ref(crypto.randomUUID())).toMatch(ALFABETO);
	});
});

describe('cola comercial-envio', () => {
	test('pendiente pasa a enviando y luego a enviado', async () => {
		const store = memory_store();
		const clock = reloj('2026-10-10T15:00:00.000Z');
		const { row, created } = await enqueue_envio(
			store,
			{ origen: 'pedido', origen_id: 'ped-1', sub_index: 0, payload: { cliente: 'Ana' } },
			clock.now,
		);
		expect(created).toBe(true);
		expect(row.estado).toBe(ESTADO_PENDIENTE);
		expect(row.intentos).toBe(0);

		const [tomado] = await claim_envios(store, { worker_id: 'w1', max: 1 }, clock.now);
		expect(tomado?.estado).toBe(ESTADO_ENVIANDO);
		expect(tomado?.intentos).toBe(1);
		expect(tomado?.lease_worker).toBe('w1');
		expect(tomado?.llave_ref).toBe(row.llave_ref);
		expect(tomado?.payload).toEqual(row.payload);
		expect(Date.parse(String(tomado?.lease_hasta))).toBe(clock.now().getTime() + LEASE_MS);

		const enviado = await report_envio(
			store,
			String(tomado?._id),
			{
				worker_id: 'w1',
				resultado: 'enviado',
				folio: '100',
				serie: 'A',
				id_doc: '55',
				existente: false,
			},
			clock.now,
		);
		expect(enviado.estado).toBe(ESTADO_ENVIADO);
		expect(enviado.cm_folio).toBe('100');
		expect(enviado.cm_serie).toBe('A');
		expect(enviado.cm_id_doc).toBe('55');
		expect(enviado.cm_existente).toBe(false);
		expect(enviado.enviado_fecha).toBe('2026-10-10T15:00:00.000Z');
		expect(enviado.lease_worker).toBeNull();
		expect(enviado.lease_hasta).toBeNull();
	});

	test('el error reintentable espera 1, 5, 15 y luego 60 minutos', async () => {
		const store = memory_store();
		const clock = reloj('2026-10-10T15:00:00.000Z');
		const { row } = await enqueue_envio(
			store,
			{ origen: 'pedido', origen_id: 'ped-2', sub_index: 0, payload: { cliente: 'Ana' } },
			clock.now,
		);
		const minutos = [1, 5, 15, 60, 60];
		for (let i = 0; i < minutos.length; i++) {
			const [tomado] = await claim_envios(store, { worker_id: 'w1', max: 1 }, clock.now);
			expect(tomado?.intentos).toBe(i + 1);
			const antes = clock.now().getTime();
			const reported = await report_envio(
				store,
				String(row._id),
				{ worker_id: 'w1', resultado: 'error', reintentable: true, mensaje: 'empresa abierta' },
				clock.now,
			);
			expect(reported.estado).toBe(ESTADO_REINTENTO);
			expect(reported.error_reintentable).toBe(true);
			expect(Date.parse(String(reported.proximo_intento)) - antes).toBe(minutos[i]! * 60 * 1000);
			expect(reported.lease_worker).toBeNull();

			const temprano = await claim_envios(store, { worker_id: 'w1', max: 1 }, clock.now);
			expect(temprano).toHaveLength(0);
			clock.set(new Date(Date.parse(String(reported.proximo_intento)) - 1));
			expect(await claim_envios(store, { worker_id: 'w1', max: 1 }, clock.now)).toHaveLength(0);
			clock.set(new Date(String(reported.proximo_intento)));
		}
		const [otra] = await claim_envios(store, { worker_id: 'w1', max: 1 }, clock.now);
		expect(otra?.estado).toBe(ESTADO_ENVIANDO);
	});

	test('un error no reintentable queda en error', async () => {
		const store = memory_store();
		const clock = reloj('2026-10-10T15:00:00.000Z');
		const { row } = await enqueue_envio(
			store,
			{ origen: 'invoice_request', origen_id: 'sol-1', sub_index: 0, payload: { cliente: 'Ana' } },
			clock.now,
		);
		await claim_envios(store, { worker_id: 'w1', max: 1 }, clock.now);
		const reported = await report_envio(
			store,
			String(row._id),
			{ worker_id: 'w1', resultado: 'error', reintentable: false, mensaje: 'cliente inexistente' },
			clock.now,
		);
		expect(reported.estado).toBe(ESTADO_ERROR);
		expect(reported.error_reintentable).toBe(false);
		expect(reported.ultimo_error).toBe('cliente inexistente');
		expect(reported.proximo_intento).toBeNull();
		expect(await claim_envios(store, { worker_id: 'w2', max: 1 }, clock.now)).toHaveLength(0);
	});

	test('el décimo intento fallido queda en error', async () => {
		const store = memory_store();
		const clock = reloj('2026-10-10T15:00:00.000Z');
		const { row } = await enqueue_envio(
			store,
			{ origen: 'pedido', origen_id: 'ped-10', sub_index: 0, payload: { cliente: 'Ana' } },
			clock.now,
		);
		for (let i = 0; i < 9; i++) {
			await claim_envios(store, { worker_id: 'w1', max: 1 }, clock.now);
			const reported = await report_envio(
				store,
				String(row._id),
				{ worker_id: 'w1', resultado: 'error', reintentable: true, mensaje: 'timeout' },
				clock.now,
			);
			expect(reported.estado).toBe(ESTADO_REINTENTO);
			clock.set(new Date(String(reported.proximo_intento)));
		}
		await claim_envios(store, { worker_id: 'w1', max: 1 }, clock.now);
		const ultimo = await report_envio(
			store,
			String(row._id),
			{ worker_id: 'w1', resultado: 'error', reintentable: true, mensaje: 'timeout' },
			clock.now,
		);
		expect(ultimo.intentos).toBe(10);
		expect(ultimo.estado).toBe(ESTADO_ERROR);
		expect(ultimo.proximo_intento).toBeNull();
		expect(await claim_envios(store, { worker_id: 'w1', max: 1 }, clock.now)).toHaveLength(0);
	});

	test('el lease dura 5 minutos; el trabajador anterior ya no puede reportar el error', async () => {
		const store = memory_store();
		const clock = reloj('2026-10-10T15:00:00.000Z');
		const { row } = await enqueue_envio(
			store,
			{ origen: 'pedido', origen_id: 'ped-lease', sub_index: 0, payload: { cliente: 'Ana' } },
			clock.now,
		);
		const [primero] = await claim_envios(store, { worker_id: 'w1', max: 1 }, clock.now);
		expect(primero?.intentos).toBe(1);

		clock.advance(LEASE_MS);
		expect(await claim_envios(store, { worker_id: 'w2', max: 1 }, clock.now)).toHaveLength(0);

		clock.advance(1);
		const [robado] = await claim_envios(store, { worker_id: 'w2', max: 1 }, clock.now);
		expect(robado?.lease_worker).toBe('w2');
		expect(robado?.intentos).toBe(2);
		expect(robado?.estado).toBe(ESTADO_ENVIANDO);

		await expect(
			report_envio(
				store,
				String(row._id),
				{ worker_id: 'w1', resultado: 'error', reintentable: true, mensaje: 'tarde' },
				clock.now,
			),
		).rejects.toBeInstanceOf(ComercialEnvioError);

		const enviado = await report_envio(
			store,
			String(row._id),
			{ worker_id: 'w1', resultado: 'enviado', folio: '8', serie: 'B', id_doc: 'doc-1', existente: true },
			clock.now,
		);
		expect(enviado.estado).toBe(ESTADO_ENVIADO);
		expect(enviado.cm_id_doc).toBe('doc-1');
		expect(enviado.cm_existente).toBe(true);
		expect(enviado.cm_folio).toBe('8');
		expect(enviado.lease_worker).toBeNull();
	});

	test('repetir enviado con el mismo id_doc no cambia la fila; otro id_doc choca', async () => {
		const store = memory_store();
		const clock = reloj('2026-10-10T15:00:00.000Z');
		const { row } = await enqueue_envio(
			store,
			{ origen: 'pedido', origen_id: 'ped-dup', sub_index: 0, payload: { cliente: 'Ana' } },
			clock.now,
		);
		await claim_envios(store, { worker_id: 'w1', max: 1 }, clock.now);
		const enviado = await report_envio(
			store,
			String(row._id),
			{ worker_id: 'w1', resultado: 'enviado', folio: '1', serie: 'A', id_doc: 'doc-1' },
			clock.now,
		);
		clock.advance(60_000);
		const repetido = await report_envio(
			store,
			String(row._id),
			{ worker_id: 'w9', resultado: 'enviado', folio: '99', serie: 'Z', id_doc: 'doc-1' },
			clock.now,
		);
		expect(repetido).toBe(enviado);
		expect(repetido.cm_folio).toBe('1');
		expect(repetido.enviado_fecha).toBe('2026-10-10T15:00:00.000Z');

		await expect(
			report_envio(
				store,
				String(row._id),
				{ worker_id: 'w9', resultado: 'enviado', folio: '2', serie: 'A', id_doc: 'doc-2' },
				clock.now,
			),
		).rejects.toMatchObject({ status: 409 });
	});

	test('encolar el mismo origen no duplica; otro subíndice sí', async () => {
		const store = memory_store();
		const clock = reloj('2026-10-10T15:00:00.000Z');
		const payload = { cliente: 'Ana', lineas: [{ sku: 'A', cant: 1 }] };
		const primero = await enqueue_envio(
			store,
			{ origen: 'pedido', origen_id: 'ped-3', sub_index: 0, payload },
			clock.now,
		);
		payload.cliente = 'Beto';
		payload.lineas[0]!.cant = 9;
		const repetido = await enqueue_envio(
			store,
			{ origen: 'pedido', origen_id: 'ped-3', sub_index: 0, payload: { cliente: 'Otro' } },
			clock.now,
		);
		expect(repetido.created).toBe(false);
		expect(repetido.row.envio_uuid).toBe(primero.row.envio_uuid);
		expect(repetido.row.llave_ref).toBe(primero.row.llave_ref);
		expect(repetido.row).toBe(primero.row);
		expect((primero.row.payload as { cliente: string }).cliente).toBe('Ana');
		expect((primero.row.payload as { lineas: Array<{ cant: number }> }).lineas[0]?.cant).toBe(1);

		clock.advance(1000);
		const otro = await enqueue_envio(
			store,
			{ origen: 'pedido', origen_id: 'ped-3', sub_index: 1, payload: { cliente: 'Ana' } },
			clock.now,
		);
		expect(otro.created).toBe(true);
		expect(otro.row.envio_uuid).not.toBe(primero.row.envio_uuid);
		const [viejo] = await claim_envios(store, { worker_id: 'w1', max: 1 }, clock.now);
		expect(viejo?.envio_uuid).toBe(primero.row.envio_uuid);
	});

	test('reintentar desde error vuelve a pendiente con la misma llave', async () => {
		const store = memory_store();
		const clock = reloj('2026-10-10T15:00:00.000Z');
		const { row } = await enqueue_envio(
			store,
			{ origen: 'pedido', origen_id: 'ped-retry', sub_index: 0, payload: { cliente: 'Ana' } },
			clock.now,
		);
		await claim_envios(store, { worker_id: 'w1', max: 1 }, clock.now);
		await report_envio(
			store,
			String(row._id),
			{ worker_id: 'w1', resultado: 'error', reintentable: false, mensaje: 'concepto inválido' },
			clock.now,
		);
		const retried = await retry_envio(store, String(row._id), clock.now);
		expect(retried.estado).toBe(ESTADO_PENDIENTE);
		expect(retried.intentos).toBe(0);
		expect(retried.proximo_intento).toBeNull();
		expect(retried.envio_uuid).toBe(row.envio_uuid);
		expect(retried.llave_ref).toBe(row.llave_ref);

		const [tomado] = await claim_envios(store, { worker_id: 'w1', max: 1 }, clock.now);
		expect(tomado?.intentos).toBe(1);
		await report_envio(
			store,
			String(row._id),
			{ worker_id: 'w1', resultado: 'error', reintentable: true, mensaje: 'sin red' },
			clock.now,
		);
		const desde_reintento = await retry_envio(store, String(row.envio_uuid), clock.now);
		expect(desde_reintento.estado).toBe(ESTADO_PENDIENTE);
		expect(desde_reintento.llave_ref).toBe(row.llave_ref);

		await claim_envios(store, { worker_id: 'w1', max: 1 }, clock.now);
		await report_envio(
			store,
			String(row._id),
			{ worker_id: 'w1', resultado: 'enviado', id_doc: '1', folio: '1', serie: 'A' },
			clock.now,
		);
		await expect(retry_envio(store, String(row._id), clock.now)).rejects.toMatchObject({ status: 409 });
	});

	test('documento_comercial usa el default si no viene y guarda el override', async () => {
		const store = memory_store();
		const clock = reloj('2026-10-10T15:00:00.000Z');
		const sin = await enqueue_envio(
			store,
			{ origen: 'invoice_request', origen_id: 'sol-2', sub_index: 0, payload: { cliente: 'Ana' } },
			clock.now,
		);
		expect(sin.row.payload).toMatchObject({
			cliente: 'Ana',
			documento_comercial: DOCUMENTO_COMERCIAL_DEFAULT,
		});
		expect(DOCUMENTO_COMERCIAL_DEFAULT.concepto).toBe(COMERCIAL_CONCEPTO_PENDIENTE);
		expect(Object.isFrozen(sin.row.payload)).toBe(true);

		const con = await enqueue_envio(
			store,
			{
				origen: 'invoice_request',
				origen_id: 'sol-2',
				sub_index: 1,
				payload: { cliente: 'Ana' },
				documento_comercial: { tipo_documento: 'pedido', concepto: 'FAC', serie: 'A' },
			},
			clock.now,
		);
		expect(con.row.payload).toMatchObject({
			documento_comercial: { tipo_documento: 'pedido', concepto: 'FAC', serie: 'A' },
		});
		const lista = await envios_by_origen(store, 'invoice_request', 'sol-2');
		expect(lista).toHaveLength(2);
		expect(lista.map((row) => row.sub_index)).toEqual([0, 1]);
	});

	test('un lease vencido con 10 intentos pasa a error y no se toma', async () => {
		const store = memory_store();
		const clock = reloj('2026-10-10T15:00:00.000Z');
		const { row } = await enqueue_envio(
			store,
			{ origen: 'pedido', origen_id: 'ped-agotado', sub_index: 0, payload: { cliente: 'Ana' } },
			clock.now,
		);
		for (let i = 0; i < 10; i++) {
			if (i > 0) clock.advance(LEASE_MS + 1);
			const tomados = await claim_envios(store, { worker_id: `w${i}`, max: 1 }, clock.now);
			expect(tomados).toHaveLength(1);
		}
		clock.advance(LEASE_MS + 1);
		expect(await claim_envios(store, { worker_id: 'w-nuevo', max: 1 }, clock.now)).toHaveLength(0);
		const [guardado] = await envios_by_origen(store, 'pedido', 'ped-agotado');
		expect(guardado?.estado).toBe(ESTADO_ERROR);
		expect(guardado?.ultimo_error).toBe('lease vencido tras 10 intentos');
		expect(guardado?.error_reintentable).toBe(false);
		expect(guardado?.envio_uuid).toBe(row.envio_uuid);
	});
});
