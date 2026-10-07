import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { handle_action } from './actions.ts';
import { build_access } from './auth.ts';
import type { ImperiumDoc } from './envelope.ts';
import { ImperiumStore, load_catalog_path } from './store.ts';
import { SubjectNotInstalledError } from './subjects-admin.ts';

const BASE = ['subject-configuracion', 'subject-configuraciones-de-vista', 'subject-planeacion'];

function catalog_store(): ImperiumStore {
	return new ImperiumStore(null as unknown as Bun.SQL, load_catalog_path());
}

/** Store del catálogo real con estas apps instaladas (además de las base). */
function store_with(...slugs: string[]): ImperiumStore {
	const store = catalog_store();
	store.set_installed_subjects([...BASE, ...slugs.map((slug) => `subject-${slug}`)]);
	return store;
}

function missing_relation(table: string) {
	return Object.assign(new Error(`relation "${table}" does not exist`), {
		code: 'ERR_POSTGRES_SERVER_ERROR',
		errno: '42P01',
	});
}

type FindMany = ImperiumStore['find_many'];

function stub_find_many(
	store: ImperiumStore,
	impl: (resource: string, opts: Parameters<FindMany>[1]) => Promise<unknown>,
) {
	(store as unknown as { find_many: unknown }).find_many = impl;
}

describe('is_resource_installed', () => {
	test('sin caché cargado todo cuenta como instalado', () => {
		const store = catalog_store();
		expect(store.is_resource_installed('employee')).toBe(true);
		expect(store.is_resource_installed('cfdi-document')).toBe(true);
		store.mark_subject_installed('subject-rh', false);
		expect(store.is_resource_installed('employee')).toBe(true);
	});

	test('las apps base y los recursos huérfanos siempre están instalados', () => {
		const store = catalog_store();
		store.set_installed_subjects([]);
		expect(store.is_resource_installed('user')).toBe(true);
		expect(store.is_resource_installed('usuario')).toBe(true);
		expect(store.is_resource_installed('cobranza-payment')).toBe(true);
		expect(store.is_resource_installed('view-config-preset')).toBe(true);
		expect(store.is_resource_installed('recurso-que-no-existe')).toBe(true);
	});

	test('un recurso de una app no instalada no lo está', () => {
		const store = store_with('almacen');
		expect(store.is_resource_installed('employee')).toBe(false);
		expect(store.is_resource_installed('cfdi-document')).toBe(false);
		expect(store.is_resource_installed('inventory-reception')).toBe(true);
	});

	test('el dueño de un recurso compartido lo decide PREFER_OWNER', () => {
		const ventas = store_with('ventas');
		expect(ventas.is_resource_installed('pedidos')).toBe(true);
		expect(ventas.is_resource_installed('products')).toBe(false);
		expect(ventas.is_resource_installed('pedidos-surtir')).toBe(false);
		const almacen = store_with('almacen');
		expect(almacen.is_resource_installed('products')).toBe(true);
		expect(almacen.is_resource_installed('pedidos-surtir')).toBe(true);
		expect(almacen.is_resource_installed('pedidos')).toBe(false);
	});

	test('instalar y desinstalar se reflejan sin releer la base', () => {
		const store = store_with();
		expect(store.is_resource_installed('employee')).toBe(false);
		store.mark_subject_installed('subject-rh', true);
		expect(store.is_resource_installed('employee')).toBe(true);
		store.mark_subject_installed('subject-rh', false);
		expect(store.is_resource_installed('employee')).toBe(false);
	});

	test('por modelo: los que no son recursos del catálogo cuentan como instalados', () => {
		const store = store_with('almacen');
		expect(store.is_model_installed('Employee')).toBe(false);
		expect(store.is_model_installed('Products')).toBe(true);
		expect(store.is_model_installed('Auth')).toBe(true);
		expect(store.is_model_installed('User')).toBe(true);
	});

	test('assert_resource_installed lanza el 404 con la pista de instalar', async () => {
		const store = store_with('ventas');
		await store.assert_resource_installed('pedidos');
		const err = await store.assert_resource_installed('cfdi-document').catch((e) => e);
		expect(err).toBeInstanceOf(SubjectNotInstalledError);
		expect(err.status).toBe(404);
		expect(err.code).toBe('subject_not_installed');
		expect(err.details).toMatchObject({
			slug: 'facturacion-electronica',
			technical_id: 'subject-facturacion-electronica',
			resource: 'cfdi-document',
		});
		expect(err.message).toContain('no está instalada');
	});
});

