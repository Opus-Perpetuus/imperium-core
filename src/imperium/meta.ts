/**
 * `GET /api/meta`: lo que el núcleo ya sabe de formularios y listas, por recurso
 * que el usuario puede leer. Misma decisión de permiso que el CRUD.
 */
import {
	assert_http_access,
	build_access,
	HttpAccessDeniedError,
	HttpAuthRequiredError,
} from './auth.ts';
import { ALWAYS_SECRET_KEYS, USER_SECRET_KEYS } from './crud.ts';
import { fail, ok, type ImperiumDoc } from './envelope.ts';
import { list_instance_type } from './list-projection.ts';
import { required_fields_for } from './required-fields.ts';
import { schema_validation_for } from './state-fields.ts';
import type { ExtraCol, ImperiumStore, ModuleLoc } from './store.ts';

type Access = Awaited<ReturnType<typeof build_access>>;

type SchemaShape = {
	required?: unknown;
	properties?: Record<string, Record<string, unknown>>;
	metadata?: {
		state_fields?: {
			fields?: Array<{
				field_name?: string;
				values?: Array<{ value?: unknown; display_leyend?: unknown }>;
			}>;
		};
	};
};

export type MetaField = {
	name: string;
	label: string;
	component: string;
	type: string;
	required: boolean;
	options?: Array<{ value: string; label: string }>;
	ref?: string;
};

export type MetaResource = {
	resource: string;
	table: string;
	path: string;
	name: string;
	subject: string | null;
	permissions: { read: boolean; create: boolean; update: boolean; delete: boolean };
	fields: MetaField[];
	list_columns: Array<{ name: string; label: string }>;
};

function is_secret(name: string): boolean {
	return USER_SECRET_KEYS.has(name) || ALWAYS_SECRET_KEYS.has(name);
}

function catalog_locs(store: ImperiumStore): ModuleLoc[] {
	const seen = new Set<string>();
	const locs: ModuleLoc[] = [];
	for (const loc of store.all_locs) {
		if (seen.has(loc.resource)) continue;
		seen.add(loc.resource);
		locs.push(store.has(loc.resource) ? store.loc(loc.resource) : loc);
	}
	locs.sort((a, b) => (a.resource < b.resource ? -1 : a.resource > b.resource ? 1 : 0));
	return locs;
}

function resource_path(store: ImperiumStore, loc: ModuleLoc): string {
	const owned = store.subjects.find((subject) => subject.slug === loc.slug);
	const in_owner = owned?.modules.find((mod) => mod.resource === loc.resource);
	if (in_owner?.path) return in_owner.path;
	for (const subject of store.subjects) {
		const mod = subject.modules.find((item) => item.resource === loc.resource);
		if (mod?.path) return mod.path;
	}
	return `/${loc.resource}`;
}

async function allows(
	store: ImperiumStore,
	user: ImperiumDoc,
	resource: string,
	method: string,
	access: Access,
): Promise<boolean> {
	try {
		await assert_http_access(store, user, resource, method, { access });
		return true;
	} catch (err) {
		if (err instanceof HttpAccessDeniedError || err instanceof HttpAuthRequiredError) return false;
		throw err;
	}
}

function required_names(resource: string, schema: SchemaShape): Set<string> {
	const names = new Set<string>(required_fields_for(resource));
	if (Array.isArray(schema.required)) {
		for (const item of schema.required) {
			if (typeof item === 'string' && item) names.add(item);
		}
	}
	return names;
}

function options_for(
	name: string,
	schema: SchemaShape,
): Array<{ value: string; label: string }> | undefined {
	const state = schema.metadata?.state_fields?.fields?.find((field) => field.field_name === name);
	const from_state = (state?.values ?? [])
		.map((value) => {
			const raw = String(value.value ?? '').trim();
			if (!raw) return null;
			const label = String(value.display_leyend ?? '').trim() || raw;
			return { value: raw, label };
		})
		.filter((item): item is { value: string; label: string } => item != null);
	return from_state.length ? from_state : undefined;
}

