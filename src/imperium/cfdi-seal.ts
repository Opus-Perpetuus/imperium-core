/**
 * Sello emisor CSD — mismo contrato que
 * backend/src/components/cfdi/domain/cfdi-seal.ts
 * (cadena simplificada; producción SAT usa XSLT Anexo 20).
 */
import { createPrivateKey, createSign } from 'node:crypto';
import type { CfdiCanonical } from './cfdi-xml.ts';

export function build_simplified_cadena_original(doc: CfdiCanonical): string {
	const c = doc.comprobante;
	const e = doc.emisor;
	const r = doc.receptor;
	const parts: string[] = [
		'||',
		doc.version,
		c.serie ?? '',
		c.folio ?? '',
		c.fecha,
		c.forma_pago ?? '',
		String(c.subtotal),
		c.moneda,
		String(c.total),
		c.tipo_de_comprobante,
		c.exportacion,
		c.metodo_pago ?? '',
		c.lugar_expedicion,
		e.rfc,
		e.nombre,
		e.regimen_fiscal,
		r.rfc,
		r.nombre,
		r.domicilio_fiscal_receptor,
		r.regimen_fiscal_receptor,
		r.uso_cfdi,
	];
	for (const concepto of doc.conceptos ?? []) {
		parts.push(
			concepto.clave_prod_serv,
			String(concepto.cantidad),
			concepto.clave_unidad,
			concepto.descripcion,
			String(concepto.valor_unitario),
			String(concepto.importe),
			concepto.objeto_imp,
		);
	}
	parts.push('||');
	return parts.join('|');
}

export function seal_cadena_original(input: {
	private_key_pem: string;
	passphrase?: string;
	cadena_original: string;
}) {
	const key = createPrivateKey({
		key: input.private_key_pem,
		passphrase: input.passphrase,
		format: 'pem',
	});
	const signer = createSign('RSA-SHA256');
	signer.update(input.cadena_original, 'utf8');
	signer.end();
	return signer.sign(key, 'base64');
}

export function seal_canonical_with_csd(
	doc: CfdiCanonical,
	private_key_pem: string,
	passphrase?: string,
) {
	const cadena_original = build_simplified_cadena_original(doc);
	const sello = seal_cadena_original({
		private_key_pem,
		passphrase,
		cadena_original,
	});
	return { cadena_original, sello };
}
