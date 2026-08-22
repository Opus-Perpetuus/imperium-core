/**
 * Historial de cambios: mismo contrato que el plugin de Mongoose del original.
 * El panel de formularios lee `document-change-history` por documentId + modelo.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { as_object, type ImperiumDoc } from './envelope.ts';

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

function diff_docs(before: ImperiumDoc | null, after: ImperiumDoc | null) {
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
		changes.push({
			op: creating ? 'add' : removing ? 'remove' : 'replace',
			tipoMovimiento: creating ? 'crear' : removing ? 'eliminar' : 'editar',
			jsonPointer: `/${key}`,
			dotPath: key,
			normalizedPath: key,
			displayLabel: display_label(key),
			displayPath: display_label(key),
			before: creating ? undefined : leaf_value(left),
			after: removing ? undefined : leaf_value(right),
		});
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
	await store.insert('document-change-history', {
		name: action_name(loc?.name ?? canonical, before, after),
		entryType: 'change',
		collectionName: loc?.collection ?? canonical,
		modelName: canonical,
		documentId: document_id,
		record_id: document_id,
		operationType: operation,
		actionName: action_name(loc?.name ?? canonical, before, after),
		actionDescription: changes
			.slice(0, 3)
			.map((change) => String(change.displayPath ?? change.dotPath))
			.join(', '),
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
}
