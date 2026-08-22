/**
 * Pure mapper: calculated payroll-receipt → JSON payload for CFDI 4.0 tipo N.
 *
 * Does **not** stamp or talk to PAC. Facturación owns XML / pack / stamp.
 * Handoff N5 / rules N-11…N-18, N-31, N-34.
 */

/** Period context (from payroll-period) for fechas / tipo nómina. */
export type PayrollToCfdiPeriodContext = {
  tipo_nomina?: string;
  fecha_pago?: Date | string;
  fecha_inicial?: Date | string;
  fecha_final?: Date | string;
  num_dias_pagados?: number;
  periodicidad_pago?: string;
};

/** Optional overrides for the pure builder. */
export type PayrollToCfdiOptions = {
  period?: PayrollToCfdiPeriodContext;
  /** Emisor placeholders; default from env or empty (pack fills later). */
  emisor?: Record<string, unknown>;
};

/** Minimal line shape from PayrollReceipt.lineas. */
export type PayrollReceiptLineLike = {
  categoria?: string;
  tipo_sat?: string;
  clave?: string;
  concepto?: string;
  importe_gravado?: number;
  importe_exento?: number;
  importe?: number;
  /** Optional days for incapacity lines if present on a denormalized object. */
  dias_incapacidad?: number;
  [key: string]: unknown;
};

/** Minimal employee snapshot from PayrollReceipt.snapshot. */
export type PayrollReceiptSnapshotLike = {
  nombre?: string;
  rfc?: string;
  curp?: string;
  nss?: string;
  num_empleado?: string;
  salario_diario?: number;
  sdi?: number;
  tipo_contrato?: string;
  tipo_regimen?: string;
  periodicidad_pago?: string;
  clave_ent_fed?: string;
  /** CP fiscal del receptor (N-02 domicilio fiscal). */
  domicilio_fiscal_receptor?: string;
  postal_code?: string;
  [key: string]: unknown;
};

/** Plain receipt (lean / JSON) used by the mapper. */
export type PayrollReceiptLike = {
  _id?: unknown;
  id?: unknown;
  name?: string;
  payroll_period?: unknown;
  employee?: unknown;
  snapshot?: PayrollReceiptSnapshotLike;
  num_dias_pagados?: number;
  estado?: string;
  lineas?: PayrollReceiptLineLike[];
  total_percepciones?: number;
  total_deducciones?: number;
  total_otros_pagos?: number;
  neto?: number;
  subsidio_causado?: number;
  /** Denormalized period fields (optional). */
  tipo_nomina?: string;
  fecha_pago?: Date | string;
  fecha_inicial?: Date | string;
  fecha_final?: Date | string;
  fecha_inicial_pago?: Date | string;
  fecha_final_pago?: Date | string;
  periodicidad_pago?: string;
  [key: string]: unknown;
};

const CATEGORIA_PERCEPTION = "perception";
const CATEGORIA_DEDUCTION = "deduction";
const CATEGORIA_OTHER_PAYMENT = "other_payment";
const CATEGORIA_INCAPACITY = "incapacity";

/** SAT TipoOtroPago for employment subsidy (N-18). */
const TIPO_OTRO_PAGO_SUBSIDIO = "002";

/** Régimen fiscal receptor sueldos/salarios (catálogo CFDI). */
const RECEPTOR_REGIMEN_SUELDOS = "605";

/** UsoCFDI nómina. */
const USO_CFDI_NOMINA = "CN01";

/**
 * Formats a date value as `YYYY-MM-DD` for CFDI attributes.
 */
export function format_cfdi_date_only(
  value: Date | string | undefined | null
): string {
  if (value == null || value === "") return "";
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
      return trimmed.slice(0, 10);
    }
    const parsed = new Date(trimmed);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString().slice(0, 10);
    }
    return trimmed;
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  return "";
}

/**
 * Coerces a number; treats null/undefined/NaN as 0.
 */
