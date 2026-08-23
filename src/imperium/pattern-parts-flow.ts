/**
 * Partes del patrón de auto-incremento: mismo contrato que el service original.
 * Crear/editar/borrar reconstruye `custom_pattern` del contador padre.
 */
import { as_array, type ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';

const TOKEN_TYPES = new Set([
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
	'sequence',
	'counter',
	'field',
	'custom',
	'literal',
]);
const FORMAT_MODES = new Set(['default', 'letra', 'romano']);

export function is_pattern_parts_resource(resource: string) {
	return resource === 'custom-pattern-increment-sequence-parts';
}

export function is_pattern_condition_resource(resource: string) {
	return resource === 'custom-pattern-condition';
}

function text(value: unknown): string {
	return typeof value === 'string' ? value.trim() : '';
}

function ref_id(value: unknown): string {
	if (value == null) return '';
	if (typeof value === 'object') return text((value as { _id?: unknown })._id);
	return text(value);
}

export function build_token_string(part: ImperiumDoc): string {
	const token_type = text(part.token_type);
	const zero_padding = Number(part.zero_padding ?? 0);
	const format_mode = text(part.format_mode);
	switch (token_type) {
		case 'sequence': {
			let token = '[sequence';
			if (zero_padding > 0) token += `;ceros=${zero_padding}`;
			if (format_mode === 'letra') token += ';letra=true';
			else if (format_mode === 'romano') token += ';romano=true';
			token += ']';
			return token;
		}
		case 'counter': {
			const counter_ref =
				text(part.counter_index_name) || text(part.field_path) || '';
			let token = `[counter=${counter_ref}`;
			if (zero_padding > 0) token += `;ceros=${zero_padding}`;
			if (format_mode === 'letra') token += ';letra=true';
			else if (format_mode === 'romano') token += ';romano=true';
			token += ']';
			return token;
		}
		case 'field': {
			let token = `[field=${text(part.field_path)}`;
			if (zero_padding > 0) token += `;ceros=${zero_padding}`;
			if (format_mode === 'letra') token += ';letra=true';
			else if (format_mode === 'romano') token += ';romano=true';
			token += ']';
			return token;
		}
		case 'custom':
			return '[custom]';
		case 'literal':
			return text(part.token_value);
		default:
			return token_type ? `[${token_type}]` : '';
	}
}

async function active_parts(
	store: ImperiumStore,
	counter_config_id: string,
): Promise<ImperiumDoc[]> {
	if (!store.has('custom-pattern-increment-sequence-parts')) return [];
	const { rows } = await store.find_many('custom-pattern-increment-sequence-parts', {
		where: { counter_config_id },
		take: 20000,
		sort: 'order:asc',
	});
	return [...rows].sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0));
}

export async function rebuild_custom_pattern(
	store: ImperiumStore,
	counter_config_id: string,
): Promise<void> {
	const id = text(counter_config_id);
	if (!id || !store.has('auto-increment-control')) return;
	const parts = await active_parts(store, id);
	const pattern = parts.map((part) => build_token_string(part)).join('');
	await store.update('auto-increment-control', id, {
		custom_pattern: pattern || null,
	});
}

async function reorder_parts(store: ImperiumStore, counter_config_id: string) {
	const id = text(counter_config_id);
	if (!id) return;
	const parts = await active_parts(store, id);
	for (let i = 0; i < parts.length; i++) {
		if (Number(parts[i]?.order ?? -1) === i) continue;
		await store.update('custom-pattern-increment-sequence-parts', String(parts[i]!._id), {
			order: i,
		});
	}
}

export async function prepare_pattern_part_create(
	store: ImperiumStore,
	incoming: ImperiumDoc,
): Promise<ImperiumDoc> {
	const counter_config_id = ref_id(incoming.counter_config_id);
	if (!counter_config_id) throw new Error('Debes indicar el contador padre.');
	const token_type = text(incoming.token_type);
	if (!token_type) throw new Error('Debes indicar el tipo de token.');
	if (!TOKEN_TYPES.has(token_type)) throw new Error('Tipo de token no válido.');
	const format_mode = text(incoming.format_mode) || 'default';
	if (!FORMAT_MODES.has(format_mode)) {
		throw new Error('Modo de formato no válido. Debe ser default, letra o romano.');
	}
	const existing = await active_parts(store, counter_config_id);
	const prepared: ImperiumDoc = {
		...incoming,
		counter_config_id,
		token_type,
		token_value: text(incoming.token_value) || undefined,
		field_path: text(incoming.field_path) || undefined,
		counter_index_name: text(incoming.counter_index_name) || undefined,
		zero_padding: Number(incoming.zero_padding ?? 0),
		format_mode,
		order: existing.length,
	};
	if (!text(prepared.name)) {
		prepared.name = build_token_string(prepared) || token_type;
	}
	return prepared;
}

export async function prepare_pattern_part_update(
	incoming: ImperiumDoc,
	previous: ImperiumDoc | null,
): Promise<ImperiumDoc> {
	if (!previous) throw new Error('No se encontró la parte del patrón.');
	const update: ImperiumDoc = { ...incoming };
	const token_type = text(incoming.token_type);
	if (token_type) {
		if (!TOKEN_TYPES.has(token_type)) throw new Error('Tipo de token no válido.');
		update.token_type = token_type;
	}
	if (incoming.token_value !== undefined) {
		update.token_value = text(incoming.token_value) || null;
	}
	if (incoming.field_path !== undefined) {
		update.field_path = text(incoming.field_path) || null;
	}
	if (incoming.counter_index_name !== undefined) {
		update.counter_index_name = text(incoming.counter_index_name) || null;
	}
	if (incoming.zero_padding !== undefined) {
		update.zero_padding = Number(incoming.zero_padding);
	}
	if (incoming.format_mode !== undefined) {
		const format_mode = text(incoming.format_mode);
		if (!FORMAT_MODES.has(format_mode)) {
			throw new Error('Modo de formato no válido. Debe ser default, letra o romano.');
		}
		update.format_mode = format_mode;
	}
	return update;
}

