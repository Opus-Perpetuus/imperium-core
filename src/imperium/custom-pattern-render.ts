/**
 * Render del `custom_pattern` de auto-incremento, mismo contrato que
 * `format_sequence_value` / `render_custom_pattern` del original.
 */
import { as_array, as_object, type ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';

const TZ = 'America/Mexico_City';

export type PatternContext = Record<string, unknown>;

export type CustomTokenValue = { value: string; is_reset_key: boolean };

async function collect_scan(
	store: ImperiumStore,
	resource: string,
	opts: {
		where?: Record<string, unknown>;
		include_inactive?: boolean;
		fields?: string[];
	} = {},
): Promise<ImperiumDoc[]> {
	const out: ImperiumDoc[] = [];
	for await (const page of store.scan(resource, opts)) out.push(...page);
	return out;
}

/** Lookups de incremento. Sin `search_field` (n-gramas). */
const INCREMENT_LOOKUP_FIELDS = [
	'name',
	'model_name',
	'collection',
	'increment_field',
	'campo',
	'index_name',
	'type',
	'custom_pattern',
	'ref_value',
	'segment',
	'_unique_string_reference',
	'is_active',
	'current_sequence',
	'current',
	'valor',
	'current_real_value',
	'updated_at',
];

export function numero_a_columna(valor_col: number): string {
	let n = valor_col;
	let out = '';
	while (n > 0) {
		const extra = (n - 1) % 26;
		n = Math.floor((n - 1) / 26);
		out = String.fromCharCode(65 + extra) + out;
	}
	return out;
}

function standard_to_roman(num: number): string {
	if (num <= 0) return '';
	const values = [
		[1000, 'M'],
		[900, 'CM'],
		[500, 'D'],
		[400, 'CD'],
		[100, 'C'],
		[90, 'XC'],
		[50, 'L'],
		[40, 'XL'],
		[10, 'X'],
		[9, 'IX'],
		[5, 'V'],
		[4, 'IV'],
		[1, 'I'],
	] as const;
	let n = num;
	let result = '';
	for (const [value, numeral] of values) {
		while (n >= value) {
			result += numeral;
			n -= value;
		}
	}
	return result;
}

export function to_extended_roman(num: number): string {
	if (num === 0) return '';
	if (num < 4000) return standard_to_roman(num);
	const parts: string[] = [];
	const millions = Math.floor(num / 1_000_000);
	if (millions > 0) parts.push(`((${standard_to_roman(millions)}))`);
	const rem = num % 1_000_000;
	const thousands = Math.floor(rem / 1000);
	if (thousands > 0) parts.push(`(${standard_to_roman(thousands)})`);
	const units = rem % 1000;
	if (units > 0) parts.push(standard_to_roman(units));
	return parts.join('');
}

export function format_token_numeric_value(params: {
	sequence: number;
	zero_padding?: number;
	use_alpha?: boolean;
	use_roman?: boolean;
}): string {
	if (params.use_alpha) return numero_a_columna(params.sequence);
	if (params.use_roman) return to_extended_roman(params.sequence);
	if ((params.zero_padding ?? 0) > 0) {
		return String(params.sequence).padStart(Number(params.zero_padding), '0');
	}
	return String(params.sequence);
}

function mexico_ymd(date = new Date()) {
	const stamp = new Intl.DateTimeFormat('en-CA', {
		timeZone: TZ,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
	}).format(date);
	const [y, m, d] = stamp.split('-').map(Number);
	return { y: y ?? 0, m: m ?? 1, d: d ?? 1 };
}

function iso_week(y: number, m: number, d: number) {
	const utc = new Date(Date.UTC(y, m - 1, d));
	const day = utc.getUTCDay() || 7;
	utc.setUTCDate(utc.getUTCDate() + 4 - day);
	const start = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
	return Math.ceil(((utc.getTime() - start.getTime()) / 86400000 + 1) / 7);
}

function day_of_year(y: number, m: number, d: number) {
	return Math.floor((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 1)) / 86400000) + 1;
}

function iso_weekday(y: number, m: number, d: number) {
	return new Date(Date.UTC(y, m - 1, d)).getUTCDay() || 7;
}

function mexico_name(kind: 'month' | 'weekday', width: 'short' | 'long', date = new Date()) {
	return new Intl.DateTimeFormat('es-MX', {
		timeZone: TZ,
		[kind]: width,
	}).format(date);
}

