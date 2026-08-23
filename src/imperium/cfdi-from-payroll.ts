/**
 * CFDI tipo N desde recibo de nómina.
 * Mismo contrato que `CfdiDocumentService.create_from_payroll_receipt`.
 */
import { as_object, ok, type ImperiumDoc } from './envelope.ts';
import { has_cfdi_errors, run_cfdi_validation } from './cfdi-validator.ts';
import { looks_like_canonical, serialize_cfdi_to_xml } from './cfdi-xml.ts';
import { stamp_with_pac } from './pac.ts';
import { payroll_payload_to_canonical } from './payroll-payload-to-canonical.ts';
import { build_payroll_cfdi_payload } from './payroll-to-cfdi-payload.ts';
import type { ImperiumStore } from './store.ts';

export type CfdiFromPayrollCtx = {
	store: ImperiumStore;
	params: Record<string, string>;
	body: Record<string, unknown>;
};

function text(value: unknown): string {
	return String(value ?? '').trim();
}

function bool_flag(value: unknown): boolean {
	if (value === true || value === 1) return true;
	return String(value ?? '').trim().toLowerCase() === 'true' || String(value ?? '') === '1';
}

async function load_issuer_optional(store: ImperiumStore, issuer_profile_id?: string) {
	if (!store.has('cfdi-issuer-profile')) return null;
	try {
		if (issuer_profile_id) {
			const by_id = await store.find_id('cfdi-issuer-profile', issuer_profile_id);
			if (!by_id || by_id.is_active === false) return null;
			return by_id;
		}
		const { rows: defaults } = await store.find_many('cfdi-issuer-profile', {
			where: { is_default: true },
			take: 1,
			sort: 'id:asc',
			include_inactive: false,
			populate: false,
		});
		if (defaults[0]) return defaults[0];
		const { rows: first_active } = await store.find_many('cfdi-issuer-profile', {
			take: 1,
			sort: 'created_at:asc',
			include_inactive: false,
			populate: false,
		});
		return first_active[0] ?? null;
	} catch {
		return null;
	}
}

async function maybe_stamp(store: ImperiumStore, doc: ImperiumDoc) {
	const canonical = as_object(doc.canonical ?? doc.payload_canonico);
	if (!looks_like_canonical(canonical)) {
		throw new Error('El documento no tiene payload canónico para timbrar.');
	}
	let xml = String(doc.xml ?? '');
	if (!xml.trim()) xml = serialize_cfdi_to_xml(canonical);
	await store.update('cfdi-document', String(doc._id), {
		status: 'stamping',
		estado: 'stamping',
	});
	try {
		const stamp = await stamp_with_pac(xml);
		return (
			(await store.update('cfdi-document', String(doc._id), {
				status: 'stamped',
				estado: 'stamped',
				canonical,
				payload_canonico: canonical,
				uuid: stamp.uuid,
				fecha_timbrado: stamp.fecha_timbrado,
				xml: stamp.xml_timbrado,
				xml_timbrado: stamp.xml_timbrado,
				rfc_prov_certif: stamp.rfc_prov_certif,
				no_certificado_sat: stamp.no_certificado_sat,
				sello_sat: stamp.sello_sat,
			})) ?? doc
		);
	} catch (error) {
		await store.update('cfdi-document', String(doc._id), {
			status: 'stamp_error',
			estado: 'stamp_error',
		});
		throw error;
	}
}

export async function create_cfdi_from_payroll_receipt(ctx: CfdiFromPayrollCtx) {
	const receipt_id =
		text(ctx.params.payrollReceiptId) ||
		text(ctx.params.id) ||
		text(ctx.body.payroll_receipt_id);
	if (!receipt_id) throw new Error('Debes indicar el id del recibo de nómina.');
	const receipt = await ctx.store.find_id('payroll-receipt', receipt_id);
	if (!receipt || receipt.is_active === false) {
		throw new Error('No se encontró el recibo de nómina.');
	}

	let payload = as_object(receipt.payload_cfdi);
	if (!Object.keys(payload).length) {
		payload = build_payroll_cfdi_payload(receipt);
	}

	const issuer = await load_issuer_optional(ctx.store, text(ctx.body.issuer_profile_id) || undefined);
	const canonical = payroll_payload_to_canonical(payload, {
		lugar_expedicion:
			text(issuer?.lugar_expedicion) || text(ctx.body.lugar_expedicion) || undefined,
		serie: text(ctx.body.serie) || text(issuer?.serie_default) || undefined,
		folio:
			text(ctx.body.folio) ||
			(issuer?.folio_siguiente != null ? String(issuer.folio_siguiente) : undefined),
	});

	if (issuer) {
		if (!canonical.emisor.rfc && issuer.rfc) {
			canonical.emisor.rfc = text(issuer.rfc);
			canonical.emisor.nombre =
				text(issuer.nombre_fiscal) || text(issuer.name) || canonical.emisor.nombre;
			canonical.emisor.regimen_fiscal =
				text(issuer.regimen_fiscal) || canonical.emisor.regimen_fiscal;
		}
		if (text(issuer.lugar_expedicion)) {
			canonical.comprobante.lugar_expedicion = text(issuer.lugar_expedicion);
		}
	}

	const issues = await run_cfdi_validation(ctx.store, canonical);
	const status = has_cfdi_errors(issues) ? 'invalid' : 'valid';
	canonical.meta = {
		...(canonical.meta ?? {}),
		source: 'payroll_receipt',
		source_id: receipt_id,
		validation: { status, errors: issues },
		json_revision: 1,
	};

	const name = `CFDI N ${canonical.receptor.nombre || receipt.name || receipt_id}`.slice(0, 200);
	let created = await ctx.store.insert('cfdi-document', {
		name: name.length >= 4 ? name : `CFDI-N-${receipt_id.slice(-8)}`,
		description: `Nómina recibo ${receipt.name || receipt_id}`,
		status,
		estado: status,
		perfil_emision: 'comercial',
		canonical,
		payload_canonico: canonical,
		validation_issues: issues,
		source_type: 'payroll_receipt',
		source_id: receipt_id,
		origen: 'payroll-receipt',
		origen_id: receipt_id,
		issuer_profile: issuer?._id ? String(issuer._id) : undefined,
		receptor_rfc: canonical.receptor.rfc,
		receptor_nombre: canonical.receptor.nombre,
		total: canonical.comprobante.total,
		json_revision: 1,
		is_active: true,
	});

	if (issuer?._id && !text(ctx.body.folio)) {
		const current = Number(issuer.folio_siguiente) || 0;
		await ctx.store.update('cfdi-issuer-profile', String(issuer._id), {
			folio_siguiente: current + 1,
		});
	}

	await ctx.store.update('payroll-receipt', receipt_id, {
		cfdi_document_id: String(created._id),
		payload_cfdi: payload,
		estado: String(receipt.estado) === 'calculated' ? 'ready_to_stamp' : receipt.estado,
	});

	if (bool_flag(ctx.body.stamp)) {
		created = await maybe_stamp(ctx.store, created);
		const provider = String(process.env.CFDI_PAC_PROVIDER ?? 'mock').toLowerCase();
		return ok(
			[created],
			`CFDI timbrado (${provider}): ${String(created.uuid ?? '')}`.trim(),
		);
	}

	return ok(
		[created],
		status === 'valid'
			? 'Documento CFDI N (nómina) generado y validado'
			: 'Documento CFDI N generado con observaciones de validación',
	);
}