export async function after_pattern_part_write(
	store: ImperiumStore,
	doc: ImperiumDoc | null,
	previous?: ImperiumDoc | null,
): Promise<void> {
	const ids = new Set(
		[ref_id(doc?.counter_config_id), ref_id(previous?.counter_config_id)].filter(Boolean),
	);
	for (const id of ids) await rebuild_custom_pattern(store, id);
}

export async function soft_delete_pattern_part(
	store: ImperiumStore,
	id: string,
): Promise<ImperiumDoc> {
	const existing = await store.find_id('custom-pattern-increment-sequence-parts', id);
	if (!existing) throw new Error('No se encontró la parte del patrón.');
	await store.update('custom-pattern-increment-sequence-parts', id, { is_active: false });
	const counter_config_id = ref_id(existing.counter_config_id);
	await reorder_parts(store, counter_config_id);
	await rebuild_custom_pattern(store, counter_config_id);
	return existing;
}

function ids_of(value: unknown): string[] {
	return as_array(value)
		.map((item) => ref_id(item) || text(item))
		.filter(Boolean);
}

function with_id(list: unknown, id: string): string[] {
	const next = ids_of(list);
	if (!next.includes(id)) next.push(id);
	return next;
}

function without_id(list: unknown, id: string): string[] {
	return ids_of(list).filter((item) => item !== id);
}

async function link_condition(
	store: ImperiumStore,
	condition_id: string,
	part_id: string,
) {
	if (!condition_id || !part_id || !store.has('custom-pattern-increment-sequence-parts')) {
		return;
	}
	const part = await store.find_id('custom-pattern-increment-sequence-parts', part_id);
	if (!part) return;
	await store.update('custom-pattern-increment-sequence-parts', part_id, {
		custom_conditions: with_id(part.custom_conditions, condition_id),
	});
	const counter_id = ref_id(part.counter_config_id);
	if (!counter_id || !store.has('auto-increment-control')) return;
	const control = await store.find_id('auto-increment-control', counter_id);
	if (!control) return;
	await store.update('auto-increment-control', counter_id, {
		custom_conditions_ids: with_id(control.custom_conditions_ids, condition_id),
	});
}

async function unlink_condition(
	store: ImperiumStore,
	condition_id: string,
	part_id: string,
) {
	if (!condition_id || !part_id || !store.has('custom-pattern-increment-sequence-parts')) {
		return;
	}
	const part = await store.find_id('custom-pattern-increment-sequence-parts', part_id);
	if (part) {
		await store.update('custom-pattern-increment-sequence-parts', part_id, {
			custom_conditions: without_id(part.custom_conditions, condition_id),
		});
	}
	const counter_id = ref_id(part?.counter_config_id);
	if (!counter_id || !store.has('auto-increment-control')) return;
	const control = await store.find_id('auto-increment-control', counter_id);
	if (!control) return;
	await store.update('auto-increment-control', counter_id, {
		custom_conditions_ids: without_id(control.custom_conditions_ids, condition_id),
	});
}

export async function after_pattern_condition_create(
	store: ImperiumStore,
	created: ImperiumDoc,
): Promise<void> {
	const part_id = ref_id(created.part_id);
	await link_condition(store, String(created._id ?? ''), part_id);
	await rebuild_from_part(store, part_id);
}

export async function after_pattern_condition_update(
	store: ImperiumStore,
	updated: ImperiumDoc,
	previous: ImperiumDoc | null,
): Promise<void> {
	const old_part = ref_id(previous?.part_id);
	const new_part = ref_id(updated.part_id) || old_part;
	const condition_id = String(updated._id ?? previous?._id ?? '');
	if (new_part && old_part && new_part !== old_part) {
		await unlink_condition(store, condition_id, old_part);
		await link_condition(store, condition_id, new_part);
		await rebuild_from_part(store, old_part);
	}
	await rebuild_from_part(store, new_part);
}

export async function after_pattern_condition_delete(
	store: ImperiumStore,
	deleted: ImperiumDoc | null,
): Promise<void> {
	if (!deleted) return;
	const part_id = ref_id(deleted.part_id);
	await unlink_condition(store, String(deleted._id ?? ''), part_id);
	await rebuild_from_part(store, part_id);
}

async function rebuild_from_part(store: ImperiumStore, part_id: string) {
	if (!part_id || !store.has('custom-pattern-increment-sequence-parts')) return;
	const part = await store.find_id('custom-pattern-increment-sequence-parts', part_id);
	const counter_id = ref_id(part?.counter_config_id);
	if (counter_id) await rebuild_custom_pattern(store, counter_id);
}

export function pattern_part_create_message() {
	return 'Parte del patrón creada correctamente.';
}

export function pattern_part_update_message() {
	return 'Parte del patrón actualizada correctamente.';
}

export function pattern_part_delete_message() {
	return 'Parte del patrón eliminada correctamente.';
}

export function pattern_condition_create_message() {
	return 'Condición creada';
}

export function pattern_condition_delete_message() {
	return 'Condición eliminada';
}
