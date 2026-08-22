/**
 * Pure builders: plain invoice-request-shaped data → CfdiCanonical.
 * No Mongoose / I/O — services load records and call these functions.
 */

import {
    CfdiCanonical,
    CfdiConcepto,
    CfdiImpuestoDetalle,
    CfdiImpuestosTotales,
    CfdiPerfilEmision,
} from "./cfdi-xml.ts";
import { cfdi_round, sum_amounts } from "./cfdi-money.util.ts";

/** Default IVA rate (16%) for objeto_imp "02" concepts. */
export const CFDI_DEFAULT_IVA_RATE = 0.16;

/** SAT ObjetoImp: subject to tax. */
export const CFDI_OBJETO_IMP_SI = "02";

/** SAT ObjetoImp: not subject to tax. */
export const CFDI_OBJETO_IMP_NO = "01";

/** One concept line before importe / tax computation. */
export interface CfdiBuilderConceptoInput {
    clave_prod_serv?: string;
    clave_unidad: string;
    descripcion: string;
    cantidad: number;
    valor_unitario: number;
    no_identificacion?: string;
    /** Defaults to "02" (Sí objeto de impuesto) when omitted. */
    objeto_imp?: string;
    unidad?: string;
}

/**
 * Plain input for `build_cfdi_from_invoice_request_data`.
 * All values are primitives / plain objects (no Mongoose docs required).
 */
export interface CfdiBuilderInput {
    perfil_emision: CfdiPerfilEmision;
    emisor: {
        rfc: string;
        nombre: string;
        regimen_fiscal: string;
    };
    receptor: {
        rfc: string;
        nombre: string;
        domicilio_fiscal_receptor: string;
        regimen_fiscal_receptor: string;
        uso_cfdi: string;
    };
    lugar_expedicion: string;
    serie?: string;
    folio?: string;
    /** ISO-like fecha (YYYY-MM-DDTHH:mm:ss); defaults to now (UTC, no ms/Z). */
    fecha?: string;
    forma_pago?: string;
    metodo_pago?: string;
    moneda?: string;
    conceptos: CfdiBuilderConceptoInput[];
    source_id?: string;
    /** IVA tasa (e.g. 0.16). Applied only when objeto_imp === "02". */
    iva_rate?: number;
}

/** Loose product row used when mapping invoice-request lines. */
export interface CfdiBuilderProductMapEntry {
    clave_prod_serv?: string;
    objeto_imp_default?: string;
    clave_unidad?: string;
    unidad?: string;
    name?: string;
    code?: string;
}

/** Loose line from InvoiceRequest / subpedido articulo. */
export interface CfdiBuilderLineItemLike {
    product?: string | { _id?: string; toString?: () => string };
    product_name?: string;
    product_code?: string;
    descripcion?: string;
    cantidad_facturable?: number;
    cantidad?: number;
    precio_unitario?: number;
    valor_unitario?: number;
    monto_total?: number;
    no_identificacion?: string;
    clave_prod_serv?: string;
    clave_unidad?: string;
    objeto_imp?: string;
    unidad?: string;
}

/** Loose issuer profile fields. */
export interface CfdiBuilderIssuerLike {
    rfc: string;
    nombre_fiscal?: string;
    name?: string;
    regimen_fiscal: string;
    lugar_expedicion: string;
    serie_default?: string;
    folio_siguiente?: number | string;
    perfil_emision_default?: string;
}

/** Loose contact / receptor fields. */
export interface CfdiBuilderReceptorLike {
    rfc?: string;
    nombre_fiscal?: string;
    name?: string;
    /** Prefer explicit CFDI CP; fall back to codigoPostal. */
    domicilio_fiscal_receptor?: string;
    codigoPostal?: string;
    codigo_postal?: string;
    regimen_fiscal?: string;
    regimen_fiscal_receptor?: string;
    uso_cfdi?: string;
    uso_cfdi_default?: string;
}

/**
 * Loose invoice-request (+ optional pre-resolved receptor / lines).
 * Used only by the mapping helper — not required by the pure builder.
 */
export interface CfdiBuilderInvoiceRequestRecordLike {
    _id?: string | { toString(): string };
    contacto_nombre?: string;
    contacto_rfc?: string;
    receptor?: CfdiBuilderReceptorLike;
    /** Pre-flattened facturable lines (service can pass articulos already mapped). */
    lineas?: CfdiBuilderLineItemLike[];
    /** Nested shape some loaders expose: subpedidos[].articulos[]. */
    subpedidos?: Array<{ articulos?: CfdiBuilderLineItemLike[] }>;
    forma_pago?: string;
    metodo_pago?: string;
    moneda?: string;
    fecha?: string;
    serie?: string;
    folio?: string;
    iva_rate?: number;
    perfil_emision?: string;
    lugar_expedicion?: string;
}

function as_id_string(
    value: string | { _id?: string; toString?: () => string } | undefined,
): string {
    if (value == null) return "";
    if (typeof value === "string") return value;
    if (typeof value._id === "string") return value._id;
    if (typeof value.toString === "function") {
        const s = value.toString();
        return s === "[object Object]" ? "" : s;
    }
    return "";
}

