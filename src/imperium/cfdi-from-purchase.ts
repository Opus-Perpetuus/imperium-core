/**
 * CFDI inbound de proveedor ligado a orden de compra.
 * Mismo contrato que `CfdiDocumentService.link_or_create_from_purchase_order`.
 */
import { as_object, ok, type ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';

export type CfdiFromPurchaseCtx = {
	store: ImperiumStore;
	params: Record<string, string>;
	body: Record<string, unknown>;
};

function text(value: unknown): string {
	return String(value ?? '').trim();
}

function ref_id(value: unknown): string {
	if (value == null) return '';
	if (typeof value === 'object') return text((value as { _id?: unknown })._id);
	return text(value);
}

export function normalize_cfdi_uuid(value: unknown): string {
	return text(value).toUpperCase();
}

function inbound_name(input: {
	uuid?: string;
	referencia?: string;
	emisor_nombre?: string;
	purchase_order_nombre?: string;
	purchase_order_id?: string;
}): string {
	const uuid_short = text(input.uuid).slice(0, 8);
	const parts = [
		'Factura proveedor',
		text(input.referencia) || uuid_short,
		text(input.emisor_nombre) || text(input.purchase_order_nombre),
	].filter(Boolean);
	let name = parts.join(' ').trim();
	if (name.length < 4) {
		name = `Factura proveedor ${String(input.purchase_order_id ?? '').slice(-8) || 'CFDI'}`;
	}
	return name.slice(0, 200);
}

async function find_by_uuid(store: ImperiumStore, uuid: string): Promise<ImperiumDoc | null> {
	if (!store.has('cfdi-document') || !uuid) return null;
	const by_where = await store.find_where('cfdi-document', { uuid });
	if (by_where && normalize_cfdi_uuid(by_where.uuid) === uuid && by_where.is_active !== false) {
		return by_where;
	}
	const { rows } = await store.find_many('cfdi-document', { take: 2000, include_inactive: false });
	return (
		rows.find((row) => normalize_cfdi_uuid(row.uuid) === uuid && row.is_active !== false) ?? null
	);
}

export async function link_or_create_from_purchase_order(
	store: ImperiumStore,
	purchase_order: ImperiumDoc,
	overrides: {
		uuid?: string;
		total?: number;
		emisor_rfc?: string;
		emisor_nombre?: string;
		referencia?: string;
		description?: string;
	} = {},
): Promise<ImperiumDoc | null> {
	const po_id = ref_id(purchase_order._id);
	if (!po_id) return null;
	const uuid = normalize_cfdi_uuid(overrides.uuid ?? purchase_order.uuid_xml);
	if (!uuid) return null;

	const emisor_rfc = text(overrides.emisor_rfc ?? purchase_order.proveedor_rfc);
	const emisor_nombre = text(overrides.emisor_nombre ?? purchase_order.proveedor_nombre);
	const referencia = text(overrides.referencia ?? purchase_order.referencia_origen);
	const total = Number(overrides.total ?? purchase_order.subtotal ?? 0);
	const purchase_order_nombre = text(purchase_order.name);
	const contacto_id = ref_id(purchase_order.proveedor) || undefined;

	const existing = await find_by_uuid(store, uuid);
	if (existing) {
		const linked_po = ref_id(existing.purchase_order);
		if (linked_po && linked_po !== po_id) {
			throw new Error(`El UUID ${uuid} ya está ligado a otra orden de compra`);
		}
		const patch: ImperiumDoc = {
			purchase_order: po_id,
			purchase_order_nombre,
			source_type: 'purchase_order',
			source_id: po_id,
			origen: 'purchase-order',
			origen_id: po_id,
			flow_direction: 'inbound',
		};
		if (emisor_rfc) patch.emisor_rfc = emisor_rfc;
		if (emisor_nombre) patch.emisor_nombre = emisor_nombre;
		if (contacto_id) patch.contacto = contacto_id;
		if (Number.isFinite(total) && total > 0 && !(Number(existing.total ?? 0) > 0)) {
			patch.total = total;
		}
		if (overrides.description) {
			patch.description = text(overrides.description).slice(0, 500);
		}
		return (await store.update('cfdi-document', String(existing._id), patch)) ?? existing;
	}

	const name = inbound_name({
		uuid,
		referencia,
		emisor_nombre,
		purchase_order_nombre,
		purchase_order_id: po_id,
	});
	return store.insert('cfdi-document', {
		name,
		description: text(
			overrides.description ||
				`CFDI de proveedor ligado a la compra ${purchase_order_nombre || po_id}`,
		).slice(0, 500),
		status: 'stamped',
		estado: 'stamped',
		perfil_emision: 'comercial',
		flow_direction: 'inbound',
		source_type: 'purchase_order',
		source_id: po_id,
		origen: 'purchase-order',
		origen_id: po_id,
		purchase_order: po_id,
		purchase_order_nombre,
		contacto: contacto_id,
		emisor_rfc: emisor_rfc || undefined,
		emisor_nombre: emisor_nombre || undefined,
		total: Number.isFinite(total) && total > 0 ? total : 0,
		uuid,
		json_revision: 1,
		is_active: true,
		validation_issues: [],
		canonical: null,
	});
}

export async function sync_inbound_supplier_invoice(store: ImperiumStore, purchase_order: ImperiumDoc) {
	const uuid = normalize_cfdi_uuid(purchase_order.uuid_xml);
	if (!uuid) return null;
	return link_or_create_from_purchase_order(store, purchase_order);
}

export async function create_cfdi_from_purchase_order(ctx: CfdiFromPurchaseCtx) {
	const purchase_order_id =
		text(ctx.params.purchaseOrderId) ||
		text(ctx.params.purchase_order_id) ||
		text(ctx.params.id) ||
		text(ctx.body.purchase_order_id);
	if (!purchase_order_id) {
		throw new Error('Se requiere un id de orden de compra válido');
	}
	const purchase_order = await ctx.store.find_id('purchase-order', purchase_order_id);
	if (!purchase_order || purchase_order.is_active === false) {
		throw new Error('No se encontró la orden de compra indicada');
	}
	const body = as_object(ctx.body);
	const uuid = normalize_cfdi_uuid(body.uuid ?? body.uuid_xml);
	if (!uuid && !normalize_cfdi_uuid(purchase_order.uuid_xml)) {
		throw new Error('Se requiere el UUID del CFDI del proveedor (uuid / uuid_xml)');
	}
	const document = await link_or_create_from_purchase_order(ctx.store, purchase_order, {
		uuid: uuid || undefined,
		total: body.total != null && body.total !== '' ? Number(body.total) : undefined,
		emisor_rfc: text(body.emisor_rfc) || undefined,
		emisor_nombre: text(body.emisor_nombre) || undefined,
		referencia: text(body.referencia) || undefined,
		description: text(body.description) || undefined,
	});
	if (!document) throw new Error('No se pudo crear la factura de proveedor');
	return ok([document], 'Factura de proveedor ligada a la orden de compra');
}
