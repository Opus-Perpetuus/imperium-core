/**
 * Cola comercial-envio: encolar, claim con lease, reporte y reintento.
 */
import type { ImperiumDoc } from './envelope.ts';
import { cfg_bool } from './interinstance.ts';
import type { ImperiumStore } from './store.ts';

export const COMERCIAL_ENVIO_RESOURCE = 'comercial-envio';

export const ESTADO_PENDIENTE = 'pendiente';
export const ESTADO_ENVIANDO = 'enviando';
export const ESTADO_ENVIADO = 'enviado';
export const ESTADO_REINTENTO = 'reintento';
export const ESTADO_ERROR = 'error';

export const ESTADOS_COMERCIAL_ENVIO = [
	ESTADO_PENDIENTE,
	ESTADO_ENVIANDO,
	ESTADO_ENVIADO,
	ESTADO_REINTENTO,
	ESTADO_ERROR,
] as const;

export type EstadoComercialEnvio = (typeof ESTADOS_COMERCIAL_ENVIO)[number];
export type OrigenComercialEnvio = 'pedido' | 'invoice_request';

export const LEASE_MS = 5 * 60 * 1000;
export const MAX_INTENTOS = 10;

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export class ComercialEnvioError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = 'ComercialEnvioError';
		this.status = status;
	}
}

export const COMERCIAL_CONCEPTO_PENDIENTE = 'PENDIENTE: leer en el laboratorio';
export const CONFIG_COMERCIAL_PEDIDO_CONCEPTO = 'configuration-comercial-pedido-concepto';
export const CONFIG_COMERCIAL_PEDIDO_SERIE = 'configuration-comercial-pedido-serie';
export const CONFIG_COMERCIAL_COLA_ACTIVA = 'configuration-comercial-cola-activa';

export type DocumentoComercial = {
	tipo_documento: string;
	concepto: string;
	serie: string;
};

export const DOCUMENTO_COMERCIAL_DEFAULT: DocumentoComercial = {
	tipo_documento: 'pedido',
	concepto: COMERCIAL_CONCEPTO_PENDIENTE,
	serie: COMERCIAL_CONCEPTO_PENDIENTE,
};

export type EnqueueEnvioInput = {
	origen: OrigenComercialEnvio;
	origen_id: string;
	sub_index?: number;
	payload: Record<string, unknown>;
	documento_comercial?: Partial<DocumentoComercial> | null;
};

export type ReportEnvioInput = {
	worker_id: string;
	resultado: 'enviado' | 'error';
	reintentable?: boolean;
	folio?: string | null;
	serie?: string | null;
	id_doc?: string | number | null;
	existente?: boolean;
	mensaje?: string | null;
};

export function backoff_ms(intentos: number): number {
	const n = Math.floor(Number(intentos));
	const minutes = n <= 1 ? 1 : n === 2 ? 5 : n === 3 ? 15 : 60;
	return minutes * 60 * 1000;
}

export function llave_ref(envio_uuid: string): string {
	const hex = envio_uuid.replace(/-/g, '').toLowerCase();
	if (!/^[0-9a-f]{32}$/.test(hex)) {
		throw new ComercialEnvioError(400, 'El identificador del envío no es un UUID válido.');
	}
	let bits = BigInt(`0x${hex.slice(0, 22)}`) >> 3n;
	const chars: string[] = [];
	for (let i = 0; i < 17; i++) {
		chars.push(CROCKFORD[Number(bits & 31n)] ?? '0');
		bits >>= 5n;
	}
	chars.reverse();
	return `IMP${chars.join('')}`;
}

function at_of(now: () => Date): Date {
	const at = now();
	if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
		throw new ComercialEnvioError(400, 'La fecha del envío no es válida.');
	}
	return at;
}

function worker_id_of(value: unknown): string {
	const id = String(value ?? '').trim();
	if (!id) throw new ComercialEnvioError(400, 'Debes indicar el trabajador.');
	return id;
}

function sub_index_of(value: unknown): number {
	if (value == null || value === '') return 0;
	const n = Number(value);
	if (!Number.isInteger(n) || n < 0) {
		throw new ComercialEnvioError(400, 'El subíndice del envío no es válido.');
	}
	return n;
}

