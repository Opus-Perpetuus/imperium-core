/**
 * CFDI desde solicitud de facturación: mismo contrato que
 * `CfdiDocumentService.create_from_invoice_request`.
 */
import {
	build_cfdi_from_invoice_request_data,
	map_invoice_request_record_to_builder_input,
	type CfdiBuilderProductMapEntry,
} from './cfdi-builder.ts';
import { as_array, as_object, ok, type ImperiumDoc } from './envelope.ts';
import type { CfdiCanonical } from './cfdi-xml.ts';
import type { ImperiumStore } from './store.ts';

export type CfdiFromInvoiceCtx = {
	store: ImperiumStore;
	params: Record<string, string>;
	body: Record<string, unknown>;
};

type ValidationIssue = {
	code: string;
	path: string;
	severity: 'error' | 'warning';
	message: string;
};

const RFC_GENERIC = new Set(['XAXX010101000', 'XEXX010101000']);

function text(value: unknown): string {
	return String(value ?? '').trim();
}

function ref_id(value: unknown): string {
	if (value == null) return '';
	if (typeof value === 'object') return text((value as { _id?: unknown })._id);
	return text(value);
}

function is_rfc(rfc: string): boolean {
	const value = rfc.trim().toUpperCase();
	if (RFC_GENERIC.has(value)) return true;
	return /^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/.test(value);
}

function issue(code: string, path: string, message: string): ValidationIssue {
	return { code, path, severity: 'error', message };
}

function validate_canonical(doc: CfdiCanonical): ValidationIssue[] {
	const issues: ValidationIssue[] = [];
	if (doc.version !== '4.0') {
		issues.push(issue('CFDI_E001', 'version', `Version debe ser "4.0", recibido "${doc.version}"`));
	}
	const c = doc.comprobante;
	if (!c?.fecha) issues.push(issue('CFDI_E010', 'comprobante.fecha', 'Fecha de emisión requerida'));
	if (!c?.moneda) issues.push(issue('CFDI_E011', 'comprobante.moneda', 'Moneda requerida'));
	if (!c?.tipo_de_comprobante) {
		issues.push(issue('CFDI_E012', 'comprobante.tipo_de_comprobante', 'TipoDeComprobante requerido'));
	}
	if (!c?.exportacion) {
		issues.push(issue('CFDI_E013', 'comprobante.exportacion', 'Exportacion requerida'));
	}
	if (!c?.lugar_expedicion || !/^\d{5}$/.test(c.lugar_expedicion)) {
		issues.push(
			issue('CFDI_E014', 'comprobante.lugar_expedicion', 'LugarExpedicion debe ser un código postal de 5 dígitos'),
		);
	}
	if (!is_rfc(doc.emisor?.rfc ?? '')) {
		issues.push(issue('CFDI_E020', 'emisor.rfc', 'RFC del emisor inválido'));
	}
	if (!text(doc.emisor?.nombre)) {
		issues.push(issue('CFDI_E021', 'emisor.nombre', 'Nombre del emisor requerido'));
	}
	if (!text(doc.emisor?.regimen_fiscal)) {
		issues.push(issue('CFDI_E022', 'emisor.regimen_fiscal', 'Régimen fiscal del emisor requerido'));
	}
	if (!is_rfc(doc.receptor?.rfc ?? '')) {
		issues.push(issue('CFDI_E030', 'receptor.rfc', 'RFC del receptor inválido'));
	}
	if (!text(doc.receptor?.nombre)) {
		issues.push(issue('CFDI_E031', 'receptor.nombre', 'Nombre del receptor requerido'));
	}
	if (!/^\d{5}$/.test(doc.receptor?.domicilio_fiscal_receptor ?? '')) {
		issues.push(
			issue(
				'CFDI_E032',
				'receptor.domicilio_fiscal_receptor',
				'Domicilio fiscal del receptor debe ser un código postal de 5 dígitos',
			),
		);
	}
	if (!text(doc.receptor?.regimen_fiscal_receptor)) {
		issues.push(issue('CFDI_E033', 'receptor.regimen_fiscal_receptor', 'Régimen fiscal del receptor requerido'));
	}
	if (!text(doc.receptor?.uso_cfdi)) {
		issues.push(issue('CFDI_E034', 'receptor.uso_cfdi', 'UsoCFDI requerido'));
	}
	if (!doc.conceptos?.length) {
		issues.push(issue('CFDI_E040', 'conceptos', 'El comprobante requiere al menos un concepto'));
	}
	for (const [index, line] of (doc.conceptos ?? []).entries()) {
		if (!text(line.clave_prod_serv)) {
			issues.push(issue('CFDI_E041', `conceptos[${index}].clave_prod_serv`, 'ClaveProdServ requerida'));
		}
		if (!text(line.clave_unidad)) {
			issues.push(issue('CFDI_E042', `conceptos[${index}].clave_unidad`, 'ClaveUnidad requerida'));
		}
		if (!text(line.descripcion)) {
			issues.push(issue('CFDI_E043', `conceptos[${index}].descripcion`, 'Descripción del concepto requerida'));
		}
		if (!(Number(line.cantidad) > 0)) {
			issues.push(issue('CFDI_E044', `conceptos[${index}].cantidad`, 'Cantidad debe ser mayor a cero'));
		}
	}
	return issues;
}

