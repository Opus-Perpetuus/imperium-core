/**
 * Sobres Imperium: mismo contrato que Angular (`ResponseStandard`).
 */

export type ImperiumDoc = Record<string, unknown>;

export function ok<T>(
	data: T[] | T | null,
	message = 'OK',
	total?: number,
): {
	data: T[];
	total_elementos: number;
	message: string;
} {
	const rows = data == null ? [] : Array.isArray(data) ? data : [data];
	return {
		data: rows,
		total_elementos: total ?? rows.length,
		message,
	};
}

export function fail(message: string, status = 400, extra?: Record<string, unknown>) {
	return {
		status,
		body: {
			message,
			error: message,
			...extra,
		},
	};
}

/**
 * Traduce unique de Postgres (`23505`) al mismo texto que el original
 * mapeaba desde Mongo `E11000`.
 */
export function humanize_caught_error(err: unknown): {
	message: string;
	code?: string;
	field_errors?: Record<string, string[]>;
} {
	const rec = err as {
		message?: unknown;
		code?: unknown;
		field_errors?: unknown;
	};
	if (rec.field_errors && typeof rec.field_errors === 'object' && !Array.isArray(rec.field_errors)) {
		const message =
			typeof rec.message === 'string' && rec.message.trim()
				? rec.message
				: 'Error de validación';
		return {
			message,
			code: typeof rec.code === 'string' && rec.code.trim() ? rec.code : 'ValidationError',
			field_errors: rec.field_errors as Record<string, string[]>,
		};
	}
	const duplicate = map_pg_duplicate_message(err);
	if (duplicate) return { message: duplicate };
	const message =
		typeof rec.message === 'string' && rec.message.trim()
			? rec.message
			: String(err);
	const code = typeof rec.code === 'string' && rec.code.trim() ? rec.code : undefined;
	return { message, code };
}

function map_pg_duplicate_message(err: unknown): string | null {
	if (!err || typeof err !== 'object') return null;
	const rec = err as {
		code?: unknown;
		errno?: unknown;
		detail?: unknown;
		constraint?: unknown;
		message?: unknown;
	};
	const code = String(rec.errno ?? rec.code ?? '');
	const message = String(rec.message ?? '');
	const is_unique =
		code === '23505' || /duplicate key value violates unique constraint/i.test(message);
	if (!is_unique) return null;

	const detail = String(rec.detail ?? '');
	const key_match = detail.match(/Key \(([^)]+)\)=\(([\s\S]*)\) already exists\.?/i);
	if (key_match) {
		const raw_field = (key_match[1] ?? '').split(',')[0]?.trim().replace(/"/g, '') ?? '';
		const raw_value = (key_match[2] ?? '').trim();
		const field = raw_field === 'ref' ? '_ref' : raw_field === 'id' ? '_id' : raw_field;
		const field_label = field === '_ref' ? 'la referencia' : `el campo ${field}`;
		if (raw_value) return `Ya existe un registro con ${field_label} "${raw_value}".`;
	}
	return 'Ya existe un registro con un valor único repetido.';
}

export function to_imperium(row: Record<string, unknown> | null): ImperiumDoc | null {
	if (!row) return null;
	const payload = as_object(row.payload);
	const custom = as_object(row.custom_data);
	const columns = omit(row, ['payload']);
	const out: ImperiumDoc = {
		...payload,
		...columns,
		_id: row.id ?? payload._id,
		id: row.id,
		_ref: row.ref ?? payload._ref ?? null,
		custom_data: custom,
		createdAt: row.created_at ?? payload.createdAt,
		updatedAt: row.updated_at ?? payload.updatedAt,
	};
	for (const [key, value] of Object.entries(payload)) {
		if (out[key] == null && value != null) out[key] = value;
	}
	return out;
}

export function from_imperium(
	doc: ImperiumDoc,
	column_names: Set<string>,
): Record<string, unknown> {
	const id = String(doc._id ?? doc.id ?? '').trim();
	const payload: Record<string, unknown> = {};
	const row: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(doc)) {
		if (k === '_id' || k === 'id') continue;
		if (k === '_ref') {
			row.ref = v;
			continue;
		}
		if (k === 'createdAt') {
			row.created_at = iso(v);
			continue;
		}
		if (k === 'updatedAt') {
			row.updated_at = iso(v);
			continue;
		}
		if (column_names.has(k)) row[k] = scalar_ref(v);
		else payload[k] = v;
	}
	if (id) row.id = id;
	row.payload = { ...as_object(doc.payload), ...payload };
	if (doc.custom_data !== undefined) row.custom_data = doc.custom_data;
	if (doc.name !== undefined) row.name = doc.name;
	if (doc.description !== undefined) row.description = doc.description;
	if (doc.is_active !== undefined) row.is_active = doc.is_active !== false;
	if (doc.state !== undefined) row.state = doc.state;
	if (doc.search_field !== undefined) row.search_field = doc.search_field;
	if (doc.created_by !== undefined) row.created_by = doc.created_by;
	return row;
}

export function as_object(v: unknown): Record<string, unknown> {
	if (v == null) return {};
	if (typeof v === 'string') {
		try {
			const p = JSON.parse(v);
			return p && typeof p === 'object' && !Array.isArray(p)
				? (p as Record<string, unknown>)
				: {};
		} catch {
			return {};
		}
	}
	if (typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
	return {};
}

export function as_array(v: unknown): unknown[] {
	if (Array.isArray(v)) return v;
	if (typeof v === 'string') {
		try {
			const p = JSON.parse(v);
			return Array.isArray(p) ? p : [];
		} catch {
			return [];
		}
	}
	return [];
}

function scalar_ref(v: unknown): unknown {
	if (!v || typeof v !== 'object' || Array.isArray(v) || v instanceof Date) {
		return v;
	}
	const o = v as Record<string, unknown>;
	const id = o._id ?? o.id;
	const allowed = new Set(['_id', 'id', 'name', 'description', 'is_active']);
	if (!Object.keys(o).every((k) => allowed.has(k))) return v;
	if (id == null || id === '') return null;
	return String(id);
}

function omit(row: Record<string, unknown>, keys: string[]) {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(row)) {
		if (!keys.includes(k)) out[k] = v;
	}
	return out;
}

function iso(v: unknown): string | null {
	if (!v) return null;
	if (v instanceof Date) return v.toISOString();
	const d = new Date(String(v));
	return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
}