function origen_of(value: unknown): OrigenComercialEnvio {
	if (value === 'pedido' || value === 'invoice_request') return value;
	throw new ComercialEnvioError(400, 'El origen del envío no es válido.');
}

function text_or_null(value: unknown): string | null {
	if (value == null) return null;
	const text = String(value).trim();
	return text ? text : null;
}

function deep_freeze<T>(value: T): T {
	if (value == null || typeof value !== 'object' || Object.isFrozen(value)) return value;
	for (const item of Object.values(value as Record<string, unknown>)) deep_freeze(item);
	return Object.freeze(value);
}

function text_or_default(value: unknown, fallback: string): string {
	const text = String(value ?? '').trim();
	return text || fallback;
}

function config_text_value(value: unknown): string {
	let current = value;
	if (typeof current === 'string') {
		const trimmed = current.trim();
		if (!trimmed) return '';
		try {
			current = JSON.parse(trimmed);
		} catch {
			current = trimmed.replace(/^"+|"+$/g, '');
		}
	}
	return String(current ?? '').trim();
}

async function config_row(store: ImperiumStore, ref: string): Promise<ImperiumDoc | null> {
	if (!store.has('configuration')) return null;
	return (
		(await store.find_where('configuration', { _ref: ref })) ??
		(await store.find_where('configuration', { ref }))
	);
}

async function config_text(store: ImperiumStore, ref: string): Promise<string> {
	return config_text_value((await config_row(store, ref))?.value);
}

export async function comercial_cola_activa(store: ImperiumStore): Promise<boolean> {
	return cfg_bool((await config_row(store, CONFIG_COMERCIAL_COLA_ACTIVA))?.value, false);
}

export async function documento_comercial_pedido(
	store: ImperiumStore,
	override?: Partial<DocumentoComercial> | null,
): Promise<DocumentoComercial> {
	const concepto = await config_text(store, CONFIG_COMERCIAL_PEDIDO_CONCEPTO);
	const serie = await config_text(store, CONFIG_COMERCIAL_PEDIDO_SERIE);
	return {
		tipo_documento: text_or_default(
			override?.tipo_documento,
			DOCUMENTO_COMERCIAL_DEFAULT.tipo_documento,
		),
		concepto: text_or_default(
			override?.concepto,
			concepto || DOCUMENTO_COMERCIAL_DEFAULT.concepto,
		),
		serie: text_or_default(override?.serie, serie || DOCUMENTO_COMERCIAL_DEFAULT.serie),
	};
}

function documento_de(value: Partial<DocumentoComercial> | null | undefined): DocumentoComercial {
	if (value == null) return { ...DOCUMENTO_COMERCIAL_DEFAULT };
	return {
		tipo_documento: text_or_default(value.tipo_documento, DOCUMENTO_COMERCIAL_DEFAULT.tipo_documento),
		concepto: text_or_default(value.concepto, DOCUMENTO_COMERCIAL_DEFAULT.concepto),
		serie: text_or_default(value.serie, DOCUMENTO_COMERCIAL_DEFAULT.serie),
	};
}

function snapshot_de(
	payload: Record<string, unknown>,
	documento: DocumentoComercial,
): Record<string, unknown> {
	if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
		throw new ComercialEnvioError(400, 'El envío no trae un payload.');
	}
	const copy = structuredClone(payload);
	copy.documento_comercial = structuredClone(documento);
	return deep_freeze(copy);
}

function activo(row: ImperiumDoc): boolean {
	return row.is_active !== false;
}

function mismo_origen(row: ImperiumDoc, origen: string, origen_id: string, sub_index: number): boolean {
	return (
		activo(row) &&
		row.origen === origen &&
		String(row.origen_id ?? '') === origen_id &&
		Number(row.sub_index) === sub_index
	);
}

async function filas(store: ImperiumStore, where?: Record<string, unknown>): Promise<ImperiumDoc[]> {
	const { rows } = await store.find_many(COMERCIAL_ENVIO_RESOURCE, {
		where,
		include_inactive: true,
		take: 5000,
		sort: 'created_at:asc',
	});
	return rows;
}

