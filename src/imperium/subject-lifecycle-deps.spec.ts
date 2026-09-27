import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
	accept_subject_lifecycle,
	accept_subject_update,
	build_install_chain,
	build_update_all_chain,
	catalog_row,
	list_catalog_subjects,
	read_schema_tables,
	subject_lifecycle_body,
	subjects_access_denied,
	SubjectLifecycleError,
	uninstall_dependents_error,
} from './subjects-admin.ts';
import { run_subject_auto_update_pass } from './subject-auto-update.ts';
import { ImperiumStore, load_catalog_path, type SubjectInfo } from './store.ts';
import type { DependencyNode } from './subject-deps.ts';

const GRAPH: DependencyNode[] = [
	{ technical_id: 'subject-configuracion', slug: 'configuracion', name: 'Configuración' },
	{ technical_id: 'subject-almacen', slug: 'almacen', name: 'Almacén' },
	{ technical_id: 'subject-rh', slug: 'rh', name: 'Recursos Humanos' },
	{
		technical_id: 'subject-ventas',
		slug: 'ventas',
		name: 'Ventas',
		depends_on: ['subject-almacen'],
	},
	{
		technical_id: 'subject-pos',
		slug: 'pos',
		name: 'POS',
		depends_on: ['subject-almacen', 'subject-rh'],
	},
];

const none = () => false;
const idle = () => undefined;

function lifecycle_error(fn: () => unknown): SubjectLifecycleError {
	try {
		fn();
	} catch (err) {
		if (err instanceof SubjectLifecycleError) return err;
		throw err;
	}
	throw new Error('no lanzó');
}

describe('build_install_chain', () => {
	test('dependencias faltantes primero y la app al final', () => {
		expect(build_install_chain(GRAPH, 'subject-pos', 'install', none, idle)).toEqual([
			{ technical_id: 'subject-almacen', kind: 'install' },
			{ technical_id: 'subject-rh', kind: 'install' },
			{ technical_id: 'subject-pos', kind: 'install' },
		]);
	});

	test('las ya instaladas no se repiten', () => {
		const ready = (tid: string) => tid === 'subject-almacen';
		expect(build_install_chain(GRAPH, 'subject-pos', 'install', ready, idle)).toEqual([
			{ technical_id: 'subject-rh', kind: 'install' },
			{ technical_id: 'subject-pos', kind: 'install' },
		]);
	});

	test('una dependencia que otro trabajo instala se espera, no se relanza', () => {
		const busy = (tid: string) => (tid === 'subject-almacen' ? 'install' : undefined);
		expect(build_install_chain(GRAPH, 'subject-ventas', 'install', none, busy)).toEqual([
			{ technical_id: 'subject-almacen', kind: 'wait' },
			{ technical_id: 'subject-ventas', kind: 'install' },
		]);
	});

	test('una dependencia desinstalándose es 409 dependency_busy', () => {
		const busy = (tid: string) => (tid === 'subject-almacen' ? 'uninstall' : undefined);
		const err = lifecycle_error(() =>
			build_install_chain(GRAPH, 'subject-ventas', 'install', none, busy),
		);
		expect(err.status).toBe(409);
		expect(err.code).toBe('dependency_busy');
		expect(err.message).toBe('No se puede instalar Ventas: Almacén se está desinstalando');
		expect(err.details).toEqual({
			technical_id: 'subject-ventas',
			slug: 'ventas',
			name: 'Ventas',
			dependency: { technical_id: 'subject-almacen', slug: 'almacen', name: 'Almacén' },
		});
	});

	test('actualizar deja la app como paso update', () => {
		const ready = (tid: string) => tid !== 'subject-rh';
		expect(build_install_chain(GRAPH, 'subject-pos', 'update', ready, idle)).toEqual([
			{ technical_id: 'subject-rh', kind: 'install' },
			{ technical_id: 'subject-pos', kind: 'update' },
		]);
	});

	test('errores del grafo son 409 con el mismo code y details', () => {
		const cycle: DependencyNode[] = [
			{ technical_id: 'subject-a', slug: 'a', depends_on: ['subject-b'] },
			{ technical_id: 'subject-b', slug: 'b', depends_on: ['subject-a'] },
		];
		const err = lifecycle_error(() => build_install_chain(cycle, 'subject-a', 'install', none, idle));
		expect(err.status).toBe(409);
		expect(err.code).toBe('dependency_cycle');
		expect(err.details).toEqual({ cycle: ['subject-a', 'subject-b', 'subject-a'] });

		const unknown: DependencyNode[] = [
			{ technical_id: 'subject-a', slug: 'a', depends_on: ['subject-fantasma'] },
		];
		const miss = lifecycle_error(() =>
			build_install_chain(unknown, 'subject-a', 'install', none, idle),
		);
		expect(miss.status).toBe(409);
		expect(miss.code).toBe('dependency_unknown');
		expect(miss.details).toEqual({ technical_id: 'subject-fantasma', required_by: 'subject-a' });
	});
});