function ref_for(name: string, schema: SchemaShape): string | undefined {
	const ref = schema.properties?.[name]?.['x-ref'];
	return typeof ref === 'string' && ref ? ref : undefined;
}

function fields_of(columns: ExtraCol[], resource: string, schema: SchemaShape): MetaField[] {
	const required = required_names(resource, schema);
	const fields: MetaField[] = [];
	for (const col of columns) {
		if (!col.name || is_secret(col.name)) continue;
		const options = options_for(col.name, schema);
		const ref = ref_for(col.name, schema);
		const field: MetaField = {
			name: col.name,
			label: col.label || col.name,
			component: col.component ?? '',
			type: col.crud ?? '',
			required: required.has(col.name),
		};
		if (options) field.options = options;
		if (ref) field.ref = ref;
		fields.push(field);
	}
	return fields;
}

function list_columns_of(
	loc: ModuleLoc,
	resource: string,
): Array<{ name: string; label: string }> {
	const labels = new Map(loc.columns.map((col) => [col.name, col.label || col.name]));
	const label_of = (name: string, fallback: string) => labels.get(name) || fallback;
	const projected = list_instance_type(resource);
	if (projected) {
		return Object.keys(projected)
			.filter((name) => !is_secret(name))
			.map((name) => ({
				name,
				label: label_of(name, projected[name]?.nombre_encabezado || name.replace(/_/g, ' ')),
			}));
	}
	const keys = ['_id', 'name', 'description', 'is_active', '_ref'];
	for (const col of loc.columns) {
		if (!col.name || is_secret(col.name) || keys.includes(col.name)) continue;
		keys.push(col.name);
	}
	return keys
		.filter((name) => !is_secret(name))
		.map((name) => ({ name, label: label_of(name, name.replace(/_/g, ' ')) }));
}

export async function build_meta(
	store: ImperiumStore,
	user: ImperiumDoc,
): Promise<{ resources: MetaResource[] }> {
	const access = await build_access(store, user);
	const resources: MetaResource[] = [];
	for (const loc of catalog_locs(store)) {
		if (!(await allows(store, user, loc.resource, 'GET', access))) continue;
		const schema = (await schema_validation_for(store, loc.resource)) as SchemaShape;
		resources.push({
			resource: loc.resource,
			table: loc.table,
			path: resource_path(store, loc),
			name: loc.name,
			subject: loc.slug || null,
			permissions: {
				read: true,
				create: await allows(store, user, loc.resource, 'POST', access),
				update: await allows(store, user, loc.resource, 'PUT', access),
				delete: await allows(store, user, loc.resource, 'DELETE', access),
			},
			fields: fields_of(loc.columns, loc.resource, schema),
			list_columns: list_columns_of(loc, loc.resource),
		});
	}
	return { resources };
}

export function meta_etag(body: string): string {
	const hex = new Bun.CryptoHasher('sha256').update(body).digest('hex');
	return `W/"${hex.slice(0, 32)}"`;
}

function etag_matches(header: string | null, etag: string): boolean {
	if (!header) return false;
	return header.split(',').some((part) => part.trim() === etag);
}

const CACHE_HEADERS = {
	'cache-control': 'private, no-cache',
	vary: 'Cookie',
};

export async function meta_http_response(
	store: ImperiumStore,
	user: ImperiumDoc | null,
	req: Request,
): Promise<Response> {
	if (!user) {
		return Response.json(
			{ error: 'No estás autenticado', message: 'No estás autenticado' },
			{ status: 401 },
		);
	}
	if (req.method !== 'GET') {
		return Response.json(fail('Método no permitido', 405).body, {
			status: 405,
			headers: { allow: 'GET' },
		});
	}
	const body = JSON.stringify(ok(await build_meta(store, user)));
	const etag = meta_etag(body);
	const headers = {
		etag,
		...CACHE_HEADERS,
		'content-type': 'application/json;charset=utf-8',
	};
	if (etag_matches(req.headers.get('if-none-match'), etag)) {
		return new Response(null, { status: 304, headers: { etag, ...CACHE_HEADERS } });
	}
	return new Response(body, { status: 200, headers });
}