describe('build_access: models por instalación', () => {
	test('admin: solo modelos de apps instaladas', async () => {
		const store = store_with('almacen');
		const access = await build_access(store, { _id: 'a', _ref: 'user-menu-management-0' });
		expect(access.models).toContain('Products');
		expect(access.models).toContain('PedidosSurtir');
		expect(access.models).toContain('User');
		expect(access.models).toContain('Auth');
		expect(access.models).toContain('McpAgent');
		expect(access.models).not.toContain('Employee');
		expect(access.models).not.toContain('Pedidos');
		expect(access.models).not.toContain('CfdiDocument');
	});

	test('admin sin caché cargado: el catálogo entero, como antes', async () => {
		const access = await build_access(catalog_store(), {
			_id: 'a',
			_ref: 'user-menu-management-0',
		});
		expect(access.models).toContain('Employee');
		expect(access.models).toContain('Pedidos');
	});

	test('usuario: los permisos se conservan, models filtra', async () => {
		const store = store_with('ventas');
		const rights: ImperiumDoc[] = ['Pedidos', 'Employee', 'UserPrintTemplate', 'Dashboard'].map(
			(model_id, i) => ({
				_id: `r${i}`,
				model_id,
				allow_read: true,
				allow_create: true,
			}),
		);
		(store as unknown as { scan: unknown }).scan = async function* (resource: string) {
			yield resource === 'access-rights' ? rights : [];
		};
		const access = await build_access(store, { _id: 'u1', _ref: 'user-cualquiera' });
		expect([...access.models].sort()).toEqual(['Dashboard', 'Pedidos', 'UserPrintTemplate']);
		expect(access.permissions_by_model.Employee?.allow_read).toBe(true);
	});
});

describe('populate_docs', () => {
	const pedido = {
		_id: 'p1',
		name: 'Pedido 1',
		contacto: 'c1',
		assigned_employee: 'e1',
	};

	test('un destino sin tabla deja sus ids y puebla el resto', async () => {
		const store = catalog_store();
		const asked: string[] = [];
		stub_find_many(store, async (resource) => {
			asked.push(resource);
			if (resource === 'employee') throw missing_relation('subject_rh.employee');
			return { rows: [{ _id: 'c1', name: 'Cliente Uno' }], total: 1 };
		});
		const [out] = await store.populate_docs('pedidos', [pedido]);
		expect(asked).toContain('employee');
		expect(out!.assigned_employee).toBe('e1');
		expect(out!.contacto).toMatchObject({ _id: 'c1', name: 'Cliente Uno' });
	});

	test('cualquier otro error se relanza', async () => {
		const store = catalog_store();
		stub_find_many(store, async (resource) => {
			if (resource === 'employee') throw new Error('se cayó la conexión');
			return { rows: [], total: 0 };
		});
		const err = await store.populate_docs('pedidos', [pedido]).catch((e) => e);
		expect(err?.message).toBe('se cayó la conexión');
	});

	test('no filtra por instalación: una app desinstalada conserva sus nombres', async () => {
		const store = store_with('ventas');
		stub_find_many(store, async (resource) => ({
			rows:
				resource === 'employee'
					? [{ _id: 'e1', name: 'Ana' }]
					: [{ _id: 'c1', name: 'Cliente Uno' }],
			total: 1,
		}));
		const [out] = await store.populate_docs('pedidos', [pedido]);
		expect(out!.assigned_employee).toMatchObject({ _id: 'e1', name: 'Ana' });
	});
});

