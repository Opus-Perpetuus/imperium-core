import { LaborIncidentCalcEffect } from './payroll-calc.types.ts';

/**
 * Maps each labor incident tipo (string values of LaborIncidentTipo) to its
 * simplified payroll effect. Domain stays free of Mongoose model imports.
 * Unknown tipos fall back to `ignore` via `resolve_incident_effect`.
 */
const LABOR_INCIDENT_CALC_EFFECT: Record<string, LaborIncidentCalcEffect> = {
  absence: "reduce_days",
  late: "ignore",
  overtime: "add_overtime",
  vacation: "ignore",
  disability: "disability",
  permission_paid: "ignore",
  permission_unpaid: "reduce_days",
  bonus: "ignore",
  loan_infonavit: "ignore",
  other_deduction: "ignore",
  termination: "ignore",
};

/**
 * Resolves the calculation effect for a labor incident tipo.
 */
function resolve_incident_effect(tipo: string): LaborIncidentCalcEffect {
  return LABOR_INCIDENT_CALC_EFFECT[tipo] ?? "ignore";
}

export { LABOR_INCIDENT_CALC_EFFECT, resolve_incident_effect };