export function date_token_value(token: string, date = new Date()): string {
	const { y, m, d } = mexico_ymd(date);
	switch (token) {
		case 'yy':
			return String(y).slice(-2);
		case 'yyyy':
			return String(y);
		case 'LL':
			return String(m).padStart(2, '0');
		case 'LLL':
			return mexico_name('month', 'short', date);
		case 'LLLL':
			return mexico_name('month', 'long', date);
		case 'WW':
			return String(iso_week(y, m, d)).padStart(2, '0');
		case 'ooo':
			return String(day_of_year(y, m, d)).padStart(3, '0');
		case 'dd':
			return String(d).padStart(2, '0');
		case 'c':
			return String(iso_weekday(y, m, d));
		case 'ccc':
			return mexico_name('weekday', 'short', date);
		case 'cccc':
			return mexico_name('weekday', 'long', date);
		default:
			return '';
	}
}

function context_value(context: PatternContext | undefined, field_path: string): unknown {
	if (!context || !field_path.trim()) return undefined;
	return field_path
		.split('.')
		.map((segment) => segment.trim())
		.filter(Boolean)
		.reduce<unknown>((current, segment) => {
			if (current == null || typeof current !== 'object') return undefined;
			return (current as Record<string, unknown>)[segment];
		}, context);
}

function stringify_context(value: unknown): string {
	if (value == null) return '';
	if (value instanceof Date) return value.toISOString();
	if (typeof value === 'object') {
		const id = (value as { _id?: unknown })._id;
		if (id != null) return String(id);
		return JSON.stringify(value);
	}
	return String(value);
}

function apply_numeric_modes(
	raw: string,
	zero_padding: number,
	use_alpha: boolean,
	use_roman: boolean,
): string {
	if (!use_alpha && !use_roman && !(zero_padding > 0)) return raw;
	const numeric = Number(raw);
	if (!raw.trim() || !Number.isFinite(numeric)) return raw;
	return format_token_numeric_value({
		sequence: numeric,
		zero_padding,
		use_alpha,
		use_roman,
	});
}

export function render_custom_pattern_sync(
	pattern: string,
	sequence: number,
	context?: PatternContext,
	external: Record<string, number> = {},
	custom_values: string[] = [],
): string {
	if (!pattern) return String(sequence);
	let value = pattern;
	value = value.replace(
		/\[(yy|yyyy|LL|LLL|LLLL|WW|ooo|dd|c|ccc|cccc)\]/g,
		(_m, token) => date_token_value(String(token)),
	);
	let custom_i = 0;
	value = value.replace(/\[custom\]/g, () => {
		const next = custom_values[custom_i] ?? '';
		custom_i += 1;
		return next;
	});
	value = value.replace(
		/\[counter=([^\]\[;]*)(;ceros=([^\]\[;]*))?(;letra=([^\]\[;]*))?(;romano=([^\]\[;]*))?\]/gi,
		(_m, id, _z, zeros, _a, alpha, _r, roman) => {
			const key = String(id ?? '').trim();
			return format_token_numeric_value({
				sequence: Number(external[key] ?? 0),
				zero_padding: Number(zeros ?? 0),
				use_alpha: String(alpha ?? '').toLowerCase() === 'true',
				use_roman: String(roman ?? '').toLowerCase() === 'true',
			});
		},
	);
	value = value.replace(
		/\[field=([^\]\[;]*)(;ceros=([^\]\[;]*))?(;letra=([^\]\[;]*))?(;romano=([^\]\[;]*))?\]/gi,
		(_m, path, _z, zeros, _a, alpha, _r, roman) => {
			const raw = stringify_context(context_value(context, String(path ?? '').trim()));
			return apply_numeric_modes(
				raw,
				Number(zeros ?? 0),
				String(alpha ?? '').toLowerCase() === 'true',
				String(roman ?? '').toLowerCase() === 'true',
			);
		},
	);
	value = value.replace(
		/\[(seq|sequence)(;ceros=([^\]\[;]*))?(;letra=([^\]\[;]*))?(;romano=([^\]\[;]*))?\]/gi,
		(_m, _t, _z, zeros, _a, alpha, _r, roman) =>
			format_token_numeric_value({
				sequence,
				zero_padding: Number(zeros ?? 0),
				use_alpha: String(alpha ?? '').toLowerCase() === 'true',
				use_roman: String(roman ?? '').toLowerCase() === 'true',
			}),
	);
	return value;
}

function candidate_values(raw: unknown): string[] {
	const out: string[] = [];
	if (raw == null) return out;
	if (typeof raw === 'object') {
		const obj = as_object(raw);
		if (typeof (raw as { toHexString?: () => string }).toHexString === 'function') {
			try {
				out.push(String((raw as { toHexString: () => string }).toHexString()));
			} catch {
				/* ignore */
			}
		}
		for (const key of ['_id', 'id', 'value', 'name', 'label']) {
			if (obj[key] != null) out.push(String(obj[key]));
		}
		out.push(stringify_context(raw));
	} else {
		out.push(String(raw));
		const s = String(raw).trim();
		if (/^[0-9a-fA-F]{24}$/.test(s)) {
			out.push(s.toLowerCase(), s.toUpperCase());
		}
	}
	return [...new Set(out.map((v) => v.trim()).filter(Boolean))];
}

