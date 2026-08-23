import { resolve_incident_effect } from './payroll-incidence.map.ts';
import {
	CalcIncidentInput,
	CalcInput,
	CalcLine,
	CalcResult,
	CalcScheduleDay,
} from './payroll-calc.types.ts';

// (o==================================================================o)
//   #region CONSTANTS
// (o-----------------------------------------------------------\/-----o)

/** Average month length used to annualize / de-annualize ISR. */
const DAYS_PER_MONTH = 30.4;

/** Standard daily hours for overtime daily-rate conversion. */
const HOURS_PER_DAY = 8;

/** Double time factor for simplified overtime (hours × daily_rate/8 × 2). */
const OVERTIME_FACTOR = 2;

/** Simplified IMSS worker share (documentado como simplificado). */
const IMSS_WORKER_RATE = 0.02375;

/**
 * Tabla ISR mensual 2025 Anexo 8 (simplificada):
 * limite_inferior, cuota_fija, porcentaje sobre excedente.
 */
const ISR_MONTHLY_BRACKETS_2025: ReadonlyArray<{
  lim_inf: number;
  cuota_fija: number;
  pct: number;
}> = [
  { lim_inf: 0.01, cuota_fija: 0, pct: 1.92 },
  { lim_inf: 746.05, cuota_fija: 14.32, pct: 6.4 },
  { lim_inf: 6332.05, cuota_fija: 371.83, pct: 10.88 },
  { lim_inf: 11128.01, cuota_fija: 894.63, pct: 16 },
  { lim_inf: 12935.82, cuota_fija: 1183.8, pct: 17.92 },
  { lim_inf: 15487.71, cuota_fija: 1631.47, pct: 21.36 },
  { lim_inf: 31236.49, cuota_fija: 5001.13, pct: 23.52 },
  { lim_inf: 49233.01, cuota_fija: 9236.89, pct: 30 },
  { lim_inf: 93993.91, cuota_fija: 22665.17, pct: 32 },
  { lim_inf: 125325.21, cuota_fija: 32691.18, pct: 34 },
  { lim_inf: 375487.51, cuota_fija: 117912.32, pct: 35 },
];

/** Upper bound of the first ISR bracket (for subsidio stub). */
const FIRST_BRACKET_CEILING = 746.04;

/** Flat subsidio stub when ISR is zero and income is low. */
const SUBSIDIO_STUB_AMOUNT = 200;

// (o-----------------------------------------------------------/\-----o)
//   #endregion CONSTANTS
// (o==================================================================o)

// (o==================================================================o)
//   #region HELPERS
// (o-----------------------------------------------------------\/-----o)

/**
 * Rounds a money amount to 2 decimal places (half-up via Number.EPSILON).
 */
function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * Parses a date-like value into a Date at local midnight (date-only comparison).
 */
