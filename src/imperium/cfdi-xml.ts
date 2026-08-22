/**
 * Serializa canónico CFDI 4.0 a XML Anexo 20.
 * Mismo contrato que backend/src/components/cfdi/domain/cfdi-xml.serializer.ts
 */

export type CfdiImpuestoDetalle = {
	base: number;
	impuesto: string;
	tipo_factor: string;
	tasa_o_cuota?: number;
	importe?: number;
};

export type CfdiConcepto = {
	clave_prod_serv: string;
	no_identificacion?: string;
	cantidad: number;
	clave_unidad: string;
	unidad?: string;
	descripcion: string;
	valor_unitario: number;
	importe: number;
	descuento?: number;
	objeto_imp: string;
	impuestos?: {
		traslados?: CfdiImpuestoDetalle[];
		retenciones?: CfdiImpuestoDetalle[];
	};
};

export type CfdiPerfilEmision = 'comercial' | 'dpa_gobierno';

export type CfdiImpuestosTotales = {
	total_impuestos_trasladados?: number;
	total_impuestos_retenidos?: number;
	traslados?: CfdiImpuestoDetalle[];
	retenciones?: Array<{ impuesto: string; importe: number }>;
};

export type CfdiCanonical = {
	version: string;
	perfil_emision?: CfdiPerfilEmision;
	comprobante: {
		serie?: string;
		folio?: string;
		fecha: string;
		forma_pago?: string;
		metodo_pago?: string;
		moneda: string;
		tipo_cambio?: number;
		tipo_de_comprobante: string;
		exportacion: string;
		lugar_expedicion: string;
		subtotal: number;
		descuento?: number;
		total: number;
		sello?: string;
		no_certificado?: string;
		certificado?: string;
	};
	emisor: { rfc: string; nombre: string; regimen_fiscal: string };
	receptor: {
		rfc: string;
		nombre: string;
		domicilio_fiscal_receptor: string;
		regimen_fiscal_receptor: string;
		uso_cfdi: string;
		residencia_fiscal?: string;
		num_reg_id_trib?: string;
	};
	conceptos: CfdiConcepto[];
	impuestos?: CfdiImpuestosTotales;
	meta?: {
		source?: string;
		source_id?: string;
		validation?: { status: string; errors: unknown[] };
		json_revision?: number;
	};
	complemento?: {
		nomina?: Record<string, unknown>;
		timbre_fiscal_digital?: {
			version?: string;
			uuid?: string;
			fecha_timbrado?: string;
			rfc_prov_certif?: string;
			sello_cfd?: string;
			no_certificado_sat?: string;
			sello_sat?: string;
		};
	};
};

const NS_CFDI = 'http://www.sat.gob.mx/cfd/4';
const XSI = 'http://www.w3.org/2001/XMLSchema-instance';
const SCHEMA_LOCATION =
	'http://www.sat.gob.mx/cfd/4 http://www.sat.gob.mx/sitio_internet/cfd/4/cfdv40.xsd';

function cfdi_round(value: number, decimals = 2) {
	if (!Number.isFinite(value)) return 0;
	const factor = 10 ** decimals;
	return Math.round((value + Number.EPSILON) * factor) / factor;
}

function format_amount(n: number) {
	return cfdi_round(n, 2).toFixed(2);
}