function default_fecha_emision(): string {
    // SAT-style local-ish stamp without ms or Z suffix.
    return new Date().toISOString().slice(0, 19);
}

function resolve_objeto_imp(
    raw: string | undefined,
    perfil: CfdiPerfilEmision,
): string {
    const value = (raw ?? "").trim();
    if (value) return value;
    // DPA defaults to non-taxable; commercial to subject-of-tax.
    return perfil === "dpa_gobierno" ? CFDI_OBJETO_IMP_NO : CFDI_OBJETO_IMP_SI;
}

function build_concepto(
    line: CfdiBuilderConceptoInput,
    perfil: CfdiPerfilEmision,
    iva_rate: number,
): CfdiConcepto {
    const cantidad = Number(line.cantidad) || 0;
    const valor_unitario = Number(line.valor_unitario) || 0;
    const importe = cfdi_round(cantidad * valor_unitario, 2);
    const objeto_imp = resolve_objeto_imp(line.objeto_imp, perfil);

    const concepto: CfdiConcepto = {
        clave_prod_serv: line.clave_prod_serv ?? "",
        cantidad,
        clave_unidad: line.clave_unidad ?? "",
        descripcion: line.descripcion ?? "",
        valor_unitario: cfdi_round(valor_unitario, 6),
        importe,
        objeto_imp,
    };

    if (line.no_identificacion) {
        concepto.no_identificacion = line.no_identificacion;
    }
    if (line.unidad) {
        concepto.unidad = line.unidad;
    }

    if (objeto_imp === CFDI_OBJETO_IMP_SI && iva_rate > 0) {
        const iva_importe = cfdi_round(importe * iva_rate, 2);
        const traslado: CfdiImpuestoDetalle = {
            base: importe,
            impuesto: "002",
            tipo_factor: "Tasa",
            tasa_o_cuota: iva_rate,
            importe: iva_importe,
        };
        concepto.impuestos = { traslados: [traslado] };
    }

    return concepto;
}

/**
 * Builds a full `CfdiCanonical` draft from plain invoice-request-shaped data.
 * Does not validate catalogs — missing ClaveProdServ still produces a document
 * (validator reports CFDI_E041 later).
 */
export function build_cfdi_from_invoice_request_data(
    input: CfdiBuilderInput,
): CfdiCanonical {
    const iva_rate =
        input.iva_rate != null && Number.isFinite(input.iva_rate)
            ? Number(input.iva_rate)
            : CFDI_DEFAULT_IVA_RATE;

    const perfil = input.perfil_emision ?? "comercial";
    const conceptos = (input.conceptos ?? []).map((line) =>
        build_concepto(line, perfil, iva_rate),
    );

    const subtotal = sum_amounts(conceptos.map((c) => c.importe));

    const traslados_detalle: CfdiImpuestoDetalle[] = [];
    for (const c of conceptos) {
        for (const t of c.impuestos?.traslados ?? []) {
            traslados_detalle.push(t);
        }
    }

    let impuestos: CfdiImpuestosTotales | undefined;
    let total_iva = 0;
    if (traslados_detalle.length > 0) {
        // Collapse same impuesto/tasa into one document-level traslado (MVP: one IVA rate).
        const by_key = new Map<string, CfdiImpuestoDetalle>();
        for (const t of traslados_detalle) {
            const key = `${t.impuesto}|${t.tipo_factor}|${t.tasa_o_cuota ?? ""}`;
            const prev = by_key.get(key);
            if (!prev) {
                by_key.set(key, { ...t });
            } else {
                prev.base = cfdi_round((prev.base ?? 0) + (t.base ?? 0), 2);
                prev.importe = cfdi_round(
                    (prev.importe ?? 0) + (t.importe ?? 0),
                    2,
                );
            }
        }
        const traslados = Array.from(by_key.values());
        total_iva = sum_amounts(traslados.map((t) => t.importe ?? 0));
        impuestos = {
            total_impuestos_trasladados: total_iva,
            traslados,
        };
    }

    const total = cfdi_round(subtotal + total_iva, 2);

    const doc: CfdiCanonical = {
        version: "4.0",
        perfil_emision: perfil,
        comprobante: {
            fecha: input.fecha?.trim() || default_fecha_emision(),
            forma_pago: input.forma_pago || "03",
            metodo_pago: input.metodo_pago || "PUE",
            moneda: input.moneda || "MXN",
            tipo_de_comprobante: "I",
            exportacion: "01",
            lugar_expedicion: input.lugar_expedicion,
            subtotal,
            total,
        },
        emisor: {
            rfc: (input.emisor?.rfc ?? "").trim().toUpperCase(),
            nombre: input.emisor?.nombre ?? "",
            regimen_fiscal: input.emisor?.regimen_fiscal ?? "",
        },
        receptor: {
            rfc: (input.receptor?.rfc ?? "").trim().toUpperCase(),
            nombre: input.receptor?.nombre ?? "",
            domicilio_fiscal_receptor:
                input.receptor?.domicilio_fiscal_receptor ?? "",
            regimen_fiscal_receptor:
                input.receptor?.regimen_fiscal_receptor ?? "",
            uso_cfdi: input.receptor?.uso_cfdi ?? "",
        },
        conceptos,
        meta: {
            source: "invoice_request",
            validation: { status: "draft", errors: [] },
            json_revision: 1,
        },
    };

    if (input.serie != null && String(input.serie).length > 0) {
        doc.comprobante.serie = String(input.serie);
    }
    if (input.folio != null && String(input.folio).length > 0) {
        doc.comprobante.folio = String(input.folio);
    }
    if (input.source_id) {
        doc.meta.source_id = String(input.source_id);
    }
    if (impuestos) {
        doc.impuestos = impuestos;
    }

    return doc;
}

