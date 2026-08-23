/**
 * Lookup de caja de cobranza: mismo contrato que CobranzaService.lookup
 * (infracción o contrato de agua → cargo + renglones + pronto pago).
 */
import { as_array, as_object, ok, type ImperiumDoc } from './envelope.ts';
import { build_access } from './auth.ts';
import { access_flag } from './record-rules.ts';
import type { ImperiumStore } from './store.ts';

const SOURCE_VIOLATION = 'violation';
const SOURCE_AGUA = 'agua';
const TERMINAL_VIOLATION = new Set(['CANCELADA', 'CONDONADA', 'IMPUGNADA', 'ARCHIVADO']);

function text(value: unknown): string {
	return String(value ?? '').trim();
}

function ref_id(value: unknown): string {
	if (value == null || value === '') return '';
	if (typeof value === 'object') return String((value as { _id?: unknown })._id ?? '').trim();
	return String(value).trim();
}

function is_id(value: string): boolean {
	return /^[a-f0-9]{24}$/i.test(value);
}

function round_money(value: number): number {
	return Math.round(value * 100) / 100;
}

export function build_violation_service_lines(
	broken_laws: Array<Record<string, unknown>> = [],
): Array<{
	description: string;
	quantity: number;
	unit_price: number;
	total: number;
	recidivist: boolean;
}> {
	return broken_laws.map((law) => {
		const article = text(law.article);
		const fraction = text(law.fraction);
		const detail = text(law.fraction_description);
		const head = [article && `Art. ${article}`, fraction && `fracc. ${fraction}`]
			.filter(Boolean)
			.join(' ');
		const quantity = Number(law.uma_qty) || 0;
		const unit_price = Number(law.uma_price) || 0;
		const total = Number(law.uma_total);
		return {
			description: [head, detail].filter(Boolean).join(' — ') || 'Infracción',
			quantity,
			unit_price,
			total: Number.isFinite(total) ? total : quantity * unit_price,
			recidivist: Boolean(law.is_recidivist),
		};
	});
}

export function pronto_pago_hint(
	created_at: Date | string | null | undefined,
	subtotal: number,
	now = new Date(),
): { rate: number; label: string; amount: number } | null {
	if (!created_at || !(subtotal > 0)) return null;
	const created = created_at instanceof Date ? created_at : new Date(created_at);
	if (Number.isNaN(created.getTime())) return null;
	const days = (now.getTime() - created.getTime()) / 86_400_000;
	if (days <= 10) {
		return {
			rate: 0.5,
			label: 'Pronto pago (primeros 10 días): 50 %',
			amount: round_money(subtotal * 0.5),
		};
	}
	if (days <= 25) {
		return {
			rate: 0.75,
			label: 'Pronto pago (días 11 a 25): 75 %',
			amount: round_money(subtotal * 0.75),
		};
	}
	return null;
}

function lookup_empty_message(can_violation: boolean, can_agua: boolean): string {
	if (can_violation && can_agua) {
		return 'No se encontró infracción ni contrato de agua con esa referencia.';
	}
	if (can_violation) return 'No se encontró ninguna infracción con esa referencia.';
	if (can_agua) return 'No se encontró ningún contrato de agua con esa referencia.';
	return 'No hay servicios de cobro habilitados para tu usuario.';
}

async function module_enabled(store: ImperiumStore, module_name: string): Promise<boolean> {
	if (!store.has('module-management')) return false;
	const exact = await store.find_where('module-management', { module_name });
	if (exact) {
		return Boolean(access_flag(exact.is_enable) && exact.is_active !== false);
	}
	const { rows } = await store.find_many('module-management', {
		mongo_match: {
			$or: [
				{ module_name },
				{ name: module_name },
				{ model_id: module_name },
			],
		},
		take: 8,
		include_inactive: true,
		populate: false,
	});
	const wanted = module_name.replace(/[^a-z0-9]/gi, '').toLowerCase();
	const hit = rows.find((row) => {
		const tokens = [row.module_name, row.name, row.model_id, row.module_model_id].map((value) =>
			String(value ?? '')
				.replace(/[^a-z0-9]/gi, '')
				.toLowerCase(),
		);
		return tokens.includes(wanted);
	});
	return Boolean(hit && access_flag(hit.is_enable) && hit.is_active !== false);
}

async function can_read_model(store: ImperiumStore, actor: ImperiumDoc | null, model_id: string) {
	const access = await build_access(store, actor);
	if (access.has_full_access) return true;
	const wanted = model_id.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
	for (const [model, perms] of Object.entries(access.permissions_by_model ?? {})) {
		if (model.replace(/[^A-Za-z0-9]/g, '').toLowerCase() === wanted && perms.allow_read) {
			return true;
		}
	}
	return access.models.some((model) => String(model).replace(/[^A-Za-z0-9]/g, '').toLowerCase() === wanted);
}

