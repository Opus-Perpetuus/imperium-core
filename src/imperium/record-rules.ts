/**
 * Record-rules de Imperium: dominio Mongo restringido + tokens de sesión.
 * Espejo de `record-rules.filter.utils.ts`.
 */
import { as_array, type ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';

function qident(name: string): string {
	if (!/^[a-z_][a-z0-9_]*$/i.test(name)) throw new Error(`bad ident ${name}`);
	return `"${name.replace(/"/g, '""')}"`;
}

export type RecordRuleOperationFlag =
	| 'allow_read'
	| 'allow_create'
	| 'allow_update'
	| 'allow_delete';

export type RecordRuleContext = {
	user_id?: string;
	user_ref?: string;
	user_email?: string;
	employee_id?: string;
	group_ids: string[];
};

export type RuleRef = { rule_name: string; group_id?: string; group_name?: string };

export type RecordRuleMatchResult = {
	match: Record<string, unknown> | null;
	applicable_rules: RuleRef[];
};

const NEVER_MATCH_ID = '000000000000000000000000';

const ALLOWED_OPERATORS = new Set([
	'$and',
	'$or',
	'$nor',
	'$not',
	'$eq',
	'$ne',
	'$gt',
	'$gte',
	'$lt',
	'$lte',
	'$in',
	'$nin',
	'$exists',
	'$regex',
	'$options',
	'$size',
	'$elemMatch',
	'$all',
	'$type',
	'$mod',
]);

export class RecordRuleDeniedError extends Error {
	status = 403;
	code = 'access_denied';
	constructor(message: string) {
		super(message);
		this.name = 'RecordRuleDeniedError';
	}
}

function session_employee_id(actor: ImperiumDoc | null): string {
	const raw = actor?.employee;
	if (raw == null || raw === '') return '';
	if (typeof raw === 'object') return String((raw as { _id?: unknown })._id ?? '');
	return String(raw).trim();
}

export function context_from_actor(
	actor: ImperiumDoc | null,
	group_ids: string[],
): RecordRuleContext {
	return {
		user_id: actor?._id ? String(actor._id) : undefined,
		user_ref: actor?._ref ? String(actor._ref) : undefined,
		user_email: actor?.email ? String(actor.email) : undefined,
		employee_id: session_employee_id(actor) || undefined,
		group_ids,
	};
}

function resolve_token(token: string, ctx: RecordRuleContext): { resolved: boolean; value?: unknown } {
	switch (token) {
		case '$current_user_id':
			return { resolved: true, value: ctx.user_id ?? null };
		case '$current_user_oid':
			return { resolved: true, value: ctx.user_id ?? null };
		case '$current_user_ref':
			return { resolved: true, value: ctx.user_ref ?? null };
		case '$current_user_email':
			return { resolved: true, value: ctx.user_email ?? null };
		case '$current_employee_id':
		case '$current_employee_oid':
			return { resolved: true, value: ctx.employee_id || NEVER_MATCH_ID };
		case '$current_group_ids':
			return { resolved: true, value: ctx.group_ids ?? [] };
		case '$now':
			return { resolved: true, value: new Date().toISOString() };
		case '$today': {
			const today = new Date();
			today.setHours(0, 0, 0, 0);
			return { resolved: true, value: today.toISOString() };
		}
		default:
			return { resolved: false };
	}
}

export function substitute_placeholders(value: unknown, ctx: RecordRuleContext): unknown {
	if (Array.isArray(value)) return value.map((item) => substitute_placeholders(item, ctx));
	if (value && typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const [key, nested] of Object.entries(value)) {
			out[key] = substitute_placeholders(nested, ctx);
		}
		return out;
	}
	if (typeof value === 'string' && value.startsWith('$')) {
		const hit = resolve_token(value, ctx);
		if (hit.resolved) return hit.value;
	}
	return value;
}

function assert_operators_allowed(value: unknown): void {
	if (Array.isArray(value)) {
		value.forEach(assert_operators_allowed);
		return;
	}
	if (value && typeof value === 'object') {
		for (const [key, nested] of Object.entries(value)) {
			if (key.startsWith('$') && !ALLOWED_OPERATORS.has(key)) {
				throw new Error(`Operador no permitido en domain de record-rule: '${key}'`);
			}
			assert_operators_allowed(nested);
		}
	}
}

export function parse_domain(domain: unknown): Record<string, unknown> | null {
	let parsed: unknown = domain;
	if (typeof domain === 'string') {
		const trimmed = domain.trim();
		if (!trimmed || trimmed === '{}') return null;
		parsed = JSON.parse(trimmed);
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		if (parsed == null) return null;
		throw new Error('El domain debe ser un objeto JSON de filtro Mongo.');
	}
	assert_operators_allowed(parsed);
	return parsed as Record<string, unknown>;
}