describe('build_update_all_chain', () => {
	test('una dependencia compartida se instala una vez y el grupo siguiente la necesita', () => {
		const ready = (tid: string) => tid === 'subject-ventas' || tid === 'subject-pos';
		expect(
			build_update_all_chain(GRAPH, ['subject-ventas', 'subject-pos'], ready, idle),
		).toEqual({
			groups: [
				{
					target: 'subject-ventas',
					steps: [
						{ technical_id: 'subject-almacen', kind: 'install' },
						{ technical_id: 'subject-ventas', kind: 'update' },
					],
					needs: [],
				},
				{
					target: 'subject-pos',
					steps: [
						{ technical_id: 'subject-rh', kind: 'install' },
						{ technical_id: 'subject-pos', kind: 'update' },
					],
					needs: ['subject-almacen'],
				},
			],
			skipped: [],
		});
	});

	test('una app con la dependencia desinstalándose se salta y se informa', () => {
		const ready = (tid: string) => tid !== 'subject-almacen';
		const busy = (tid: string) => (tid === 'subject-almacen' ? 'uninstall' : undefined);
		const plan = build_update_all_chain(GRAPH, ['subject-ventas', 'subject-rh'], ready, busy);
		expect(plan.groups.map((g) => g.target)).toEqual(['subject-rh']);
		expect(plan.skipped).toEqual([
			{
				technical_id: 'subject-ventas',
				code: 'dependency_busy',
				message: 'No se puede actualizar Ventas: Almacén se está desinstalando',
			},
		]);
	});
});

describe('uninstall_dependents_error', () => {
	test('409 con la lista de apps vivas que la usan', () => {
		const live = (tid: string) => tid === 'subject-ventas' || tid === 'subject-pos';
		const err = uninstall_dependents_error(GRAPH, 'subject-almacen', live)!;
		expect(err.status).toBe(409);
		expect(err.code).toBe('subject_has_dependents');
		expect(err.message).toBe('No se puede desinstalar Almacén: la usan Ventas, POS');
		expect(subject_lifecycle_body(err)).toEqual({
			error: 'subject_has_dependents',
			code: 'subject_has_dependents',
			message: 'No se puede desinstalar Almacén: la usan Ventas, POS',
			details: {
				technical_id: 'subject-almacen',
				slug: 'almacen',
				name: 'Almacén',
				dependents: [
					{ technical_id: 'subject-ventas', slug: 'ventas', name: 'Ventas' },
					{ technical_id: 'subject-pos', slug: 'pos', name: 'POS' },
				],
			},
		});
	});

	test('cuenta dependientes transitivas aunque la intermedia no esté viva', () => {
		const chain: DependencyNode[] = [
			{ technical_id: 'subject-c', slug: 'c', name: 'C' },
			{ technical_id: 'subject-b', slug: 'b', name: 'B', depends_on: ['subject-c'] },
			{ technical_id: 'subject-a', slug: 'a', name: 'A', depends_on: ['subject-b'] },
		];
		const err = uninstall_dependents_error(chain, 'subject-c', (tid) => tid === 'subject-a');
		expect(err?.message).toBe('No se puede desinstalar C: la usan A');
	});

	test('sin dependientes vivas se puede desinstalar', () => {
		expect(uninstall_dependents_error(GRAPH, 'subject-almacen', none)).toBeNull();
	});

	test('set_subject_installed repite el control antes de cortar el acceso', () => {
		const src = readFileSync(new URL('./subjects-admin.ts', import.meta.url), 'utf8');
		const body = src.slice(
			src.indexOf('export async function set_subject_installed'),
			src.indexOf('const JOB_KIND'),
		);
		const check = body.indexOf('uninstall_dependents_error(');
		expect(check).toBeGreaterThan(0);
		expect(check).toBeLessThan(body.indexOf('begin_subject_lifecycle('));
	});
});