function por_antiguedad(rows: ImperiumDoc[]): ImperiumDoc[] {
	return [...rows].sort((a, b) => {
		const stamp = String(a.created_at ?? a.createdAt ?? '').localeCompare(
			String(b.created_at ?? b.createdAt ?? ''),
		);
		if (stamp) return stamp;
		return String(a._id ?? '').localeCompare(String(b._id ?? ''));
	});
}

async function cargar(store: ImperiumStore, id: string): Promise<ImperiumDoc> {
	const key = String(id ?? '').trim();
	if (!key) throw new ComercialEnvioError(400, 'Debes indicar el envío.');
	const by_id = await store.find_id(COMERCIAL_ENVIO_RESOURCE, key);
	if (by_id) return by_id;
	const rows = await filas(store, { envio_uuid: key });
	const found = rows.find((row) => String(row.envio_uuid ?? '') === key);
	if (!found) throw new ComercialEnvioError(404, 'No se encontró el envío a comercial.');
	return found;
}

async function guardar(store: ImperiumStore, id: string, patch: ImperiumDoc): Promise<ImperiumDoc> {
	const saved = await store.update(COMERCIAL_ENVIO_RESOURCE, id, patch);
	if (!saved) throw new ComercialEnvioError(404, 'No se encontró el envío a comercial.');
	return saved;
}

export async function enqueue_envio(
	store: ImperiumStore,
	input: EnqueueEnvioInput,
	now: () => Date = () => new Date(),
): Promise<{ row: ImperiumDoc; created: boolean }> {
	const origen = origen_of(input.origen);
	const origen_id = String(input.origen_id ?? '').trim();
	if (!origen_id) throw new ComercialEnvioError(400, 'Debes indicar el documento de origen.');
	const sub_index = sub_index_of(input.sub_index);
	const at = at_of(now);
	const existentes = await filas(store, { origen, origen_id, sub_index });
	const previo = por_antiguedad(existentes).find((row) => mismo_origen(row, origen, origen_id, sub_index));
	if (previo) return { row: previo, created: false };

	const envio_uuid = crypto.randomUUID();
	const row = await store.insert(COMERCIAL_ENVIO_RESOURCE, {
		envio_uuid,
		llave_ref: llave_ref(envio_uuid),
		origen,
		origen_id,
		sub_index,
		payload: snapshot_de(input.payload, documento_de(input.documento_comercial)),
		estado: ESTADO_PENDIENTE,
		intentos: 0,
		proximo_intento: null,
		lease_worker: null,
		lease_hasta: null,
		ultimo_error: null,
		error_reintentable: null,
		cm_folio: null,
		cm_serie: null,
		cm_id_doc: null,
		cm_existente: null,
		enviado_fecha: null,
		is_active: true,
		created_at: at.toISOString(),
	});
	return { row, created: true };
}

function claimable(row: ImperiumDoc, at: Date): 'listo' | 'vencido' | null {
	if (!activo(row)) return null;
	const estado = String(row.estado ?? '');
	if (estado === ESTADO_PENDIENTE) return 'listo';
	if (estado === ESTADO_REINTENTO) {
		const when = Date.parse(String(row.proximo_intento ?? ''));
		return Number.isFinite(when) && when <= at.getTime() ? 'listo' : null;
	}
	if (estado === ESTADO_ENVIANDO) {
		const until = Date.parse(String(row.lease_hasta ?? ''));
		return Number.isFinite(until) && until < at.getTime() ? 'vencido' : null;
	}
	return null;
}

export async function claim_envios(
	store: ImperiumStore,
	input: { worker_id: string; max: number },
	now: () => Date = () => new Date(),
): Promise<ImperiumDoc[]> {
	const worker_id = worker_id_of(input.worker_id);
	const max = Math.floor(Number(input.max));
	if (!Number.isFinite(max) || max < 1) {
		throw new ComercialEnvioError(400, 'Debes indicar cuántos envíos tomar.');
	}
	const at = at_of(now);
	const hasta = new Date(at.getTime() + LEASE_MS).toISOString();
	const candidatos = por_antiguedad(await filas(store)).filter((row) => claimable(row, at));
	const tomados: ImperiumDoc[] = [];
	for (const row of candidatos) {
		const id = String(row._id ?? '');
		if (!id) continue;
		const modo = claimable(row, at);
		const intentos = Number(row.intentos ?? 0);
		if (modo === 'vencido' && intentos >= MAX_INTENTOS) {
			await guardar(store, id, {
				estado: ESTADO_ERROR,
				ultimo_error: `lease vencido tras ${intentos} intentos`,
				error_reintentable: false,
				lease_worker: null,
				lease_hasta: null,
			});
			continue;
		}
		if (tomados.length >= max) continue;
		tomados.push(
			await guardar(store, id, {
				estado: ESTADO_ENVIANDO,
				lease_worker: worker_id,
				lease_hasta: hasta,
				intentos: intentos + 1,
			}),
		);
	}
	return tomados;
}