function normalize_expected(raw: unknown): string {
	if (raw == null) return '';
	if (typeof raw === 'object') {
		const obj = as_object(raw);
		if (obj._id != null) return String(obj._id).trim();
		if (obj.id != null) return String(obj.id).trim();
		if (typeof (raw as { toHexString?: () => string }).toHexString === 'function') {
			try {
				return String((raw as { toHexString: () => string }).toHexString()).trim();
			} catch {
				/* fall through */
			}
		}
		try {
			return JSON.stringify(raw);
		} catch {
			return String(raw).trim();
		}
	}
	const text = String(raw).trim();
	if ((text.startsWith('{') && text.endsWith('}')) || (text.startsWith('"') && text.endsWith('"'))) {
		try {
			return normalize_expected(JSON.parse(text));
		} catch {
			return text;
		}
	}
	return text;
}

function flag_true(value: unknown): boolean {
	if (value === true || value === 1) return true;
	if (value === false || value === 0 || value == null) return false;
	const text = String(value).trim().toLowerCase();
	return text === 'true' || text === '1' || text === 't' || text === 'yes' || text === 'si';
}

function ref_string(value: unknown): string {
	if (value == null) return '';
	if (typeof value === 'object') {
		const obj = as_object(value);
		return String(obj._id ?? obj.id ?? '').trim();
	}
	return String(value).trim();
}

function is_id_like(value: unknown): boolean {
	if (typeof value !== 'string') return false;
	const text = value.trim();
	return /^[0-9a-fA-F]{24}$/.test(text) || /^[0-9a-fA-F-]{8,}$/.test(text);
}

async function fetch_referenced_doc(
	store: ImperiumStore,
	control: ImperiumDoc | null,
	base_path: string,
	base_value: unknown,
): Promise<ImperiumDoc | null> {
	if (base_value == null || typeof store.find_id !== 'function') return null;
	const id = ref_string(base_value) || (typeof base_value === 'string' ? base_value.trim() : '');
	if (!id) return null;
	const parent_model = String(control?.model_name ?? '');
	const parent_resource = parent_model ? store.resource_for_model(parent_model) : null;
	const refs =
		parent_resource && typeof store.field_refs === 'function'
			? store.field_refs(parent_resource)
			: {};
	const ref_model = String(refs[base_path] ?? '');
	const targets = new Set<string>();
	if (ref_model) {
		const mapped = store.resource_for_model(ref_model);
		if (mapped) targets.add(mapped);
		const kebab = ref_model.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
		targets.add(kebab);
		targets.add(`${kebab}s`);
	}
	const field_kebab = base_path.replace(/_/g, '-');
	targets.add(field_kebab);
	targets.add(`${field_kebab}s`);
	for (const resource of targets) {
		if (!resource || !store.has(resource)) continue;
		const hit = await store.find_id(resource, id);
		if (hit) return hit;
	}
	return null;
}

async function expand_condition_candidates(
	store: ImperiumStore,
	control: ImperiumDoc | null,
	context: PatternContext,
	field_path: string,
): Promise<string[]> {
	const out = new Set<string>();
	const add = (raw: unknown) => {
		for (const item of candidate_values(raw)) out.add(item);
	};
	add(context_value(context, field_path));
	const segments = field_path
		.split('.')
		.map((segment) => segment.trim())
		.filter(Boolean);
	if (segments.length > 1) {
		const base_path = segments[0]!;
		const rest = segments.slice(1).join('.');
		const base = context_value(context, base_path);
		add(base);
		const fetched = await fetch_referenced_doc(store, control, base_path, base);
		if (fetched) {
			add(context_value(fetched, rest));
			add(fetched);
		}
	} else {
		const direct = context_value(context, field_path);
		if (is_id_like(direct) || (direct && typeof direct === 'object')) {
			const fetched = await fetch_referenced_doc(store, control, field_path, direct);
			if (fetched) add(fetched);
		}
	}
	return [...out];
}

function part_matches_config(part: ImperiumDoc, control_id: string): boolean {
	return ref_string(part.counter_config_id) === control_id;
}