describe('ensure_defaults', () => {
	const ORIGINAL_REINDEX = process.env.AUTO_REINDEX_SEARCH_ON_STARTUP;
	beforeAll(() => {
		process.env.AUTO_REINDEX_SEARCH_ON_STARTUP = 'false';
	});
	afterAll(() => {
		if (ORIGINAL_REINDEX == null) delete process.env.AUTO_REINDEX_SEARCH_ON_STARTUP;
		else process.env.AUTO_REINDEX_SEARCH_ON_STARTUP = ORIGINAL_REINDEX;
	});

	/** Solo la parte de siembra: el DDL y los catálogos van en blanco. */
	function seeding_store(employee: () => Promise<unknown>, installed?: string[]) {
		const store = installed ? store_with(...installed) : catalog_store();
		const inserts: Array<{ resource: string; doc: ImperiumDoc }> = [];
		const asked: string[] = [];
		const noop = async () => {};
		const has = store.has.bind(store);
		Object.assign(store, {
			// Las semillas de configuración recorren backend/src: segundos por test.
			has: (resource: string) => resource !== 'configuration' && has(resource),
			ensure_orphan_tables: noop,
			ensure_catalog_columns: noop,
			ensure_postgres_table_tracker_table: async () => {
				throw new Error('sin base');
			},
			ensure_object_json_cells: noop,
			ensure_search_indexes: noop,
			ensure_unique_indexes: noop,
			seed_font_awesome_catalog: noop,
			scan: async function* () {
				throw new Error('sin base');
			},
			find_where: async () => null,
			insert: async (resource: string, doc: ImperiumDoc) => {
				inserts.push({ resource, doc });
				return { _id: `${resource}-1`, ...doc };
			},
		});
		stub_find_many(store, async (resource) => {
			asked.push(resource);
			if (resource === 'employee') return employee();
			return { rows: [], total: 1 };
		});
		return { store, inserts, asked };
	}

	const print_right = (inserts: Array<{ resource: string; doc: ImperiumDoc }>) =>
		inserts.some(
			(i) =>
				i.resource === 'access-rights' &&
				i.doc._ref === 'user-print-template-access-rights-0',
		);

	test('sin RH instalada ni se intenta y el resto corre', async () => {
		const { store, inserts, asked } = seeding_store(async () => {
			throw new Error('no debió consultarse');
		}, ['almacen']);
		await store.ensure_defaults();
		expect(asked).not.toContain('employee');
		expect(print_right(inserts)).toBe(true);
	});

	test('tabla de RH inexistente: se salta y el resto corre', async () => {
		const { store, inserts, asked } = seeding_store(async () => {
			throw missing_relation('subject_rh.employee');
		});
		await store.ensure_defaults();
		expect(asked).toContain('employee');
		expect(inserts.some((i) => i.resource === 'employee')).toBe(false);
		expect(print_right(inserts)).toBe(true);
	});

	test('otro fallo al sembrar el empleado tampoco aborta', async () => {
		const warn = console.warn;
		console.warn = () => {};
		try {
			const { store, inserts } = seeding_store(async () => {
				throw new Error('se cayó la conexión');
			});
			await store.ensure_defaults();
			expect(print_right(inserts)).toBe(true);
		} finally {
			console.warn = warn;
		}
	});

	test('con RH instalada y sin empleados, se siembra', async () => {
		const { store, inserts } = seeding_store(async () => ({ rows: [], total: 0 }), ['rh']);
		await store.ensure_defaults();
		expect(inserts.some((i) => i.resource === 'employee' && i.doc._ref === 'employee-admin-0')).toBe(
			true,
		);
	});
});