describe('catalog_row con el catálogo real', () => {
	const store = new ImperiumStore(null as unknown as Bun.SQL, load_catalog_path());
	const by_slug = (slug: string) => store.subjects.find((s) => s.slug === slug)!;
	const installed = new Set(
		store.subjects
			.filter((s) => ['configuracion', 'almacen', 'ventas', 'pos'].includes(s.slug))
			.map((s) => s.technical_id),
	);
	const row = (slug: string) =>
		catalog_row(by_slug(slug), installed.has(by_slug(slug).technical_id), undefined, {
			subjects: store.subjects,
			installed,
		});

	test('un recurso compartido se atribuye a su dueña (PREFER_OWNER)', () => {
		const paths = (slug: string) => row(slug).modules.map((m) => m.path);
		expect(paths('almacen')).toContain('/pedidos/surtir');
		expect(paths('almacen')).toContain('/products');
		expect(paths('almacen')).not.toContain('/pedidos');
		expect(paths('ventas')).toContain('/pedidos');
		expect(paths('ventas')).not.toContain('/products');
		expect(paths('logistica')).not.toContain('/pedidos');
		const owners = (resource: string) =>
			store.subjects
				.filter((s) => row(s.slug).modules.some((m) => m.resource === resource))
				.map((s) => s.slug);
		expect(owners('pedidos')).toEqual(['ventas']);
		expect(owners('products')).toEqual(['almacen']);
		expect(owners('pedidos-surtir')).toEqual(['almacen']);
	});

	test('expone depends_on, required_by y missing_dependencies', () => {
		const pos = row('pos');
		expect(pos.depends_on).toEqual(['subject-almacen', 'subject-rh']);
		expect(pos.missing_dependencies).toEqual(['subject-rh']);
		expect(pos.required_by).toEqual([]);
		const almacen = row('almacen');
		expect(almacen.depends_on).toEqual([]);
		expect(almacen.missing_dependencies).toEqual([]);
		expect([...almacen.required_by].sort()).toEqual(['subject-pos', 'subject-ventas']);
		expect(row('logistica').missing_dependencies).toEqual(['subject-vehiculos']);
		expect(row('rh').required_by).toEqual(['subject-pos']);
	});
});

describe('read_schema_tables', () => {
	test('arreglo, string JSON y doble codificado', () => {
		expect(read_schema_tables(['a', 'b'])).toEqual(['a', 'b']);
		expect(read_schema_tables('["a","b"]')).toEqual(['a', 'b']);
		expect(read_schema_tables(JSON.stringify(JSON.stringify(['a'])))).toEqual(['a']);
	});

	test('lo ilegible queda vacío', () => {
		expect(read_schema_tables(null)).toEqual([]);
		expect(read_schema_tables('no es json')).toEqual([]);
		expect(read_schema_tables('{"a":1}')).toEqual([]);
	});
});