function to_date_only(value: Date | string): Date {
  const d = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * Inclusive calendar-day span between two dates (min 0).
 */
function inclusive_day_count(start: Date, end: Date): number {
  const ms = end.getTime() - start.getTime();
  if (ms < 0) return 0;
  return Math.floor(ms / (24 * 60 * 60 * 1000)) + 1;
}

/**
 * Overlap of incident range with period range, in inclusive calendar days.
 */
function overlap_days(
  period_start: Date,
  period_end: Date,
  incident_start: Date,
  incident_end: Date
): number {
  const start =
    incident_start.getTime() > period_start.getTime()
      ? incident_start
      : period_start;
  const end =
    incident_end.getTime() < period_end.getTime() ? incident_end : period_end;
  return inclusive_day_count(start, end);
}

/**
 * Whether two date ranges (inclusive) intersect.
 */
function ranges_overlap(
  a_start: Date,
  a_end: Date,
  b_start: Date,
  b_end: Date
): boolean {
  return a_start.getTime() <= b_end.getTime() && b_start.getTime() <= a_end.getTime();
}

/**
 * Default Mon–Fri schedule (8h) when none is provided.
 */
function default_schedule_days(): CalcScheduleDay[] {
  return [1, 2, 3, 4, 5].map((weekday) => ({ weekday, hours: 8 }));
}

/**
 * Progressive monthly ISR from the 2025 Anexo 8 simplified table.
 */
function isr_monthly(taxable_monthly: number): number {
  if (taxable_monthly <= 0) return 0;
  let bracket = ISR_MONTHLY_BRACKETS_2025[0];
  for (const candidate of ISR_MONTHLY_BRACKETS_2025) {
    if (taxable_monthly >= candidate.lim_inf) {
      bracket = candidate;
    } else {
      break;
    }
  }
  const excedente = Math.max(0, taxable_monthly - bracket.lim_inf);
  return round2(bracket.cuota_fija + (excedente * bracket.pct) / 100);
}

/**
 * Sum of perception amounts (gravado + exento, or importe).
 */
function perception_amount(line: CalcLine): number {
  if (line.categoria !== "perception") return 0;
  const gravado = line.importe_gravado ?? 0;
  const exento = line.importe_exento ?? 0;
  if (gravado > 0 || exento > 0) return gravado + exento;
  return line.importe ?? 0;
}

/**
 * N-16: perception with both gravado and exento zero (or missing) is invalid.
 * Returns true when the line should be emitted / is valid.
 */
function is_valid_perception_amounts(
  gravado: number | undefined,
  exento: number | undefined
): boolean {
  const g = gravado ?? 0;
  const e = exento ?? 0;
  return g > 0 || e > 0;
}

// (o-----------------------------------------------------------/\-----o)
//   #endregion HELPERS
// (o==================================================================o)

// (o==================================================================o)
//   #region ENGINE
// (o-----------------------------------------------------------\/-----o)

/**
 * Pure payroll receipt calculation.
 *
 * Simplified rules (MVP):
 * - base days = period.num_dias_pagados
 * - absences / unpaid permissions reduce days
 * - sueldo 001/P001 fully taxed
 * - overtime 019 double time (or importe)
 * - ISR progressive monthly table prorated by days/30.4
 * - IMSS obrero 2.375% of SDI × days
 * - subsidio stub when ISR is zero and income is low
 * - disability line + unpaid day reduction
 * - N-16: no zero/zero perception lines
 */
function calculate_payroll_receipt(input: CalcInput): CalcResult {
  const calc_errors: string[] = [];
  const lineas: CalcLine[] = [];

  const employee = input.employee ?? ({ name: "" } as CalcInput["employee"]);
  const period = input.period;
  const salario_diario = Number(employee.salario_diario ?? 0);
  const sdi = Number(employee.sdi ?? 0) || salario_diario;
  const base_days = Number(period?.num_dias_pagados ?? 0);

  const snapshot = {
    nombre: employee.name,
    rfc: employee.rfc,
    curp: employee.curp,
    nss: employee.nss,
    num_empleado: employee.num_empleado,
    salario_diario: salario_diario > 0 ? salario_diario : undefined,
    sdi: sdi > 0 ? sdi : undefined,
    tipo_contrato: employee.tipo_contrato,
    tipo_regimen: employee.tipo_regimen,
    periodicidad_pago:
      employee.periodicidad_pago ?? period?.periodicidad_pago,
    clave_ent_fed: employee.clave_ent_fed,
  };

  if (!period) {
    calc_errors.push("Falta el periodo de nómina para el cálculo");
    return empty_result(snapshot, calc_errors);
  }

  if (!(salario_diario > 0)) {
    calc_errors.push("El empleado no tiene salario_diario válido (> 0)");
  }

  if (!(base_days > 0)) {
    calc_errors.push("num_dias_pagados del periodo debe ser mayor a 0");
  }

  const period_start = to_date_only(period.fecha_inicial);
  const period_end = to_date_only(period.fecha_final);
  const days_in_period = Math.max(base_days, 0.001);

  // Schedule is accepted for future use; MVP uses num_dias_pagados as base.
  void (input.schedule_days?.length
    ? input.schedule_days
    : default_schedule_days());

  let days_reduced = 0;
  let overtime_amount = 0;

  const incidents: CalcIncidentInput[] = input.incidents ?? [];
  for (const incident of incidents) {
    const i_start = to_date_only(incident.fecha_inicio);
    const i_end = to_date_only(incident.fecha_fin);
    if (!ranges_overlap(period_start, period_end, i_start, i_end)) {
      continue;
    }

    const effect = resolve_incident_effect(incident.tipo);
    const days_hit =
      typeof incident.dias === "number" && incident.dias >= 0
        ? incident.dias
        : overlap_days(period_start, period_end, i_start, i_end);

    if (effect === "reduce_days") {
      days_reduced += days_hit;
    } else if (effect === "add_overtime") {
      if (typeof incident.importe === "number" && incident.importe > 0) {
        overtime_amount += incident.importe;
      } else {
        const hours = Number(incident.horas ?? 0);
        if (hours > 0 && salario_diario > 0) {
          overtime_amount +=
            hours * (salario_diario / HOURS_PER_DAY) * OVERTIME_FACTOR;
        }
      }
    } else if (effect === "disability") {
      // Unpaid disability reduces paid days; paid disability still records the line.
      const unpaid =
        !(typeof incident.importe === "number" && incident.importe > 0);
      if (unpaid) {
        days_reduced += days_hit;
      }
      const incap_importe =
        typeof incident.importe === "number" && incident.importe > 0
          ? round2(incident.importe)
          : 0;
      lineas.push({
        categoria: "incapacity",
        tipo_sat: incident.tipo_incapacidad ?? "01",
        clave: "I001",
        concepto: "Incapacidad",
        importe: incap_importe,
        meta: {
          tipo_incapacidad: incident.tipo_incapacidad ?? "01",
          dias: days_hit,
        },
      });
    }
  }

  const days_worked = Math.max(0, round2(base_days - days_reduced));
  const sueldo = salario_diario > 0 ? round2(salario_diario * days_worked) : 0;
  overtime_amount = round2(overtime_amount);

  // Perception: Sueldo 001 / P001 (full gravado)
  if (is_valid_perception_amounts(sueldo, 0) && sueldo > 0) {
    lineas.push({
      categoria: "perception",
      tipo_sat: "001",
      clave: "P001",
      concepto: "Sueldo",
      importe_gravado: sueldo,
      importe_exento: 0,
    });
  }

  // Perception: Horas extra 019
  if (is_valid_perception_amounts(overtime_amount, 0) && overtime_amount > 0) {
    lineas.push({
      categoria: "perception",
      tipo_sat: "019",
      clave: "P019",
      concepto: "Horas extra",
      importe_gravado: overtime_amount,
      importe_exento: 0,
    });
  }

  const total_percepciones_gravadas = lineas
    .filter((l) => l.categoria === "perception")
    .reduce((acc, l) => acc + (l.importe_gravado ?? 0), 0);

  // ISR simplified: estimate monthly income from period taxable sueldo+OT
  const period_taxable = total_percepciones_gravadas;
  const monthly_income = round2(
    period_taxable * (DAYS_PER_MONTH / days_in_period)
  );
  const isr_month = isr_monthly(monthly_income);
  const isr_period = round2(isr_month * (days_in_period / DAYS_PER_MONTH));

  if (isr_period > 0) {
    lineas.push({
      categoria: "deduction",
      tipo_sat: "002",
      clave: "D002",
      concepto: "ISR",
      importe: isr_period,
    });
  }

  // IMSS obrero simplified: 2.375% of (sdi || salario_diario) * days_worked
  let imss = 0;
  if (sdi > 0 && days_worked > 0) {
    imss = round2(IMSS_WORKER_RATE * sdi * days_worked);
    if (imss > 0) {
      lineas.push({
        categoria: "deduction",
        tipo_sat: "001",
        clave: "D001",
        concepto: "IMSS (cuota obrera simplificada)",
        importe: imss,
      });
    }
  }

  // Subsidio stub: when ISR is zero and income is low
  let subsidio_causado = 0;
  if (isr_period === 0 && sueldo > 0) {
    if (monthly_income > 0 && monthly_income <= FIRST_BRACKET_CEILING) {
      subsidio_causado = SUBSIDIO_STUB_AMOUNT;
    }
    if (subsidio_causado > 0) {
      lineas.push({
        categoria: "other_payment",
        tipo_sat: "002",
        clave: "OP002",
        concepto: "Subsidio para el empleo",
        importe: subsidio_causado,
      });
    }
  }

  // N-16 guard: drop any perception that ended up with both gravado/exento 0
  const filtered_lineas = lineas.filter((line) => {
    if (line.categoria !== "perception") return true;
    const valid = is_valid_perception_amounts(
      line.importe_gravado,
      line.importe_exento
    );
    if (!valid) {
      calc_errors.push(
        `N-16: percepción ${line.clave} con gravado y exento en 0 omitida`
      );
    }
    return valid;
  });

  const total_percepciones = round2(
    filtered_lineas
      .filter((l) => l.categoria === "perception")
      .reduce((acc, l) => acc + perception_amount(l), 0)
  );
  const total_deducciones = round2(
    filtered_lineas
      .filter((l) => l.categoria === "deduction")
      .reduce((acc, l) => acc + (l.importe ?? 0), 0)
  );
  const total_otros_pagos = round2(
    filtered_lineas
      .filter((l) => l.categoria === "other_payment")
      .reduce((acc, l) => acc + (l.importe ?? 0), 0)
  );
  const neto = round2(
    total_percepciones - total_deducciones + total_otros_pagos
  );

  const estado =
    calc_errors.length === 0
      ? ("ready_to_stamp" as const)
      : total_percepciones > 0 || filtered_lineas.length > 0
        ? ("calculated" as const)
        : ("draft" as const);

  return {
    lineas: filtered_lineas,
    total_percepciones,
    total_deducciones,
    total_otros_pagos,
    neto,
    subsidio_causado: subsidio_causado > 0 ? subsidio_causado : undefined,
    num_dias_pagados: days_worked,
    days_worked,
    calc_errors,
    estado,
    snapshot,
  };
}

/**
 * Empty failed result with errors.
 */
function empty_result(
  snapshot: CalcResult["snapshot"],
  calc_errors: string[]
): CalcResult {
  return {
    lineas: [],
    total_percepciones: 0,
    total_deducciones: 0,
    total_otros_pagos: 0,
    neto: 0,
    num_dias_pagados: 0,
    days_worked: 0,
    calc_errors,
    estado: "draft",
    snapshot,
  };
}

// (o-----------------------------------------------------------/\-----o)
//   #endregion ENGINE
// (o==================================================================o)

export {
  calculate_payroll_receipt,
  isr_monthly,
  round2,
  DAYS_PER_MONTH,
  IMSS_WORKER_RATE,
  ISR_MONTHLY_BRACKETS_2025,
};
