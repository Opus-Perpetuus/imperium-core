/**
 * Importación masiva: mismo envelope y resolución de `*_name*` que el
 * `$Service.batch` original.
 */
import { as_object, type ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';

const AUTOMATIC_MATCH = new Set(['_id', 'name', 'description']);

export async function run_batch_import(params: {
	store: ImperiumStore;
	resource: string;
	rows: unknown[];
	match_field: string | null;
	persist_create: (doc: ImperiumDoc) => Promise<ImperiumDoc>;
	persist_update: (id: string, doc: ImperiumDoc) => Promise<ImperiumDoc | null>;
}): Promise<Record<string, unknown>> {
	const requested = text(params.match_field);
	if (requested && !AUTOMATIC_MATCH.has(requested) && !allowed_match_field(params.store, params.resource, requested)) {
		throw new Error(
			`El campo '${requested}' no está habilitado para coincidencia exacta en importación masiva.`,
		);
	}

	const success: Array<Record<string, unknown>> = [];
	const errors: Array<Record<string, unknown>> = [];
	const warnings: Array<Record<string, unknown>> = [];

	for (let index = 0; index < params.rows.length; index++) {
		const raw = as_object(params.rows[index]);
		const row_number = index + 1;
		const row_errors: string[] = [];
		const row_warnings: string[] = [];
		try {
			const processed = await prepare_batch_row(params.store, params.resource, raw, row_errors, row_warnings);
			if (row_errors.length) {
				errors.push({ row: row_number, data: raw, errors: row_errors });
				continue;
			}
			const existing = await resolve_existing(
				params.store,
				params.resource,
				processed,
				requested || null,
			);
			if (existing.error) {
				errors.push({ row: row_number, data: raw, errors: [existing.error] });
				continue;
			}
			row_warnings.push(...existing.warnings);
			let persisted: ImperiumDoc | null;
			let operation: 'create' | 'update';
			if (existing.record_id) {
				processed._id = existing.record_id;
				persisted = await params.persist_update(existing.record_id, processed);
				operation = 'update';
			} else {
				persisted = await params.persist_create(processed);
				operation = 'create';
			}
			if (!persisted?._id) {
				errors.push({
					row: row_number,
					data: raw,
					errors: ['No se pudo persistir la fila'],
				});
				continue;
			}
			if (row_warnings.length) {
				warnings.push({ row: row_number, data: raw, warnings: row_warnings });
			}
			success.push({
				row: row_number,
				_id: persisted._id,
				operation,
				warnings: row_warnings.length ? row_warnings : undefined,
			});
		} catch (error) {
			errors.push({
				row: row_number,
				data: raw,
				errors: [error instanceof Error ? error.message : String(error)],
			});
		}
	}

	return {
		data: [],
		total_elementos: 0,
		message: `Importación completada: ${success.length} exitosos, ${errors.length} con errores, ${warnings.length} con advertencias`,
		summary: {
			total_rows: params.rows.length,
			successful: success.length,
			failed: errors.length,
			warnings: warnings.length,
		},
		success,
		errors,
		warnings,
	};
}

function allowed_match_field(store: ImperiumStore, resource: string, field: string) {
	if (store.column_names(resource).has(field)) return true;
	return Boolean(store.field_refs(resource)[field]);
}

async function prepare_batch_row(
	store: ImperiumStore,
	resource: string,
	raw: Record<string, unknown>,
	row_errors: string[],
	row_warnings: string[],
): Promise<ImperiumDoc> {
	const processed: ImperiumDoc = { ...raw };
	if (processed.is_active !== undefined) {
		const parsed = parse_excel_boolean(processed.is_active);
		if (parsed === null) {
			row_errors.push(
				`❌ Campo 'is_active': Valor booleano inválido '${processed.is_active}'. ` +
					`Formato correcto: VERDADERO, FALSO, TRUE, FALSE, SI, NO, 1 o 0.`,
			);
		} else if (parsed === undefined) {
			delete processed.is_active;
		} else {
			processed.is_active = parsed;
		}
	}

	const refs = store.field_refs(resource);
	const processed_from_helper = new Set<string>();
	for (const key of Object.keys(processed)) {
		if (!key.endsWith('_name*')) continue;
		const stripped = key.replace(/_name\*$/, '');
		const dotted = stripped.replace(/_/g, '.');
		const field = refs[stripped] ? stripped : refs[dotted] ? dotted : stripped;
		const model = refs[field];
		const value = processed[key];
		delete processed[key];
		if (!model) continue;
		if (processed[field] !== undefined && processed[field] !== null && processed[field] !== '') {
			row_warnings.push(
				`⚠️ Conflicto detectado en campo '${field}': ` +
					`Tiene valor en columna sin asterisco Y en columna con asterisco ('${value}'). ` +
					`Se dará prioridad a la columna con asterisco (${key}) porque es más fácil de editar. ` +
					`Recomendación: Elimina la columna '${field}' del Excel y usa solo '${key}'.`,
			);
		}
		const resolved = await resolve_reference(store, field, value, model);
		if (resolved.error) row_errors.push(resolved.error);
		else if (resolved.id) {
			processed[field] = resolved.id;
			processed_from_helper.add(field);
		}
	}

	for (const [field, model] of Object.entries(refs)) {
		if (field.includes('.') || processed_from_helper.has(field)) continue;
		const raw_value = processed[field];
		if (raw_value === undefined || raw_value === null || raw_value === '') continue;
		if (looks_like_id(raw_value) && (await store.find_id(store.resource_for_model(model) ?? '', String(raw_value)))) {
			continue;
		}
		if (looks_like_id(raw_value)) continue;
		const resolved = await resolve_reference(store, field, raw_value, model);
		if (resolved.error) row_errors.push(resolved.error);
		else if (resolved.id) {
			processed[field] = resolved.id;
			row_warnings.push(
				`⚠️ Campo '${field}': Se resolvió la referencia desde la columna base. ` +
					`Para evitar ambigüedad, prefiere la columna '${field.replace(/\./g, '_')}_name*'.`,
			);
		}
	}
	return processed;
}

async function resolve_reference(
	store: ImperiumStore,
	field_path: string,
	value: unknown,
	ref_model_name: string,
): Promise<{ id: string | null; error: string | null }> {
	const wanted = text(value);
	if (!wanted) return { id: null, error: null };
	const resource = store.resource_for_model(ref_model_name);
	if (!resource || !store.has(resource)) {
		return {
			id: null,
			error: `❌ Error de configuración: El modelo '${ref_model_name}' referenciado en campo '${field_path}' no existe en el sistema.`,
		};
	}
	if (looks_like_id(wanted)) {
		const by_id = await store.find_id(resource, wanted);
		if (by_id) return { id: String(by_id._id), error: null };
		return {
			id: null,
			error: `❌ Campo '${field_path}': No se encontró registro con ID '${wanted}' en '${ref_model_name}'. Verifica que el ID sea correcto o usa la columna '${field_path}_name*' con el nombre del registro.`,
		};
	}
	const by_name = await store.find_where(resource, { name: wanted });
	if (by_name) return { id: String(by_name._id), error: null };
	return {
		id: null,
		error: `❌ Campo '${field_path}_name*': No se encontró registro con nombre '${wanted}' en '${ref_model_name}'. Verifica que el nombre sea exacto (sensible a mayúsculas/minúsculas).`,
	};
}

async function resolve_existing(
	store: ImperiumStore,
	resource: string,
	processed: ImperiumDoc,
	requested_match_field: string | null,
): Promise<{ record_id: string | null; warnings: string[]; error: string | null }> {
	const explicit_id = text(processed._id);
	if (looks_like_id(explicit_id)) {
		const existing = await store.find_id(resource, explicit_id);
		return {
			record_id: existing?._id ? String(existing._id) : null,
			warnings: [],
			error: null,
		};
	}

	const strategies: Array<{ field: string; value: unknown }> = [];
	const seen = new Set<string>();
	const add = (field: string, value: unknown) => {
		if (seen.has(field) || !has_match_value(value)) return;
		seen.add(field);
		strategies.push({ field, value });
	};
	add('_id', processed._id);
	add('name', processed.name);
	add('description', processed.description);
	if (requested_match_field) add(requested_match_field, processed[requested_match_field]);
	if (!strategies.length) return { record_id: null, warnings: [], error: null };

	const matches = new Map<string, string[]>();
	for (const strategy of strategies) {
		const found = await find_exact_batch_match(store, resource, strategy.field, strategy.value);
		if (found.error) return { record_id: null, warnings: [], error: found.error };
		if (!found.record_id) continue;
		matches.set(found.record_id, [...(matches.get(found.record_id) ?? []), strategy.field]);
	}
	if (!matches.size) return { record_id: null, warnings: [], error: null };
	if (matches.size > 1) {
		const detail = [...matches.entries()]
			.map(([id, fields]) => `${id} (${fields.join(', ')})`)
			.join('; ');
		return {
			record_id: null,
			warnings: [],
			error:
				'❌ Coincidencias exactas en conflicto: la fila coincide con más de un registro existente. ' +
				`Detalle: ${detail}.`,
		};
	}
	const [[record_id, matched_fields]] = [...matches.entries()];
	const warnings: string[] = [];
	if (!matched_fields.includes('_id')) {
		warnings.push(
			`⚠️ Coincidencia exacta encontrada por ${matched_fields
				.map((field) => `'${field}'`)
				.join(', ')}. La fila actualizará un registro existente en lugar de crear uno nuevo.`,
		);
	}
	return { record_id, warnings, error: null };
}

async function find_exact_batch_match(
	store: ImperiumStore,
	resource: string,
	field: string,
	value: unknown,
): Promise<{ record_id: string | null; error: string | null }> {
	if (!has_match_value(value)) return { record_id: null, error: null };
	if (field === '_id') {
		if (!looks_like_id(value)) return { record_id: null, error: null };
		const found = await store.find_id(resource, String(value).trim());
		return { record_id: found?._id ? String(found._id) : null, error: null };
	}
	const { rows } = await store.find_many(resource, {
		where: { [field]: value },
		take: 2,
		include_inactive: true,
		populate: false,
	});
	if (rows.length > 1) {
		return {
			record_id: null,
			error:
				`❌ Campo '${field}': Se encontraron múltiples registros con la misma coincidencia exacta. ` +
				`La importación no puede decidir cuál actualizar. Ajusta el archivo para usar un valor único.`,
		};
	}
	const id = rows[0]?._id ? String(rows[0]._id) : null;
	return { record_id: id, error: null };
}

function parse_excel_boolean(value: unknown): boolean | null | undefined {
	if (typeof value === 'boolean') return value;
	if (value === null || value === undefined || value === '') return undefined;
	const raw = String(value).trim().toLowerCase();
	if (['true', 'verdadero', 'si', 'sí', '1'].includes(raw)) return true;
	if (['false', 'falso', 'no', '0'].includes(raw)) return false;
	return null;
}

function has_match_value(value: unknown) {
	if (value === undefined || value === null) return false;
	return String(value).trim().length > 0;
}

function looks_like_id(value: unknown) {
	return /^[a-f0-9]{24}$/i.test(String(value ?? '').trim());
}

function text(value: unknown) {
	return String(value ?? '').trim();
}
