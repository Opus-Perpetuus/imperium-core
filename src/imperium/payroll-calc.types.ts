/**
 * Pure payroll calculation contracts (no I/O, no Mongoose).
 * Used by `calculate_payroll_receipt` and by the period draft generator.
 */

/** Employee snapshot fields required (or useful) for calculation. */
export interface CalcEmployeeInput {
  name: string;
  rfc?: string;
  curp?: string;
  nss?: string;
  num_empleado?: string;
  salario_diario?: number;
  sdi?: number;
  tipo_contrato?: string;
  tipo_regimen?: string;
  tipo_jornada?: string;
  periodicidad_pago?: string;
  clave_ent_fed?: string;
  fecha_ingreso?: Date | string | null;
  fecha_baja?: Date | string | null;
}

/** Period dates and paid days for the corrida. */
export interface CalcPeriodInput {
  fecha_inicial: Date | string;
  fecha_final: Date | string;
  fecha_pago: Date | string;
  num_dias_pagados: number;
  tipo_nomina?: string;
  periodicidad_pago?: string;
}

/** Weekday hours from labor schedule (0=Sun … 6=Sat). */
export interface CalcScheduleDay {
  weekday: number;
  hours: number;
}

/** Labor incident that may affect paid days or lines. */
export interface CalcIncidentInput {
  tipo: string;
  fecha_inicio: Date | string;
  fecha_fin: Date | string;
  dias?: number;
  horas?: number;
  importe?: number;
  tipo_incapacidad?: string;
}

/** Full pure-function input. */
export interface CalcInput {
  employee: CalcEmployeeInput;
  period: CalcPeriodInput;
  schedule_days?: CalcScheduleDay[];
  incidents?: CalcIncidentInput[];
}

/** Receipt line category (mirrors PayrollReceiptLineCategoria). */
export type CalcLineCategoria =
  | "perception"
  | "deduction"
  | "other_payment"
  | "incapacity";

/** One calculated line of the receipt. */
export interface CalcLine {
  categoria: CalcLineCategoria;
  /** SAT type code (TipoPercepcion / TipoDeduccion / …). */
  tipo_sat: string;
  /** Internal clave (P001, D002, …). */
  clave: string;
  concepto: string;
  importe_gravado?: number;
  importe_exento?: number;
  /** Simple amount for deductions / other payments / incapacity. */
  importe?: number;
  /** Optional meta (e.g. disability tipo_incapacidad). */
  meta?: Record<string, unknown>;
}

/** Lifecycle hint after calculation (maps to PayrollReceiptStates subset). */
export type CalcResultEstado = "draft" | "calculated" | "ready_to_stamp";

/** Employee fiscal snapshot stored on the receipt. */
export interface CalcEmployeeSnapshot {
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
}

/** Pure calculation output. */
export interface CalcResult {
  lineas: CalcLine[];
  total_percepciones: number;
  total_deducciones: number;
  total_otros_pagos: number;
  neto: number;
  subsidio_causado?: number;
  /** Days used for payment after absences / disability. */
  num_dias_pagados: number;
  days_worked: number;
  calc_errors: string[];
  estado: CalcResultEstado;
  snapshot: CalcEmployeeSnapshot;
}

/** Effects produced by labor incident types. */
export type LaborIncidentCalcEffect =
  | "reduce_days"
  | "add_overtime"
  | "disability"
  | "ignore";
