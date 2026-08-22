/**
 * Validador canónico CFDI 4.0 + existencia en catálogos SAT.
 * Espejo de `backend/src/components/cfdi/domain/cfdi-validator.ts`.
 */
import type { CfdiCanonical, CfdiPerfilEmision } from './cfdi-xml.ts';
import { cfdi_round } from './cfdi-money.util.ts';
import type { ImperiumStore } from './store.ts';

export type CfdiValidationIssue = {
	code: string;
	path: string;
	message: string;
	severity: 'error' | 'warning';
	sat_hint?: string;
};

export type CfdiValidationContext = {
	catalog_exists?: (catalog: string, code: string) => boolean | Promise<boolean>;
};

const RFC_GENERIC_NACIONAL = 'XAXX010101000';
const RFC_GENERIC_EXTRANJERO = 'XEXX010101000';

export function is_rfc_format_valid(rfc: string): boolean {
	const value = (rfc ?? '').trim().toUpperCase();
	if (value === RFC_GENERIC_NACIONAL || value === RFC_GENERIC_EXTRANJERO) return true;
	return /^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/.test(value);
}

function issue(
	code: string,
	path: string,
	message: string,
	severity: 'error' | 'warning' = 'error',
	sat_hint?: string,
): CfdiValidationIssue {
	return { code, path, message, severity, sat_hint };
}

export async function catalog_exists(
	store: ImperiumStore,
	catalog: string,
	code: string,
): Promise<boolean> {
	if (!store.has('cfdi-catalog')) return false;
	const trimmed = String(code ?? '').trim();
	if (!trimmed) return false;
	const { total } = await store.find_many('cfdi-catalog', {
		where: { catalog, code: trimmed },
		take: 1,
	});
	return total > 0;
}

