/**
 * Normalización de folios: mismo contrato que
 * `AutoIncrementControlService.normalize_all_counters` del original.
 */
import { as_object, type ImperiumDoc } from './envelope.ts';
import {
	type CustomTokenValue,
	date_token_value,
	find_or_create_increment_segment,
	format_increment_real_value,
	format_token_numeric_value,
	increment_format_control,
	is_global_ref,
	is_missing_increment_value,
	numeric_sequence_from_unknown,
	numero_a_columna,
	reset_key_from_values,
	resolve_custom_values,
	unwrap_ref_value,
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
	/** Folios ilegibles o sin segmento: se dejan intactos. */
	unresolved_documents: number;
	/** Escrituras rechazadas por el store (unicidad, refs inválidas…). */
	failed_documents?: number;
	renumbered_documents?: number;
	adjusted_trackers?: number;
	/** Errores puntuales (documento o tracker) que no detuvieron la corrida. */
	errors?: string[];
	/** El índice completo no se pudo procesar (p. ej. tabla inaccesible). */
	failed?: boolean;
};

export type CounterNormalizationSummary = {
	forced: boolean;
	total_indexes: number;
	executed_indexes: number;
	normalized_indexes: number;
	scanned_documents: number;
	updated_documents: number;
	unresolved_documents: number;
	failed_documents: number;
	renumbered_documents: number;
	adjusted_trackers: number;
	/** Contadores cuya normalización falló por completo. */
	failed_indexes: number;
	/** Muestra de errores (documentos, trackers e índices), acotada. */
	errors: string[];
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

function sequence_from_document_field_tokens(
	tokens: PatternToken[],
	document: ImperiumDoc,
): number | null {
	for (const token of tokens) {
		if (token.kind !== 'field') continue;
		const found = numeric_sequence_from_unknown(
			context_value(document, token.field_path ?? ''),
		);
		if (found != null) return found;
	}
	return null;
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
	/** Valores `[custom]` ya resueltos: anclan el token en el regex. */
	custom_values?: string[];
}): { sequence: number | null; counter_captures: string[] } | null {
	let regex_source = '';
	let custom_index = 0;
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
			case 'custom': {
				// Con el valor resuelto se ancla literal (como `[field]`): si el
				// comodín se comiera parte del prefijo, la secuencia capturada
				// incluiría dígitos del custom y el folio crecería en cada corrida
				// (`D1005` → `D11005`). Sin valor cae al comodín de antes.
				const value = params.custom_values?.[custom_index++];
				regex_source += value ? escape_regex(value) : '(?:.*?)';
				break;
			}
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
	/** Valores `[custom]` ya resueltos para este documento (evita re-resolver). */
	custom_values?: string[];
}): Promise<string> {
	const custom_values =
		params.custom_values ??
		(params.tokens.some((token) => token.kind === 'custom')
			? (
					await resolve_custom_values(params.store, params.config, as_object(params.document))
				).map((entry) => entry.value)
			: []);
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
		// Solo columnas A–Z (estilo Excel): minúsculas o dígitos son datos
		// inválidos; reinterpretarlos reescribiría el folio en silencio.
		const text = String(params.old_value ?? '').trim();
		if (!/^[A-Za-z]+$/.test(text)) return undefined;
		const sequence = columna_a_numero(text.toUpperCase());
		if (!Number.isFinite(sequence) || sequence <= 0) return undefined;
		return numero_a_columna(sequence);
	}
	if (!params.tokens.length) return undefined;
	const custom = await resolve_document_custom_values(params);
	if (custom === undefined) return undefined;
	const custom_values = custom.map((entry) => entry.value);
	const extracted = extract_normalization_parts({
		tokens: params.tokens,
		old_value: params.old_value,
		reference_datetime: params.reference_datetime,
		document: params.document,
		custom_values,
	});
	let sequence = extracted?.sequence ?? null;
	if (sequence == null || !Number.isFinite(sequence) || sequence <= 0) {
		sequence = sequence_from_document_field_tokens(params.tokens, params.document);
	}
	if (sequence == null || !Number.isFinite(sequence) || sequence <= 0) {
		return undefined;
	}
	return rerender_folio({
		store: params.store,
		config: params.config,
		tokens: params.tokens,
		sequence,
		reference_datetime: params.reference_datetime,
		document: params.document,
		counter_captures: extracted?.counter_captures ?? [],
		custom_values,
	});
}