export function is_rule_effective(params: {
	rule_id: string;
	rule_group_id: string;
	user_group_record_rule_ids: Set<string>;
	user_group_reference_ids: Set<string>;
	record_rule_ids_assigned_to_any_group: Set<string>;
}): boolean {
	const linked =
		params.user_group_record_rule_ids.has(params.rule_id) ||
		(!!params.rule_group_id && params.user_group_reference_ids.has(params.rule_group_id));
	const is_global =
		!params.rule_group_id && !params.record_rule_ids_assigned_to_any_group.has(params.rule_id);
	return Boolean(linked || is_global);
}

export function build_record_rule_match(
	rules: ImperiumDoc[] | undefined,
	operation: RecordRuleOperationFlag,
	ctx: RecordRuleContext,
): RecordRuleMatchResult {
	const applicable = (rules ?? []).filter((rule) => rule && Boolean(rule[operation]));
	if (!applicable.length) return { match: null, applicable_rules: [] };
	const applicable_rules: RuleRef[] = applicable.map((rule) => ({
		rule_name: String(rule.name ?? ''),
		group_id: rule.group_id != null ? String(rule.group_id) : undefined,
		group_name: rule.__group_name != null ? String(rule.__group_name) : undefined,
	}));
	const ors: Record<string, unknown>[] = [];
	let grants_all = false;
	for (const rule of applicable) {
		let parsed: Record<string, unknown> | null;
		try {
			parsed = parse_domain(rule.domain);
		} catch {
			continue;
		}
		if (parsed === null) {
			grants_all = true;
			continue;
		}
		ors.push(substitute_placeholders(parsed, ctx) as Record<string, unknown>);
	}
	if (grants_all) return { match: null, applicable_rules };
	if (!ors.length) return { match: { _id: { $in: [] } }, applicable_rules };
	return { match: ors.length === 1 ? ors[0]! : { $or: ors }, applicable_rules };
}

export function describe_blocking_rules(applicable_rules: RuleRef[]): string {
	if (!applicable_rules.length) return 'reglas de registro de tu grupo';
	return applicable_rules
		.map((rule) => {
			const group = rule.group_name ? ` (grupo ${rule.group_name})` : '';
			return `${rule.rule_name}${group}`;
		})
		.join(', ');
}

const CRUD_VERB: Record<string, string> = {
	GET: 'leer',
	POST: 'crear',
	PUT: 'modificar',
	PATCH: 'modificar',
	DELETE: 'eliminar',
};

export function build_record_denied_message(
	method: string,
	model: string,
	applicable_rules: RuleRef[],
): string {
	const operacion = CRUD_VERB[method] ?? method.toLowerCase();
	return (
		`No puedes ${operacion} este ${model}: las reglas de registro ` +
		`${describe_blocking_rules(applicable_rules)} limitan los registros permitidos y este queda fuera.`
	);
}

function ref_id(value: unknown): string {
	if (value == null) return '';
	if (typeof value === 'object') return String((value as { _id?: unknown })._id ?? '');
	return String(value);
}

export async function load_record_rules_by_model(
	store: ImperiumStore,
	user_groups: ImperiumDoc[],
): Promise<Record<string, ImperiumDoc[]>> {
	if (!store.has('record-rules')) return {};
	const all_rules = (
		await store.find_many('record-rules', { take: 2000, include_inactive: false, populate: false })
	).rows;
	if (!all_rules.length) return {};
	const all_groups = store.has('user-group')
		? (await store.find_many('user-group', { take: 500, include_inactive: false, populate: false }))
				.rows
		: [];
	const user_group_record_rule_ids = new Set(
		user_groups.flatMap((group) => as_array(group.record_rules_ids).map((id) => ref_id(id))),
	);
	const record_rule_ids_assigned_to_any_group = new Set(
		all_groups.flatMap((group) => as_array(group.record_rules_ids).map((id) => ref_id(id))),
	);
	const user_group_reference_ids = new Set(
		user_groups.flatMap((group) => [String(group._id ?? ''), String(group._ref ?? '')]).filter(Boolean),
	);
	const out: Record<string, ImperiumDoc[]> = {};
	for (const rule of all_rules) {
		const rule_id = String(rule._id ?? '');
		const rule_group_id = ref_id(rule.group_id);
		if (
			!is_rule_effective({
				rule_id,
				rule_group_id,
				user_group_record_rule_ids,
				user_group_reference_ids,
				record_rule_ids_assigned_to_any_group,
			})
		) {
			continue;
		}
		const model_id = String(rule.model_id ?? '');
		if (!model_id) continue;
		const group_name =
			user_groups.find((group) => {
				const ids = as_array(group.record_rules_ids).map((id) => ref_id(id));
				if (ids.includes(rule_id)) return true;
				return String(group._id) === rule_group_id || String(group._ref ?? '') === rule_group_id;
			})?.name ?? (rule_group_id ? undefined : 'global');
		const decorated = { ...rule, __group_name: group_name };
		const resource = store.resource_for_model(model_id) ?? model_id.toLowerCase();
		for (const key of new Set([model_id, resource])) {
			(out[key] ??= []).push(decorated);
		}
	}
	return out;
}