describe('candado de /subjects', () => {
	const admin = { _id: 'u1', _ref: 'user-menu-management-0' };
	const staff = { _id: 'u2', _ref: 'user-cualquiera' };

	test('sin sesión ni maestro: 401', () => {
		expect(subjects_access_denied('GET', null, false)?.status).toBe(401);
	});

	test('leer basta con una sesión interna', () => {
		expect(subjects_access_denied('GET', staff, false)).toBeNull();
	});

	test('cambiar exige administrador', async () => {
		for (const method of ['POST', 'PUT']) {
			const res = subjects_access_denied(method, staff, false)!;
			expect(res.status).toBe(403);
			expect(await res.json()).toEqual({
				error: 'admin_required',
				code: 'admin_required',
				message: 'Solo un administrador puede instalar o desinstalar apps',
			});
		}
		expect(subjects_access_denied('POST', admin, false)).toBeNull();
	});

	test('el maestro de gateway pasa sin sesión', () => {
		expect(subjects_access_denied('POST', null, true)).toBeNull();
	});

	test('cableado: el candado va antes de cualquier ruta y los dos catch llevan code y details', () => {
		const src = readFileSync(new URL('./router.ts', import.meta.url), 'utf8');
		const body = src.slice(src.indexOf('async function handle_subjects'));
		const gate = body.indexOf('subjects_access_denied(');
		expect(gate).toBeGreaterThan(0);
		expect(gate).toBeLessThan(body.indexOf('list_catalog_subjects('));
		expect(body.match(/subject_lifecycle_body\(err\)/g)?.length).toBe(2);
		expect(body).not.toContain('{ error: err.code, message: err.message }');
		expect(src).not.toContain('subject_gateway_ok');
	});
});

// ---- Ciclo de vida contra un Postgres en memoria: solo lo que tocan estas rutas.

type Row = {
	technical_id: string;
	installed: boolean;
	status: string;
	installed_at: string | null;
	uninstalled_at: string | null;
	version: number | null;
	installed_image: string | null;
};

type Hook = (row: { technical_id: string; status: string }) => Promise<void> | void;
type SelectHook = (call: number) => Promise<void> | void;

function fake_sql(initial: Array<[string, boolean, string?]>) {
	const rows = new Map<string, Row>();
	const writes: Array<{ technical_id: string; status: string }> = [];
	let hook: Hook | null = null;
	let select_hook: SelectHook | null = null;
	let selects = 0;
	for (const [technical_id, installed, image] of initial) {
		rows.set(technical_id, {
			technical_id,
			installed,
			status: installed ? 'installed' : 'not_installed',
			installed_at: null,
			uninstalled_at: null,
			version: null,
			installed_image: image ?? null,
		});
	}
	const sql = {
		async unsafe(query: string, params: unknown[] = []) {
			if (query.includes('subject_schema_versions')) return [];
			if (query.includes('INSERT INTO public.subject_installs')) {
				const technical_id = String(params[0]);
				const status = String(params[2]);
				await hook?.({ technical_id, status });
				writes.push({ technical_id, status });
				const prev = rows.get(technical_id);
				const installed = query.includes('VALUES ($1, TRUE');
				rows.set(technical_id, {
					technical_id,
					installed,
					status,
					installed_at: prev?.installed_at ?? null,
					uninstalled_at: prev?.uninstalled_at ?? null,
					version: prev?.version ?? null,
					installed_image: installed
						? ((params[3] as string | null) ?? prev?.installed_image ?? null)
						: status === 'uninstalled'
							? null
							: (prev?.installed_image ?? null),
				});
				return [];
			}
			if (query.includes('SELECT') && query.includes('public.subject_installs')) {
				// Lo leído es lo que había al ejecutar; el hook decide cuándo llega.
				const read = [...rows.values()].map((row) => ({ ...row }));
				await select_hook?.(++selects);
				return read;
			}
			return [];
		},
	} as unknown as Bun.SQL;
	return {
		sql,
		rows,
		writes,
		on_write(next: Hook | null) {
			hook = next;
		},
		on_select(next: SelectHook | null) {
			selects = 0;
			select_hook = next;
		},
	};
}

function subject(node: DependencyNode, image = ''): SubjectInfo {
	return {
		slug: node.slug,
		name: node.name ?? node.slug,
		path: `/${node.slug}`,
		menu_ref: `${node.slug}-menu-root`,
		technical_id: node.technical_id,
		image,
		depends_on: node.depends_on ?? [],
		modules: [],
	};
}

const IMAGE_NEW = 'ghcr.io/opus-perpetuus/subject-pos:0.2.0';
const IMAGE_OLD = 'ghcr.io/opus-perpetuus/subject-pos:0.1.0';