async function load_custom_parts(
	store: ImperiumStore,
	control: ImperiumDoc,
): Promise<ImperiumDoc[]> {
	if (!store.has('custom-pattern-increment-sequence-parts')) return [];
	const control_id = String(control._id ?? '');
	let linked = (
		await collect_scan(store, 'custom-pattern-increment-sequence-parts', {
			where: { counter_config_id: control_id },
			include_inactive: true,
		})
	).filter((part) => part_matches_config(part, control_id));
	if (!linked.length) {
		const all = await collect_scan(store, 'custom-pattern-increment-sequence-parts', {
			include_inactive: true,
		});
		linked = all.filter((part) => part_matches_config(part, control_id));
		if (!linked.length) {
			const ids = as_array(control.custom_pattern_parts)
				.map((item) => ref_string(item) || String(item ?? '').trim())
				.filter(Boolean);
			linked = all.filter((part) => ids.includes(String(part._id ?? '')));
		}
	}
	return linked
		.filter((part) => part.is_active !== false && String(part.token_type ?? '') === 'custom')
		.sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0));
}

export async function resolve_custom_values(
	store: ImperiumStore,
	control: ImperiumDoc | null,
	context?: PatternContext,
): Promise<CustomTokenValue[]> {
	if (!control || !context || !store.has('custom-pattern-increment-sequence-parts')) {
		return [];
	}
	const custom_parts = await load_custom_parts(store, control);
	if (!custom_parts.length) return [];
	const has_conditions = store.has('custom-pattern-condition');
	const values: CustomTokenValue[] = [];
	for (const part of custom_parts) {
		if (!has_conditions) {
			values.push({ value: '', is_reset_key: false });
			continue;
		}
		const part_id = String(part._id ?? '');
		let conditions = await collect_scan(store, 'custom-pattern-condition', {
			where: { part_id },
			include_inactive: true,
		});
		if (!conditions.length) {
			conditions = await collect_scan(store, 'custom-pattern-condition', {
				include_inactive: true,
			});
		}
		conditions = conditions.filter(
			(condition) =>
				condition.is_active !== false && ref_string(condition.part_id) === part_id,
		);
		let matched = '';
		let matched_reset = false;
		let fallback = '';
		let fallback_reset = false;
		for (const condition of conditions) {
			const expected = normalize_expected(condition.expected_value);
			const ret = String(condition.return_value ?? '').trim();
			const own_count = flag_true(condition.own_count);
			if (flag_true(condition.is_default_value)) {
				if (!fallback) {
					fallback = ret;
					fallback_reset = own_count;
				}
				continue;
			}
			const field_path = String(condition.field_path ?? part.field_path ?? '').trim();
			if (!field_path) continue;
			const candidates = await expand_condition_candidates(store, control, context, field_path);
			if (expected && candidates.includes(expected)) {
				matched = ret;
				matched_reset = own_count;
				break;
			}
		}
		values.push(
			matched
				? { value: matched, is_reset_key: matched_reset }
				: { value: fallback, is_reset_key: fallback_reset },
		);
	}
	return values;
}

async function find_external_counter(
	store: ImperiumStore,
	id: string,
	ref_value: string | null,
): Promise<ImperiumDoc | null> {
	let matches = await collect_scan(store, 'auto-increment-control', {
		where: { index_name: id },
		include_inactive: true,
		fields: INCREMENT_LOOKUP_FIELDS,
	});
	if (!matches.length) {
		const by_field = await collect_scan(store, 'auto-increment-control', {
			where: { increment_field: id },
			include_inactive: true,
			fields: INCREMENT_LOOKUP_FIELDS,
		});
		const by_name = await collect_scan(store, 'auto-increment-control', {
			where: { name: id },
			include_inactive: true,
			fields: INCREMENT_LOOKUP_FIELDS,
		});
		matches = [...by_field, ...by_name];
	}
	matches.sort((a, b) =>
		String(b.updatedAt ?? b.updated_at ?? '').localeCompare(
			String(a.updatedAt ?? a.updated_at ?? ''),
		),
	);
	if (ref_value) {
		return (
			matches.find((row) => unwrap_ref_value(row.ref_value) === ref_value) ??
			matches.find((row) => is_global_ref(row.ref_value)) ??
			matches[0] ??
			null
		);
	}
	return matches.find((row) => is_global_ref(row.ref_value)) ?? matches[0] ?? null;
}

