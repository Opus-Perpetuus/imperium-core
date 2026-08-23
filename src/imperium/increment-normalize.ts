/**
 * Normalización de folios: mismo contrato que
 * `AutoIncrementControlService.normalize_all_counters` del original.
 */
import { as_object, type ImperiumDoc } from './envelope.ts';
import {
	compute_reset_key,
	date_token_value,
	find_or_create_increment_segment,
	format_token_numeric_value,
	is_global_ref,
	numero_a_columna,
	resolve_custom_values,
} from './custom-pattern-render.ts';
import type { ImperiumStore } from './store.ts';

export type CounterNormalizationIndexSummary = {
	model_name: string;
	collection_name: string;
	increment_field: string;
	index_name: string;
	type: string;
	scanned_documents: number;
	updated_documents: number;
	unresolved_documents: number;
	renumbered_documents?: number;
	adjusted_trackers?: number;
};

export type CounterNormalizationSummary = {
	forced: boolean;
	total_indexes: number;
	executed_indexes: number;
	normalized_indexes: number;
	scanned_documents: number;
	updated_documents: number;
	unresolved_documents: number;
	renumbered_documents: number;
	adjusted_trackers: number;
	results: CounterNormalizationIndexSummary[];
};

type PatternToken = {
	kind: 'literal' | 'date' | 'seq' | 'field' | 'custom' | 'counter';
	text?: string;
	date_format?: string;
	zero_padding?: number;
	use_alpha?: boolean;
	use_roman?: boolean;
	field_path?: string;
	counter_id?: string;
	same_model_field?: string | null;
};

export function columna_a_numero(str: string): number {
	let total = 0;
	for (const ch of str) {
		total = ch.charCodeAt(0) - 64 + total * 26;
	}
	return total;
}

function serialize_value(value: unknown): string {
	if (value === null || value === undefined) return 'null';
	if (typeof value === 'object') return JSON.stringify(value);
	return String(value);
}

function escape_regex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function has_increment_value(doc: ImperiumDoc, field: string): boolean {
	const value = doc[field];
	if (value == null) return false;
	if (typeof value === 'string' && value.trim() === '') return false;
	return true;
}

function reference_date(doc: ImperiumDoc): Date {
	const raw = doc.createdAt ?? doc.created_at;
	if (raw instanceof Date && !Number.isNaN(raw.getTime())) return raw;
	if (raw && !Number.isNaN(new Date(String(raw)).getTime())) return new Date(String(raw));
	return new Date();
}