function fake_store(auto_update = false) {
	return {
		subjects: GRAPH.map((node) => subject(node, node.slug === 'pos' ? IMAGE_NEW : '')),
		locs: new Map(),
		has: (resource: string) => auto_update && resource === 'configuration',
		find_where: async () => ({ _id: 'cfg', value: true }),
		mark_subject_installed: () => {},
		seed_default_employee: async () => {},
	} as unknown as ImperiumStore;
}

function gate() {
	let open!: () => void;
	const promise = new Promise<void>((resolve) => (open = resolve));
	return { promise, open };
}

/** La cadena corre en segundo plano: se espera a que las filas dejen de moverse. */
async function settled(db: ReturnType<typeof fake_sql>) {
	const started = Date.now();
	while (Date.now() - started < 15_000) {
		const busy = [...db.rows.values()].some((row) =>
			['installing', 'uninstalling', 'updating'].includes(row.status),
		);
		if (!busy) {
			// `settle` corre en el `finally`, justo después de la última escritura.
			await Bun.sleep(5);
			return;
		}
		await Bun.sleep(2);
	}
	throw new Error('la cadena no terminó');
}

function state(db: ReturnType<typeof fake_sql>, tid: string) {
	const row = db.rows.get(tid);
	return row ? `${row.installed ? 'on' : 'off'}:${row.status}` : 'none';
}