function mismo_documento(row: ImperiumDoc, id_doc: string | null): boolean {
	return text_or_null(row.cm_id_doc) === id_doc;
}

async function publicar(
	row: ImperiumDoc,
	on_change?: (row: ImperiumDoc) => Promise<void>,
): Promise<ImperiumDoc> {
	if (on_change) await on_change(row);
	return row;
}

export async function report_envio(
	store: ImperiumStore,
	id: string,
	input: ReportEnvioInput,
	now: () => Date = () => new Date(),
	on_change?: (row: ImperiumDoc) => Promise<void>,
): Promise<ImperiumDoc> {
	const worker_id = worker_id_of(input.worker_id);
	const at = at_of(now);
	const row = await cargar(store, id);
	const row_id = String(row._id ?? '');
	if (input.resultado === 'enviado') {
		const id_doc = text_or_null(input.id_doc);
		if (row.estado === ESTADO_ENVIADO) {
			if (mismo_documento(row, id_doc)) return publicar(row, on_change);
			throw new ComercialEnvioError(
				409,
				'El envío ya fue registrado en Comercial con otro documento.',
			);
		}
		return publicar(await guardar(store, row_id, {
			estado: ESTADO_ENVIADO,
			cm_folio: text_or_null(input.folio),
			cm_serie: text_or_null(input.serie),
			cm_id_doc: id_doc,
			cm_existente: input.existente === true,
			enviado_fecha: at.toISOString(),
			lease_worker: null,
			lease_hasta: null,
			ultimo_error: null,
			error_reintentable: null,
			proximo_intento: null,
		}), on_change);
	}
	if (input.resultado !== 'error') {
		throw new ComercialEnvioError(400, 'El resultado del envío no es válido.');
	}
	if (row.estado !== ESTADO_ENVIANDO || String(row.lease_worker ?? '') !== worker_id) {
		throw new ComercialEnvioError(
			409,
			'Este error solo se acepta del trabajador que tiene el envío en curso.',
		);
	}
	const intentos = Number(row.intentos ?? 0);
	const reintentable = input.reintentable === true;
	const sigue = reintentable && intentos < MAX_INTENTOS;
	return publicar(await guardar(store, row_id, {
		estado: sigue ? ESTADO_REINTENTO : ESTADO_ERROR,
		proximo_intento: sigue ? new Date(at.getTime() + backoff_ms(intentos)).toISOString() : null,
		ultimo_error: String(input.mensaje ?? ''),
		error_reintentable: reintentable,
		lease_worker: null,
		lease_hasta: null,
	}), on_change);
}

export async function retry_envio(
	store: ImperiumStore,
	id: string,
	now: () => Date = () => new Date(),
	on_change?: (row: ImperiumDoc) => Promise<void>,
): Promise<ImperiumDoc> {
	at_of(now);
	const row = await cargar(store, id);
	if (row.estado !== ESTADO_ERROR && row.estado !== ESTADO_REINTENTO) {
		throw new ComercialEnvioError(409, 'Solo se puede reintentar un envío en error o reintento.');
	}
	return publicar(await guardar(store, String(row._id), {
		estado: ESTADO_PENDIENTE,
		intentos: 0,
		proximo_intento: null,
		lease_worker: null,
		lease_hasta: null,
	}), on_change);
}

export async function envios_by_origen(
	store: ImperiumStore,
	origen: OrigenComercialEnvio,
	origen_id: string,
): Promise<ImperiumDoc[]> {
	const id = String(origen_id ?? '').trim();
	const rows = await filas(store, { origen, origen_id: id });
	return por_antiguedad(rows).filter(
		(row) => activo(row) && row.origen === origen && String(row.origen_id ?? '') === id,
	);
}
