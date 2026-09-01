/**
 * Historial de cambios: mismo contrato que el plugin de Mongoose del original.
 * El panel de formularios lee `document-change-history` por documentId + modelo.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { as_object, type ImperiumDoc } from './envelope.ts';
import { notify_document_subscription_event, register_document_mentions } from './notifications.ts';

export type HistoryCapableStore = {
	has(resource: string): boolean;
	loc(resource: string): { resource: string; collection: string; name: string };
	insert(resource: string, doc: ImperiumDoc): Promise<ImperiumDoc>;
	all_locs: Array<{ resource: string; collection: string; name: string; table: string }>;
};

type HistoryRequestContext = {
	actor?: ImperiumDoc | null;
	method?: string;
	path?: string;
	user_agent?: string;
};

const als = new AsyncLocalStorage<HistoryRequestContext>();

const SKIP_RESOURCES = new Set([
	'document-change-history',
	'debug-log',
	'mentions',
	'auth',
	'notifications',
]);

const IGNORE_KEYS = new Set([
	'createdAt',
	'updatedAt',
	'created_at',
	'updated_at',
	'__v',
	'search_field',
	'password',
	'payload',
	'id',
	'reset_password_token_hash',
	'reset_password_expires',
	'reset_password_kind',
]);

const LABELS: Record<string, string> = {
	name: 'nombre',
	description: 'descripción',
	is_active: 'activo',
	email: 'correo electrónico',
	status: 'estatus',
	folio: 'folio',
	code: 'código',
	codigo: 'código',
	amount: 'monto',
	price: 'precio',
	quantity: 'cantidad',
};

export function run_with_history_context<T>(
	ctx: HistoryRequestContext,
	fn: () => Promise<T>,
): Promise<T> {
	return als.run(ctx, fn);
}

export function collapse_history_key(value: string): string {
	return value.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
}

export function resolve_history_model(
	store: HistoryCapableStore,
	model_name?: string,
	collection_name?: string,
): string {
	const raw = String(model_name || collection_name || '').trim();
	if (!raw) return '';
	if (store.has(raw)) return store.loc(raw).resource;
	const collapsed = collapse_history_key(raw);
	for (const loc of store.all_locs) {
		const keys = [loc.resource, loc.collection, loc.name, loc.table];
		if (keys.some((key) => collapse_history_key(String(key ?? '')) === collapsed)) {
			return loc.resource;
		}
	}
	return raw;
}

export function history_page_limits(input: {
	limite?: string | number | null;
	size?: string | number | null;
	desde?: string | number | null;
}): { desde: number; limite: number } {
	const legacy_size = Number(input.size ?? 0);
	const limite = Math.min(
		50,
		Math.max(1, Number(input.limite ?? 0) || legacy_size || 15),
	);
	const desde = Math.max(0, Number(input.desde ?? 0) || 0);
	return { desde, limite };
}

export function history_find_many_opts(input: {
	document_id: string;
	canonical: string;
	collection_name?: string;
	model_name?: string;
	desde: number;
	limite: number;
}) {
	return {
		/** Un solo `payload ->> 'documentId'` sargable: el btree / compuesto lo cubre. */
		where: { documentId: input.document_id },
		skip: input.desde,
		take: input.limite,
		include_inactive: true,
		sort: 'created_at:desc' as const,
		populate: false,
	};
}

export function history_row_matches(
	store: HistoryCapableStore,
	row: ImperiumDoc,
	document_id: string,
	canonical: string,
): boolean {
	const same_doc =
		String(row.documentId ?? row.document_id ?? row.record_id ?? '') === document_id;
	if (!same_doc) return false;
	const row_model = resolve_history_model(
		store,
		String(row.modelName ?? row.model_name ?? row.model ?? ''),
		String(row.collectionName ?? row.collection_name ?? ''),
	);
	return collapse_history_key(row_model) === collapse_history_key(canonical);
}