describe('flujos entre apps', () => {
	/** Registra cada lectura/escritura: un flujo cortado no debe tocar nada. */
	function recording_store(...slugs: string[]) {
		const store = store_with(...slugs);
		const calls: string[] = [];
		const record =
			(op: string, result: unknown = null) =>
			async (resource: string) => {
				calls.push(`${op}:${resource}`);
				return typeof result === 'function' ? (result as (r: string) => unknown)(resource) : result;
			};
		Object.assign(store, {
			find_id: record('find_id'),
			find_where: record('find_where'),
			insert: record('insert', { _id: 'nuevo' }),
			update: record('update'),
			scan: async function* (resource: string) {
				calls.push(`scan:${resource}`);
				yield [];
			},
		});
		return { store, calls };
	}

	test('borrador CFDI sin facturación: 404 antes de leer o escribir', async () => {
		const { create_cfdi_from_invoice_request } = await import('./cfdi-from-invoice.ts');
		const { store, calls } = recording_store('ventas', 'almacen');
		const err = await create_cfdi_from_invoice_request({
			store,
			params: { id: 'ir1' },
			body: {},
		}).catch((e) => e);
		expect(err).toBeInstanceOf(SubjectNotInstalledError);
		expect(err.details.slug).toBe('facturacion-electronica');
		expect(calls).toEqual([]);
	});

	test('OC con UUID sin facturación: se guarda sin vínculo', async () => {
		const { create_cfdi_from_purchase_order, sync_inbound_supplier_invoice } = await import(
			'./cfdi-from-purchase.ts'
		);
		const { store, calls } = recording_store('ventas', 'almacen');
		const po = { _id: 'po1', name: 'OC-1', uuid_xml: 'abc-123' };
		expect(await sync_inbound_supplier_invoice(store, po)).toBeNull();
		const err = await create_cfdi_from_purchase_order({
			store,
			params: { id: 'po1' },
			body: { uuid: 'abc-123' },
		}).catch((e) => e);
		expect(err).toBeInstanceOf(SubjectNotInstalledError);
		expect(calls).toEqual([]);
	});

	test('cobro en caja sin POS: 404 antes de registrar el pago', async () => {
		const { apply_cobranza_payment } = await import('./cobranza-payment-flow.ts');
		const { store, calls } = recording_store('control-municipal');
		(store as unknown as { find_id: unknown }).find_id = async (resource: string) => {
			calls.push(`find_id:${resource}`);
			return resource === 'cobranza' ? { _id: 'c1', balance: 100, reference: 'AG-1' } : null;
		};
		const err = await apply_cobranza_payment({
			store,
			actor: { _id: 'u1' },
			params: {},
			body: { charge_id: 'c1', method_id: 'm1', pos_session_id: 's1', amount: 10 },
		}).catch((e) => e);
		expect(err).toBeInstanceOf(SubjectNotInstalledError);
		expect(err.details.slug).toBe('pos');
		expect(calls).toEqual(['find_id:cobranza']);
	});

	test('cobro municipal sin POS registra el pago sin sesión de caja', async () => {
		const { apply_cobranza_payment } = await import('./cobranza-payment-flow.ts');
		const { store } = recording_store('control-municipal');
		const inserted: ImperiumDoc[] = [];
		(store as unknown as { find_id: unknown }).find_id = async (resource: string) =>
			resource === 'cobranza'
				? { _id: 'c1', balance: 100, total_amount: 100, reference: 'AG-1' }
				: null;
		(store as unknown as { insert: unknown }).insert = async (
			resource: string,
			doc: ImperiumDoc,
		) => {
			inserted.push({ resource, ...doc });
			return { _id: 'p1', ...doc };
		};
		(store as unknown as { next_auto_increment: unknown }).next_auto_increment = async () => 7;
		const res = await apply_cobranza_payment({
			store,
			actor: { _id: 'u1' },
			params: {},
			body: { charge_id: 'c1', method_id: 'm1', amount: 10 },
		});
		expect(res.message).toContain('Pago aplicado');
		expect(inserted).toHaveLength(1);
		expect(inserted[0]).toMatchObject({
			resource: 'cobranza-payment',
			amount: 10,
			method_id: 'm1',
			folio: 7,
		});
		expect(inserted[0]).not.toHaveProperty('pos_session_id');
		expect(store.is_resource_installed('pos-session')).toBe(false);
	});

	test('con POS instalado el efectivo sigue exigiendo caja abierta', async () => {
		const { apply_cobranza_payment } = await import('./cobranza-payment-flow.ts');
		const { store } = recording_store('control-municipal', 'pos');
		(store as unknown as { find_id: unknown }).find_id = async (resource: string) =>
			resource === 'cobranza'
				? { _id: 'c1', balance: 100, total_amount: 100, reference: 'AG-1' }
				: null;
		const err = await apply_cobranza_payment({
			store,
			actor: { _id: 'u1' },
			params: {},
			body: { charge_id: 'c1', method_id: 'm1', amount: 10 },
		}).catch((e) => e);
		expect(err).toBeInstanceOf(Error);
		expect(err.message).toBe('Se requiere una sesión de caja abierta.');
		expect(store.is_resource_installed('pos-session')).toBe(true);
	});

	test('estadísticas de costos: sin Ventas no se recorren pedidos', async () => {
		const { cost_entry_stats } = await import('./inventory-logistics-flow.ts');
		const solo = recording_store('almacen');
		const stats = await cost_entry_stats(solo.store);
		expect(solo.calls).toEqual(['scan:inventory-cost-entry']);
		expect(stats.estimated_fifo).toMatchObject({ sales_total: 0, sales_quantity: 0 });
		const con_ventas = recording_store('almacen', 'ventas');
		await cost_entry_stats(con_ventas.store);
		expect(con_ventas.calls).toEqual(['scan:inventory-cost-entry', 'scan:pedidos']);
	});

	test('un widget de una app no instalada se rechaza', async () => {
		const { resolve_widget_data } = await import('./dashboard-flow.ts');
		const { store, calls } = recording_store('almacen');
		const err = await resolve_widget_data(store, null, {
			spec: { widget_type: 'kpi', model_id: 'Employee' },
		}).catch((e) => e);
		expect(err?.message).toBe("El módulo del modelo 'Employee' no está instalado.");
		expect(calls).toEqual([]);
	});

	test('un widget guardado se lee con la especificación del tablero, no con la del cliente', async () => {
		const { resolve_saved_widget_data } = await import('./dashboard-flow.ts');
		const { store } = recording_store('almacen');
		(store as unknown as { find_id: unknown }).find_id = async (resource: string, id: string) =>
			resource === 'dynamic-dashboard' && id === 'd1'
				? { _id: 'd1', widgets: [{ widget_type: 'kpi', model_id: 'Employee' }] }
				: null;
		const admin = { _id: 'a', _ref: 'user-menu-management-0' };
		const leer = (id: string, query: string) =>
			resolve_saved_widget_data(store, admin, id, new URLSearchParams(query));
		expect(await leer('d1', 'widget=1')).toBeNull();
		expect(await leer('d1', '')).toBeNull();
		expect(await leer('d2', 'widget=0')).toBeNull();
		const err = await leer('d1', 'widget=0&model_id=Product').catch((e) => e);
		expect(err?.message).toBe("El módulo del modelo 'Employee' no está instalado.");
	});

	describe('catálogo de tableros', () => {
		const ADMIN = { _id: 'a', _ref: 'user-menu-management-0' };

		/** `module_rows`: filas habilitadas de module-management (vacío = recorre todo el catálogo). */
		function catalog_store(module_rows: ImperiumDoc[]) {
			const { store, calls } = recording_store('almacen');
			Object.assign(store, {
				scan: async function* (resource: string) {
					calls.push(`scan:${resource}`);
					yield resource === 'module-management' ? module_rows : [];
				},
			});
			stub_find_many(store, async (resource) => {
				calls.push(`find_many:${resource}`);
				return { rows: [], total: 0 };
			});
			return { store, calls };
		}

		test('no ofrece ni muestrea modelos de apps no instaladas', async () => {
			const { resolve_dashboard_catalog } = await import('./dashboard-flow.ts');
			const { store, calls } = catalog_store([
				{ _id: 'm1', model_id: 'Employee', is_enable: true },
				{ _id: 'm2', model_id: 'Products', is_enable: true },
			]);
			const res = await resolve_dashboard_catalog(store, ADMIN);
			expect(res.data.map((e) => e.model_id)).toEqual(['Products']);
			expect(calls).not.toContain('find_many:employee');
		});

		test('sin módulos habilitados recorre el catálogo, solo lo instalado', async () => {
			const { resolve_dashboard_catalog } = await import('./dashboard-flow.ts');
			const { store, calls } = catalog_store([]);
			const res = await resolve_dashboard_catalog(store, ADMIN);
			const models = res.data.map((e) => e.model_id);
			expect(models).toContain('Products');
			expect(models).not.toContain('Employee');
			expect(models).not.toContain('CfdiDocument');
			expect(calls).not.toContain('find_many:employee');
			expect(calls).not.toContain('find_many:cfdi-document');
		});
	});
});

