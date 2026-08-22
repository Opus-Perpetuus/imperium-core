/**
 * QR de plantillas: mismo payload que `backend/.../report-qr.utils.ts`.
 */
import { toDataURL } from 'qrcode';

export const REPORT_QR_MODELS = {
	delivery_package: 3,
	contacto: 4,
	inventory_location: 5,
	product: 6,
} as const;

export const REPORT_QR_ACTIONS = {
	none: 0,
	navigate: 1,
} as const;

export function encode_qr_payload(data: unknown): string {
	return encodeURIComponent(JSON.stringify(data));
}

function resolve_simple_path(record: unknown, field: string): unknown {
	if (!record || typeof record !== 'object' || !field) return undefined;
	const source = record as Record<string, unknown>;
	if (Object.prototype.hasOwnProperty.call(source, field)) return source[field];
	const segments = field.split('.').filter((segment) => segment.length > 0);
	let current: unknown = record;
	for (const segment of segments) {
		if (current == null || typeof current !== 'object') return undefined;
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

function stringify_qr_field_value(value: unknown): string {
	if (value === null || value === undefined) return '';
	if (typeof value === 'string') return value;
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	if (typeof value === 'object') {
		const object_value = value as { toHexString?: () => string; _id?: unknown; id?: unknown };
		if (typeof object_value.toHexString === 'function') return String(value);
		if (object_value._id != null) return String(object_value._id);
		if (object_value.id != null) return String(object_value.id);
		try {
			return JSON.stringify(value);
		} catch {
			return '';
		}
	}
	return String(value);
}

function record_identifier(record: unknown): string {
	if (!record || typeof record !== 'object') return '';
	const rec = record as { _id?: unknown; id?: unknown };
	return String(rec._id ?? rec.id ?? '').trim();
}

function normalize_model_name(model_name?: string): string {
	return String(model_name ?? '')
		.trim()
		.toLowerCase();
}

function model_matches(model_name: string | undefined, ...aliases: string[]): boolean {
	const normalized = normalize_model_name(model_name);
	if (!normalized) return false;
	return aliases.some((alias) => alias.toLowerCase() === normalized);
}

export function build_report_qr_payload(
	record: unknown,
	model_name?: string,
	field?: string,
): string {
	if (field) {
		return stringify_qr_field_value(resolve_simple_path(record, field));
	}
	const id = record_identifier(record);
	const rec = (record || {}) as Record<string, unknown>;
	const codigo = String(rec.codigo ?? '').trim();
	if (model_matches(model_name, 'InventoryInternalLocation', 'inventory-internal-location')) {
		return encode_qr_payload({
			id,
			m: REPORT_QR_MODELS.inventory_location,
			ac: REPORT_QR_ACTIONS.none,
			c: codigo,
		});
	}
	if (model_matches(model_name, 'Contacto', 'contacto')) {
		return encode_qr_payload({
			id,
			m: REPORT_QR_MODELS.contacto,
			ac: REPORT_QR_ACTIONS.none,
			c: codigo,
		});
	}
	if (model_matches(model_name, 'Products', 'products')) {
		return encode_qr_payload({
			ac: REPORT_QR_ACTIONS.navigate,
			id,
			p: 'products',
			m: REPORT_QR_MODELS.product,
			c: codigo,
		});
	}
	if (model_matches(model_name, 'DeliveryPackage', 'delivery-package')) {
		return encode_qr_payload({
			ac: REPORT_QR_ACTIONS.navigate,
			id,
			p: 'delivery-package',
			m: REPORT_QR_MODELS.delivery_package,
			c: String(rec.codigo_bulto ?? '').trim(),
		});
	}
	return id || codigo;
}

export async function qr_payload_to_data_url(payload: string): Promise<string> {
	return toDataURL(payload, {
		margin: 0,
		errorCorrectionLevel: 'M',
		width: 300,
	});
}

export function render_qr_img_tag(data_url: string): string {
	return `<img src="${data_url}" alt="QR" style="width:32mm;height:32mm;display:block;margin:0 auto;" />`;
}