function leaf_value(value: unknown): unknown {
	if (value == null) return value;
	if (Array.isArray(value)) {
		return value.map((item) =>
			item && typeof item === 'object' && '_id' in (item as object)
				? String((item as { _id: unknown })._id)
				: item,
		);
	}
	if (typeof value === 'object') {
		const obj = value as Record<string, unknown>;
		if (obj._id) return String(obj._id);
		return JSON.stringify(value);
	}
	return value;
}

function same_leaf(left: unknown, right: unknown): boolean {
	return JSON.stringify(leaf_value(left)) === JSON.stringify(leaf_value(right));
}

function display_label(path: string): string {
	return LABELS[path] ?? path.replace(/[_-]+/g, ' ');
}

const OPERATION_TEMPLATES: Record<string, string> = {
	crear: 'Se agregó {{etiqueta}} con {{valorNuevo}} (i{class:fas fa-plus})',
	eliminar: 'Se eliminó {{etiqueta}} que tenía {{valorAnterior}} (i{class:fas fa-trash})',
	editar: 'Se cambió {{etiqueta}} de {{valorAnterior}} (i{class:fas fa-arrow-right}) {{valorNuevo}}',
	reordenar:
		'Se reordenó {{etiqueta}} de la posición {{indiceAnterior}} (i{class:fas fa-arrow-right}) {{indiceNuevo}}',
};

const MAX_DISPLAY_VALUE_LENGTH = 180;

export function format_history_value(value: unknown): string {
	if (value === undefined) return 'sin valor';
	if (value === null) return 'nulo';
	if (typeof value === 'boolean') return value ? 'sí' : 'no';
	if (typeof value === 'number') return String(value);
	if (typeof value === 'string') {
		const clipped =
			value.length > MAX_DISPLAY_VALUE_LENGTH
				? `${value.slice(0, MAX_DISPLAY_VALUE_LENGTH)}…`
				: value;
		return `"${clipped}"`;
	}
	try {
		const text = JSON.stringify(value);
		return text.length > MAX_DISPLAY_VALUE_LENGTH
			? `${text.slice(0, MAX_DISPLAY_VALUE_LENGTH)}…`
			: text;
	} catch {
		return String(value);
	}
}

export function enrich_history_change(
	change: Record<string, unknown>,
): Record<string, unknown> {
	const movement = String(change.tipoMovimiento ?? 'editar');
	const label = String(change.displayLabel ?? change.normalizedPath ?? 'Campo');
	const existing =
		change.displayPathValues && typeof change.displayPathValues === 'object'
			? (change.displayPathValues as Record<string, unknown>)
			: {};
	const displayPathValues = {
		etiqueta: existing.etiqueta ?? label,
		valorAnterior: existing.valorAnterior ?? format_history_value(change.before),
		valorNuevo: existing.valorNuevo ?? format_history_value(change.after),
		...existing,
	};
	const current_path = String(change.displayPath ?? '');
	const displayPath = current_path.includes('{{')
		? current_path
		: (OPERATION_TEMPLATES[movement] ?? OPERATION_TEMPLATES.editar);
	return { ...change, displayPath, displayPathValues };
}

export function interpolate_plain_history_template(
	template: string,
	values: Record<string, unknown> = {},
): string {
	return template
		.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) =>
			String(values[key] ?? ''),
		)
		.replace(/\(\s*i\{class:[^}]*fa-arrow-right[^}]*\}\s*\)/gi, '→')
		.replace(/\(\s*[a-zA-Z][\w-]*\{[^{}]+\}\s*\)/g, '')
		.replace(/\s{2,}/g, ' ')
		.trim();
}

export function build_history_action_description(
	changes: Array<Record<string, unknown>>,
): string {
	return changes
		.slice(0, 3)
		.map((change) => {
			const enriched = enrich_history_change(change);
			return interpolate_plain_history_template(
				String(enriched.displayPath ?? ''),
				(enriched.displayPathValues ?? {}) as Record<string, unknown>,
			);
		})
		.filter(Boolean)
		.join(', ');
}