async function can_lookup_source(
	store: ImperiumStore,
	actor: ImperiumDoc | null,
	module_name: string,
	model_name: string,
): Promise<boolean> {
	if (!(await module_enabled(store, module_name))) return false;
	return can_read_model(store, actor, model_name);
}

async function payments_of(store: ImperiumStore, charge_id: string) {
	if (!store.has('cobranza-payment')) return [];
	const { rows } = await store.find_many('cobranza-payment', {
		where: { charge_id },
		take: 20000,
		include_inactive: true,
		populate: true,
	});
	return rows.sort((a, b) => String(b.createdAt ?? b.created_at ?? '').localeCompare(String(a.createdAt ?? a.created_at ?? '')));
}

async function agua_outstanding_amount(store: ImperiumStore, contrato: ImperiumDoc): Promise<number> {
	const adeudo = Number(contrato.adeudo ?? 0);
	if (adeudo > 0) return round_money(adeudo);
	if (!store.has('lectura')) return 0;
	const number = text(contrato.contrato);
	const { rows } = await store.find_many('lectura', {
		where: number ? { contrato: number } : undefined,
		take: 1,
		sort: 'fecha_lectura:desc',
		include_inactive: false,
		populate: false,
	});
	const last = rows
		.filter((row) => text(row.contrato) === number)
		.sort((a, b) => String(b.fecha_lectura ?? '').localeCompare(String(a.fecha_lectura ?? '')))[0];
	return round_money(Number(last?.importe ?? 0));
}

async function get_or_create_agua_charge(store: ImperiumStore, source_id: string): Promise<ImperiumDoc> {
	const contrato = await store.find_id('contrato', source_id);
	if (!contrato) throw new Error('No se encontró el contrato de agua.');
	const outstanding = await agua_outstanding_amount(store, contrato);
	const existing = await store.find_where('cobranza', {
		source_module: SOURCE_AGUA,
		source_id: String(contrato._id),
	});
	const reference = text(contrato.contrato ?? contrato.name ?? contrato._id);
	const concept = text(contrato.contribuyente)
		? `Servicio de agua - ${text(contrato.contribuyente)}`
		: `Servicio de agua ${reference}`;
	if (existing) {
		const status = text(existing.status ?? existing.estado).toUpperCase();
		if (status === 'CANCELADO' || status === 'CANCELED') return existing;
		const updated = await store.update('cobranza', String(existing._id), {
			total_amount: round_money(Number(existing.paid_amount ?? 0) + outstanding),
			reference,
			concept,
			name: `Cobro agua ${reference}`,
		});
		return updated ?? existing;
	}
	return store.insert('cobranza', {
		name: `Cobro agua ${reference}`,
		source_module: SOURCE_AGUA,
		source_id: String(contrato._id),
		reference,
		concept,
		total_amount: outstanding,
		paid_amount: 0,
		balance: outstanding,
		status: outstanding <= 0 ? 'PAGADO' : 'PENDIENTE',
		estado: outstanding <= 0 ? 'pagado' : 'pendiente',
		currency: 'MXN',
		is_active: true,
	});
}

async function get_or_create_violation_charge(store: ImperiumStore, source_id: string): Promise<ImperiumDoc> {
	const existing = await store.find_where('cobranza', {
		source_module: SOURCE_VIOLATION,
		source_id,
	});
	if (existing) return existing;
	const violation = await store.find_id('violation', source_id);
	if (!violation) throw new Error('No se encontró la infracción solicitada.');
	const laws = as_array(violation.broken_laws).map(as_object);
	const total_amount = laws.reduce((sum, law) => sum + Number(law.uma_total ?? 0), 0);
	const reference =
		violation.folio != null && text(violation.folio)
			? String(violation.folio)
			: violation.has_plates && text(violation.plates)
				? text(violation.plates)
				: String(violation._id);
	return store.insert('cobranza', {
		name: `Cobro infracción ${reference}`,
		source_module: SOURCE_VIOLATION,
		source_id: String(violation._id),
		reference,
		concept: `Infracción${text(violation.name) ? ` - ${text(violation.name)}` : ''}`,
		total_amount,
		paid_amount: 0,
		balance: total_amount,
		status: 'PENDIENTE',
		estado: 'pendiente',
		currency: 'MXN',
		is_active: true,
	});
}