function esc(value: string | number | undefined | null) {
	if (value === undefined || value === null) return '';
	return String(value)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

function attr(
	name: string,
	value: string | number | undefined | null,
	opts?: { required?: boolean },
) {
	if (value === undefined || value === null || value === '') {
		if (opts?.required) throw new Error(`Atributo XML requerido faltante: ${name}`);
		return '';
	}
	return ` ${name}="${esc(value)}"`;
}

export function looks_like_canonical(raw: unknown): raw is CfdiCanonical {
	if (!raw || typeof raw !== 'object') return false;
	const doc = raw as Record<string, unknown>;
	return Boolean(
		doc.comprobante &&
			typeof doc.comprobante === 'object' &&
			doc.emisor &&
			doc.receptor &&
			Array.isArray(doc.conceptos),
	);
}

export function serialize_cfdi_to_xml(doc: CfdiCanonical): string {
	const c = doc.comprobante;
	const lines: string[] = [];
	lines.push(`<?xml version="1.0" encoding="UTF-8"?>`);

	let open = `<cfdi:Comprobante xmlns:cfdi="${NS_CFDI}" xmlns:xsi="${XSI}" xsi:schemaLocation="${SCHEMA_LOCATION}"`;
	open += attr('Version', doc.version, { required: true });
	open += attr('Serie', c.serie);
	open += attr('Folio', c.folio);
	open += attr('Fecha', c.fecha, { required: true });
	open += attr('Sello', c.sello ?? '');
	open += attr('FormaPago', c.forma_pago);
	open += attr('NoCertificado', c.no_certificado ?? '');
	open += attr('Certificado', c.certificado ?? '');
	open += attr('SubTotal', format_amount(c.subtotal), { required: true });
	open += attr('Descuento', c.descuento != null ? format_amount(c.descuento) : undefined);
	open += attr('Moneda', c.moneda, { required: true });
	open += attr('TipoCambio', c.tipo_cambio);
	open += attr('Total', format_amount(c.total), { required: true });
	open += attr('TipoDeComprobante', c.tipo_de_comprobante, { required: true });
	open += attr('Exportacion', c.exportacion, { required: true });
	open += attr('MetodoPago', c.metodo_pago);
	open += attr('LugarExpedicion', c.lugar_expedicion, { required: true });
	open += '>';
	lines.push(open);

	lines.push(
		`  <cfdi:Emisor${attr('Rfc', doc.emisor.rfc, { required: true })}${attr(
			'Nombre',
			doc.emisor.nombre,
			{ required: true },
		)}${attr('RegimenFiscal', doc.emisor.regimen_fiscal, { required: true })}/>`,
	);

	let receptor = `  <cfdi:Receptor`;
	receptor += attr('Rfc', doc.receptor.rfc, { required: true });
	receptor += attr('Nombre', doc.receptor.nombre, { required: true });
	receptor += attr('DomicilioFiscalReceptor', doc.receptor.domicilio_fiscal_receptor, {
		required: true,
	});
	receptor += attr('ResidenciaFiscal', doc.receptor.residencia_fiscal);
	receptor += attr('NumRegIdTrib', doc.receptor.num_reg_id_trib);
	receptor += attr('RegimenFiscalReceptor', doc.receptor.regimen_fiscal_receptor, {
		required: true,
	});
	receptor += attr('UsoCFDI', doc.receptor.uso_cfdi, { required: true });
	receptor += `/>`;
	lines.push(receptor);

	lines.push(`  <cfdi:Conceptos>`);
	for (const concepto of doc.conceptos) {
		let line = `    <cfdi:Concepto`;
		line += attr('ClaveProdServ', concepto.clave_prod_serv, { required: true });
		line += attr('NoIdentificacion', concepto.no_identificacion);
		line += attr('Cantidad', concepto.cantidad, { required: true });
		line += attr('ClaveUnidad', concepto.clave_unidad, { required: true });
		line += attr('Unidad', concepto.unidad);
		line += attr('Descripcion', concepto.descripcion, { required: true });
		line += attr('ValorUnitario', format_amount(concepto.valor_unitario), { required: true });
		line += attr('Importe', format_amount(concepto.importe), { required: true });
		line += attr(
			'Descuento',
			concepto.descuento != null ? format_amount(concepto.descuento) : undefined,
		);
		line += attr('ObjetoImp', concepto.objeto_imp, { required: true });

		const has_taxes =
			(concepto.impuestos?.traslados?.length ?? 0) > 0 ||
			(concepto.impuestos?.retenciones?.length ?? 0) > 0;
		if (!has_taxes) {
			line += `/>`;
			lines.push(line);
			continue;
		}
		line += `>`;
		lines.push(line);
		lines.push(`      <cfdi:Impuestos>`);
		if (concepto.impuestos?.traslados?.length) {
			lines.push(`        <cfdi:Traslados>`);
			for (const t of concepto.impuestos.traslados) {
				let tr = `          <cfdi:Traslado`;
				tr += attr('Base', format_amount(t.base), { required: true });
				tr += attr('Impuesto', t.impuesto, { required: true });
				tr += attr('TipoFactor', t.tipo_factor, { required: true });
				tr += attr('TasaOCuota', t.tasa_o_cuota);
				tr += attr('Importe', t.importe != null ? format_amount(t.importe) : undefined);
				tr += `/>`;
				lines.push(tr);
			}
			lines.push(`        </cfdi:Traslados>`);
		}
		lines.push(`      </cfdi:Impuestos>`);
		lines.push(`    </cfdi:Concepto>`);
	}
	lines.push(`  </cfdi:Conceptos>`);

	if (doc.impuestos) {
		let imp = `  <cfdi:Impuestos`;
		imp += attr(
			'TotalImpuestosTrasladados',
			doc.impuestos.total_impuestos_trasladados != null
				? format_amount(doc.impuestos.total_impuestos_trasladados)
				: undefined,
		);
		imp += attr(
			'TotalImpuestosRetenidos',
			doc.impuestos.total_impuestos_retenidos != null
				? format_amount(doc.impuestos.total_impuestos_retenidos)
				: undefined,
		);
		const has_body =
			(doc.impuestos.traslados?.length ?? 0) > 0 ||
			(doc.impuestos.retenciones?.length ?? 0) > 0;
		if (!has_body) {
			imp += `/>`;
			lines.push(imp);
		} else {
			imp += `>`;
			lines.push(imp);
			if (doc.impuestos.traslados?.length) {
				lines.push(`    <cfdi:Traslados>`);
				for (const t of doc.impuestos.traslados) {
					let tr = `      <cfdi:Traslado`;
					tr += attr('Base', format_amount(t.base), { required: true });
					tr += attr('Impuesto', t.impuesto, { required: true });
					tr += attr('TipoFactor', t.tipo_factor, { required: true });
					tr += attr('TasaOCuota', t.tasa_o_cuota);
					tr += attr('Importe', t.importe != null ? format_amount(t.importe) : undefined);
					tr += `/>`;
					lines.push(tr);
				}
				lines.push(`    </cfdi:Traslados>`);
			}
			lines.push(`  </cfdi:Impuestos>`);
		}
	}

	const tfd = doc.complemento?.timbre_fiscal_digital;
	if (tfd) {
		lines.push(`  <cfdi:Complemento>`);
		let t = `    <tfd:TimbreFiscalDigital xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital"`;
		t += attr('Version', tfd.version);
		t += attr('UUID', tfd.uuid);
		t += attr('FechaTimbrado', tfd.fecha_timbrado);
		t += attr('RfcProvCertif', tfd.rfc_prov_certif);
		t += attr('SelloCFD', tfd.sello_cfd);
		t += attr('NoCertificadoSAT', tfd.no_certificado_sat);
		t += attr('SelloSAT', tfd.sello_sat);
		t += `/>`;
		lines.push(t);
		lines.push(`  </cfdi:Complemento>`);
	}

	lines.push(`</cfdi:Comprobante>`);
	return lines.join('\n');
}
