/**
 * `GET /model-tracker/global/:id/field-values/:field_path` — mismo contrato
 * que `ModelTrackerService.read_field_values_for_model`.
 */
import { as_array, as_object, ok, type ImperiumDoc } from './envelope.ts';
import { field_values_message } from './field-values.ts';
import type { ImperiumStore } from './store.ts';

type TrackerDescriptor = {
	path: string;
	type?: string;
	is_array?: boolean;
	is_reference?: boolean;
	ref?: string;
};

type FieldValueOption = {
	value: string;
	label: string;
	count: number;
	is_reference: boolean;
};

type TrackerCtx = {
	store: ImperiumStore;
	params: Record<string, string>;
	url: URL;
};

function text(value: unknown) {
	return typeof value === 'string' ? value.trim() : '';
}

function escape_regex(value: string) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function resolve_descriptor(tracker: ImperiumDoc, field_path: string): TrackerDescriptor | null {
	const fields = as_array(tracker.__schema_fields);
	const found = fields.find((item) => as_object(item).path === field_path);
	if (!found || typeof found !== 'object') return null;
	const rec = as_object(found);
	return {
		path: field_path,
		type: text(rec.type) || undefined,
		is_array: rec.is_array === true,
		is_reference: rec.is_reference === true,
		ref: text(rec.ref) || undefined,
	};
}

function values_at_path(doc: ImperiumDoc, field_path: string): unknown[] {
	let current: unknown[] = [doc];
	for (const segment of field_path.split('.')) {
		current = current.flatMap((item) => {
			if (!item || typeof item !== 'object') return [];
			const next = as_object(item)[segment];
			if (next === undefined || next === null) return [];
			return Array.isArray(next) ? next : [next];
		});
	}
	return current;
}

function serialize_field_value(raw: unknown): string | null {
	if (raw === null || raw === undefined) return null;
	if (raw instanceof Date) return raw.toISOString();
	if (typeof raw === 'object') {
		const rec = as_object(raw);
		const id = rec._id ?? rec.id;
		return id == null ? null : String(id);
	}
	if (typeof raw === 'boolean' || typeof raw === 'number') return String(raw);
	const value = String(raw).trim();
	if (!value || value === '-' || value === 'ERR!') return null;
	return value;
}

function normalize_ref_string(raw: unknown) {
	return typeof raw === 'string' && raw.trim() ? raw.trim() : '';
}

function reference_label(doc: ImperiumDoc, fallback: string) {
	const name = normalize_ref_string(doc.name);
	const description = normalize_ref_string(doc.description);
	if (name && description) return `${name} — ${description}`;
	return name || fallback;
}

function usable_label(label: string) {
	return Boolean(label) && label !== '-' && label !== 'ERR!';
}

function resolve_ref_model(
	store: ImperiumStore,
	resource: string,
	field_path: string,
	descriptor: TrackerDescriptor | null,
) {
	if (descriptor?.is_reference && descriptor.ref) return descriptor.ref;
	return store.field_refs(resource)[field_path] || null;
}

function increment_parent_counts(
	counts: Map<string, number>,
	rows: ImperiumDoc[],
	field_path: string,
) {
	for (const row of rows) {
		for (const raw of values_at_path(row, field_path)) {
			const value = serialize_field_value(raw);
			if (!value) continue;
			counts.set(value, (counts.get(value) ?? 0) + 1);
		}
	}
}

async function load_tracker(store: ImperiumStore, model_tracker_id: string) {
	if (/^[a-f0-9]{24}$/i.test(model_tracker_id)) {
		const by_id = await store.find_id('model-tracker', model_tracker_id);
		if (by_id) return by_id;
	}
	return store.find_where('model-tracker', { __model_name: model_tracker_id });
}

export async function model_tracker_field_values(ctx: TrackerCtx) {
	const model_tracker_id = text(ctx.params.model_tracker_id);
	const field_path = text(ctx.params.field_path);
	if (!model_tracker_id || !field_path) {
		throw new Error('Se requiere el ID del modelo y la ruta del campo.');
	}
	if (!/^[A-Za-z0-9_][A-Za-z0-9_.]*$/.test(field_path)) {
		throw new Error('La ruta del campo contiene caracteres no permitidos.');
	}
	if (!ctx.store.has('model-tracker')) {
		throw new Error('No se encontró el modelo especificado.');
	}
	const tracker = await load_tracker(ctx.store, model_tracker_id);
	if (!tracker) throw new Error('No se encontró el modelo especificado.');
	const model_name = String(tracker.__model_name ?? tracker.name ?? '');
	const resource = ctx.store.resource_for_model(model_name);
	if (!resource || !ctx.store.has(resource)) {
		throw new Error('El modelo no tiene una colección asociada.');
	}

	const termino = text(ctx.url.searchParams.get('termino'));
	const desde = Math.max(Number.parseInt(ctx.url.searchParams.get('desde') ?? '0', 10) || 0, 0);
	const limite = Math.min(
		Number.parseInt(ctx.url.searchParams.get('limite') ?? '2000', 10) || 2000,
		10000,
	);

	const descriptor = resolve_descriptor(tracker, field_path);
	const ref_model = resolve_ref_model(ctx.store, resource, field_path, descriptor);
	const ref_resource = ref_model ? ctx.store.resource_for_model(ref_model) : null;
	const is_reference = Boolean(ref_resource && ctx.store.has(ref_resource));

	const dotted = field_path.includes('.');
	const as_array_field = descriptor?.is_array === true;
	/* Escalares: GROUP BY en SQL. Refs/objetos/arrays/paths con punto
	 * siguen en scan: `payload ->>` no es el id de serialize_field_value. */
	const use_sql_counts = !dotted && !as_array_field && !is_reference;

	const counts = new Map<string, number>();
	if (use_sql_counts) {
		const counted = await ctx.store.value_counts(resource, field_path, {
			include_inactive: true,
		});
		for (const { value, count } of counted) counts.set(value, count);
	} else {
		for await (const page of ctx.store.scan(resource, {
			include_inactive: true,
			fields: [field_path],
		})) {
			increment_parent_counts(counts, page, field_path);
		}
	}

	let options: FieldValueOption[];
	if (is_reference && ref_resource) {
		const merged = new Map<string, FieldValueOption>();
		for await (const refs of ctx.store.scan(ref_resource, {
			include_inactive: true,
			populate_lite: true,
		})) {
			for (const doc of refs) {
				const value = String(doc._id ?? '');
				if (!value) continue;
				const label = reference_label(doc, value);
				if (!usable_label(label)) continue;
				merged.set(value, {
					value,
					label,
					count: counts.get(value) ?? 0,
					is_reference: true,
				});
			}
		}
		for (const [value, count] of counts) {
			if (merged.has(value)) continue;
			if (!usable_label(value)) continue;
			merged.set(value, { value, label: value, count, is_reference: true });
		}
		options = [...merged.values()];
	} else {
		options = [...counts.entries()]
			.filter(([value]) => usable_label(value))
			.map(([value, count]) => ({
				value,
				label: value,
				count,
				is_reference: false,
			}));
	}

	if (termino) {
		const matcher = new RegExp(escape_regex(termino), 'i');
		options = options.filter((option) => matcher.test(option.label));
	}
	options.sort((left, right) =>
		left.label.localeCompare(right.label, 'es', { sensitivity: 'base', numeric: true }),
	);
	const total = options.length;
	return ok(options.slice(desde, desde + limite), field_values_message(field_path), total);
}
