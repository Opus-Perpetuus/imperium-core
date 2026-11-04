/**
 * `GET /:resource/field-values/:field` — mismo contrato que
 * `$Controller.controller_read_field_values`.
 */
import { field_name_access, JSON_BLOB_FIELDS, snake_field_name } from '@opus-perpetuus/imperium-core-kit';
import { as_object, type ImperiumDoc } from './envelope.ts';
import {
	GROUP_REF_ALMACEN,
	GROUP_REF_SURTIDORES,
	GROUP_REF_VENDEDORES,
	GROUP_REF_VENTAS,
	actor_group_refs,
	is_seed_admin,
} from './group-access.ts';
import { is_pedido_resource } from './pedidos-flow.ts';
import type { StateField } from './state-fields.ts';
import type { ImperiumStore } from './store.ts';

export type FieldValueOption = {
	value: string;
	label: string;
	count: number;
	description?: string;
	color?: string;
	icon?: string;
};

export function field_values_message(field_path: string) {
	return `Valores del campo "${field_path}" obtenidos correctamente.`;
}

/** `clientSecret` → `client_secret` (misma regla que el kit). */
export function snake_field_segment(segment: string): string {
	return snake_field_name(segment);
}

/** Blobs que no se abren ni por subcampo (`config_json.secret_key`). */
const CLOSED_JSON_BLOBS = new Set(['config_json', 'spec_json']);

/**
 * `recurso:campo` que sí pueden listar sus valores aunque la regla los niegue.
 * Agregar aquí solo si los valores distintos se pueden mostrar a cualquiera con
 * lectura del recurso.
 */
export const FIELD_VALUES_ALLOW: ReadonlySet<string> = new Set<string>();

export const FIELD_VALUES_DENIED_MESSAGE = 'Ese campo no admite valores (field-values).';

/**
 * `field-values` devuelve los valores distintos de una columna a quien tenga
 * lectura del recurso. Credenciales, firmas y blobs json enteros no salen nunca;
 * la PII (contacto, domicilio, nombres, datos clínicos, ciudad, placas) solo sale
 * con sesión interna (`has_session`), sin sesión ni para externos
 * (regla del kit: `field_name_access`).
 * Un subcampo de `payload`/`custom_data` sí, salvo que se llame como credencial.
 */
export function field_values_denied(
	resource: string,
	field_path: string,
	columns: ReadonlyArray<{ name: string; pg?: string }> = [],
	allow: ReadonlySet<string> = FIELD_VALUES_ALLOW,
	/** `store.field_refs(resource)`: un `_id`/`_ref` sensible solo pasa si es FK real. */
	refs: Readonly<Record<string, string>> = {},
	/** Sesión interna válida: la PII sí lista valores; credenciales y blobs no. */
	has_session = false,
): boolean {
	if (allow.has(`${resource}:${field_path}`)) return false;
	const raw_segments = field_path.split('.');
	const segments = raw_segments.map(snake_field_segment);
	const is_reference = (i: number) => Boolean(refs[raw_segments.slice(0, i + 1).join('.')]);
	// `payload.estado` sí: la raíz blob con subcampo se decide abajo.
	const opens_blob = segments.length > 1 && JSON_BLOB_FIELDS.has(segments[0] ?? '');
	const root = segments[0] ?? '';
	const pg = columns.find((column) => column.name.toLowerCase() === root)?.pg ?? '';
	// Una columna booleana (`home`, `has_pin`) solo enseña true/false.
	const is_boolean = segments.length === 1 && /^bool/i.test(pg);
	if (
		segments.some(
			(segment, i) =>
				!(i === 0 && opens_blob) &&
				denied_for(field_name_access(segment, { is_reference: is_reference(i), is_boolean, resource }), has_session),
		)
	) {
		return true;
	}
	if (CLOSED_JSON_BLOBS.has(root)) return true;
	if (segments.length > 1) return false;
	if (JSON_BLOB_FIELDS.has(root)) return true;
	return /json/i.test(pg);
}

function denied_for(access: 'open' | 'session' | 'denied', has_session: boolean): boolean {
	if (access === 'denied') return true;
	return access === 'session' && !has_session;
}

export function field_values_missing_field_error() {
	return 'No se proporciono el campo solicitado para obtener valores.';
}