/**
 * Resuelve los `[custom]` del documento una sola vez. Devuelve `undefined`
 * si algún slot queda vacío (departamento sin condición, condición borrada):
 * reescribir ese folio produciría un valor degenerado (`-001`) y contarlo
 * pisaría el contador global, así que el documento se deja intacto.
 */
async function resolve_document_custom_values(params: {
	store: ImperiumStore;
	config: ImperiumDoc;
	tokens: PatternToken[];
	document: ImperiumDoc;
}): Promise<CustomTokenValue[] | undefined> {
	if (!params.tokens.some((token) => token.kind === 'custom')) return [];
	const values = await resolve_custom_values(
		params.store,
		params.config,
		as_object(params.document),
	);
	return values.some((entry) => !entry.value) ? undefined : values;
}

/** Secuencia que hoy lleva el documento, para no reutilizarla si no se pudo renumerar. */
function existing_sequence(params: {
	type: string;
	tokens: PatternToken[];
	field: string;
	document: ImperiumDoc;
	reference_datetime: Date;
	custom_values?: string[];
}): number | null {
	const value = params.document[params.field];
	if (params.type === 'numeric') return numeric_sequence_from_unknown(value);
	if (params.type === 'alphanumeric') {
		const text = String(value ?? '').trim();
		return /^[A-Za-z]+$/.test(text) ? columna_a_numero(text.toUpperCase()) : null;
	}
	const extracted = extract_normalization_parts({
		tokens: params.tokens,
		old_value: value,
		reference_datetime: params.reference_datetime,
		document: params.document,
		custom_values: params.custom_values,
	});
	const sequence = extracted?.sequence ?? null;
	return sequence != null && Number.isFinite(sequence) && sequence > 0 ? sequence : null;
}

async function load_all(store: ImperiumStore, resource: string): Promise<ImperiumDoc[]> {
	const out: ImperiumDoc[] = [];
	for await (const page of store.scan(resource, { include_inactive: true })) {
		out.push(...page);
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
		failed_documents: 0,
		renumbered_documents: 0,
		adjusted_trackers: 0,
		errors: [],
	};
}

const MAX_ERRORS_PER_INDEX = 20;

