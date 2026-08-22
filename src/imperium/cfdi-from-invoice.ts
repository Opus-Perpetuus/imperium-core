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
import type { ImperiumStore } from './store.ts';
import { has_cfdi_errors, run_cfdi_validation } from './cfdi-validator.ts';

export type CfdiFromInvoiceCtx = {
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
	const issues = await run_cfdi_validation(ctx.store, canonical);
	const status = has_cfdi_errors(issues) ? 'invalid' : 'valid';
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