/**
 * Maps loaded invoice-request + issuer (+ optional product catalog map) into
 * `CfdiBuilderInput`. Pure — does not hit the DB.
 *
 * `product_map` keys are product ids (string). When a line has no SAT keys,
 * values are taken from the map entry if present.
 */
export function map_invoice_request_record_to_builder_input(
    record: CfdiBuilderInvoiceRequestRecordLike,
    issuer: CfdiBuilderIssuerLike,
    product_map: Record<string, CfdiBuilderProductMapEntry> = {},
): CfdiBuilderInput {
    const raw_lines: CfdiBuilderLineItemLike[] = [];
    if (Array.isArray(record.lineas)) {
        raw_lines.push(...record.lineas);
    }
    if (Array.isArray(record.subpedidos)) {
        for (const sp of record.subpedidos) {
            if (Array.isArray(sp?.articulos)) {
                raw_lines.push(...sp.articulos);
            }
        }
    }

    const conceptos: CfdiBuilderConceptoInput[] = raw_lines.map((line) => {
        const product_id = as_id_string(line.product as string | undefined);
        const mapped = product_id ? product_map[product_id] : undefined;

        const cantidad =
            line.cantidad_facturable ?? line.cantidad ?? 0;
        const valor_unitario =
            line.precio_unitario ?? line.valor_unitario ?? 0;

        const concepto: CfdiBuilderConceptoInput = {
            clave_prod_serv:
                line.clave_prod_serv ?? mapped?.clave_prod_serv ?? "",
            clave_unidad: line.clave_unidad ?? mapped?.clave_unidad ?? "",
            descripcion:
                line.descripcion ||
                line.product_name ||
                mapped?.name ||
                "",
            cantidad: Number(cantidad) || 0,
            valor_unitario: Number(valor_unitario) || 0,
            objeto_imp:
                line.objeto_imp ??
                mapped?.objeto_imp_default ??
                undefined,
        };

        const no_id =
            line.no_identificacion || line.product_code || mapped?.code;
        if (no_id) concepto.no_identificacion = no_id;

        const unidad = line.unidad || mapped?.unidad;
        if (unidad) concepto.unidad = unidad;

        return concepto;
    });

    const receptor_src = record.receptor ?? {};
    const receptor = {
        rfc: (
            receptor_src.rfc ||
            record.contacto_rfc ||
            ""
        )
            .trim()
            .toUpperCase(),
        nombre:
            receptor_src.nombre_fiscal ||
            receptor_src.name ||
            record.contacto_nombre ||
            "",
        domicilio_fiscal_receptor:
            receptor_src.domicilio_fiscal_receptor ||
            receptor_src.codigoPostal ||
            receptor_src.codigo_postal ||
            "",
        regimen_fiscal_receptor:
            receptor_src.regimen_fiscal_receptor ||
            receptor_src.regimen_fiscal ||
            "",
        uso_cfdi:
            receptor_src.uso_cfdi ||
            receptor_src.uso_cfdi_default ||
            "",
    };

    const perfil_raw =
        record.perfil_emision || issuer.perfil_emision_default || "comercial";
    const perfil_emision: CfdiPerfilEmision =
        perfil_raw === "dpa_gobierno" ? "dpa_gobierno" : "comercial";

    const source_id =
        record._id != null
            ? typeof record._id === "string"
                ? record._id
                : record._id.toString()
            : undefined;

    const folio_from_issuer =
        issuer.folio_siguiente != null
            ? String(issuer.folio_siguiente)
            : undefined;

    return {
        perfil_emision,
        emisor: {
            rfc: (issuer.rfc ?? "").trim().toUpperCase(),
            nombre: issuer.nombre_fiscal || issuer.name || "",
            regimen_fiscal: issuer.regimen_fiscal ?? "",
        },
        receptor,
        lugar_expedicion:
            record.lugar_expedicion || issuer.lugar_expedicion || "",
        serie: record.serie ?? issuer.serie_default,
        folio: record.folio ?? folio_from_issuer,
        fecha: record.fecha,
        forma_pago: record.forma_pago,
        metodo_pago: record.metodo_pago,
        moneda: record.moneda,
        conceptos,
        source_id,
        iva_rate: record.iva_rate,
    };
}