function context_value(doc: ImperiumDoc, field_path: string): unknown {
	if (!field_path.trim()) return undefined;
	return field_path
		.split('.')
		.map((segment) => segment.trim())
		.filter(Boolean)
		.reduce<unknown>((current, segment) => {
			if (current == null || typeof current !== 'object') return undefined;
			return (current as Record<string, unknown>)[segment];
		}, doc);
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

function format_token_field_value(raw_value: string, token: PatternToken): string {
	const zero_padding = token.zero_padding ?? 0;
	const use_alpha = !!token.use_alpha;
	const use_roman = !!token.use_roman;
	if (!use_alpha && !use_roman && !(zero_padding > 0)) return raw_value;
	const numeric = Number(raw_value);
	if (!raw_value.trim() || !Number.isFinite(numeric)) return raw_value;
	return format_token_numeric_value({
		sequence: numeric,
		zero_padding,
		use_alpha,
		use_roman,
	});
}

export function tokenize_custom_pattern(pattern: string): PatternToken[] {
	const tokens: PatternToken[] = [];
	const token_regex =
		/\[(yy|yyyy|LL|LLL|LLLL|WW|ooo|dd|c|ccc|cccc)\]|\[(seq|sequence)(;ceros=([^\]\[;]*))?(;letra=([^\]\[;]*))?(;romano=([^\]\[;]*))?\]|\[counter=([^\]\[;]*)(;ceros=([^\]\[;]*))?(;letra=([^\]\[;]*))?(;romano=([^\]\[;]*))?\]|\[field=([^\]\[;]*)(;ceros=([^\]\[;]*))?(;letra=([^\]\[;]*))?(;romano=([^\]\[;]*))?\]|\[custom\]/g;
	let last_index = 0;
	const to_bool = (value: unknown) => String(value ?? '').toLowerCase() === 'true';
	for (const match of pattern.matchAll(token_regex)) {
		const match_index = match.index ?? 0;
		if (match_index > last_index) {
			tokens.push({ kind: 'literal', text: pattern.slice(last_index, match_index) });
		}
		last_index = match_index + match[0].length;
		if (match[1]) {
			tokens.push({ kind: 'date', date_format: match[1] });
		} else if (match[2]) {
			tokens.push({
				kind: 'seq',
				zero_padding: Number(match[4] ?? 0),
				use_alpha: to_bool(match[6]),
				use_roman: to_bool(match[8]),
			});
		} else if (match[9] !== undefined) {
			tokens.push({
				kind: 'counter',
				counter_id: String(match[9]).trim(),
				zero_padding: Number(match[11] ?? 0),
				use_alpha: to_bool(match[13]),
				use_roman: to_bool(match[15]),
			});
		} else if (match[16] !== undefined) {
			tokens.push({
				kind: 'field',
				field_path: String(match[16]).trim(),
				zero_padding: Number(match[18] ?? 0),
				use_alpha: to_bool(match[20]),
				use_roman: to_bool(match[22]),
			});
		} else {
			tokens.push({ kind: 'custom' });
		}
	}
	if (last_index < pattern.length) {
		tokens.push({ kind: 'literal', text: pattern.slice(last_index) });
	}
	return tokens;
}

function extract_normalization_parts(params: {
	tokens: PatternToken[];
	old_value: unknown;
	reference_datetime: Date;
	document: ImperiumDoc;
}): { sequence: number | null; counter_captures: string[] } | null {
	let regex_source = '';
	const group_kinds: Array<'seq' | 'counter'> = [];
	for (const token of params.tokens) {
		switch (token.kind) {
			case 'literal':
				regex_source += escape_regex(token.text ?? '');
				break;
			case 'date':
				regex_source += escape_regex(
					date_token_value(token.date_format ?? '', params.reference_datetime),
				);
				break;
			case 'field': {
				const raw = stringify_context(context_value(params.document, token.field_path ?? ''));
				regex_source += raw
					? escape_regex(format_token_field_value(raw, token))
					: '(?:.+?)';
				break;
			}
			case 'custom':
				regex_source += '(?:.*?)';
				break;
			case 'seq':
				regex_source += token.use_alpha
					? '([A-Za-z]+)'
					: token.use_roman
						? '([IVXLCDM()]+)'
						: '(\\d+)';
				group_kinds.push('seq');
				break;
			case 'counter':
				if (token.same_model_field) regex_source += '(?:.*?)';
				else {
					regex_source += '(.+?)';
					group_kinds.push('counter');
				}
				break;
		}
	}
	const match = String(params.old_value).match(new RegExp(`^${regex_source}$`, 'i'));
	if (!match) return null;
	let sequence: number | null = null;
	const counter_captures: string[] = [];
	group_kinds.forEach((kind, index) => {
		const capture = match[index + 1] ?? '';
		if (kind === 'counter') {
			counter_captures.push(capture);
			return;
		}
		if (sequence !== null) return;
		const trimmed = capture.trim();
		if (/^[A-Za-z]+$/.test(trimmed)) {
			sequence = columna_a_numero(trimmed.toUpperCase());
		} else if (/^[IVXLCDM()]+$/i.test(trimmed) && !/\d/.test(trimmed)) {
			sequence = null;
		} else {
			const parsed = Number(trimmed);
			sequence = Number.isFinite(parsed) ? parsed : null;
		}
	});
	return { sequence, counter_captures };
}

async function rerender_folio(params: {
	store: ImperiumStore;
	config: ImperiumDoc;
	tokens: PatternToken[];
	sequence: number;
	reference_datetime: Date;
	document: ImperiumDoc;
	counter_captures: string[];
	force_counter_read?: boolean;
	segment_ref_value?: string | null;
}): Promise<string> {
	const custom_values = params.tokens.some((token) => token.kind === 'custom')
		? (await resolve_custom_values(params.store, params.config, as_object(params.document))).map(
				(entry) => entry.value,
			)
		: [];
	let custom_index = 0;
	let counter_index = 0;
	let value = '';
	for (const token of params.tokens) {
		switch (token.kind) {
			case 'literal':
				value += token.text ?? '';
				break;
			case 'date':
				value += date_token_value(token.date_format ?? '', params.reference_datetime);
				break;
			case 'seq':
				value += format_token_numeric_value({
					sequence: params.sequence,
					zero_padding: token.zero_padding,
					use_alpha: token.use_alpha,
					use_roman: token.use_roman,
				});
				break;
			case 'field': {
				const raw = stringify_context(context_value(params.document, token.field_path ?? ''));
				value += format_token_field_value(raw, token);
				break;
			}
			case 'custom':
				value += custom_values[custom_index] ?? '';
				custom_index += 1;
				break;
			case 'counter':
				if (token.same_model_field) {
					const raw = stringify_context(
						context_value(params.document, token.same_model_field),
					);
					value += format_token_field_value(raw, token);
				} else if (params.force_counter_read) {
					const hit =
						(await params.store.find_where('auto-increment-control', {
							index_name: token.counter_id ?? '',
						})) ??
						(await params.store.find_where('auto-increment-control', {
							increment_field: token.counter_id ?? '',
						}));
					value += format_token_numeric_value({
						sequence: Number(hit?.current_sequence ?? hit?.current ?? hit?.valor ?? 0),
						zero_padding: token.zero_padding,
						use_alpha: token.use_alpha,
						use_roman: token.use_roman,
					});
				} else {
					value += params.counter_captures[counter_index] ?? '';
					counter_index += 1;
				}
				break;
		}
	}
	return value;
}

async function compute_normalized_value(params: {
	store: ImperiumStore;
	config: ImperiumDoc;
	tokens: PatternToken[];
	type: string;
	old_value: unknown;
	document: ImperiumDoc;
	reference_datetime: Date;
}): Promise<unknown> {
	if (params.type === 'numeric') {
		const numeric = Number(params.old_value);
		if (!Number.isFinite(numeric) || numeric <= 0) return undefined;
		return numeric;
	}
	if (params.type === 'alphanumeric') {
		const sequence = columna_a_numero(String(params.old_value ?? ''));
		if (!Number.isFinite(sequence) || sequence <= 0) return undefined;
		return numero_a_columna(sequence);
	}
	if (!params.tokens.length) return undefined;
	const extracted = extract_normalization_parts({
		tokens: params.tokens,
		old_value: params.old_value,
		reference_datetime: params.reference_datetime,
		document: params.document,
	});
	if (
		!extracted ||
		extracted.sequence === null ||
		!Number.isFinite(extracted.sequence) ||
		extracted.sequence <= 0
	) {
		return undefined;
	}
	return rerender_folio({
		store: params.store,
		config: params.config,
		tokens: params.tokens,
		sequence: extracted.sequence,
		reference_datetime: params.reference_datetime,
		document: params.document,
		counter_captures: extracted.counter_captures,
	});
}

async function load_all(store: ImperiumStore, resource: string): Promise<ImperiumDoc[]> {
	const out: ImperiumDoc[] = [];
	let skip = 0;
	const take = 500;
	for (;;) {
		const { rows, total } = await store.find_many(resource, {
			take,
			skip,
			include_inactive: true,
			populate: false,
		});
		out.push(...rows);
		skip += rows.length;
		if (!rows.length || skip >= total) break;
	}
	return out;
}

function empty_summary(config: ImperiumDoc, resource: string): CounterNormalizationIndexSummary {
	return {
		model_name: String(config.model_name ?? ''),
		collection_name: String(config.collection ?? resource),
		increment_field: String(config.increment_field ?? ''),
		index_name: String(config.index_name ?? config.increment_field ?? ''),
		type: String(config.type ?? 'numeric'),
		scanned_documents: 0,
		updated_documents: 0,
		unresolved_documents: 0,
		renumbered_documents: 0,
		adjusted_trackers: 0,
	};
}

function annotate_same_model(
	tokens: PatternToken[],
	configs: ImperiumDoc[],
	model_name: string,
): PatternToken[] {
	return tokens.map((token) => {
		if (token.kind !== 'counter') return token;
		const hit = configs.find(
			(row) =>
				String(row.model_name ?? '') === model_name &&
				(String(row.index_name ?? '') === token.counter_id ||
					String(row.increment_field ?? '') === token.counter_id),
		);
		return { ...token, same_model_field: hit ? String(hit.increment_field ?? '') : null };
	});
}

async function normalize_index(params: {
	store: ImperiumStore;
	config: ImperiumDoc;
	configs: ImperiumDoc[];
	force: boolean;
}): Promise<CounterNormalizationIndexSummary> {
	const model_name = String(params.config.model_name ?? '');
	const field = String(params.config.increment_field ?? '');
	const type = String(params.config.type ?? 'numeric');
	const resource = params.store.resource_for_model(model_name);
	const summary = empty_summary(params.config, resource ?? '');
	if (!resource || !params.store.has(resource) || !field) return summary;

	const tokens = annotate_same_model(
		type === 'custom' ? tokenize_custom_pattern(String(params.config.custom_pattern ?? '')) : [],
		params.configs,
		model_name,
	);
	if (type === 'custom' && !tokens.some((token) => token.kind !== 'literal')) return summary;

	const documents = (await load_all(params.store, resource)).filter((doc) =>
		has_increment_value(doc, field),
	);

	if (params.force) {
		const sorted = [...documents].sort((a, b) => {
			const ta = String(a.createdAt ?? a.created_at ?? '');
			const tb = String(b.createdAt ?? b.created_at ?? '');
			if (ta !== tb) return ta.localeCompare(tb);
			return String(a._id ?? '').localeCompare(String(b._id ?? ''));
		});
		const segment_counts = new Map<string | null, number>();
		for (const doc of sorted) {
			summary.scanned_documents += 1;
			try {
				const when = reference_date(doc);
				const segment =
					type === 'custom'
						? await compute_reset_key(params.store, params.config, as_object(doc), when)
						: null;
				const next = (segment_counts.get(segment) ?? 0) + 1;
				segment_counts.set(segment, next);
				let next_value: unknown;
				if (type === 'numeric') next_value = next;
				else if (type === 'alphanumeric') next_value = numero_a_columna(next);
				else {
					next_value = await rerender_folio({
						store: params.store,
						config: params.config,
						tokens,
						sequence: next,
						reference_datetime: when,
						document: doc,
						counter_captures: [],
						force_counter_read: true,
						segment_ref_value: segment,
					});
				}
				if (serialize_value(next_value) === serialize_value(doc[field])) continue;
				await params.store.update(resource, String(doc._id), { [field]: next_value });
				summary.updated_documents += 1;
			} catch {
				summary.unresolved_documents += 1;
			}
		}
		summary.renumbered_documents = summary.updated_documents;
		for (const [segment, count] of segment_counts) {
			const target = await find_or_create_increment_segment(params.store, params.config, segment);
			const real = await rerender_folio({
				store: params.store,
				config: params.config,
				tokens: tokens.length ? tokens : [{ kind: 'seq' }],
				sequence: count,
				reference_datetime: new Date(),
				document: {},
				counter_captures: [],
			}).catch(() => count);
			await params.store.update('auto-increment-control', String(target._id), {
				current_sequence: count,
				current: count,
				valor: count,
				current_real_value: type === 'numeric' ? count : real,
			});
			summary.adjusted_trackers = (summary.adjusted_trackers ?? 0) + 1;
		}
		const { rows: trackers } = await params.store.find_many('auto-increment-control', {
			where: { model_name },
			take: 200,
			include_inactive: true,
		});
		for (const tracker of trackers) {
			if (String(tracker.increment_field ?? '') !== field) continue;
			if (is_global_ref(tracker.ref_value)) continue;
			const ref = String(tracker.ref_value ?? '');
			if (!ref || segment_counts.has(ref)) continue;
			await params.store.update('auto-increment-control', String(tracker._id), {
				current_sequence: 0,
				current: 0,
				valor: 0,
			});
			summary.adjusted_trackers = (summary.adjusted_trackers ?? 0) + 1;
		}
		return summary;
	}

	for (const doc of documents) {
		summary.scanned_documents += 1;
		const next_value = await compute_normalized_value({
			store: params.store,
			config: params.config,
			tokens,
			type,
			old_value: doc[field],
			document: doc,
			reference_datetime: reference_date(doc),
		});
		if (next_value === undefined) {
			summary.unresolved_documents += 1;
			continue;
		}
		if (serialize_value(next_value) === serialize_value(doc[field])) continue;
		await params.store.update(resource, String(doc._id), { [field]: next_value });
		summary.updated_documents += 1;
	}
	return summary;
}

export async function normalize_all_counters(
	store: ImperiumStore,
	opts: { force?: boolean } = {},
): Promise<CounterNormalizationSummary> {
	const force = opts.force === true;
	const { rows } = await store.find_many('auto-increment-control', {
		take: 5000,
		include_inactive: true,
	});
	const seen = new Set<string>();
	const configs = rows
		.filter((row) => {
			if (!is_global_ref(row.ref_value)) return false;
			if (row.is_active === false) return false;
			const model_name = String(row.model_name ?? '').trim();
			const field = String(row.increment_field ?? '').trim();
			if (!model_name || !field) return false;
			const key = `${model_name}::${field}::${row.index_name ?? field}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		})
		.sort(
			(a, b) =>
				(String(a.type ?? '') === 'custom' ? 1 : 0) -
				(String(b.type ?? '') === 'custom' ? 1 : 0),
		);

	const results: CounterNormalizationIndexSummary[] = [];
	for (const config of configs) {
		results.push(await normalize_index({ store, config, configs, force }));
	}

	const sum = (selector: (row: CounterNormalizationIndexSummary) => number) =>
		results.reduce((total, row) => total + selector(row), 0);
	return {
		forced: force,
		total_indexes: results.length,
		executed_indexes: results.filter((row) => row.scanned_documents > 0).length,
		normalized_indexes: results.filter((row) => row.updated_documents > 0).length,
		scanned_documents: sum((row) => row.scanned_documents),
		updated_documents: sum((row) => row.updated_documents),
		unresolved_documents: sum((row) => row.unresolved_documents),
		renumbered_documents: sum((row) => row.renumbered_documents ?? 0),
		adjusted_trackers: sum((row) => row.adjusted_trackers ?? 0),
		results,
	};
}