async function load_issuer(store: ImperiumStore, issuer_profile_id?: string): Promise<ImperiumDoc> {
	if (!store.has('cfdi-issuer-profile')) {
		throw new Error(
			'No hay perfil de emisor CFDI activo. Configura un emisor antes de generar el comprobante.',
		);
	}
	if (issuer_profile_id) {
		const by_id = await store.find_id('cfdi-issuer-profile', issuer_profile_id);
		if (!by_id || by_id.is_active === false) {
			throw new Error('No se encontró el perfil de emisor CFDI indicado o está inactivo.');
		}
		return by_id;
	}
	const { rows } = await store.find_many('cfdi-issuer-profile', {
		take: 200,
		include_inactive: false,
	});
	const active = rows.filter((row) => row.is_active !== false);
	const def = active.find((row) => row.is_default === true || row.is_default === 'true');
	const first = def ?? active.sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')))[0];
	if (!first) {
		throw new Error(
			'No hay perfil de emisor CFDI activo. Configura un emisor antes de generar el comprobante.',
		);
	}
	return first;
}

async function build_product_map(
	store: ImperiumStore,
	product_ids: string[],
): Promise<Record<string, CfdiBuilderProductMapEntry>> {
	const unique = [...new Set(product_ids.filter(Boolean))];
	const map: Record<string, CfdiBuilderProductMapEntry> = {};
	if (!unique.length || !store.has('products')) return map;
	for (const id of unique) {
		const product = await store.find_id('products', id);
		if (!product) continue;
		const unidad = as_object(product.unidad);
		const unidad_id = ref_id(product.unidad);
		let unidad_doc = Object.keys(unidad).length ? unidad : null;
		if (!unidad_doc && unidad_id && store.has('unidad')) {
			unidad_doc = (await store.find_id('unidad', unidad_id)) ?? null;
		}
		if (!unidad_doc && unidad_id && store.has('uom')) {
			unidad_doc = (await store.find_id('uom', unidad_id)) ?? null;
		}
		map[id] = {
			clave_prod_serv: text(product.clave_prod_serv) || undefined,
			objeto_imp_default: text(product.objeto_imp_default) || undefined,
			clave_unidad: text(unidad_doc?.clave_unidad) || undefined,
			unidad: text(unidad_doc?.name) || undefined,
			name: text(product.name) || undefined,
			code: text(product.codigo ?? product.code) || undefined,
		};
	}
	return map;
}

function resolve_iva_rate(invoice_request: ImperiumDoc, body: Record<string, unknown>): number | undefined {
	if (body.iva_rate != null && body.iva_rate !== '') {
		const from_body = Number(body.iva_rate);
		if (Number.isFinite(from_body) && from_body >= 0) return from_body;
	}
	const iva = Number(invoice_request.pedido_iva) || 0;
	const total = Number(invoice_request.pedido_total) || 0;
	const base = total - iva;
	if (base > 0 && iva > 0) return iva / base;
	return undefined;
}