describe('reportes genéricos', () => {
	const admin: ImperiumDoc = { _id: 'a', _ref: 'user-menu-management-0' };

	function reports_store(...slugs: string[]) {
		const store = store_with(...slugs);
		const calls: string[] = [];
		(store as unknown as { find_where: unknown }).find_where = async () => null;
		stub_find_many(store, async (resource) => {
			calls.push(resource);
			return { rows: [], total: 0 };
		});
		return { store, calls };
	}

	const model_records = (store: ImperiumStore, model: string) => {
		const url = new URL(`http://core/api/reports/model-records/${model}`);
		return handle_action(
			store,
			null as unknown as Bun.SQL,
			new Request(url),
			url,
			'reports',
			'get_model_records',
			{ model_identifier: model },
			admin,
		);
	};

	test('registros de un modelo sin su app: 404 con la pista de instalar, sin tocar su tabla', async () => {
		const { store, calls } = reports_store('almacen');
		const err = await model_records(store, 'Employee').catch((e) => e);
		expect(err).toBeInstanceOf(SubjectNotInstalledError);
		expect(err.status).toBe(404);
		expect(err.details).toMatchObject({
			slug: 'rh',
			technical_id: 'subject-rh',
			resource: 'employee',
		});
		expect(calls).toEqual([]);
	});

	test('con la app instalada se listan como siempre', async () => {
		const { store, calls } = reports_store('almacen', 'rh');
		const res = await model_records(store, 'Employee');
		expect(res.status).toBe(200);
		expect(calls).toEqual(['employee']);
	});
});