async function external_sequences(
	store: ImperiumStore,
	pattern: string,
	ref_value: string | null = null,
): Promise<Record<string, number>> {
	const ids = [...pattern.matchAll(/\[counter=([^\]\[;]*)/gi)].map((m) => String(m[1] ?? '').trim());
	const out: Record<string, number> = {};
	if (!ids.length || !store.has('auto-increment-control')) return out;
	for (const id of ids) {
		const hit = await find_external_counter(store, id, ref_value);
		out[id] = Number(hit?.current_sequence ?? hit?.current ?? hit?.valor ?? 0);
	}
	return out;
}

export function is_global_ref(value: unknown): boolean {
	if (value == null) return true;
	// Filas migradas pueden traer '""' o '"null"' envueltos: son globales.
	const text = unwrap_ref_value(value);
	return text === '' || text === 'null';
}

/** Empty / 0 / "0" means the increment field was never assigned. */
export function is_missing_increment_value(value: unknown): boolean {
	if (value === undefined || value === null) return true;
	if (typeof value === 'number') return !Number.isFinite(value) || value <= 0;
	if (typeof value === 'string') {
		const trimmed = value.trim();
		return !trimmed || trimmed === '0';
	}
	return false;
}

export function numeric_sequence_from_unknown(value: unknown): number | null {
	if (value == null || value === '') return null;
	const numeric = Number(value);
	if (!Number.isFinite(numeric) || numeric <= 0) return null;
	return numeric;
}

const DATE_RESET_TOKENS = [
	'yy',
	'yyyy',
	'LL',
	'LLL',
	'LLLL',
	'WW',
	'ooo',
	'dd',
	'c',
	'ccc',
	'cccc',
] as const;

export function date_reset_fragments(pattern: string, date = new Date()): string[] {
	const fragments: string[] = [];
	if (!pattern) return fragments;
	for (const token of DATE_RESET_TOKENS) {
		const matches = pattern.match(new RegExp(`\\[${token}\\]`, 'g'));
		if (!matches?.length) continue;
		const replacement = date_token_value(token, date);
		for (let i = 0; i < matches.length; i++) fragments.push(replacement);
	}
	return fragments;
}

export function pattern_reset_key(pattern: string, date = new Date()): string | null {
	return date_reset_fragments(pattern, date).join('') || null;
}

/**
 * Clave de segmento a partir de valores `[custom]` ya resueltos (mismo
 * resultado que `compute_reset_key`, sin volver a resolver condiciones).
 */
export function reset_key_from_values(
	pattern: string,
	custom_values: CustomTokenValue[],
	date = new Date(),
): string | null {
	if (!pattern) return null;
	const fragments = date_reset_fragments(pattern, date);
	const custom_matches = [...pattern.matchAll(/\[custom\]/g)];
	for (let i = 0; i < custom_matches.length; i++) {
		const entry = custom_values[i];
		if (entry?.is_reset_key && entry.value) fragments.push(entry.value);
		else fragments.push('');
	}
	return fragments.join('') || null;
}

export async function compute_reset_key(
	store: ImperiumStore,
	control: ImperiumDoc | null,
	context?: PatternContext,
	date = new Date(),
): Promise<string | null> {
	const pattern = String(control?.custom_pattern ?? '');
	if (!pattern) return null;
	const custom_values = /\[custom\]/.test(pattern)
		? await resolve_custom_values(store, control, context)
		: [];
	return reset_key_from_values(pattern, custom_values, date);
}

export function custom_counter_ref(values: CustomTokenValue[]): string | null {
	const fragments = values.filter((entry) => entry.is_reset_key && entry.value).map((entry) => entry.value);
	return fragments.length ? fragments.join('') : null;
}

export function tracker_unique_ref(
	control: ImperiumDoc,
	ref_value: unknown,
): string {
	return [
		control.collection ?? '',
		control.model_name ?? '',
		control.increment_field ?? '',
		control.index_name ?? control.increment_field ?? '',
		JSON.stringify(ref_value ?? null),
	].join('::');
}

/**
 * Normaliza un `ref_value` leído de la BD: filas legacy guardan el valor
 * envuelto como JSON-string (`"AGP"` con comillas) en la columna jsonb,
 * mientras el resto del código compara contra el valor plano (`AGP`).
 * Devuelve la cadena plana en ambos casos.
 */
export function unwrap_ref_value(value: unknown): string {
	let raw = String(value ?? '').trim();
	// Cada escritura que re-envuelve suma un nivel (`"\"AGP\""`): se
	// desenvuelve hasta llegar al valor plano, con tope por seguridad.
	for (let depth = 0; depth < 8 && raw.startsWith('"'); depth++) {
		try {
			const parsed = JSON.parse(raw);
			if (typeof parsed !== 'string') break;
			raw = parsed.trim();
		} catch {
			// No es un JSON-string válido: se usa el valor tal cual.
			break;
		}
	}
	return raw;
}

/** ¿La fila de tracker apunta al segmento `reset_key`, en cualquier envoltura? */
function segment_ref_matches(row: ImperiumDoc, reset_key: string): boolean {
	return unwrap_ref_value(row.ref_value) === reset_key;
}

function field_matches(row: ImperiumDoc, increment_field: string) {
	return String(row.increment_field ?? row.campo ?? '') === increment_field;
}

export async function find_increment_control(
	store: ImperiumStore,
	model_name: string,
	increment_field: string,
): Promise<ImperiumDoc | null> {
	if (!store.has('auto-increment-control') || !model_name) return null;
	const rows = await collect_scan(store, 'auto-increment-control', {
		where: increment_field ? { model_name, increment_field } : { model_name },
		include_inactive: true,
		fields: INCREMENT_LOOKUP_FIELDS,
	});
	const matches = increment_field
		? rows.filter((row) => field_matches(row, increment_field))
		: rows;
	// Solo una fila global es configuración: un segmento (`ref_value` con
	// clave) nunca debe actuar como patrón/tipo del contador, ni siquiera
	// cuando la global fue desactivada desde la UI.
	return (
		matches.find((row) => is_global_ref(row.ref_value) && row.is_active !== false) ??
		matches.find((row) => is_global_ref(row.ref_value)) ??
		rows.find((row) => is_global_ref(row.ref_value) && row.is_active !== false) ??
		null
	);
}

export async function find_increment_segment(
	store: ImperiumStore,
	control: ImperiumDoc,
	reset_key: string | null,
): Promise<ImperiumDoc | null> {
	if (!reset_key) return control;
	const model_name = String(control.model_name ?? '');
	const increment_field = String(control.increment_field ?? '');
	// 1) Clave única exacta: es la que chocaría al insertar el segmento, así
	// que si existe se reutiliza aunque su `ref_value` esté perdido o mal
	// envuelto (`_unique_string_reference` es columna text: match exacto).
	const by_unique = await store.find_where('auto-increment-control', {
		_unique_string_reference: tracker_unique_ref(control, reset_key),
	});
	if (by_unique) return by_unique;
	// 2) Filas legacy guardan `ref_value` envuelto como JSON-string (`"AGP"`),
	// las nuevas lo guardan plano (`AGP`): se busca en ambos formatos para
	// no duplicar el segmento y violar el único `_unique_string_reference`.
	const exact =
		(await store.find_where('auto-increment-control', {
			model_name,
			increment_field,
			ref_value: reset_key,
		})) ??
		(await store.find_where('auto-increment-control', {
			model_name,
			increment_field,
			ref_value: JSON.stringify(reset_key),
		}));
	if (exact && field_matches(exact, increment_field) && segment_ref_matches(exact, reset_key)) {
		return exact;
	}
	// 3) Barrido por modelo sin filtrar `increment_field` en SQL: las filas
	// legacy pueden traer el campo solo como `campo` (columna NULL); el match
	// se hace en memoria desenvolviendo el ref a cualquier profundidad.
	const rows = await collect_scan(store, 'auto-increment-control', {
		where: { model_name },
		include_inactive: true,
		fields: INCREMENT_LOOKUP_FIELDS,
	});
	return (
		rows.find(
			(row) => field_matches(row, increment_field) && segment_ref_matches(row, reset_key),
		) ?? null
	);
}

/**
 * Deja `ref_value`/`segment` planos en una fila de segmento reutilizada
 * (legacy envuelta, doble envuelta o con el ref perdido) para que todos los
 * lectores (`String(row.ref_value)`, listado, formato) vean la clave real.
 */
async function heal_segment_ref(
	store: ImperiumStore,
	row: ImperiumDoc,
	reset_key: string,
): Promise<ImperiumDoc> {
	if (row.ref_value === reset_key && row.segment === reset_key) return row;
	if (!row._id) return row;
	try {
		const healed = await store.update('auto-increment-control', String(row._id), {
			ref_value: reset_key,
			segment: reset_key,
		});
		return healed ?? { ...row, ref_value: reset_key, segment: reset_key };
	} catch {
		// La reparación es cosmética: el conteo sigue siendo válido sin ella.
		return row;
	}
}

export async function find_or_create_increment_segment(
	store: ImperiumStore,
	control: ImperiumDoc,
	reset_key: string | null,
): Promise<ImperiumDoc> {
	const existing = await find_increment_segment(store, control, reset_key);
	if (!reset_key) return existing ?? control;
	if (existing) return heal_segment_ref(store, existing, reset_key);
	const increment_field = String(control.increment_field ?? 'sequence');
	const model_name = String(control.model_name ?? '');
	const unique = tracker_unique_ref(control, reset_key);
	try {
		return await store.insert('auto-increment-control', {
			name: `${model_name}.${increment_field}`,
			model_name,
			collection: control.collection ?? '',
			increment_field,
			index_name: control.index_name ?? increment_field,
			type: control.type ?? 'custom',
			custom_pattern: control.custom_pattern ?? null,
			current_sequence: 0,
			current: 0,
			valor: 0,
			current_real_value: 0,
			ref_value: reset_key,
			segment: reset_key,
			_unique_string_reference: unique,
			is_active: true,
		});
	} catch (err) {
		// Carrera con otra asignación o fila que el barrido no vio: si la
		// clave única ya existe se reutiliza esa fila en vez de fallar.
		const raced = await store.find_where('auto-increment-control', {
			_unique_string_reference: unique,
		});
		if (raced) return heal_segment_ref(store, raced, reset_key);
		throw err;
	}
}

export async function resolve_increment_preview_target(
	store: ImperiumStore,
	model_name: string,
	increment_field: string,
	context?: PatternContext,
): Promise<{ config: ImperiumDoc | null; target: ImperiumDoc | null }> {
	const config = await find_increment_control(store, model_name, increment_field);
	if (!config) return { config: null, target: null };
	const reset_key = await compute_reset_key(store, config, context);
	const target = reset_key
		? ((await find_increment_segment(store, config, reset_key)) ?? {
				...config,
				current_sequence: 0,
				current: 0,
				valor: 0,
				ref_value: reset_key,
			})
		: config;
	return { config, target };
}

export async function format_increment_real_value(
	store: ImperiumStore,
	control: ImperiumDoc | null,
	sequence: number,
	context?: PatternContext,
): Promise<unknown> {
	const type = String(control?.type ?? 'numeric');
	if (type !== 'custom' && sequence <= 0) {
		return type === 'alphanumeric' ? '' : 0;
	}
	if (type === 'alphanumeric') return numero_a_columna(sequence);
	if (type !== 'custom') return sequence;
	const pattern = String(control?.custom_pattern ?? '');
	let custom_values = context
		? await resolve_custom_values(store, control, context)
		: [];
	if (
		!custom_values.some((entry) => entry.value) &&
		control &&
		!is_global_ref(control.ref_value) &&
		String(control.ref_value ?? '') &&
		!date_reset_fragments(pattern).length &&
		pattern.includes('[custom]')
	) {
		custom_values = [{ value: unwrap_ref_value(control.ref_value), is_reset_key: true }];
	}
	const external = await external_sequences(store, pattern, custom_counter_ref(custom_values));
	return render_custom_pattern_sync(
		pattern,
		sequence,
		context,
		external,
		custom_values.map((entry) => entry.value),
	);
}

export async function assign_document_increments(
	store: ImperiumStore,
	resource: string,
	doc: ImperiumDoc,
): Promise<ImperiumDoc> {
	if (resource === 'auto-increment-control' || !store.has('auto-increment-control')) {
		return doc;
	}
	const rows = await collect_scan(store, 'auto-increment-control', {
		include_inactive: true,
		fields: INCREMENT_LOOKUP_FIELDS,
	});
	const seen = new Set<string>();
	const configs = rows
		.filter((row) => {
			if (!is_global_ref(row.ref_value) || row.is_active === false) return false;
			const model_name = String(row.model_name ?? '').trim();
			const field = String(row.increment_field ?? '').trim();
			if (!model_name || !field) return false;
			if (store.resource_for_model(model_name) !== resource) return false;
			if (seen.has(field)) return false;
			seen.add(field);
			return true;
		})
		.sort(
			(a, b) =>
				(String(a.type ?? '') === 'custom' ? 1 : 0) - (String(b.type ?? '') === 'custom' ? 1 : 0),
		);
	const out: ImperiumDoc = { ...doc };
	for (const config of configs) {
		const field = String(config.increment_field ?? '');
		const current = out[field];
		if (!is_missing_increment_value(current)) continue;
		const next = await store.next_auto_increment(String(config.model_name), field, {
			resource,
			context: out,
		});
		out[field] = await format_increment_real_value(store, config, next, out);
	}
	return out;
}

export async function format_model_field_value(
	store: ImperiumStore,
	model_name: string,
	increment_field: string,
	sequence: number,
	context?: PatternContext,
	fallback?: unknown,
): Promise<unknown> {
	const control = await find_increment_control(store, model_name, increment_field);
	if (!control) return fallback ?? sequence;
	return format_increment_real_value(store, control, sequence, context);
}

export type AdvanceIncrementOpts = {
	resource?: string;
	context?: PatternContext;
	/** If present, skip compute_reset_key and use this segment (null = global). */
	ref_value?: string | null;
	max_numeric?: (resource: string, field: string) => Promise<number>;
	bump?: (target: ImperiumDoc, floor: number) => Promise<number>;
};

/** Control used to render the folio: global pattern + segment `ref_value`. */
export function increment_format_control(
	config: ImperiumDoc | null,
	target: ImperiumDoc,
	reset_key: string | null,
): ImperiumDoc {
	const formatter = config ?? target;
	const segment =
		reset_key || (!is_global_ref(target.ref_value) ? unwrap_ref_value(target.ref_value) : '');
	if (segment && is_global_ref(formatter.ref_value)) {
		return { ...formatter, ref_value: segment };
	}
	return formatter;
}

/**
 * Misma resolución de segmento que `ImperiumStore.next_auto_increment`,
 * sin SQL: tests y el store real avanzan el tracker apuntado.
 */
export async function advance_increment_sequence(
	store: ImperiumStore,
	model_name: string,
	increment_field: string,
	opts: AdvanceIncrementOpts = {},
): Promise<number> {
	const config = store.has('auto-increment-control')
		? await find_increment_control(store, model_name, increment_field)
		: null;
	const reset_key =
		'ref_value' in opts
			? (opts.ref_value ?? null)
			: config
				? await compute_reset_key(store, config, opts.context)
				: null;
	let floor = 0;
	if (!reset_key && opts.resource && opts.max_numeric) {
		floor = await opts.max_numeric(opts.resource, increment_field);
	}
	if (!store.has('auto-increment-control')) return floor + 1;
	const target = config
		? await find_or_create_increment_segment(store, config, reset_key)
		: null;
	if (!target?._id) return floor + 1;
	const next = opts.bump
		? await opts.bump(target, floor)
		: Math.max(Number(target.current_sequence ?? target.current ?? target.valor ?? 0), floor) + 1;
	const real_value = await format_increment_real_value(
		store,
		increment_format_control(config, target, reset_key),
		next,
		opts.context,
	);
	await store.update('auto-increment-control', String(target._id), {
		current_sequence: next,
		current: next,
		valor: next,
		current_real_value: real_value,
	});
	return next;
}

export async function preview_increment_value(
	store: ImperiumStore,
	model_name: string,
	increment_field: string,
	context?: PatternContext,
): Promise<{
	next_sequence: number;
	next_real_value: unknown;
	tracker: ImperiumDoc | null;
}> {
	const { config, target } = await resolve_increment_preview_target(
		store,
		model_name,
		increment_field,
		context,
	);
	const next_sequence =
		Number(target?.current_sequence ?? target?.current ?? target?.valor ?? 0) + 1;
	const next_real_value = await format_increment_real_value(
		store,
		target
			? increment_format_control(
					config,
					target,
					is_global_ref(target.ref_value) ? null : unwrap_ref_value(target.ref_value),
				)
			: config,
		next_sequence,
		context,
	);
	return { next_sequence, next_real_value, tracker: target ?? null };
}

export async function increment_control_record(
	store: ImperiumStore,
	doc: ImperiumDoc,
	amount = 1,
	context?: PatternContext,
): Promise<{ next: number; real_value: unknown; target: ImperiumDoc | null }> {
	const steps = Math.max(1, Number(amount) || 1);
	const model_name = String(doc.model_name ?? '');
	const increment_field = String(doc.increment_field ?? doc.campo ?? 'sequence');
	const pointed = is_global_ref(doc.ref_value) ? undefined : unwrap_ref_value(doc.ref_value);
	let next = Number(doc.current_sequence ?? doc.current ?? doc.valor ?? 0);
	if (model_name) {
		for (let i = 0; i < steps; i++) {
			next = await advance_increment_sequence(store, model_name, increment_field, {
				context,
				...(pointed !== undefined ? { ref_value: pointed } : {}),
			});
		}
		const config = await find_increment_control(store, model_name, increment_field);
		const target = pointed
			? ((await find_increment_segment(store, config ?? doc, pointed)) ?? doc)
			: ((await resolve_increment_preview_target(store, model_name, increment_field, context))
					.target ?? doc);
		const shown = target
			? await store.find_id('auto-increment-control', String(target._id))
			: doc;
		return {
			next,
			real_value: shown?.current_real_value ?? next,
			target: shown ?? target ?? doc,
		};
	}
	next += steps;
	const real_value = await format_increment_real_value(store, doc, next, context);
	const updated = await store.update('auto-increment-control', String(doc._id), {
		current_sequence: next,
		current: next,
		valor: next,
		counter: next,
		current_real_value: real_value,
	});
	return { next, real_value, target: updated ?? doc };
}
