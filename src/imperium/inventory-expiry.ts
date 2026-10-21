/**
 * Existencias por ubicación con caducidad vencida o dentro de los próximos
 * días: qué lote, dónde y cuánto queda.
 */
import type { ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';

const DAY = 86_400_000;
export const DEFAULT_EXPIRY_DAYS = 30;

export type ExpiryRow = {
	_id: string;
	producto_id: string;
	producto_codigo: string;
	producto_nombre: string;
	ubicacion_codigo: string;
	lote_codigo: string;
	fecha_caducidad: string;
	cantidad: number;
	dias_restantes: number;
	estado: 'vencido' | 'por_vencer';
};

function text(value: unknown): string {
	return String(value ?? '').trim();
}

function ref_id(value: unknown): string {
	if (value && typeof value === 'object') return text((value as { _id?: unknown })._id);
	return text(value);
}

function day_start(raw: unknown): number | null {
	const value = text(raw);
	if (!value) return null;
	const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00` : value);
	if (Number.isNaN(d.getTime())) return null;
	d.setHours(0, 0, 0, 0);
	return d.getTime();
}

export function parse_expiry_days(raw: unknown): number {
	if (raw == null || raw === '') return DEFAULT_EXPIRY_DAYS;
	const n = Number(raw);
	if (!Number.isInteger(n) || n < 0 || n > 3650) throw new Error('Los días deben ser un entero entre 0 y 3650');
	return n;
}

export function build_expiry_report(quants: ImperiumDoc[], dias: number, hoy: Date = new Date()) {
	const today = day_start(hoy.toISOString())!;
	const rows: ExpiryRow[] = [];
	for (const q of quants) {
		if (q.is_active === false) continue;
		const cantidad = Number(q.cantidad ?? 0) || 0;
		if (cantidad <= 0) continue;
		const expiry = day_start(q.fecha_caducidad);
		if (expiry == null) continue;
		const dias_restantes = Math.round((expiry - today) / DAY);
		if (dias_restantes > dias) continue;
		rows.push({
			_id: text(q._id),
			producto_id: ref_id(q.producto) || text(q.producto_id),
			producto_codigo: text(q.producto_codigo),
			producto_nombre: text(q.producto_nombre),
			ubicacion_codigo: text(q.ubicacion_codigo),
			lote_codigo: text(q.lote_codigo),
			fecha_caducidad: text(q.fecha_caducidad).slice(0, 10),
			cantidad: Number(cantidad.toFixed(4)),
			dias_restantes,
			estado: dias_restantes < 0 ? 'vencido' : 'por_vencer',
		});
	}
	rows.sort((a, b) => a.dias_restantes - b.dias_restantes || a.producto_nombre.localeCompare(b.producto_nombre));
	return {
		dias,
		vencidos: rows.filter((r) => r.estado === 'vencido').length,
		por_vencer: rows.filter((r) => r.estado === 'por_vencer').length,
		existencias: rows,
	};
}

export async function expiring_stock(store: ImperiumStore, raw_days: unknown) {
	const dias = parse_expiry_days(raw_days);
	const quants: ImperiumDoc[] = [];
	if (store.has('inventory-stock-quant')) {
		for await (const page of store.scan('inventory-stock-quant', {})) quants.push(...page);
	}
	return build_expiry_report(quants, dias);
}