export async function create_cfdi_from_invoice_request(ctx: CfdiFromInvoiceCtx) {
	const invoice_request_id = text(ctx.params.invoiceRequestId ?? ctx.params.id);
	if (!invoice_request_id) {
		throw new Error('Debes indicar el identificador de la solicitud de facturación.');
	}
	const invoice_request = await ctx.store.find_id('invoice-request', invoice_request_id);
	if (!invoice_request || invoice_request.is_active === false) {
		throw new Error('No se encontró la solicitud de facturación.');
	}

	const issuer = await load_issuer(ctx.store, text(ctx.body.issuer_profile_id) || undefined);
	const contacto_id = ref_id(invoice_request.contacto);
	let contacto: ImperiumDoc | null = null;
	if (contacto_id && ctx.store.has('contacto')) {
		contacto = await ctx.store.find_id('contacto', contacto_id);
		if (contacto?.is_active === false) contacto = null;
	}

	const product_ids: string[] = [];
	for (const sub of as_array(invoice_request.subpedidos)) {
		for (const art of as_array(as_object(sub).articulos)) {
			const product = ref_id(as_object(art).product);
			if (product) product_ids.push(product);
		}
	}
	const product_map = await build_product_map(ctx.store, product_ids);
	const iva_rate = resolve_iva_rate(invoice_request, ctx.body);
	const builder_input = map_invoice_request_record_to_builder_input(
		{
			_id: String(invoice_request._id),
			contacto_nombre: text(invoice_request.contacto_nombre) || undefined,
			contacto_rfc: text(invoice_request.contacto_rfc) || undefined,
			receptor: contacto
				? {
						rfc: text(contacto.rfc) || undefined,
						nombre_fiscal: text(contacto.nombre_fiscal) || undefined,
						name: text(contacto.name) || undefined,
						codigoPostal: text(contacto.codigoPostal ?? contacto.codigo_postal) || undefined,
						regimen_fiscal: text(contacto.regimen_fiscal) || undefined,
						uso_cfdi_default: text(contacto.uso_cfdi_default) || undefined,
					}
				: undefined,
			subpedidos: as_array(invoice_request.subpedidos) as Array<{ articulos?: unknown[] }>,
			forma_pago: text(ctx.body.forma_pago) || undefined,
			metodo_pago: text(ctx.body.metodo_pago) || undefined,
			moneda: text(ctx.body.moneda) || undefined,
			fecha: text(ctx.body.fecha) || undefined,
			serie: text(ctx.body.serie) || undefined,
			folio: text(ctx.body.folio) || undefined,
			iva_rate,
			perfil_emision:
				text(ctx.body.perfil_emision) || text(issuer.perfil_emision_default) || undefined,
		},
		{
			rfc: text(issuer.rfc),
			nombre_fiscal: text(issuer.nombre_fiscal) || undefined,
			name: text(issuer.name) || undefined,
			regimen_fiscal: text(issuer.regimen_fiscal),
			lugar_expedicion: text(issuer.lugar_expedicion),
			serie_default: text(issuer.serie_default) || undefined,
			folio_siguiente: issuer.folio_siguiente as number | string | undefined,
			perfil_emision_default: text(issuer.perfil_emision_default) || undefined,
		},
		product_map,
	);

	if (!builder_input.conceptos.length) {
		throw new Error(
			'La solicitud de facturación no tiene líneas facturables para generar el CFDI.',
		);
	}

	const canonical = build_cfdi_from_invoice_request_data(builder_input);
	const issues = validate_canonical(canonical);
	const status = issues.some((item) => item.severity === 'error') ? 'invalid' : 'valid';
	canonical.meta = {
		...(canonical.meta ?? {}),
		source: 'invoice_request',
		source_id: String(invoice_request._id),
		validation: { status, errors: issues },
		json_revision: 1,
	};

	const receptor_nombre = canonical.receptor?.nombre || '';
	const receptor_rfc = canonical.receptor?.rfc || '';
	const total = Number(canonical.comprobante?.total) || 0;
	const serie = canonical.comprobante?.serie || '';
	const folio = canonical.comprobante?.folio || '';
	const name_parts = [
		'CFDI',
		serie && folio ? `${serie}-${folio}` : serie || folio,
		receptor_nombre || text(invoice_request.contacto_nombre) || text(invoice_request.name),
	].filter(Boolean);
	let name = name_parts.join(' ').trim();
	if (name.length < 4) name = `CFDI ${String(invoice_request._id).slice(-8)}`;

	const created = await ctx.store.insert('cfdi-document', {
		name,
		description: `Generado desde solicitud ${invoice_request.name}`,
		status,
		estado: status,
		perfil_emision: canonical.perfil_emision || 'comercial',
		canonical,
		payload_canonico: canonical,
		validation_issues: issues,
		source_type: 'invoice_request',
		source_id: String(invoice_request._id),
		origen: 'invoice-request',
		origen_id: String(invoice_request._id),
		issuer_profile: String(issuer._id ?? ''),
		contacto: contacto_id || undefined,
		receptor_rfc,
		receptor_nombre,
		total,
		json_revision: 1,
		is_active: true,
	});

	if (issuer._id && !text(ctx.body.folio)) {
		const current = Number(issuer.folio_siguiente) || 0;
		await ctx.store.update('cfdi-issuer-profile', String(issuer._id), {
			folio_siguiente: current + 1,
		});
	}

	await ctx.store.update('invoice-request', String(invoice_request._id), {
		cfdi_document_id: created._id,
		cfdi_document_status: status,
		cfdi_document_name: name,
	});

	return ok(
		[created],
		status === 'valid'
			? 'Documento CFDI generado y validado correctamente'
			: 'Documento CFDI generado con observaciones de validación',
	);
}