async function find_violation_for_lookup(store: ImperiumStore, reference: string) {
	if (!store.has('violation')) return null;
	if (/^\d{6}$/.test(reference)) {
		const by_code = await store.find_where('violation', { code: reference });
		if (by_code) return by_code;
	}
	if (/^\d+$/.test(reference)) {
		const by_folio =
			(await store.find_where('violation', { folio: Number(reference) })) ??
			(await store.find_where('violation', { folio: reference }));
		if (by_folio) return by_folio;
	}
	if (is_id(reference)) {
		const by_id = await store.find_id('violation', reference);
		if (by_id) return by_id;
	}
	return store.find_where('violation', { plates: reference });
}

async function find_contrato_for_lookup(store: ImperiumStore, reference: string) {
	if (!store.has('contrato')) return null;
	const by_number = await store.find_where('contrato', { contrato: reference });
	if (by_number && by_number.is_active !== false) return by_number;
	if (is_id(reference)) return store.find_id('contrato', reference);
	return null;
}

async function pack_agua_lookup(store: ImperiumStore, contrato: ImperiumDoc, message: string) {
	const charge = await get_or_create_agua_charge(store, String(contrato._id));
	const payments = await payments_of(store, String(charge._id));
	return ok(
		[
			{
				charge,
				payments,
				source_module: SOURCE_AGUA,
				source_label: 'Servicio de agua',
				lines: [
					{
						description: charge.concept,
						quantity: 1,
						unit_price: charge.total_amount,
						total: charge.total_amount,
						recidivist: false,
					},
				],
				pronto_pago: null,
			},
		],
		message,
	);
}

async function pack_violation_lookup(store: ImperiumStore, violation: ImperiumDoc) {
	const charge = await get_or_create_violation_charge(store, String(violation._id));
	const payments = await payments_of(store, String(charge._id));
	const lines = build_violation_service_lines(as_array(violation.broken_laws).map(as_object));
	const subtotal = lines.reduce((sum, line) => sum + Number(line.total), 0);
	return ok(
		[
			{
				charge,
				payments,
				source_module: SOURCE_VIOLATION,
				source_label: 'Servicio de infracción',
				source: {
					folio: violation.folio ?? null,
					code: violation.code ?? null,
					plates: violation.plates ?? null,
					status: violation.status ?? null,
					holder: text(violation.infractor_name || violation.name),
				},
				lines,
				pronto_pago: pronto_pago_hint(
					(violation.createdAt ?? violation.created_at) as string | undefined,
					subtotal,
				),
			},
		],
		'Cargo de infracción obtenido correctamente.',
	);
}

export async function sync_cobranza_sources(store: ImperiumStore, charge: ImperiumDoc | null) {
	if (!charge) return;
	const source_module = text(charge.source_module);
	const source_id = ref_id(charge.source_id) || text(charge.source_id);
	if (!source_id) return;
	if (source_module === SOURCE_AGUA && store.has('contrato')) {
		await store.update('contrato', source_id, { adeudo: Number(charge.balance ?? 0) });
		return;
	}
	if (source_module !== SOURCE_VIOLATION || !store.has('violation')) return;
	const violation = await store.find_id('violation', source_id);
	if (!violation) return;
	const status = text(violation.status ?? violation.estado).toUpperCase();
	if (TERMINAL_VIOLATION.has(status)) return;
	const charge_status = text(charge.status ?? charge.estado).toUpperCase();
	if (charge_status === 'PAGADO' || charge_status === 'PAID') {
		await store.update('violation', source_id, {
			status: 'PAGADA',
			estado: 'PAGADA',
			paid_at: violation.paid_at ?? new Date().toISOString(),
		});
		return;
	}
	if (status === 'PAGADA') {
		await store.update('violation', source_id, {
			status: 'EMITIDA',
			estado: 'EMITIDA',
			paid_at: null,
		});
	}
}

export async function lookup_cobranza(
	store: ImperiumStore,
	actor: ImperiumDoc | null,
	reference: string,
) {
	const wanted = text(reference);
	if (!wanted) throw new Error('Debes proporcionar una referencia de búsqueda.');
	const can_agua = await can_lookup_source(store, actor, 'agua', 'Contrato');
	const can_violation = await can_lookup_source(store, actor, 'violation', 'Violation');
	if (can_agua && /^\d{8}$/.test(wanted)) {
		const contrato_by_number = await find_contrato_for_lookup(store, wanted);
		if (contrato_by_number) {
			return pack_agua_lookup(store, contrato_by_number, 'Cargo de agua obtenido correctamente.');
		}
	}
	if (can_violation) {
		const violation = await find_violation_for_lookup(store, wanted);
		if (violation) return pack_violation_lookup(store, violation);
	}
	if (can_agua) {
		const contrato = await find_contrato_for_lookup(store, wanted);
		if (contrato) return pack_agua_lookup(store, contrato, 'Cargo obtenido correctamente.');
	}
	return ok([], lookup_empty_message(can_violation, can_agua), 0);
}
