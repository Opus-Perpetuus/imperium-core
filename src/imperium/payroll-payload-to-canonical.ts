/**
 * Maps nómina handoff JSON (build_payroll_cfdi_payload) → CfdiCanonical.
 * Shared path: payroll builds payload; Facturación stores/stamps via same PAC.
 */

import type { CfdiCanonical } from "./cfdi-xml.ts";
import { cfdi_round } from "./cfdi-money.util.ts";

/** ClaveProdServ SAT for payroll services. */
export const CLAVE_PROD_SERV_NOMINA = "84111505";
/** ClaveUnidad: Activity unit. */
export const CLAVE_UNIDAD_NOMINA = "ACT";

function as_num(value: unknown): number {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "") {
        const n = Number(value);
        if (Number.isFinite(n)) return n;
    }
    return 0;
}

function as_str(value: unknown): string {
    return String(value ?? "").trim();
}

/**
 * Converts a payroll CFDI N payload into the shared canonical tree.
 */
export function payroll_payload_to_canonical(
    payload: Record<string, unknown>,
    options?: {
        lugar_expedicion?: string;
        serie?: string;
        folio?: string;
        fecha?: string;
    },
): CfdiCanonical {
    const emisor_raw = (payload.emisor ?? {}) as Record<string, unknown>;
    const receptor_raw = (payload.receptor ?? {}) as Record<string, unknown>;
    const nomina = (payload.nomina ?? {}) as Record<string, unknown>;
    const meta_raw = (payload.meta ?? {}) as Record<string, unknown>;

    const total_percepciones = as_num(nomina.total_percepciones);
    const total_deducciones = as_num(nomina.total_deducciones);
    const total_otros = as_num(nomina.total_otros_pagos);
    // CFDI N: Total ≈ percepciones - deducciones (otros pagos often in complement).
    const subtotal = cfdi_round(total_percepciones, 2);
    const total = cfdi_round(
        Math.max(0, total_percepciones - total_deducciones),
        2,
    );

    const fecha_pago = as_str(nomina.fecha_pago);
    const fecha =
        options?.fecha ||
        (fecha_pago
            ? `${fecha_pago}T12:00:00`
            : new Date().toISOString().replace(/\.\d{3}Z$/, "").replace(/Z$/, ""));

    const lugar =
        options?.lugar_expedicion ||
        as_str(emisor_raw.lugar_expedicion) ||
        as_str(receptor_raw.domicilio_fiscal_receptor) ||
        "00000";

    const source = as_str(meta_raw.source) || 'payroll_receipt';
    const source_id = as_str(meta_raw.source_id) || undefined;

    return {
        version: "4.0",
        perfil_emision: "comercial",
        comprobante: {
            serie: options?.serie,
            folio: options?.folio,
            fecha,
            moneda: "MXN",
            tipo_de_comprobante: "N",
            exportacion: "01",
            lugar_expedicion: lugar,
            subtotal,
            total,
            // Nómina often omits forma/método pago on comprobante.
        },
        emisor: {
            rfc: as_str(emisor_raw.rfc),
            nombre: as_str(emisor_raw.nombre),
            regimen_fiscal: as_str(emisor_raw.regimen_fiscal) || "601",
        },
        receptor: {
            rfc: as_str(receptor_raw.rfc),
            nombre: as_str(receptor_raw.nombre),
            domicilio_fiscal_receptor: as_str(
                receptor_raw.domicilio_fiscal_receptor,
            ) || lugar,
            regimen_fiscal_receptor:
                as_str(receptor_raw.regimen_fiscal_receptor) || "605",
            uso_cfdi: as_str(receptor_raw.uso_cfdi) || "CN01",
        },
        conceptos: [
            {
                clave_prod_serv: CLAVE_PROD_SERV_NOMINA,
                cantidad: 1,
                clave_unidad: CLAVE_UNIDAD_NOMINA,
                unidad: "Actividad",
                descripcion: "Pago de nómina",
                valor_unitario: subtotal,
                importe: subtotal,
                objeto_imp: "01",
            },
        ],
        complemento: {
            nomina: {
                ...nomina,
                // Keep registro_patronal if present on emisor placeholders.
                ...(as_str(emisor_raw.registro_patronal)
                    ? {
                          emisor: {
                              registro_patronal: as_str(
                                  emisor_raw.registro_patronal,
                              ),
                          },
                      }
                    : {}),
            },
        },
        meta: {
            source: source === "payroll_receipt" ? "payroll_receipt" : source,
            source_id,
            validation: { status: "draft", errors: [] },
            json_revision: 1,
        },
    };
}