function literal(s: string): string {
	return `'${s.replace(/'/g, "''")}'`;
}

function scalar(value: unknown): unknown {
	if (value == null) return null;
	if (value instanceof Date) return value.toISOString();
	if (typeof value === 'object') return ref_id(value);
	return value;
}

function field_extract(field: string, cols: Set<string>): string {
	const name = field === '_id' ? 'id' : field === '_ref' ? 'ref' : field;
	if (name === 'id' || cols.has(name)) return qident(name);
	const key = literal(field);
	return `(COALESCE(payload ->> ${key}, CASE WHEN jsonb_typeof(payload) = 'string' THEN ((payload #>> '{}')::jsonb) ->> ${key} END))`;
}

/**
 * Traduce un match Mongo (allowlist) a SQL AND-able. Vacío ⇒ sin cláusula.
 */
export function mongo_match_to_sql(
	match: unknown,
	cols: Set<string>,
	params: unknown[],
): string {
	if (match == null || typeof match !== 'object') return '';
	if (Array.isArray(match)) {
		const parts = match.map((item) => mongo_match_to_sql(item, cols, params)).filter(Boolean);
		return parts.length ? `(${parts.join(' AND ')})` : '';
	}
	const rec = match as Record<string, unknown>;
	if (Array.isArray(rec.$or)) {
		const parts = rec.$or.map((item) => mongo_match_to_sql(item, cols, params)).filter(Boolean);
		return parts.length ? `(${parts.join(' OR ')})` : 'FALSE';
	}
	if (Array.isArray(rec.$and)) {
		const parts = rec.$and.map((item) => mongo_match_to_sql(item, cols, params)).filter(Boolean);
		return parts.length ? `(${parts.join(' AND ')})` : '';
	}
	if (Array.isArray(rec.$nor)) {
		const inner = rec.$nor.map((item) => mongo_match_to_sql(item, cols, params)).filter(Boolean);
		return inner.length ? `NOT (${inner.join(' OR ')})` : '';
	}
	const parts: string[] = [];
	for (const [key, raw] of Object.entries(rec)) {
		if (key.startsWith('$')) continue;
		const expr = field_extract(key, cols);
		if (raw && typeof raw === 'object' && !Array.isArray(raw) && !(raw instanceof Date)) {
			const op = raw as Record<string, unknown>;
			if ('$in' in op) {
				const values = as_array(op.$in).map(scalar);
				if (!values.length) {
					parts.push('FALSE');
					continue;
				}
				const marks = values.map((item) => {
					params.push(item);
					return `$${params.length}`;
				});
				parts.push(`${expr} IN (${marks.join(', ')})`);
				continue;
			}
			if ('$nin' in op) {
				const values = as_array(op.$nin).map(scalar);
				if (!values.length) continue;
				const marks = values.map((item) => {
					params.push(item);
					return `$${params.length}`;
				});
				parts.push(`${expr} NOT IN (${marks.join(', ')})`);
				continue;
			}
			if ('$ne' in op) {
				params.push(scalar(op.$ne));
				parts.push(`${expr} IS DISTINCT FROM $${params.length}`);
				continue;
			}
			if ('$eq' in op) {
				params.push(scalar(op.$eq));
				parts.push(`${expr} = $${params.length}`);
				continue;
			}
			if ('$exists' in op) {
				parts.push(op.$exists ? `${expr} IS NOT NULL` : `${expr} IS NULL`);
				continue;
			}
		}
		params.push(scalar(raw));
		parts.push(`${expr} = $${params.length}`);
	}
	return parts.length ? `(${parts.join(' AND ')})` : '';
}

export function operation_flag(method: string): RecordRuleOperationFlag {
	const m = method.toUpperCase();
	if (m === 'POST') return 'allow_create';
	if (m === 'PUT' || m === 'PATCH') return 'allow_update';
	if (m === 'DELETE') return 'allow_delete';
	return 'allow_read';
}
