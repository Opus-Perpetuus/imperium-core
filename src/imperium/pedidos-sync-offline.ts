/**
 * Dedupe del sync offline de pedidos (`POST /pedidos/offline/sincronizar`).
 *
 * El `offline_uuid` identifica al pedido; el folio del teléfono no. Dos
 * teléfonos o navegadores del mismo vendedor pueden numerar igual el mismo
 * día, así que un folio repetido solo es el mismo pedido si además coinciden
 * el vendedor y la huella (cliente y artículos). Si no coinciden es otro
 * pedido y se crea con el folio local desambiguado (Odoo #272).
 */
export type CoincidenciaFolio = 'ninguna' | 'mismo_pedido' | 'otro_pedido';

export type DecisionSyncOffline =
	| { decision: 'crear'; folio_offline: string | undefined }
	| { decision: 'duplicado'; motivo: 'uuid' | 'folio' };

export function decidir_sync_offline(input: {
	ya_existe_uuid: boolean;
	folio: string;
	offline_uuid: string;
	coincidencia_folio: CoincidenciaFolio;
}): DecisionSyncOffline {
	if (input.ya_existe_uuid) return { decision: 'duplicado', motivo: 'uuid' };
	const folio = input.folio.trim();
	if (!folio) return { decision: 'crear', folio_offline: undefined };
	if (input.coincidencia_folio === 'mismo_pedido') return { decision: 'duplicado', motivo: 'folio' };
	if (input.coincidencia_folio === 'otro_pedido') {
		return { decision: 'crear', folio_offline: folio_offline_desambiguado(folio, input.offline_uuid) };
	}
	return { decision: 'crear', folio_offline: folio };
}

/** `folio_offline` es único en BD; el uuid del pedido distingue al segundo teléfono. */
export function folio_offline_desambiguado(folio: string, offline_uuid: string): string {
	return `${folio.trim()}#${offline_uuid.trim()}`;
}

function ref(value: unknown): string {
	if (value && typeof value === 'object') {
		const obj = value as Record<string, unknown>;
		return String(obj._id ?? obj.id ?? '').trim();
	}
	return String(value ?? '').trim();
}

/** Cliente y artículos (producto/sku y cantidad), sin orden. */
export function huella_pedido_offline(pedido: Record<string, unknown>): string {
	const articulos = Array.isArray(pedido.articulos) ? pedido.articulos : [];
	const lineas = articulos
		.map((raw) => {
			const a = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
			const item = ref(a.sku) || ref(a.product) || ref(a.producto) || ref(a.productId) || ref(a.codigo);
			const cantidad = Number(a.cantidad ?? a.quantity ?? 0);
			return `${item}:${Number.isFinite(cantidad) ? cantidad : 0}`;
		})
		.sort();
	return JSON.stringify([ref(pedido.contacto), lineas]);
}

/** ¿El pedido ya guardado con ese folio es el mismo que llega? */
export function es_mismo_pedido_offline(
	existente: Record<string, unknown>,
	usuario: string,
	huella: string,
): boolean {
	if (ref(existente.usuario) !== usuario) return false;
	const guardada = typeof existente.huella_offline === 'string' ? existente.huella_offline : '';
	return (guardada || huella_pedido_offline(existente)) === huella;
}
