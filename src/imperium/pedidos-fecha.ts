import { FieldValidationError } from './required-fields.ts';

/**
 * Ningún pedido se guarda sin `fecha` (Odoo #267). Antes de 13.121.3 el núcleo
 * no la escribía al crear (ni en el alta normal ni en el sync offline); la
 * lista la rellenaba con la fecha de alta al leer, pero el filtro Fecha busca
 * en la columna y no los encontraba. Esto corre en `store.insert` y
 * `store.update`, así que cubre todos los caminos de escritura: alta,
 * edición, `/pedidos/offline/sincronizar`, `/sync/v1/mutaciones` y semillas.
 */
export function is_pedido_resource(resource: string): boolean {
	return resource === 'pedidos' || resource === 'pedidos-surtir';
}

function blank(value: unknown): boolean {
	return value == null || (typeof value === 'string' && !value.trim());
}

function valid_iso(value: unknown): string | null {
	if (blank(value)) return null;
	if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
	if (typeof value !== 'string' && typeof value !== 'number') return null;
	const time = new Date(value).getTime();
	return Number.isNaN(time) ? null : typeof value === 'string' ? value.trim() : new Date(time).toISOString();
}

/**
 * Deja `doc.fecha` con una fecha válida. Si viene vacía usa, en orden: la fecha
 * ya guardada, la fecha de alta (`createdAt` / `created_at`) y ahora. Si viene
 * con algo que no es fecha, la rechaza con 400.
 */
export function ensure_pedido_fecha(
	doc: Record<string, unknown>,
	previous?: Record<string, unknown> | null,
	now: Date = new Date(),
): void {
	if (!blank(doc.fecha)) {
		const fecha = valid_iso(doc.fecha);
		if (!fecha) {
			const message = 'La fecha del pedido no es válida';
			throw new FieldValidationError({ fecha: [message] }, `Pedidos validation failed: fecha: ${message}`);
		}
		doc.fecha = fecha;
		return;
	}
	doc.fecha =
		valid_iso(previous?.fecha) ??
		valid_iso(previous?.createdAt) ??
		valid_iso(previous?.created_at) ??
		valid_iso(doc.createdAt) ??
		valid_iso(doc.created_at) ??
		now.toISOString();
}