function error_text(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Registra un error puntual sin detener la corrida (muestra acotada). */
function note_error(summary: CounterNormalizationIndexSummary, detail: string) {
	summary.errors ??= [];
	if (summary.errors.length < MAX_ERRORS_PER_INDEX) summary.errors.push(detail);
}

type FolioChange = {
	id: string;
	current: unknown;
	next: unknown;
	segment: string | null;
	/** Secuencia que llevaba antes: si la escritura falla, el tracker no debe bajar de ella. */
	previous_sequence: number | null;
};

/**
 * Valor temporal único para romper un ciclo de intercambio de folios
 * (A→B y B→A) cuando el campo es único: nunca colisiona con folios reales
 * (negativo en numéricos; sufijo con el id en cadenas).
 */
function temporary_folio(change: FolioChange, type: string, ordinal: number): unknown {
	if (type === 'numeric') return -ordinal;
	return `${String(change.next)}~${change.id}`;
}

/**
 * Aplica los cambios de folio en un orden que nunca escribe un valor que
 * otro documento aún ocupa (el campo puede ser único: `name` de tickets,
 * `codigo` de SKU…). Un ciclo se rompe con un valor temporal. Cuando el
 * ocupante no va a cambiar se intenta igual: si el campo no es único la
 * escritura pasa; si lo es, el error queda como documento fallido.
 */
async function apply_folio_changes(params: {
	store: ImperiumStore;
	resource: string;
	field: string;
	type: string;
	documents: ImperiumDoc[];
	changes: FolioChange[];
	summary: CounterNormalizationIndexSummary;
}): Promise<FolioChange[]> {
	const { store, resource, field, summary } = params;
	const failed: FolioChange[] = [];
	const holders = new Map<string, string>();
	for (const doc of params.documents) {
		if (is_missing_increment_value(doc[field])) continue;
		const key = serialize_value(doc[field]);
		if (!holders.has(key)) holders.set(key, String(doc._id));
	}
	const write = async (change: FolioChange, value: unknown): Promise<boolean> => {
		try {
			await store.update(resource, change.id, { [field]: value });
		} catch (err) {
			summary.failed_documents = (summary.failed_documents ?? 0) + 1;
			failed.push(change);
			note_error(summary, `${change.id}: ${error_text(err)}`);
			return false;
		}
		const previous = serialize_value(change.current);
		if (holders.get(previous) === change.id) holders.delete(previous);
		holders.set(serialize_value(value), change.id);
		change.current = value;
		return true;
	};
	let pending = [...params.changes];
	let placeholders = 0;
	while (pending.length) {
		const blocked: FolioChange[] = [];
		for (const change of pending) {
			const holder = holders.get(serialize_value(change.next));
			if (holder && holder !== change.id) {
				blocked.push(change);
				continue;
			}
			if (await write(change, change.next)) summary.updated_documents += 1;
		}
		if (blocked.length === pending.length) {
			const first = blocked[0]!;
			const holder_id = holders.get(serialize_value(first.next));
			const holder = blocked.find((change) => change.id === holder_id);
			if (holder) {
				placeholders += 1;
				if (!(await write(holder, temporary_folio(holder, params.type, placeholders)))) {
					blocked.splice(blocked.indexOf(holder), 1);
				}
			} else {
				blocked.shift();
				if (await write(first, first.next)) summary.updated_documents += 1;
			}
		}
		pending = blocked;
	}
	return failed;
}

/**
 * Deja cada tracker de segmento en el conteo real de sus documentos,
 * alinea duplicados del mismo segmento y pone en 0 los huérfanos. Nunca
 * lanza: cada tracker que falle queda anotado en `summary.errors`.
 */
async function adjust_segment_trackers(params: {
	store: ImperiumStore;
	config: ImperiumDoc;
	type: string;
	field: string;
	segment_counts: Map<string | null, number>;
	/** Último documento de cada segmento: contexto real para renderizar el valor. */
	segment_samples: Map<string | null, ImperiumDoc>;
	/**
	 * Mayor secuencia que conserva un documento que NO se pudo renumerar: el
	 * tracker no baja de ahí, o la siguiente alta repetiría ese folio.
	 */
	segment_floors: Map<string | null, number>;
	summary: CounterNormalizationIndexSummary;
}): Promise<void> {
	const { store, config, type, field, summary } = params;
	const model_name = String(config.model_name ?? '');
	const touched = new Set<string>();
	const count_for = (segment: string | null) =>
		Math.max(params.segment_counts.get(segment) ?? 0, params.segment_floors.get(segment) ?? 0);
	// Mismo render que la asignación (`advance_increment_sequence`): el
	// `current_real_value` del tracker queda igual al folio que emitiría.
	const real_value = async (target: ImperiumDoc, segment: string | null, count: number) => {
		if (type === 'numeric') return count;
		if (type === 'alphanumeric') return numero_a_columna(count);
		const sample = params.segment_samples.get(segment);
		return format_increment_real_value(
			store,
			increment_format_control(config, target, segment),
			count,
			sample ? as_object(sample) : undefined,
		).catch(() => count);
	};
	for (const segment of params.segment_counts.keys()) {
		const count = count_for(segment);
		try {
			const target = await find_or_create_increment_segment(store, config, segment);
			const patch = {
				current_sequence: count,
				current: count,
				valor: count,
				current_real_value: await real_value(target, segment, count),
			};
			await store.update('auto-increment-control', String(target._id), patch);
			touched.add(String(target._id));
			summary.adjusted_trackers = (summary.adjusted_trackers ?? 0) + 1;
		} catch (err) {
			note_error(summary, `tracker ${segment ?? '(global)'}: ${error_text(err)}`);
		}
	}
	// Barrido: duplicados del mismo segmento reciben el mismo conteo (así no
	// queda una fila rezagada que la asignación pueda tomar) y los segmentos
	// sin documentos vuelven a 0. Los refs legacy llegan envueltos (`"AGP"`):
	// se comparan desenvueltos contra las claves planas de `segment_counts`.
	for await (const page of store.scan('auto-increment-control', {
		where: { model_name },
		include_inactive: true,
	})) {
		for (const tracker of page) {
			const id = String(tracker._id ?? '');
			if (touched.has(id)) continue;
			if (String(tracker.increment_field ?? tracker.campo ?? '') !== field) continue;
			if (is_global_ref(tracker.ref_value)) continue;
			const ref = unwrap_ref_value(tracker.ref_value);
			if (!ref) continue;
			const count = params.segment_counts.has(ref) ? count_for(ref) : 0;
			try {
				await store.update('auto-increment-control', id, {
					current_sequence: count,
					current: count,
					valor: count,
					...(count === 0 ? {} : { current_real_value: await real_value(tracker, ref, count) }),
				});
				touched.add(id);
				summary.adjusted_trackers = (summary.adjusted_trackers ?? 0) + 1;
			} catch (err) {
				note_error(summary, `tracker ${ref}: ${error_text(err)}`);
			}
		}
	}
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

	const documents = await load_all(params.store, resource);

	if (params.force) {
		const sorted = [...documents].sort((a, b) => {
			const ta = String(a.createdAt ?? a.created_at ?? '');
			const tb = String(b.createdAt ?? b.created_at ?? '');
			if (ta !== tb) return ta.localeCompare(tb);
			return String(a._id ?? '').localeCompare(String(b._id ?? ''));
		});
		const pattern = String(params.config.custom_pattern ?? '');
		const segment_counts = new Map<string | null, number>();
		const segment_samples = new Map<string | null, ImperiumDoc>();
		const segment_floors = new Map<string | null, number>();
		const raise_floor = (segment: string | null, sequence: number | null) => {
			if (sequence == null) return;
			segment_floors.set(segment, Math.max(segment_floors.get(segment) ?? 0, sequence));
		};
		const changes: FolioChange[] = [];
		for (const doc of sorted) {
			summary.scanned_documents += 1;
			const when = reference_date(doc);
			let segment: string | null = null;
			try {
				const raw_custom =
					type === 'custom'
						? await resolve_custom_values(params.store, params.config, as_object(doc))
						: [];
				const custom_values = raw_custom.map((entry) => entry.value);
				const previous_sequence = existing_sequence({
					type,
					tokens,
					field,
					document: doc,
					reference_datetime: when,
					custom_values,
				});
				segment = type === 'custom' ? reset_key_from_values(pattern, raw_custom, when) : null;
				if (type === 'custom' && raw_custom.some((entry) => !entry.value)) {
					// Sin valor para algún [custom]: el folio se deja intacto y la
					// secuencia que lleva sigue reservada en su segmento (si lo tenía).
					raise_floor(segment, previous_sequence);
					summary.unresolved_documents += 1;
					note_error(summary, `${String(doc._id ?? '')}: sin valor para [custom]; se deja intacto`);
					continue;
				}
				const next = (segment_counts.get(segment) ?? 0) + 1;
				segment_counts.set(segment, next);
				segment_samples.set(segment, doc);
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
						custom_values,
					});
				}
				if (serialize_value(next_value) === serialize_value(doc[field])) continue;
				changes.push({
					id: String(doc._id),
					current: doc[field],
					next: next_value,
					segment,
					previous_sequence,
				});
			} catch (err) {
				// previous_sequence no está disponible aquí (falló antes de calcularlo);
				// el piso de floor se cubre con lo ya renumerado del segmento.
				summary.unresolved_documents += 1;
				note_error(summary, `${String(doc._id ?? '')}: ${error_text(err)}`);
			}
		}
		const failed = await apply_folio_changes({
			store: params.store,
			resource,
			field,
			type,
			documents,
			changes,
			summary,
		});
		for (const change of failed) raise_floor(change.segment, change.previous_sequence);
		summary.renumbered_documents = summary.updated_documents;
		await adjust_segment_trackers({
			store: params.store,
			config: params.config,
			type,
			field,
			segment_counts,
			segment_samples,
			segment_floors,
			summary,
		});
		return summary;
	}

	for (const doc of documents) {
		summary.scanned_documents += 1;
		try {
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
		} catch (err) {
			// Un documento con refs inválidas o folio en conflicto no detiene
			// la normalización del resto: queda intacto y anotado.
			summary.failed_documents = (summary.failed_documents ?? 0) + 1;
			note_error(summary, `${String(doc._id ?? '')}: ${error_text(err)}`);
		}
	}
	return summary;
}