function resolve_value_by_path(source: Record<string, unknown>, path: string): unknown {
	return path.split('.').reduce<unknown>((current, segment) => {
		if (
			current === null ||
			current === undefined ||
			typeof current !== 'object' ||
			Array.isArray(current)
		) {
			return undefined;
		}
		return (current as Record<string, unknown>)[segment];
	}, source);
}

function object_label(candidate: Record<string, unknown>) {
	for (const key of ['name', 'label', 'title', 'description', 'value'] as const) {
		const value = candidate[key];
		if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
			const normalized = String(value).trim();
			if (normalized) return normalized;
		}
	}
	return '';
}

function object_text(candidate: Record<string, unknown>, key: string) {
	const value = candidate[key];
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function extract_filter_values(value: unknown): FieldValueOption[] {
	if (value === null || value === undefined) return [];
	if (Array.isArray(value)) return value.flatMap((item) => extract_filter_values(item));
	if (value instanceof Date) {
		return [
			{
				value: value.toISOString(),
				label: value.toLocaleString('es-MX'),
				count: 1,
			},
		];
	}
	if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
		const normalized = String(value).trim();
		if (!normalized || normalized === '-' || normalized === 'ERR!') return [];
		return [
			{
				value: normalized,
				label: typeof value === 'boolean' ? (value ? 'Si' : 'No') : normalized,
				count: 1,
			},
		];
	}
	if (typeof value !== 'object') return [];
	const candidate = value as Record<string, unknown>;
	const label = object_label(candidate);
	if (!label) return [];
	return [
		{
			value: label,
			label,
			description: object_text(candidate, 'description'),
			color: object_text(candidate, 'color'),
			icon: object_text(candidate, 'icon'),
			count: 1,
		},
	];
}

function state_aliases(value: unknown): string[] {
	if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
		const normalized = String(value).trim();
		return normalized ? [normalized] : [];
	}
	if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
	const candidate = value as Record<string, unknown>;
	return [
		...new Set(
			[
				candidate.value,
				candidate._id,
				candidate.id,
				candidate.name,
				candidate.label,
				candidate.title,
				candidate.display_leyend,
				candidate.description,
			]
				.map((alias) =>
					typeof alias === 'string' || typeof alias === 'number' || typeof alias === 'boolean'
						? String(alias).trim()
						: '',
				)
				.filter(Boolean),
		),
	];
}

function state_matches(state_value: Record<string, unknown>, alias: string) {
	const needle = alias.trim().toLocaleLowerCase();
	if (!needle) return false;
	return ['value', 'display_leyend', 'label', 'name'].some((key) => {
		const candidate = state_value[key];
		if (
			typeof candidate !== 'string' &&
			typeof candidate !== 'number' &&
			typeof candidate !== 'boolean'
		) {
			return false;
		}
		return String(candidate).trim().toLocaleLowerCase() === needle;
	});
}

function configured_state_option(
	value: unknown,
	configured: StateField | null,
): FieldValueOption | null {
	const values = configured?.values ?? [];
	if (!values.length) return null;
	for (const alias of state_aliases(value)) {
		const match = values.find((state_value) => state_matches(state_value, alias));
		if (!match?.value) continue;
		const label = match.display_leyend || match.value;
		const object = as_object(value);
		const description =
			typeof value === 'object' && value && !Array.isArray(value)
				? object_text(object, 'description')
				: undefined;
		return {
			value: match.value,
			label,
			count: 1,
			description: description && description !== label ? description : undefined,
			color: match.color,
			icon: match.icon,
		};
	}
	return null;
}

function extract_state_values(value: unknown, configured: StateField | null): FieldValueOption[] {
	if (value === null || value === undefined) return [];
	if (Array.isArray(value)) {
		return value.flatMap((item) => extract_state_values(item, configured));
	}
	return configured_state_option(value, configured)
		? [configured_state_option(value, configured)!]
		: extract_filter_values(value);
}

export function field_values_from_distinct(
	values: unknown[],
	field_path: string,
	configured: StateField | null,
): FieldValueOption[] {
	const records = values.map((value) => {
		const doc: ImperiumDoc = {};
		let cursor: Record<string, unknown> = doc;
		const parts = field_path.split('.');
		for (let i = 0; i < parts.length - 1; i++) {
			const next: Record<string, unknown> = {};
			cursor[parts[i] ?? ''] = next;
			cursor = next;
		}
		cursor[parts[parts.length - 1] ?? field_path] = value;
		return doc;
	});
	return build_field_values(records, field_path, configured);
}

