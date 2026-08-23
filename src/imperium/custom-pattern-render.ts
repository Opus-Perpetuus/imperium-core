/**
 * Render del `custom_pattern` de auto-incremento, mismo contrato que
 * `format_sequence_value` / `render_custom_pattern` del original.
 */
import { as_object, type ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';

const TZ = 'America/Mexico_City';

export type PatternContext = Record<string, unknown>;

export type CustomTokenValue = { value: string; is_reset_key: boolean };

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

export async function resolve_custom_values(
	store: ImperiumStore,
	control: ImperiumDoc | null,
	context?: PatternContext,
): Promise<CustomTokenValue[]> {
	if (!control || !context || !store.has('custom-pattern-increment-sequence-parts')) {
		return [];
	}
	const { rows: parts } = await store.find_many('custom-pattern-increment-sequence-parts', {
		where: { counter_config_id: String(control._id) },
		take: 20000,
		sort: 'order:asc',
	});
	const custom_parts = parts
		.filter((part) => String(part.token_type ?? '') === 'custom')
		.sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0));
	if (!custom_parts.length) return [];
	const has_conditions = store.has('custom-pattern-condition');
	const values: CustomTokenValue[] = [];
	for (const part of custom_parts) {
		if (!has_conditions) {
			values.push({ value: '', is_reset_key: false });
			continue;
		}
		const { rows: conditions } = await store.find_many('custom-pattern-condition', {
			where: { part_id: String(part._id) },
			take: 200,
		});
		let matched = '';
		let matched_reset = false;
		let fallback = '';
		let fallback_reset = false;
		for (const condition of conditions) {
			const expected = String(condition.expected_value ?? '').trim();
			const ret = String(condition.return_value ?? '').trim();
			const own_count = !!condition.own_count;
			if (condition.is_default_value) {
				if (!fallback) {
					fallback = ret;
					fallback_reset = own_count;
				}
				continue;
			}
			const field_path = String(condition.field_path ?? part.field_path ?? '').trim();
			if (!field_path) continue;
			const candidates = candidate_values(context_value(context, field_path));
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
	const { rows } = await store.find_many('auto-increment-control', {
		take: 80,
		include_inactive: true,
	});
	const matches = rows.filter(
		(row) =>
			String(row.index_name ?? '') === id ||
			String(row.increment_field ?? '') === id ||
			String(row.name ?? '') === id,
	);
	if (ref_value) {
		return (
			matches.find((row) => String(row.ref_value ?? '') === ref_value) ??
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
	const text = typeof value === 'string' ? value.trim() : String(value);
	return text === '' || text === 'null';
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

export async function compute_reset_key(
	store: ImperiumStore,
	control: ImperiumDoc | null,
	context?: PatternContext,
	date = new Date(),
): Promise<string | null> {
	const pattern = String(control?.custom_pattern ?? '');
	if (!pattern) return null;
	const fragments = date_reset_fragments(pattern, date);
	const custom_matches = [...pattern.matchAll(/\[custom\]/g)];
	if (custom_matches.length) {
		const custom_values = await resolve_custom_values(store, control, context);
		for (let i = 0; i < custom_matches.length; i++) {
			const entry = custom_values[i];
			if (entry?.is_reset_key && entry.value) fragments.push(entry.value);
			else fragments.push('');
		}
	}
	return fragments.join('') || null;
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

function field_matches(row: ImperiumDoc, increment_field: string) {
	return String(row.increment_field ?? row.campo ?? '') === increment_field;
}

export async function find_increment_control(
	store: ImperiumStore,
	model_name: string,
	increment_field: string,
): Promise<ImperiumDoc | null> {
	if (!store.has('auto-increment-control') || !model_name) return null;
	const { rows } = await store.find_many('auto-increment-control', {
		where: increment_field ? { model_name, increment_field } : { model_name },
		take: 20000,
		include_inactive: true,
	});
	const matches = increment_field
		? rows.filter((row) => field_matches(row, increment_field))
		: rows;
	return (
		matches.find((row) => is_global_ref(row.ref_value) && row.is_active !== false) ??
		matches.find((row) => row.is_active !== false) ??
		matches.find((row) => is_global_ref(row.ref_value)) ??
		matches[0] ??
		rows.find((row) => is_global_ref(row.ref_value) && row.is_active !== false) ??
		rows[0] ??
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
	const exact = await store.find_where('auto-increment-control', {
		model_name,
		increment_field,
		ref_value: reset_key,
	});
	if (exact && field_matches(exact, increment_field) && String(exact.ref_value ?? '') === reset_key) {
		return exact;
	}
	const { rows } = await store.find_many('auto-increment-control', {
		where: { model_name, increment_field },
		take: 20000,
		include_inactive: true,
	});
	return (
		rows.find(
			(row) =>
				field_matches(row, increment_field) && String(row.ref_value ?? '') === reset_key,
		) ?? null
	);
}

export async function find_or_create_increment_segment(
	store: ImperiumStore,
	control: ImperiumDoc,
	reset_key: string | null,
): Promise<ImperiumDoc> {
	const existing = await find_increment_segment(store, control, reset_key);
	if (existing) return existing;
	if (!reset_key) return control;
	const increment_field = String(control.increment_field ?? 'sequence');
	const model_name = String(control.model_name ?? '');
	return store.insert('auto-increment-control', {
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
		_unique_string_reference: tracker_unique_ref(control, reset_key),
		is_active: true,
	});
}

export async function resolve_increment_preview_target(
	store: ImperiumStore,
	model_name: string,
	increment_field: string,
): Promise<{ config: ImperiumDoc | null; target: ImperiumDoc | null }> {
	const config = await find_increment_control(store, model_name, increment_field);
	if (!config) return { config: null, target: null };
	const reset_key = await compute_reset_key(store, config);
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
	if (sequence <= 0) return 0;
	const type = String(control?.type ?? 'numeric');
	if (type === 'alphanumeric') return numero_a_columna(sequence);
	if (type !== 'custom') return sequence;
	const pattern = String(control?.custom_pattern ?? '');
	const custom_values = await resolve_custom_values(store, control, context);
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
	const { rows } = await store.find_many('auto-increment-control', {
		take: 20000,
		include_inactive: true,
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
		if (current !== undefined && current !== null && current !== '') continue;
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
