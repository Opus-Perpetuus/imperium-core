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

export function to_imperium(row: Record<string, unknown> | null): ImperiumDoc | null {
	if (!row) return null;
	const payload = as_object(row.payload);
	const custom = as_object(row.custom_data);
	const out: ImperiumDoc = {
		...payload,
		...omit(row, ['payload']),
		_id: row.id ?? payload._id,
		id: row.id,
		_ref: row.ref ?? payload._ref ?? null,
		custom_data: custom,
		createdAt: row.created_at ?? payload.createdAt,
		updatedAt: row.updated_at ?? payload.updatedAt,
	};
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
	if (id == null || id === '') return v;
	const allowed = new Set(['_id', 'id', 'name', 'description', 'is_active']);
	if (Object.keys(o).every((k) => allowed.has(k))) return String(id);
	return v;
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