export async function normalize_all_counters(
	store: ImperiumStore,
	opts: { force?: boolean } = {},
): Promise<CounterNormalizationSummary> {
	const force = opts.force === true;
	const seen = new Set<string>();
	const configs: ImperiumDoc[] = [];
	for await (const page of store.scan('auto-increment-control', {
		include_inactive: true,
	})) {
		for (const row of page) {
			if (!is_global_ref(row.ref_value)) continue;
			if (row.is_active === false) continue;
			const model_name = String(row.model_name ?? '').trim();
			const field = String(row.increment_field ?? '').trim();
			if (!model_name || !field) continue;
			// Misma identidad que la asignación (`assign_document_increments`,
			// `find_increment_control`): un campo tiene UN contador aunque haya
			// dos globales con distinto index_name; procesar ambas renumeraría
			// dos veces y pondría en 0 los segmentos de la otra.
			const key = `${model_name}::${field}`;
			if (seen.has(key)) continue;
			seen.add(key);
			configs.push(row);
		}
	}
	configs.sort(
		(a, b) =>
			(String(a.type ?? '') === 'custom' ? 1 : 0) -
			(String(b.type ?? '') === 'custom' ? 1 : 0),
	);

	const results: CounterNormalizationIndexSummary[] = [];
	for (const config of configs) {
		try {
			results.push(await normalize_index({ store, config, configs, force }));
		} catch (err) {
			// Un contador roto (tabla inaccesible, patrón inválido…) no impide
			// normalizar los demás: se reporta y la corrida continúa.
			const failed = empty_summary(config, store.resource_for_model(String(config.model_name ?? '')) ?? '');
			failed.failed = true;
			note_error(failed, error_text(err));
			results.push(failed);
		}
	}

	const sum = (selector: (row: CounterNormalizationIndexSummary) => number) =>
		results.reduce((total, row) => total + selector(row), 0);
	const errors = results.flatMap((row) =>
		(row.errors ?? []).map((detail) => `${row.model_name}.${row.increment_field}: ${detail}`),
	);
	return {
		forced: force,
		total_indexes: results.length,
		executed_indexes: results.filter((row) => row.scanned_documents > 0).length,
		normalized_indexes: results.filter((row) => row.updated_documents > 0).length,
		scanned_documents: sum((row) => row.scanned_documents),
		updated_documents: sum((row) => row.updated_documents),
		unresolved_documents: sum((row) => row.unresolved_documents),
		failed_documents: sum((row) => row.failed_documents ?? 0),
		renumbered_documents: sum((row) => row.renumbered_documents ?? 0),
		adjusted_trackers: sum((row) => row.adjusted_trackers ?? 0),
		failed_indexes: results.filter((row) => row.failed).length,
		errors: errors.slice(0, MAX_ERRORS_PER_INDEX),
		results,
	};
}