export function enrich_history_row(row: ImperiumDoc): ImperiumDoc {
	const changes = Array.isArray(row.changes) ? row.changes : [];
	const enriched_changes = changes
		.filter((change): change is Record<string, unknown> => Boolean(change) && typeof change === 'object')
		.map((change) => enrich_history_change(change));
	const stored_description = String(row.actionDescription ?? '');
	const actionDescription =
		stored_description.includes('{{') || /\(\s*i\{/.test(stored_description)
			? build_history_action_description(enriched_changes)
			: stored_description;
	return {
		...row,
		changes: enriched_changes,
		...(actionDescription ? { actionDescription } : {}),
	};
}

export function diff_docs(before: ImperiumDoc | null, after: ImperiumDoc | null) {
	const prev = as_object(before);
	const next = as_object(after);
	const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
	const changes: Array<Record<string, unknown>> = [];
	for (const key of keys) {
		if (IGNORE_KEYS.has(key) || key.startsWith('_')) continue;
		const left = prev[key];
		const right = next[key];
		if (same_leaf(left, right)) continue;
		const creating = left === undefined;
		const removing = right === undefined;
		const movement = creating ? 'crear' : removing ? 'eliminar' : 'editar';
		const label = display_label(key);
		const before_value = creating ? undefined : leaf_value(left);
		const after_value = removing ? undefined : leaf_value(right);
		changes.push(
			enrich_history_change({
				op: creating ? 'add' : removing ? 'remove' : 'replace',
				tipoMovimiento: movement,
				jsonPointer: `/${key}`,
				dotPath: key,
				normalizedPath: key,
				displayLabel: label,
				displayPath: OPERATION_TEMPLATES[movement],
				before: before_value,
				after: after_value,
				displayPathValues: {
					etiqueta: label,
					valorAnterior: format_history_value(before_value),
					valorNuevo: format_history_value(after_value),
				},
			}),
		);
	}
	return changes;
}

function action_name(loc_name: string, before: ImperiumDoc | null, after: ImperiumDoc | null) {
	const label = loc_name || 'Registro';
	if (!before) return `${label} creado`;
	if (after?.is_active === false && before.is_active !== false) return `${label} eliminado`;
	return `${label} actualizado`;
}

export async function record_document_history(
	store: HistoryCapableStore,
	resource: string,
	before: ImperiumDoc | null,
	after: ImperiumDoc | null,
): Promise<void> {
	const ctx = als.getStore();
	if (!ctx) return;
	if (!store.has('document-change-history')) return;
	if (SKIP_RESOURCES.has(resource)) return;
	const loc = store.has(resource) ? store.loc(resource) : null;
	const canonical = loc?.resource ?? resource;
	if (SKIP_RESOURCES.has(canonical)) return;
	const document_id = String(after?._id ?? before?._id ?? '').trim();
	if (!document_id) return;
	const changes = diff_docs(before, after);
	if (!changes.length) return;
	const operation = !before ? 'save' : after?.is_active === false && before.is_active !== false ? 'deleteOne' : 'save';
	const collection_name = loc?.collection ?? canonical;
	const created = await store.insert('document-change-history', {
		name: action_name(loc?.name ?? canonical, before, after),
		entryType: 'change',
		collectionName: collection_name,
		modelName: canonical,
		documentId: document_id,
		record_id: document_id,
		operationType: operation,
		actionName: action_name(loc?.name ?? canonical, before, after),
		actionDescription: build_history_action_description(changes),
		changeCount: changes.length,
		changes,
		actor: {
			_id: ctx.actor?._id,
			name: ctx.actor?.name,
			email: ctx.actor?.email,
			img: ctx.actor?.img,
		},
		request: {
			method: ctx.method,
			url: ctx.path,
			userAgent: ctx.user_agent,
		},
		created_by: ctx.actor?._id,
	});
	await notify_document_subscription_event(store as never, {
		history_id: String(created._id ?? ''),
		actor: ctx.actor,
		collection_name,
		model_name: canonical,
		document_id,
		was_new: !before,
		current_document: after,
		module_label: loc?.name ?? canonical,
	}).catch(() => undefined);
	await register_document_mentions(store as never, ctx.actor ?? null, {
		current_document: after,
		previous_document: before ?? undefined,
		resource: canonical,
		document_id,
	}).catch(() => undefined);
}
