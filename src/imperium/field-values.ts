/**
 * `GET /:resource/field-values/:field` — mismo contrato que
 * `$Controller.controller_read_field_values`.
 */
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
	return options.filter((option) => {
		switch (option.value) {
			case 'por_surtir':
				return refs.includes(GROUP_REF_VENTAS);
			case 'surtiendo':
			case 'surtido':
				return refs.includes(GROUP_REF_ALMACEN) || refs.includes(GROUP_REF_SURTIDORES);
			default:
				return true;
		}
	});
}

export function field_values_limit(raw: string | null) {
	const parsed = Number(raw);
	const requested = Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : 500;
	return Math.min(requested || 500, 500);
}
