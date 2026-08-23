/**
 * Nómina: generate-drafts y payload de recibo como el service original.
 */
import { as_array, as_object, type ImperiumDoc } from './envelope.ts';
import { calculate_payroll_receipt } from './payroll-calc.engine.ts';
import type { CalcIncidentInput, CalcScheduleDay } from './payroll-calc.types.ts';
import {
	build_payroll_cfdi_payload,
	type PayrollReceiptLike,
	type PayrollToCfdiPeriodContext,
} from './payroll-to-cfdi-payload.ts';
import type { ImperiumStore } from './store.ts';

function text(value: unknown): string {
	return String(value ?? '').trim();
}

function ref_id(value: unknown): string {
	if (value == null || value === '') return '';
	if (typeof value === 'object') return String((value as { _id?: unknown })._id ?? '').trim();
	return String(value).trim();
}

function to_date(value: unknown): Date | null {
	if (!value) return null;
	const parsed = value instanceof Date ? value : new Date(String(value));
	return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function salary(value: unknown): number {
	const n = Number(value ?? 0);
	return Number.isFinite(n) ? n : 0;
}

function employee_eligible(employee: ImperiumDoc, period_start: Date, period_end: Date): boolean {
	if (employee.is_active === false) return false;
	if (!(salary(employee.salario_diario) > 0)) return false;
	const ingreso = to_date(employee.fecha_ingreso);
	if (ingreso && ingreso.getTime() > period_end.getTime()) return false;
	const baja = to_date(employee.fecha_baja);
	if (baja && baja.getTime() < period_start.getTime()) return false;
	return true;
}

function map_employee_to_calc(employee: ImperiumDoc) {
	return {
		name: text(employee.name),
		rfc: text(employee.rfc) || undefined,
		curp: text(employee.curp) || undefined,
		nss: text(employee.nss) || undefined,
		num_empleado: text(employee.num_empleado) || undefined,
		salario_diario: salary(employee.salario_diario),
		sdi: salary(employee.sdi) || undefined,
		tipo_contrato: text(employee.tipo_contrato) || undefined,
		tipo_regimen: text(employee.tipo_regimen) || undefined,
		tipo_jornada: text(employee.tipo_jornada) || undefined,
		periodicidad_pago: text(employee.periodicidad_pago) || undefined,
		clave_ent_fed: text(employee.clave_ent_fed) || undefined,
		fecha_ingreso: employee.fecha_ingreso as string | undefined,
		fecha_baja: employee.fecha_baja as string | undefined,
	};
}

function build_receipt_payload(period: ImperiumDoc, employee: ImperiumDoc, calc: ReturnType<typeof calculate_payroll_receipt>) {
	const employee_label = text(employee.num_empleado) || text(employee.name) || String(employee._id);
	const period_label = text(period.name) || String(period._id);
	const estado =
		calc.estado === 'ready_to_stamp'
			? 'ready_to_stamp'
			: calc.estado === 'calculated'
				? 'calculated'
				: 'draft';
	return {
		name: `Recibo ${employee_label} · ${period_label}`.slice(0, 200),
		description: 'Borrador de nómina generado automáticamente',
		payroll_period: period._id,
		employee: employee._id,
		snapshot: calc.snapshot,
		num_dias_pagados: calc.num_dias_pagados,
		estado,
		lineas: calc.lineas.map((line) => ({
			categoria: line.categoria,
			tipo_sat: line.tipo_sat,
			clave: line.clave,
			concepto: line.concepto,
			importe_gravado: line.importe_gravado,
			importe_exento: line.importe_exento,
			importe: line.importe,
		})),
		total_percepciones: calc.total_percepciones,
		total_deducciones: calc.total_deducciones,
		total_otros_pagos: calc.total_otros_pagos,
		neto: calc.neto,
		subsidio_causado: calc.subsidio_causado,
		calc_errors: calc.calc_errors.length > 0 ? calc.calc_errors : undefined,
		is_active: true,
	};
}

export async function generate_payroll_drafts(store: ImperiumStore, period_id: string) {
	const id = text(period_id);
	if (!id || id === 'generate-drafts') {
		throw new Error('Se requiere el id del periodo de nómina');
	}
	const period = await store.find_id('payroll-period', id);
	if (!period || period.is_active === false) {
		throw new Error('Periodo de nómina no encontrado');
	}
	await store.update('payroll-period', id, { estado: 'generating' });
	const period_start = to_date(period.fecha_inicial) ?? new Date();
	const period_end = to_date(period.fecha_final) ?? period_start;
	const branch = ref_id(period.branch_office);
	const employees = store.has('employee')
		? (
				await store.find_many('employee', {
					mongo_match: { salario_diario: { $gt: '0' } },
					take: 20000,
					populate: false,
				})
			).rows.filter((row) => {
				if (!employee_eligible(row, period_start, period_end)) return false;
				if (branch) {
					const emp_branch = ref_id(row.branch_office) || text(row.branch_office);
					if (emp_branch !== branch) return false;
				}
				return true;
			})
		: [];
	const existing = store.has('payroll-receipt')
		? (
				await store.find_many('payroll-receipt', {
					where: { payroll_period: id },
					take: 20000,
					populate: false,
					include_inactive: true,
				})
			).rows
		: [];
	const by_emp = new Map<string, ImperiumDoc>();
	for (const rec of existing) {
		const emp_id = ref_id(rec.employee) || text(rec.employee);
		if (emp_id) by_emp.set(emp_id, rec);
	}
	let created = 0;
	let updated = 0;
	const errors: Array<{ employee_id?: string; message: string }> = [];
	for (const employee of employees) {
		const emp_id = String(employee._id ?? '');
		if (!emp_id) continue;
		const schedule = store.has('labor-schedule')
			? (
					await store.find_many('labor-schedule', {
						where: { employee: emp_id, is_default: true },
						take: 1,
						populate: false,
					})
				).rows[0]
			: null;
		const incidents = store.has('labor-incident')
			? (
					await store.find_many('labor-incident', {
						where: { employee: emp_id },
						take: 500,
						populate: false,
					})
				).rows.filter((row) => {
					if (row.is_active === false) return false;
					const start = to_date(row.fecha_inicio);
					const end = to_date(row.fecha_fin);
					if (!start || !end) return false;
					return start.getTime() <= period_end.getTime() && end.getTime() >= period_start.getTime();
				})
			: [];
		try {
			const calc = calculate_payroll_receipt({
				employee: map_employee_to_calc(employee),
				period: {
					fecha_inicial: String(period.fecha_inicial ?? ''),
					fecha_final: String(period.fecha_final ?? ''),
					fecha_pago: String(period.fecha_pago ?? period.fecha_final ?? ''),
					num_dias_pagados: Number(period.num_dias_pagados ?? 0),
					tipo_nomina: text(period.tipo_nomina) || undefined,
					periodicidad_pago: text(period.periodicidad_pago) || undefined,
				},
				schedule_days: as_array(schedule?.days).map((raw) => {
					const day = as_object(raw);
					return { weekday: Number(day.weekday ?? 0), hours: Number(day.hours ?? 0) } as CalcScheduleDay;
				}),
				incidents: incidents.map((row) => ({
					tipo: text(row.tipo),
					fecha_inicio: String(row.fecha_inicio ?? ''),
					fecha_fin: String(row.fecha_fin ?? ''),
					dias: Number(row.dias ?? 0) || undefined,
					horas: Number(row.horas ?? 0) || undefined,
					importe: Number(row.importe ?? 0) || undefined,
					tipo_incapacidad: text(row.tipo_incapacidad) || undefined,
				})) as CalcIncidentInput[],
			});
			const payload = build_receipt_payload(period, employee, calc);
			const hit = by_emp.get(emp_id);
			const estado = text(hit?.estado);
			if (estado === 'stamped' || estado === 'stamping') continue;
			if (hit) {
				await store.update('payroll-receipt', String(hit._id), payload);
				updated += 1;
			} else {
				await store.insert('payroll-receipt', payload);
				created += 1;
			}
			if (calc.calc_errors.length) {
				errors.push({ employee_id: emp_id, message: calc.calc_errors.join('; ') });
			}
		} catch (err) {
			errors.push({
				employee_id: emp_id,
				message: err instanceof Error ? err.message : 'Error al calcular recibo',
			});
		}
	}
	const after = store.has('payroll-receipt')
		? (
				await store.find_many('payroll-receipt', {
					where: { payroll_period: id },
					take: 20000,
					populate: false,
				})
			).rows
		: [];
	const calculated_count = after.filter((row) =>
		['calculated', 'ready_to_stamp'].includes(text(row.estado)),
	).length;
	const stamped_count = after.filter((row) => text(row.estado) === 'stamped').length;
	await store.update('payroll-period', id, {
		estado: 'open',
		receipts_count: after.length,
		calculated_count,
		stamped_count,
	});
	return {
		created,
		updated,
		errors,
		receipts_count: after.length,
		calculated_count,
	};
}

function receipt_for_cfdi(rec: ImperiumDoc): PayrollReceiptLike {
	return {
		...rec,
		lineas: as_array(rec.lineas) as PayrollReceiptLike['lineas'],
		snapshot: as_object(rec.snapshot),
	};
}

async function load_period_context(
	store: ImperiumStore,
	payroll_period: unknown,
): Promise<PayrollToCfdiPeriodContext | undefined> {
	const id = ref_id(payroll_period) || text(payroll_period);
	if (!id || !store.has('payroll-period')) return undefined;
	const period = await store.find_id('payroll-period', id);
	if (!period) return undefined;
	return {
		tipo_nomina: text(period.tipo_nomina) || undefined,
		fecha_pago: period.fecha_pago as string | undefined,
		fecha_inicial: period.fecha_inicial as string | undefined,
		fecha_final: period.fecha_final as string | undefined,
		num_dias_pagados: Number(period.num_dias_pagados ?? 0) || undefined,
		periodicidad_pago: text(period.periodicidad_pago) || undefined,
	};
}

function payroll_cfdi_handoff(payload: Record<string, unknown>) {
	const pac_name = text(process.env.CFDI_PAC_PROVIDER) || 'unknown';
	return {
		status: 'payload_ready' as const,
		payload,
		message:
			'Payload CFDI N listo y pack Facturación detectable. ' +
			`PAC compartido: ${pac_name}. ` +
			'Timbrar vía POST /cfdi-document/from-payroll-receipt/:id? o stamp del documento (mismo código que facturación comercial).',
	};
}

async function load_active_receipt(store: ImperiumStore, receipt_id: string, empty: string) {
	const id = text(receipt_id);
	if (!id || id === 'prepare-stamp' || id === 'export-payload') {
		throw new Error(empty);
	}
	const rec = await store.find_id('payroll-receipt', id);
	if (!rec || rec.is_active === false) {
		throw new Error('Recibo de nómina no encontrado');
	}
	return rec;
}

export async function prepare_payroll_stamp(store: ImperiumStore, receipt_id: string) {
	const rec = await load_active_receipt(
		store,
		receipt_id,
		'Se necesita un id de recibo para prepare-stamp',
	);
	const period = await load_period_context(store, rec.payroll_period);
	const payload = build_payroll_cfdi_payload(receipt_for_cfdi(rec), { period });
	const next_estado = text(rec.estado) === 'calculated' ? 'ready_to_stamp' : text(rec.estado);
	const updated = await store.update('payroll-receipt', String(rec._id), {
		payload_cfdi: payload,
		...(next_estado === 'ready_to_stamp' ? { estado: 'ready_to_stamp' } : {}),
	});
	if (!updated) throw new Error('Recibo de nómina no encontrado');
	const handoff = payroll_cfdi_handoff(payload);
	const stored = as_object(updated.payload_cfdi);
	return {
		receipt: {
			...updated,
			payload_cfdi: stored.tipo_de_comprobante ? stored : payload,
			handoff,
		},
		handoff,
	};
}

export async function export_payroll_payload(store: ImperiumStore, receipt_id: string) {
	const rec = await load_active_receipt(
		store,
		receipt_id,
		'Se necesita un id de recibo para export-payload',
	);
	const period = await load_period_context(store, rec.payroll_period);
	return build_payroll_cfdi_payload(receipt_for_cfdi(rec), { period });
}