describe('tablas del catálogo que la app no llegó a crear', () => {
	const BASE_IDS = [
		'subject-configuracion',
		'subject-configuraciones-de-vista',
		'subject-planeacion',
		'subject-reportes',
	];

	function sql_recording(present: Array<{ schema: string; table: string }>) {
		const statements: string[] = [];
		const sql = {
			unsafe: async (query: string) => {
				statements.push(query);
				if (query.includes('pg_class')) return present;
				return [];
			},
		};
		return { sql, statements };
	}

	function creates(statements: string[], table: string) {
		return statements.some(
			(query) =>
				query.includes('CREATE TABLE') && query.includes(`"${table}"`),
		);
	}

	test('con Almacén instalada crea subject_almacen.inventory_lot si falta', async () => {
		const { sql, statements } = sql_recording([]);
		const store = new ImperiumStore(sql as unknown as Bun.SQL, load_catalog_path());
		store.set_installed_subjects([...BASE_IDS, 'subject-almacen']);
		await store.ensure_missing_catalog_tables();
		expect(creates(statements, 'inventory_lot')).toBe(true);
		expect(
			statements.some((query) =>
				query.includes('CREATE SCHEMA IF NOT EXISTS "subject_almacen"'),
			),
		).toBe(true);
	});

	test('no vuelve a crear la tabla si ya está', async () => {
		const { sql, statements } = sql_recording([
			{ schema: 'subject_almacen', table: 'inventory_lot' },
		]);
		const store = new ImperiumStore(sql as unknown as Bun.SQL, load_catalog_path());
		store.set_installed_subjects([...BASE_IDS, 'subject-almacen']);
		await store.ensure_missing_catalog_tables();
		expect(creates(statements, 'inventory_lot')).toBe(false);
	});

	test('sin Almacén instalada no crea inventory_lot', async () => {
		const { sql, statements } = sql_recording([]);
		const store = new ImperiumStore(sql as unknown as Bun.SQL, load_catalog_path());
		store.set_installed_subjects(BASE_IDS);
		await store.ensure_missing_catalog_tables();
		expect(creates(statements, 'inventory_lot')).toBe(false);
	});
});

describe('cableado', () => {
	test('el arranque carga el caché antes de ensure_defaults', () => {
		const src = readFileSync(new URL('./router.ts', import.meta.url), 'utf8');
		const boot = src.slice(src.indexOf('const boot = () =>'));
		const load = boot.indexOf('await load_installed_subjects()');
		expect(load).toBeGreaterThan(0);
		expect(load).toBeLessThan(boot.indexOf('store.ensure_defaults()'));
	});

	test('cada escritura final de installed actualiza el caché', () => {
		const src = readFileSync(new URL('./subjects-admin.ts', import.meta.url), 'utf8');
		const section = (from: string, to: string) =>
			src.slice(src.indexOf(from), src.indexOf(to, src.indexOf(from)));
		expect(
			section('async function begin_subject_lifecycle', 'async function finish_subject_lifecycle'),
		).toContain('mark_subject_installed(technical_id, false)');
		expect(
			section('async function finish_subject_lifecycle', 'export async function set_subject_installed'),
		).toContain('mark_subject_installed(technical_id, installed)');
		expect(
			section('export async function run_subject_update', 'export async function accept_subject_update_all'),
		).toContain('mark_subject_installed(technical_id, true)');
	});
});