describe('ciclo de vida con dependencias', () => {
	const ORIGINAL_RUNTIME = process.env.SUBJECT_RUNTIME;
	beforeAll(() => {
		process.env.SUBJECT_RUNTIME = 'off';
	});
	afterAll(() => {
		if (ORIGINAL_RUNTIME == null) delete process.env.SUBJECT_RUNTIME;
		else process.env.SUBJECT_RUNTIME = ORIGINAL_RUNTIME;
	});

	test('instalar POS instala antes Almacén y RH, en orden', async () => {
		const db = fake_sql([]);
		const store = fake_store();
		const res = (await accept_subject_lifecycle(store, db.sql, 'subject-pos', true, null))!;
		expect(res.already_running).toBe(false);
		expect(res.rows.map((r) => r.technical_id)).toEqual([
			'subject-pos',
			'subject-almacen',
			'subject-rh',
		]);
		expect(res.rows.every((r) => r.busy && r.status === 'installing')).toBe(true);
		expect(res.dependencies.map((d) => d.name)).toEqual(['Almacén', 'Recursos Humanos']);
		await settled(db);
		expect(state(db, 'subject-almacen')).toBe('on:installed');
		expect(state(db, 'subject-rh')).toBe('on:installed');
		expect(state(db, 'subject-pos')).toBe('on:installed');
		const finals = db.writes.filter((w) => w.status === 'installed').map((w) => w.technical_id);
		expect(finals).toEqual(['subject-almacen', 'subject-rh', 'subject-pos']);
	});

	test('al terminar de instalar RH se siembra su empleado, sin esperar al arranque', async () => {
		const db = fake_sql([]);
		const marks: string[] = [];
		const seeded: string[] = [];
		const store = {
			...fake_store(),
			mark_subject_installed: (tid: string, on: boolean) => marks.push(`${tid}:${on}`),
			seed_default_employee: async () => {
				seeded.push(marks.at(-1) ?? '');
			},
		} as unknown as ImperiumStore;
		await accept_subject_lifecycle(store, db.sql, 'subject-pos', true, null);
		await settled(db);
		expect(marks).toEqual(['subject-almacen:true', 'subject-rh:true', 'subject-pos:true']);
		// Una vez, y ya con RH marcada como instalada en el caché.
		expect(seeded).toEqual(['subject-rh:true']);
	});

	test('un job por app, y un fallo al guardar su progreso no tumba el proceso', async () => {
		const db = fake_sql([]);
		const inserted: Array<{ technical_id: string; job_kind: string }> = [];
		const store = {
			...fake_store(),
			has: (resource: string) => resource === 'notifications',
			find_many: async () => ({ rows: [] }),
			insert: async (_: string, doc: { payload: { technical_id: string; job_kind: string } }) => {
				inserted.push({
					technical_id: doc.payload.technical_id,
					job_kind: doc.payload.job_kind,
				});
				return { ...doc, _id: `n-${inserted.length}` };
			},
			find_id: async () => {
				throw new Error('notificaciones caídas');
			},
		} as unknown as ImperiumStore;
		const res = (await accept_subject_lifecycle(store, db.sql, 'subject-pos', true, {
			_id: 'u1',
		}))!;
		expect(inserted).toEqual([
			{ technical_id: 'subject-almacen', job_kind: 'subject_install' },
			{ technical_id: 'subject-rh', job_kind: 'subject_install' },
			{ technical_id: 'subject-pos', job_kind: 'subject_install' },
		]);
		expect(res.notification?._id).toBe('n-3');
		await settled(db);
		expect(state(db, 'subject-pos')).toBe('on:installed');
	});

	test('si falla una dependencia, la cadena se corta y las restantes quedan en error', async () => {
		const db = fake_sql([]);
		db.on_write(({ technical_id, status }) => {
			if (technical_id === 'subject-almacen' && status === 'installed') {
				throw new Error('se cayó la base');
			}
		});
		await accept_subject_lifecycle(fake_store(), db.sql, 'subject-pos', true, null);
		await settled(db);
		expect(state(db, 'subject-almacen')).toBe('off:error');
		expect(state(db, 'subject-rh')).toBe('off:error');
		expect(state(db, 'subject-pos')).toBe('off:error');
		expect(db.writes.some((w) => w.technical_id === 'subject-rh' && w.status === 'installed')).toBe(
			false,
		);
	});

	test('desinstalar Almacén con Ventas instalada: 409 y el acceso no se corta', async () => {
		const db = fake_sql([
			['subject-almacen', true],
			['subject-ventas', true],
		]);
		const err = await accept_subject_lifecycle(
			fake_store(),
			db.sql,
			'subject-almacen',
			false,
			null,
		).catch((e) => e);
		expect(err).toBeInstanceOf(SubjectLifecycleError);
		expect(err.status).toBe(409);
		expect(err.code).toBe('subject_has_dependents');
		expect(err.details.dependents).toEqual([
			{ technical_id: 'subject-ventas', slug: 'ventas', name: 'Ventas' },
		]);
		expect(state(db, 'subject-almacen')).toBe('on:installed');
		expect(db.writes).toEqual([]);
	});

	test('una dependiente que se está instalando cuenta como viva', async () => {
		const db = fake_sql([['subject-almacen', true]]);
		const store = fake_store();
		const hold = gate();
		db.on_write(async ({ technical_id, status }) => {
			if (technical_id === 'subject-ventas' && status === 'installed') await hold.promise;
		});
		await accept_subject_lifecycle(store, db.sql, 'subject-ventas', true, null);
		const err = await accept_subject_lifecycle(
			store,
			db.sql,
			'subject-almacen',
			false,
			null,
		).catch((e) => e);
		expect(err.code).toBe('subject_has_dependents');
		expect(state(db, 'subject-almacen')).toBe('on:installed');
		hold.open();
		await settled(db);
		expect(state(db, 'subject-ventas')).toBe('on:installed');
	});

	test('dos instalaciones a la vez comparten la dependencia: se instala una sola vez', async () => {
		const db = fake_sql([]);
		const store = fake_store();
		const hold = gate();
		db.on_write(async ({ technical_id, status }) => {
			if (technical_id === 'subject-almacen' && status === 'installed') await hold.promise;
		});
		const [ventas, pos] = await Promise.all([
			accept_subject_lifecycle(store, db.sql, 'subject-ventas', true, null),
			accept_subject_lifecycle(store, db.sql, 'subject-pos', true, null),
		]);
		expect(ventas!.dependencies.map((d) => d.slug)).toEqual(['almacen']);
		expect(pos!.dependencies.map((d) => d.slug)).toEqual(['almacen', 'rh']);
		hold.open();
		await settled(db);
		const almacen_begins = db.writes.filter(
			(w) => w.technical_id === 'subject-almacen' && w.status === 'installing',
		);
		expect(almacen_begins).toHaveLength(1);
		expect(state(db, 'subject-ventas')).toBe('on:installed');
		expect(state(db, 'subject-pos')).toBe('on:installed');
	});

	test('instalar con la dependencia desinstalándose: 409 dependency_busy', async () => {
		const db = fake_sql([['subject-almacen', true]]);
		const store = fake_store();
		const hold = gate();
		db.on_write(async ({ technical_id, status }) => {
			if (technical_id === 'subject-almacen' && status === 'uninstalled') await hold.promise;
		});
		await accept_subject_lifecycle(store, db.sql, 'subject-almacen', false, null);
		const err = await accept_subject_lifecycle(
			store,
			db.sql,
			'subject-ventas',
			true,
			null,
		).catch((e) => e);
		expect(err.code).toBe('dependency_busy');
		expect(err.status).toBe(409);
		expect(db.rows.has('subject-ventas')).toBe(false);
		hold.open();
		await settled(db);
		expect(state(db, 'subject-almacen')).toBe('off:uninstalled');
	});

	test('actualizar instala antes la dependencia que falte', async () => {
		const db = fake_sql([
			['subject-almacen', true],
			['subject-pos', true, IMAGE_OLD],
		]);
		const hold = gate();
		db.on_write(async ({ technical_id, status }) => {
			if (technical_id === 'subject-rh' && status === 'installed') await hold.promise;
		});
		const res = (await accept_subject_update(fake_store(), db.sql, 'subject-pos', null))!;
		expect(res.dependencies.map((d) => d.slug)).toEqual(['rh']);
		// Mientras RH se instala, POS ya se ve ocupada: el front no la da por actualizada.
		const pos = res.rows.find((r) => r.technical_id === 'subject-pos')!;
		expect(pos.status).toBe('updating');
		expect(pos.busy).toBe(true);
		expect(pos.installed).toBe(true);
		hold.open();
		expect(await res.done).toBeNull();
		await settled(db);
		expect(state(db, 'subject-rh')).toBe('on:installed');
		expect(state(db, 'subject-pos')).toBe('on:installed');
	});

	test('si la dependencia de una actualización falla, la app sigue instalada', async () => {
		const db = fake_sql([
			['subject-almacen', true],
			['subject-pos', true, IMAGE_OLD],
		]);
		db.on_write(({ technical_id, status }) => {
			if (technical_id === 'subject-rh' && status === 'installed') throw new Error('sin red');
		});
		const res = (await accept_subject_update(fake_store(), db.sql, 'subject-pos', null))!;
		expect(await res.done).toBe('falló su dependencia Recursos Humanos');
		await settled(db);
		expect(state(db, 'subject-rh')).toBe('off:error');
		expect(state(db, 'subject-pos')).toBe('on:installed');
		expect(db.rows.get('subject-pos')?.installed_image).toBe(IMAGE_OLD);
		expect(
			db.writes.filter((w) => w.technical_id === 'subject-pos').map((w) => w.status),
		).toEqual(['updating', 'installed']);
	});

	test('un fallo que no es de Docker al actualizar no deja la app colgada en updating', async () => {
		const db = fake_sql([
			['subject-almacen', true],
			['subject-rh', true],
			['subject-pos', true, IMAGE_OLD],
		]);
		let failed = false;
		db.on_write(({ technical_id, status }) => {
			if (technical_id === 'subject-pos' && status === 'installed' && !failed) {
				failed = true;
				throw new Error('se cayó la base');
			}
		});
		const res = (await accept_subject_update(fake_store(), db.sql, 'subject-pos', null))!;
		expect(await res.done).toBe('se cayó la base');
		await settled(db);
		expect(state(db, 'subject-pos')).toBe('on:installed');
		expect(db.rows.get('subject-pos')?.installed_image).toBe(IMAGE_OLD);
	});

	test('una espera que no puede releer el estado no escribe la fila de la dependencia', async () => {
		const db = fake_sql([]);
		const store = fake_store();
		const hold = gate();
		db.on_write(async ({ technical_id, status }) => {
			if (technical_id === 'subject-almacen' && status === 'installed') await hold.promise;
		});
		await accept_subject_lifecycle(store, db.sql, 'subject-ventas', true, null);
		await accept_subject_lifecycle(store, db.sql, 'subject-pos', true, null);
		// La siguiente lectura es la de POS al despertar de su espera por Almacén.
		db.on_select(() => {
			db.on_select(null);
			throw new Error('sin conexión');
		});
		hold.open();
		await settled(db);
		expect(state(db, 'subject-almacen')).toBe('on:installed');
		expect(state(db, 'subject-ventas')).toBe('on:installed');
		expect(state(db, 'subject-pos')).toBe('off:error');
		expect(state(db, 'subject-rh')).toBe('off:error');
		expect(
			db.writes.filter((w) => w.technical_id === 'subject-almacen').map((w) => w.status),
		).toEqual(['installing', 'installed']);
	});

	test('el listado no pisa una fila que se asienta mientras la lee', async () => {
		const db = fake_sql([]);
		const store = fake_store();
		const hold = gate();
		db.on_write(async ({ technical_id, status }) => {
			if (technical_id === 'subject-almacen' && status === 'installed') await hold.promise;
		});
		await accept_subject_lifecycle(store, db.sql, 'subject-almacen', true, null);
		// 1.ª lectura: la siembra. 2.ª: la del listado, que ve `installing` y
		// llega cuando el trabajo ya escribió `installed` y salió de `in_flight`.
		db.on_select(async (call) => {
			if (call !== 2) return;
			db.on_select(null);
			hold.open();
			await settled(db);
		});
		const rows = await list_catalog_subjects(store, db.sql);
		expect(state(db, 'subject-almacen')).toBe('on:installed');
		// La fila vieja sale ocupada, no como huérfana: el front la tomaba por
		// fallida ("No se pudo completar") antes de verla instalada.
		const row = rows.find((r) => r.technical_id === 'subject-almacen')!;
		expect([row.status, row.busy]).toEqual(['installing', true]);
		expect(
			db.writes.filter((w) => w.technical_id === 'subject-almacen').map((w) => w.status),
		).toEqual(['installing', 'installed']);
	});

	test('la auto-actualización salta una app ocupada', async () => {
		const db = fake_sql([
			['subject-almacen', true],
			['subject-rh', true],
			['subject-pos', true, IMAGE_OLD],
		]);
		const store = fake_store(true);
		const hold = gate();
		db.on_write(async ({ technical_id, status }) => {
			if (technical_id === 'subject-pos' && status === 'installed') await hold.promise;
		});
		const manual = (await accept_subject_update(store, db.sql, 'subject-pos', null))!;
		const pass = await run_subject_auto_update_pass(store, db.sql);
		expect(pass.skipped).toEqual(['pos']);
		expect(pass.updated).toEqual([]);
		hold.open();
		expect(await manual.done).toBeNull();
		await settled(db);
	});

	test('la auto-actualización salta una app cuya dependencia se está desinstalando', async () => {
		// Catálogo nuevo: POS ya pide RH, que alguien desinstala (antes nadie la usaba).
		const db = fake_sql([
			['subject-almacen', true],
			['subject-rh', true],
			['subject-pos', true, IMAGE_OLD],
		]);
		const store = fake_store(true);
		const pos = store.subjects.find((s) => s.slug === 'pos')!;
		pos.depends_on = ['subject-almacen'];
		const hold = gate();
		db.on_write(async ({ technical_id, status }) => {
			if (technical_id === 'subject-rh' && status === 'uninstalled') await hold.promise;
		});
		await accept_subject_lifecycle(store, db.sql, 'subject-rh', false, null);
		pos.depends_on = ['subject-almacen', 'subject-rh'];
		const pass = await run_subject_auto_update_pass(store, db.sql);
		expect(pass.skipped).toEqual(['pos']);
		expect(pass.failed).toEqual([]);
		hold.open();
		await settled(db);
		expect(state(db, 'subject-pos')).toBe('on:installed');
	});
});