function text(value: unknown): string {
	return String(value ?? '').trim();
}

/**
 * Misma clave que `AutoIncrementControlService.build_unique_string_reference`.
 */
export function build_increment_unique_ref(params: {
	collection: string;
	model_name: string;
	increment_field: string;
	index_name: string;
}): string {
	return [
		params.collection,
		params.model_name,
		params.increment_field,
		params.index_name,
		JSON.stringify(null),
	].join('::');
}

/**
 * Completa collection / index_name / _unique_string_reference como
 * `AutoIncrementControlService.normalize_payload` + `__create`.
 */
export async function prepare_increment_create(
	store: ImperiumStore,
	incoming: ImperiumDoc,
): Promise<ImperiumDoc> {
	const model_name = text(incoming.model_name);
	if (!model_name) throw new Error('Debes indicar el nombre del modelo.');
	const hit = store
		.available_mongoose_models()
		.find((row) => row.model_name === model_name);
	if (!hit) throw new Error(`El modelo ${model_name} no existe.`);
	const increment_field = text(incoming.increment_field ?? incoming.campo);
	if (!increment_field) throw new Error('Debes indicar el campo a incrementar.');
	const collection = hit.collection;
	const index_name = text(incoming.index_name) || increment_field;
	const type = text(incoming.type) || 'numeric';
	if (!['numeric', 'alphanumeric', 'custom'].includes(type)) {
		throw new Error('El tipo debe ser numeric, alphanumeric o custom.');
	}
	const custom_pattern =
		type === 'custom' ? text(incoming.custom_pattern) || undefined : undefined;
	const unique = build_increment_unique_ref({
		collection,
		model_name,
		increment_field,
		index_name,
	});
	for await (const page of store.scan('auto-increment-control', {
		where: { model_name, increment_field },
		include_inactive: true,
	})) {
		// Un campo lleva un solo contador: otra global activa para el mismo
		// (model, field) —aunque cambie index_name— duplicaría la numeración.
		const combo = page.find(
			(row) =>
				is_global_ref(row.ref_value) &&
				(row.is_active !== false || text(row.index_name ?? row.increment_field) === index_name),
		);
		const by_unique = page.find((row) => text(row._unique_string_reference) === unique);
		if (combo || by_unique) {
			throw new Error('Ya existe un control de auto-incremento para esa combinación.');
		}
	}
	return {
		...incoming,
		name: text(incoming.name) || `${model_name}.${increment_field}`,
		model_name,
		collection,
		increment_field,
		index_name,
		type,
		custom_pattern,
		_unique_string_reference: unique,
		user_edited: true,
	};
}
