/**
 * Pagos a proveedor: cada pago se aplica a una factura conciliada (o con sus
 * diferencias autorizadas) y no puede pasar de su saldo. No se editan: se
 * cancelan, y la factura recalcula lo pagado.
 */
import { ok, type ImperiumDoc } from './envelope.ts';
import { supplier_display_name } from './purchase-order-flow.ts';
import type { ImperiumStore } from './store.ts';
import {
	SUPPLIER_PAYMENT_APPLIED,
	SUPPLIER_PAYMENT_CANCELED,
	recompute_supplier_invoice,
} from './supplier-invoice-flow.ts';

const PAYABLE_MATCH = new Set(['conciliada', 'autorizada']);
const METHODS = new Set(['transferencia', 'cheque', 'efectivo', 'tarjeta', 'otro']);

function text(value: unknown): string {
	return String(value ?? '').trim();
}

function ref_id(value: unknown): string {
	if (value == null || value === '') return '';
	if (typeof value === 'object') return String((value as { _id?: unknown })._id ?? '').trim();
	return String(value).trim();
}

export async function apply_supplier_payment(
	store: ImperiumStore,
	body: ImperiumDoc,
) {
	const invoice_id = ref_id(body.supplier_invoice);
	const invoice = invoice_id ? await store.find_id('supplier-invoice', invoice_id) : null;
	if (!invoice) throw new Error('El pago requiere una factura de proveedor válida');
	if (text(invoice.estado) !== 'registrada') throw new Error('La factura está cancelada');
	if (!PAYABLE_MATCH.has(text(invoice.estado_match))) {
		throw new Error('La factura tiene diferencias sin autorizar; autorízalas antes de pagarla');
	}
	const monto = Number(body.monto);
	const saldo = Number(invoice.saldo ?? invoice.total ?? 0);
	if (!Number.isFinite(monto) || monto <= 0) throw new Error('El monto del pago debe ser mayor a cero');
	if (monto > saldo + 0.009) throw new Error(`El pago excede el saldo de la factura (${saldo})`);
	const metodo = text(body.metodo_pago).toLowerCase() || 'transferencia';
	if (!METHODS.has(metodo)) throw new Error(`El método de pago «${metodo}» no existe`);
	const doc: ImperiumDoc = {
		name: `Pago ${text(invoice.numero_factura)}`,
		supplier_invoice: invoice_id,
		numero_factura: text(invoice.numero_factura),
		purchase_order: ref_id(invoice.purchase_order) || undefined,
		proveedor: ref_id(invoice.proveedor) || undefined,
		proveedor_nombre: await supplier_display_name(
			store,
			invoice.proveedor_nombre,
			invoice.proveedor,
		),
		fecha_pago: text(body.fecha_pago) || new Date().toISOString(),
		metodo_pago: metodo,
		referencia: text(body.referencia),
		monto: Math.round(monto * 100) / 100,
		notas: text(body.notas),
		status: SUPPLIER_PAYMENT_APPLIED,
	};
	doc.folio = await store.next_auto_increment('SupplierPayment', 'folio', {
		resource: 'supplier-payment',
		context: doc,
	});
	const created = await store.insert('supplier-payment', doc);
	await recompute_supplier_invoice(store, invoice_id);
	return ok([created], 'Pago registrado correctamente');
}

export async function cancel_supplier_payment(
	store: ImperiumStore,
	id: unknown,
	motivo: unknown,
) {
	const payment_id = ref_id(id);
	const payment = payment_id ? await store.find_id('supplier-payment', payment_id) : null;
	if (!payment) throw new Error('No se encontró el pago indicado');
	if (text(payment.status).toUpperCase() === SUPPLIER_PAYMENT_CANCELED) {
		throw new Error('El pago ya estaba cancelado');
	}
	const razon = text(motivo);
	if (!razon) throw new Error('Indica el motivo de la cancelación');
	const saved = await store.update('supplier-payment', payment_id, {
		status: SUPPLIER_PAYMENT_CANCELED,
		motivo_cancelacion: razon,
	});
	await recompute_supplier_invoice(store, ref_id(payment.supplier_invoice));
	return ok([saved], 'Pago cancelado');
}
