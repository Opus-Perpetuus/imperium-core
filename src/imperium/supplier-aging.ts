/**
 * Antigüedad de saldos de cuentas por pagar: facturas de proveedor con saldo,
 * agrupadas por proveedor en «por vencer», 1–30, 31–60, 61–90 y más de 90 días
 * vencidas a la fecha de corte.
 */
import type { ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';

const DAY = 86_400_000;
export const AGING_BUCKETS = ['por_vencer', 'd1_30', 'd31_60', 'd61_90', 'mas_90'] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];
type Buckets = Record<AgingBucket, number>;

export type AgingInvoice = {
	_id: string;
	numero_factura: string;
	fecha_factura: string;
	fecha_vencimiento: string;
	total: number;
	saldo: number;
	dias_vencida: number;
	tramo: AgingBucket;
};

export type AgingSupplier = Buckets & {
	proveedor_id: string;
	proveedor_nombre: string;
	saldo: number;
	facturas: AgingInvoice[];
};

function text(value: unknown): string {
	return String(value ?? '').trim();
}

function money(value: number): number {
	return Math.round((value + Number.EPSILON) * 100) / 100;
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

function local_day(t: number): string {
	const d = new Date(t);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function aging_bucket(dias_vencida: number): AgingBucket {
	if (dias_vencida <= 0) return 'por_vencer';
	if (dias_vencida <= 30) return 'd1_30';
	if (dias_vencida <= 60) return 'd31_60';
	if (dias_vencida <= 90) return 'd61_90';
	return 'mas_90';
}

function empty_buckets(): Buckets {
	return { por_vencer: 0, d1_30: 0, d31_60: 0, d61_90: 0, mas_90: 0 };
}

export function build_supplier_aging(invoices: ImperiumDoc[], corte: string | Date = new Date()) {
	const cut = day_start(corte instanceof Date ? corte.toISOString() : corte);
	if (cut == null) throw new Error(`Fecha de corte inválida: ${String(corte)}`);
	const by_supplier = new Map<string, AgingSupplier>();
	const totals = empty_buckets();
	for (const inv of invoices) {
		if (inv.is_active === false || text(inv.estado).toLowerCase() === 'cancelada') continue;
		const total = Number(inv.total ?? 0) || 0;
		const saldo = money(Number(inv.saldo ?? total) || 0);
		if (saldo <= 0.009) continue;
		const due = day_start(inv.fecha_vencimiento) ?? day_start(inv.fecha_factura) ?? cut;
		const dias_vencida = Math.round((cut - due) / DAY);
		const tramo = aging_bucket(dias_vencida);
		const key = ref_id(inv.proveedor) || text(inv.proveedor_nombre) || 'sin-proveedor';
		const row = by_supplier.get(key) ?? {
			proveedor_id: ref_id(inv.proveedor),
			proveedor_nombre: text(inv.proveedor_nombre) || 'Sin proveedor',
			saldo: 0,
			...empty_buckets(),
			facturas: [],
		};
		row[tramo] = money(row[tramo] + saldo);
		row.saldo = money(row.saldo + saldo);
		totals[tramo] = money(totals[tramo] + saldo);
		row.facturas.push({
			_id: text(inv._id),
			numero_factura: text(inv.numero_factura) || text(inv.folio),
			fecha_factura: text(inv.fecha_factura),
			fecha_vencimiento: text(inv.fecha_vencimiento),
			total: money(total),
			saldo,
			dias_vencida,
			tramo,
		});
		by_supplier.set(key, row);
	}
	const proveedores = [...by_supplier.values()]
		.map((row) => ({ ...row, facturas: row.facturas.sort((a, b) => b.dias_vencida - a.dias_vencida) }))
		.sort((a, b) => b.saldo - a.saldo || a.proveedor_nombre.localeCompare(b.proveedor_nombre));
	return {
		corte: local_day(cut),
		saldo: money(proveedores.reduce((s, r) => s + r.saldo, 0)),
		...totals,
		proveedores,
	};
}

export async function supplier_aging(store: ImperiumStore, corte?: string | null) {
	const invoices: ImperiumDoc[] = [];
	if (store.has('supplier-invoice')) {
		for await (const page of store.scan('supplier-invoice', {})) invoices.push(...page);
	}
	return build_supplier_aging(invoices, corte || new Date());
}