function as_number(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

/**
 * Builds emisor placeholders (env or empty). Pack Facturación fills later (N-29).
 */
export function build_emisor_placeholders(
  override?: Record<string, unknown>
): Record<string, unknown> {
  if (override && Object.keys(override).length > 0) {
    return { ...override };
  }
  return {
    rfc: process.env.CFDI_EMISOR_RFC ?? process.env.NOMINA_EMISOR_RFC ?? "",
    nombre:
      process.env.CFDI_EMISOR_NOMBRE ?? process.env.NOMINA_EMISOR_NOMBRE ?? "",
    regimen_fiscal:
      process.env.CFDI_EMISOR_REGIMEN ??
      process.env.NOMINA_EMISOR_REGIMEN ??
      "",
    registro_patronal:
      process.env.CFDI_EMISOR_REGISTRO_PATRONAL ??
      process.env.NOMINA_EMISOR_REGISTRO_PATRONAL ??
      "",
  };
}

/**
 * Resolves source_id from a receipt plain object.
 */
function resolve_source_id(receipt: PayrollReceiptLike): string {
  if (receipt._id != null) return String(receipt._id);
  if (receipt.id != null) return String(receipt.id);
  return "";
}

/**
 * Maps receipt lineas into complemento nómina buckets by categoria.
 */
function map_lineas(
  lineas: PayrollReceiptLineLike[] | undefined,
  subsidio_causado: number | undefined
): {
  percepciones: Record<string, unknown>[];
  deducciones: Record<string, unknown>[];
  otros_pagos: Record<string, unknown>[];
  incapacidades: Record<string, unknown>[];
} {
  const percepciones: Record<string, unknown>[] = [];
  const deducciones: Record<string, unknown>[] = [];
  const otros_pagos: Record<string, unknown>[] = [];
  const incapacidades: Record<string, unknown>[] = [];

  for (const line of lineas ?? []) {
    const categoria = String(line.categoria ?? "").toLowerCase();
    const tipo_sat = String(line.tipo_sat ?? "").trim();
    const clave = String(line.clave ?? "").trim();
    const concepto = String(line.concepto ?? "").trim();

    if (categoria === CATEGORIA_PERCEPTION) {
      percepciones.push({
        tipo_percepcion: tipo_sat,
        clave,
        concepto,
        importe_gravado: as_number(line.importe_gravado),
        importe_exento: as_number(line.importe_exento),
      });
      continue;
    }

    if (categoria === CATEGORIA_DEDUCTION) {
      deducciones.push({
        tipo_deduccion: tipo_sat,
        clave,
        concepto,
        importe: as_number(
          line.importe != null
            ? line.importe
            : as_number(line.importe_gravado) + as_number(line.importe_exento)
        ),
      });
      continue;
    }

    if (categoria === CATEGORIA_OTHER_PAYMENT) {
      const row: Record<string, unknown> = {
        tipo_otro_pago: tipo_sat,
        clave,
        concepto,
        importe: as_number(line.importe),
      };
      // N-18: TipoOtroPago 002 carries SubsidioCausado.
      if (tipo_sat === TIPO_OTRO_PAGO_SUBSIDIO) {
        row.subsidio_al_empleo = {
          subsidio_causado: as_number(subsidio_causado),
        };
      }
      otros_pagos.push(row);
      continue;
    }

    if (categoria === CATEGORIA_INCAPACITY) {
      const row: Record<string, unknown> = {
        tipo_incapacidad: tipo_sat,
        importe: as_number(line.importe),
      };
      if (line.dias_incapacidad != null) {
        row.dias_incapacidad = as_number(line.dias_incapacidad);
      }
      incapacidades.push(row);
    }
  }

  return { percepciones, deducciones, otros_pagos, incapacidades };
}

/**
 * Maps a calculated payroll-receipt (plain object) to a CFDI 4.0 tipo N payload.
 *
 * Pure: no I/O, no mongoose. Period dates come from `options.period` or
 * denormalized fields on the receipt.
 */
export function build_payroll_cfdi_payload(
  receipt: PayrollReceiptLike,
  options: PayrollToCfdiOptions = {}
): Record<string, unknown> {
  const snapshot = receipt.snapshot ?? {};
  const period = options.period ?? {};

  const tipo_nomina =
    period.tipo_nomina ?? receipt.tipo_nomina ?? "O";
  const fecha_pago = format_cfdi_date_only(
    period.fecha_pago ?? receipt.fecha_pago
  );
  const fecha_inicial_pago = format_cfdi_date_only(
    period.fecha_inicial ??
      receipt.fecha_inicial_pago ??
      receipt.fecha_inicial
  );
  const fecha_final_pago = format_cfdi_date_only(
    period.fecha_final ?? receipt.fecha_final_pago ?? receipt.fecha_final
  );
  const num_dias_pagados = as_number(
    period.num_dias_pagados ?? receipt.num_dias_pagados
  );
  const periodicidad_pago =
    period.periodicidad_pago ??
    receipt.periodicidad_pago ??
    snapshot.periodicidad_pago ??
    "";

  const { percepciones, deducciones, otros_pagos, incapacidades } = map_lineas(
    receipt.lineas,
    receipt.subsidio_causado
  );

  const domicilio =
    snapshot.domicilio_fiscal_receptor ??
    snapshot.postal_code ??
    undefined;

  const receptor_cfdi: Record<string, unknown> = {
    rfc: snapshot.rfc ?? "",
    nombre: snapshot.nombre ?? "",
    curp: snapshot.curp ?? "",
    regimen_fiscal_receptor: RECEPTOR_REGIMEN_SUELDOS,
    uso_cfdi: USO_CFDI_NOMINA,
  };
  if (domicilio) {
    receptor_cfdi.domicilio_fiscal_receptor = String(domicilio);
  }

  const nomina_receptor: Record<string, unknown> = {
    curp: snapshot.curp ?? "",
    num_empleado: snapshot.num_empleado ?? "",
    tipo_contrato: snapshot.tipo_contrato ?? "",
    tipo_regimen: snapshot.tipo_regimen ?? "",
    periodicidad_pago,
    clave_ent_fed: snapshot.clave_ent_fed ?? "",
  };
  if (snapshot.nss) nomina_receptor.nss = snapshot.nss;
  if (snapshot.sdi != null) nomina_receptor.sdi = as_number(snapshot.sdi);
  if (snapshot.salario_diario != null) {
    nomina_receptor.salario_diario = as_number(snapshot.salario_diario);
  }

  const nomina: Record<string, unknown> = {
    version: "1.2",
    tipo_nomina,
    fecha_pago,
    fecha_inicial_pago,
    fecha_final_pago,
    num_dias_pagados,
    total_percepciones: as_number(receipt.total_percepciones),
    total_deducciones: as_number(receipt.total_deducciones),
    total_otros_pagos: as_number(receipt.total_otros_pagos),
    receptor: nomina_receptor,
    percepciones,
    deducciones,
    otros_pagos,
  };

  if (incapacidades.length > 0) {
    nomina.incapacidades = incapacidades;
  }

  if (receipt.subsidio_causado != null) {
    nomina.subsidio_causado = as_number(receipt.subsidio_causado);
  }

  return {
    version: "4.0",
    tipo_de_comprobante: "N",
    meta: {
      source: "payroll_receipt",
      source_id: resolve_source_id(receipt),
    },
    emisor: build_emisor_placeholders(options.emisor),
    receptor: receptor_cfdi,
    nomina,
  };
}