export function build_field_values(
	records: ImperiumDoc[],
	field_path: string,
	configured: StateField | null,
): FieldValueOption[] {
	const value_map = new Map<string, FieldValueOption>();
	for (const record of records) {
		for (const option of extract_state_values(
			resolve_value_by_path(record, field_path),
			configured,
		)) {
			const existing = value_map.get(option.value);
			if (existing) {
				existing.count += 1;
				continue;
			}
			value_map.set(option.value, { ...option });
		}
	}
	for (const state_value of configured?.values ?? []) {
		const value = state_value.value.trim();
		if (!value) continue;
		const existing = value_map.get(value);
		value_map.set(value, {
			value,
			label: state_value.display_leyend || value,
			count: existing?.count ?? 0,
			description: existing?.description,
			color: state_value.color || existing?.color,
			icon: state_value.icon || existing?.icon,
		});
	}
	return [...value_map.values()].sort((left, right) =>
		left.label.localeCompare(right.label, 'es', { sensitivity: 'base', numeric: true }),
	);
}

const LOOKS_LIKE_ID = /^[a-fA-F0-9]{24}$|^[0-9a-fA-F-]{36}$/;

/** Ids crudos del distinct que el filtro debe seguir usando como value. */
export function field_value_ids_needing_label(options: FieldValueOption[]): string[] {
	return options
		.filter(
			(option) =>
				LOOKS_LIKE_ID.test(option.value.trim()) && option.label.trim() === option.value.trim(),
		)
		.map((option) => option.value.trim());
}

/**
 * El distinct de una ref (assinged_to, etc.) devuelve ids. El filtro lista
 * personas: label = name, value sigue siendo el id.
 */
export function apply_related_labels(
	options: FieldValueOption[],
	names_by_id: Map<string, string>,
): FieldValueOption[] {
	return options.map((option) => {
		const name =
			names_by_id.get(option.value)?.trim() ||
			names_by_id.get(option.value.trim())?.trim();
		if (!name) return option;
		return { ...option, label: name };
	});
}

const RELATED_NAME_KEYS = ['name', 'nombreCompleto', 'username', 'email'] as const;

/** Nombre visible de un doc relacionado (empleado / usuario). */
export function related_doc_label(row: Record<string, unknown>): string {
	for (const key of RELATED_NAME_KEYS) {
		const value = String(row[key] ?? '').trim();
		if (value) return value;
	}
	return '';
}

export function merge_related_names(
	primary: Map<string, string>,
	fallback: Map<string, string>,
): Map<string, string> {
	if (!fallback.size) return primary;
	const out = new Map(primary);
	for (const [id, name] of fallback) {
		const label = name.trim();
		if (!label || out.has(id)) continue;
		out.set(id, label);
	}
	return out;
}

export async function filter_pedido_estado_options(
	store: ImperiumStore,
	actor: ImperiumDoc | null,
	resource: string,
	field_path: string,
	options: FieldValueOption[],
): Promise<FieldValueOption[]> {
	if (!is_pedido_resource(resource) || field_path !== 'estado') return options;
	if (is_seed_admin(actor)) return options;
	const refs = await actor_group_refs(store, actor);
	const in_flow =
		refs.includes(GROUP_REF_VENDEDORES) ||
		refs.includes(GROUP_REF_VENTAS) ||
		refs.includes(GROUP_REF_ALMACEN) ||
		refs.includes(GROUP_REF_SURTIDORES);
	if (!in_flow) return options;
	return options.filter((option) =>
		pedido_estado_visible_para_grupos(option.value, refs),
	);
}

/** Por surtir lo ven ventas, almacén y surtidores. Un vendedor no. */
export function pedido_estado_visible_para_grupos(
	value: string,
	refs: string[],
): boolean {
	switch (value) {
		case 'por_surtir':
			return (
				refs.includes(GROUP_REF_VENTAS) ||
				refs.includes(GROUP_REF_ALMACEN) ||
				refs.includes(GROUP_REF_SURTIDORES)
			);
		case 'surtiendo':
		case 'surtido':
			return refs.includes(GROUP_REF_ALMACEN) || refs.includes(GROUP_REF_SURTIDORES);
		default:
			return true;
	}
}

export function field_values_limit(raw: string | null) {
	const parsed = Number(raw);
	const requested = Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : 500;
	return Math.min(requested || 500, 500);
}