export async function validate_cfdi_canonical(
	doc: CfdiCanonical,
	ctx: CfdiValidationContext = {},
): Promise<CfdiValidationIssue[]> {
	const issues: CfdiValidationIssue[] = [];

	if (doc.version !== '4.0') {
		issues.push(issue('CFDI_E001', 'version', `Version debe ser "4.0", recibido "${doc.version}"`));
	}

	const c = doc.comprobante;
	if (!c?.fecha) {
		issues.push(issue('CFDI_E010', 'comprobante.fecha', 'Fecha de emisión requerida'));
	}
	if (!c?.moneda) {
		issues.push(issue('CFDI_E011', 'comprobante.moneda', 'Moneda requerida'));
	}
	if (!c?.tipo_de_comprobante) {
		issues.push(issue('CFDI_E012', 'comprobante.tipo_de_comprobante', 'TipoDeComprobante requerido'));
	}
	if (!c?.exportacion) {
		issues.push(issue('CFDI_E013', 'comprobante.exportacion', 'Exportacion requerida'));
	}
	if (!c?.lugar_expedicion || !/^\d{5}$/.test(c.lugar_expedicion)) {
		issues.push(
			issue(
				'CFDI_E014',
				'comprobante.lugar_expedicion',
				'LugarExpedicion debe ser un código postal de 5 dígitos',
			),
		);
	}
	if (typeof c?.subtotal !== 'number' || c.subtotal < 0) {
		issues.push(issue('CFDI_E015', 'comprobante.subtotal', 'SubTotal inválido'));
	}
	if (typeof c?.total !== 'number' || c.total < 0) {
		issues.push(issue('CFDI_E016', 'comprobante.total', 'Total inválido'));
	}

	if (!doc.emisor?.rfc || !is_rfc_format_valid(doc.emisor.rfc)) {
		issues.push(issue('CFDI_E020', 'emisor.rfc', 'RFC del emisor inválido'));
	}
	if (!doc.emisor?.nombre?.trim()) {
		issues.push(issue('CFDI_E021', 'emisor.nombre', 'Nombre del emisor requerido'));
	}
	if (!doc.emisor?.regimen_fiscal) {
		issues.push(issue('CFDI_E022', 'emisor.regimen_fiscal', 'Régimen fiscal del emisor requerido'));
	}

	if (!doc.receptor?.rfc || !is_rfc_format_valid(doc.receptor.rfc)) {
		issues.push(issue('CFDI_E030', 'receptor.rfc', 'RFC del receptor inválido'));
	}
	if (!doc.receptor?.nombre?.trim()) {
		issues.push(issue('CFDI_E031', 'receptor.nombre', 'Nombre del receptor requerido'));
	}
	if (!doc.receptor?.domicilio_fiscal_receptor || !/^\d{5}$/.test(doc.receptor.domicilio_fiscal_receptor)) {
		issues.push(
			issue(
				'CFDI_E032',
				'receptor.domicilio_fiscal_receptor',
				'DomicilioFiscalReceptor debe ser un código postal de 5 dígitos',
			),
		);
	}
	if (!doc.receptor?.regimen_fiscal_receptor) {
		issues.push(
			issue(
				'CFDI_E033',
				'receptor.regimen_fiscal_receptor',
				'Régimen fiscal del receptor requerido',
			),
		);
	}
	if (!doc.receptor?.uso_cfdi) {
		issues.push(issue('CFDI_E034', 'receptor.uso_cfdi', 'UsoCFDI requerido'));
	}

	if (!Array.isArray(doc.conceptos) || doc.conceptos.length === 0) {
		issues.push(issue('CFDI_E040', 'conceptos', 'Se requiere al menos un concepto'));
	} else {
		doc.conceptos.forEach((concepto, index) => {
			const base = `conceptos[${index}]`;
			if (!concepto.clave_prod_serv) {
				issues.push(issue('CFDI_E041', `${base}.clave_prod_serv`, 'ClaveProdServ requerida'));
			}
			if (!concepto.clave_unidad) {
				issues.push(issue('CFDI_E042', `${base}.clave_unidad`, 'ClaveUnidad requerida'));
			}
			if (!concepto.descripcion?.trim()) {
				issues.push(issue('CFDI_E043', `${base}.descripcion`, 'Descripción del concepto requerida'));
			}
			if (!(concepto.cantidad > 0)) {
				issues.push(issue('CFDI_E044', `${base}.cantidad`, 'Cantidad debe ser mayor a 0'));
			}
			if (concepto.valor_unitario < 0) {
				issues.push(issue('CFDI_E045', `${base}.valor_unitario`, 'ValorUnitario inválido'));
			}
			const expected = cfdi_round(concepto.cantidad * concepto.valor_unitario, 6);
			if (Math.abs(cfdi_round(concepto.importe, 2) - cfdi_round(expected, 2)) > 0.01) {
				issues.push(
					issue(
						'CFDI_E046',
						`${base}.importe`,
						`Importe ${concepto.importe} no cuadra con cantidad×valor (${expected})`,
					),
				);
			}
			if (!concepto.objeto_imp) {
				issues.push(issue('CFDI_E047', `${base}.objeto_imp`, 'ObjetoImp requerido'));
			}
		});
	}

	if (doc.conceptos?.length) {
		const sum = cfdi_round(
			doc.conceptos.reduce((acc, x) => acc + (x.importe || 0), 0),
			2,
		);
		if (Math.abs(sum - cfdi_round(c.subtotal, 2)) > 0.01) {
			issues.push(
				issue(
					'CFDI_E050',
					'comprobante.subtotal',
					`SubTotal ${c.subtotal} no cuadra con suma de conceptos ${sum}`,
				),
			);
		}
	}

	issues.push(...validate_profile_rules(doc.perfil_emision, doc));

	if (ctx.catalog_exists) {
		const checks: Array<[string, string | undefined, string]> = [
			['c_RegimenFiscal', doc.emisor?.regimen_fiscal, 'emisor.regimen_fiscal'],
			['c_RegimenFiscal', doc.receptor?.regimen_fiscal_receptor, 'receptor.regimen_fiscal_receptor'],
			['c_UsoCFDI', doc.receptor?.uso_cfdi, 'receptor.uso_cfdi'],
			['c_Moneda', c?.moneda, 'comprobante.moneda'],
			['c_CodigoPostal', c?.lugar_expedicion, 'comprobante.lugar_expedicion'],
			['c_CodigoPostal', doc.receptor?.domicilio_fiscal_receptor, 'receptor.domicilio_fiscal_receptor'],
		];
		for (const [catalog, code, path] of checks) {
			if (!code) continue;
			const ok = await ctx.catalog_exists(catalog, code);
			if (!ok) {
				issues.push(
					issue('CFDI_E060', path, `Clave "${code}" no encontrada en catálogo ${catalog}`, 'error', catalog),
				);
			}
		}
		for (let i = 0; i < (doc.conceptos?.length ?? 0); i++) {
			const concepto = doc.conceptos[i]!;
			if (concepto.clave_prod_serv) {
				const ok = await ctx.catalog_exists('c_ClaveProdServ', concepto.clave_prod_serv);
				if (!ok) {
					issues.push(
						issue(
							'CFDI_E061',
							`conceptos[${i}].clave_prod_serv`,
							`ClaveProdServ "${concepto.clave_prod_serv}" no está en catálogo`,
							'warning',
						),
					);
				}
			}
			if (concepto.clave_unidad) {
				const ok = await ctx.catalog_exists('c_ClaveUnidad', concepto.clave_unidad);
				if (!ok) {
					issues.push(
						issue(
							'CFDI_E062',
							`conceptos[${i}].clave_unidad`,
							`ClaveUnidad "${concepto.clave_unidad}" no está en catálogo`,
							'warning',
						),
					);
				}
			}
		}
	}

	return issues;
}

function validate_profile_rules(
	perfil: CfdiPerfilEmision | undefined,
	doc: CfdiCanonical,
): CfdiValidationIssue[] {
	const issues: CfdiValidationIssue[] = [];
	if (perfil !== 'dpa_gobierno') return issues;
	if (doc.comprobante.moneda && doc.comprobante.moneda !== 'MXN') {
		issues.push(issue('CFDI_E070', 'comprobante.moneda', 'Perfil DPA: Moneda debe ser MXN'));
	}
	if (doc.comprobante.tipo_cambio != null) {
		issues.push(issue('CFDI_E071', 'comprobante.tipo_cambio', 'Perfil DPA: TipoCambio no debe enviarse'));
	}
	if (doc.comprobante.exportacion && doc.comprobante.exportacion !== '01') {
		issues.push(
			issue('CFDI_E072', 'comprobante.exportacion', 'Perfil DPA: Exportacion típica es 01', 'warning'),
		);
	}
	const has_retenciones =
		!!doc.impuestos?.retenciones?.length ||
		doc.conceptos?.some((line) => line.impuestos?.retenciones?.length);
	if (has_retenciones) {
		issues.push(
			issue(
				'CFDI_E073',
				'impuestos.retenciones',
				'Perfil DPA (derechos/contribuciones): el nodo de retenciones no debe existir',
			),
		);
	}
	return issues;
}

export function has_cfdi_errors(issues: CfdiValidationIssue[]): boolean {
	return issues.some((item) => item.severity === 'error');
}

export async function run_cfdi_validation(store: ImperiumStore, doc: CfdiCanonical) {
	return validate_cfdi_canonical(doc, {
		catalog_exists: (catalog, code) => catalog_exists(store, catalog, code),
	});
}
