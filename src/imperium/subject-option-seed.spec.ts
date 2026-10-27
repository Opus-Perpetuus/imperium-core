import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { SUBJECT_CALLER_HEADER } from '@opus-perpetuus/imperium-core-kit';
import type { ImperiumDoc } from './envelope.ts';
import {
	derive_subject_secret,
	is_subject_request,
	master_secret,
} from './subject-secret.ts';
import {
	authorize_subject_option_seed,
	type SubjectOptionSeedDeps,
} from './subject-option-seed.ts';
import { seed_status_defaults } from './status-options.ts';
import type { ImperiumStore } from './store.ts';

const TIENDA = 'subject-tienda';
const secret_of = (tid: string) => `derivado-de-${tid}`;

const deps: SubjectOptionSeedDeps = {
	master_configured: () => true,
	catalog_tids: new Set([TIENDA, 'subject-pos']),
	is_subject_request: (req, tid) =>
		req.headers.get('x-core-subject-gateway-secret') === secret_of(tid),
	installed: async (tid) => tid !== 'subject-pos',
};

function seed_request(
	caller: string | null,
	secret: string,
	body: unknown,
	extra: Record<string, string> = {},
): Request {
	const headers: Record<string, string> = {
		'content-type': 'application/json',
		'x-core-subject-gateway-secret': secret,
		...extra,
	};
	if (caller !== null) headers[SUBJECT_CALLER_HEADER] = caller;
	return new Request('http://core/api/status-option-control/seed-defaults', {
		method: 'POST',
		headers,
		body: typeof body === 'string' ? body : JSON.stringify(body),
	});
}

const orders_entry = {
	model_id: 'subject-tienda/orders',
	module_name: 'subject-tienda/orders',
	status_fields: ['status'],
	options: [{ value: 'pagado', label: 'Pagado', field_name: 'status' }],
};

async function gate(
	req: Request,
	resource = 'status-option-control',
	action: string | undefined = 'seed_defaults',
	over: Partial<SubjectOptionSeedDeps> = {},
) {
	return authorize_subject_option_seed(req, resource, action, { ...deps, ...over });
}

async function refused(result: Awaited<ReturnType<typeof gate>>) {
	expect(result).toBeInstanceOf(Response);
	return (await (result as Response).json()) as Record<string, unknown>;
}

describe('authorize_subject_option_seed', () => {
	test('sin remitente sigue siendo sesión humana, aunque viaje el secreto', async () => {
		expect(await gate(seed_request(null, secret_of(TIENDA), { entries: [orders_entry] }))).toBeNull();
		expect(await gate(seed_request('  ', secret_of(TIENDA), { entries: [orders_entry] }))).toBeNull();
	});

	test('otra acción con remitente no abre este candado', async () => {
		expect(
			await gate(seed_request(TIENDA, secret_of(TIENDA), {}), 'status-option-control', 'read_list'),
		).toBeNull();
		expect(
			await gate(seed_request(TIENDA, secret_of(TIENDA), {}), 'pedidos', 'seed_defaults'),
		).toBeNull();
	});

	test('sin maestro → 503 gateway_secret_missing', async () => {
		const result = await gate(seed_request(TIENDA, secret_of(TIENDA), { entries: [orders_entry] }), undefined, undefined, {
			master_configured: () => false,
		});
		expect(result).toBeInstanceOf(Response);
		expect((result as Response).status).toBe(503);
		expect((await refused(result)).code).toBe('gateway_secret_missing');
	});

	test('sin secreto, secreto ajeno o tid fuera del catálogo → 403 forbidden', async () => {
		for (const req of [
			seed_request(TIENDA, '', { entries: [orders_entry] }),
			seed_request(TIENDA, secret_of('subject-pos'), { entries: [orders_entry] }),
			seed_request('subject-inventada', secret_of('subject-inventada'), { entries: [orders_entry] }),
		]) {
			const result = await gate(req);
			expect((result as Response).status).toBe(403);
			expect((await refused(result)).code).toBe('forbidden');
		}
	});

	test('remitente sin instalar → 403 caller_not_installed', async () => {
		const result = await gate(
			seed_request('subject-pos', secret_of('subject-pos'), {
				entries: [{ model_id: 'subject-pos/tickets', module_name: 'subject-pos/tickets' }],
			}),
		);
		expect((result as Response).status).toBe(403);
		expect((await refused(result)).code).toBe('caller_not_installed');
	});

	test('prefijo propio en estatus y en listas generales', async () => {
		const status = await gate(seed_request(TIENDA, secret_of(TIENDA), { entries: [orders_entry] }));
		expect(status).toEqual({ ok: true, caller: TIENDA });
		const loose = await gate(
			seed_request(TIENDA, secret_of(TIENDA), {
				model_id: 'subject-tienda/orders',
				options: orders_entry.options,
			}),
		);
		expect(loose).toEqual({ ok: true, caller: TIENDA });
		const lists = await gate(
			seed_request(TIENDA, secret_of(TIENDA), {
				entries: [{ module_name: TIENDA, lists: [] }],
			}),
			'general-option-list-control',
		);
		expect(lists).toEqual({ ok: true, caller: TIENDA });
		const named = await gate(
			seed_request(TIENDA, secret_of(TIENDA), {
				entries: [{ model_id: 'subject-tienda/order_returns', module_name: TIENDA }],
			}),
		);
		expect(named).toEqual({ ok: true, caller: TIENDA });
	});

	test('model_id ajeno, prefijo pegado o module_name corto → 403 y no siembra parcial', async () => {
		for (const entries of [
			[orders_entry, { model_id: 'subject-other/orders', module_name: 'subject-other/orders' }],
			[{ model_id: 'subject-tienda-evil/orders', module_name: 'subject-tienda-evil/orders' }],
			[{ model_id: 'Pedidos', module_name: 'pedidos' }],
			[{ model_id: 'subject-tienda/orders', module_name: 'orders' }],
			[{ module_id: '507f1f77bcf86cd799439011', model_id: 'subject-tienda/orders' }],
			[{}],
			[{ module_id: 'subject-tienda/orders' }],
		]) {
			const result = await gate(seed_request(TIENDA, secret_of(TIENDA), { entries }));
			expect((result as Response).status).toBe(403);
			expect((await refused(result)).code).toBe('seed_out_of_scope');
		}
	});

	test('listas anidadas con model_id/module_name/module_id ajenos → 403 seed_out_of_scope', async () => {
		for (const lists of [
			[{ list_key: 'prioridad', model_id: 'subject-other/orders', options: [{ value: 'alta', label: 'Alta' }] }],
			[{ list_key: 'prioridad', module_name: 'subject-other/orders', options: [{ value: 'alta', label: 'Alta' }] }],
			[{ list_key: 'prioridad', module_id: 'subject-other/orders', options: [{ value: 'alta', label: 'Alta' }] }],
			[
				{ list_key: 'propia', options: [{ value: 'ok', label: 'Ok' }] },
				{ list_key: 'ajena', model_id: 'Pedidos', options: [{ value: 'x', label: 'X' }] },
			],
		]) {
			const result = await gate(
				seed_request(TIENDA, secret_of(TIENDA), {
					entries: [{ model_id: 'subject-tienda/orders', module_name: 'subject-tienda/orders', lists }],
				}),
				'general-option-list-control',
			);
			expect((result as Response).status).toBe(403);
			expect((await refused(result)).code).toBe('seed_out_of_scope');
		}
	});

	test('listas anidadas propias o sin claim de módulo pasan el candado', async () => {
		const result = await gate(
			seed_request(TIENDA, secret_of(TIENDA), {
				entries: [
					{
						model_id: 'subject-tienda/orders',
						module_name: 'subject-tienda/orders',
						lists: [
							{ list_key: 'prioridad', options: [{ value: 'alta', label: 'Alta' }] },
							{
								list_key: 'canal',
								model_id: 'subject-tienda/orders',
								module_name: 'subject-tienda/orders',
								options: [{ value: 'web', label: 'Web' }],
							},
						],
					},
				],
			}),
			'general-option-list-control',
		);
		expect(result).toEqual({ ok: true, caller: TIENDA });
	});

	test('sin entries, builtin false o cuerpo vacío no siembra los builtins del núcleo', async () => {
		for (const [resource, body] of [
			['status-option-control', {}],
			['status-option-control', { entries: [] }],
			['status-option-control', { builtin: false }],
			['status-option-control', { module_name: 'subject-tienda/orders' }],
			['general-option-list-control', {}],
			['general-option-list-control', { entries: [] }],
		] as const) {
			const result = await gate(seed_request(TIENDA, secret_of(TIENDA), body), resource);
			expect((result as Response).status).toBe(403);
			expect((await refused(result)).code).toBe('seed_builtins_forbidden');
		}
	});

	test('JSON inválido → 400 y el cuerpo original sigue legible si era válido', async () => {
		const bad = await gate(seed_request(TIENDA, secret_of(TIENDA), '{'));
		expect((bad as Response).status).toBe(400);
		expect((await refused(bad)).code).toBe('invalid_body');

		const req = seed_request(TIENDA, secret_of(TIENDA), { entries: [orders_entry] }, {
			cookie: 'connect.sid=humana',
		});
		expect(await gate(req)).toEqual({ ok: true, caller: TIENDA });
		expect(await req.json()).toEqual({ entries: [orders_entry] });
	});

	test('strict: vale el derivado de la app, no el maestro ni un secreto vacío', async () => {
		const prev_secret = process.env.CORE_SUBJECT_GATEWAY_SECRET;
		const prev_mode = process.env.CORE_SUBJECT_SECRET_MODE;
		process.env.CORE_SUBJECT_GATEWAY_SECRET = 'maestro-de-prueba';
		process.env.CORE_SUBJECT_SECRET_MODE = 'strict';
		try {
			const derived = derive_subject_secret('maestro-de-prueba', TIENDA);
			const real: SubjectOptionSeedDeps = {
				master_configured: () => Boolean(master_secret()),
				catalog_tids: new Set([TIENDA]),
				is_subject_request,
				installed: async () => true,
			};
			const ok = await authorize_subject_option_seed(
				seed_request(TIENDA, derived, { entries: [orders_entry] }),
				'status-option-control',
				'seed_defaults',
				real,
			);
			expect(ok).toEqual({ ok: true, caller: TIENDA });
			for (const secret of ['maestro-de-prueba', '']) {
				const denied = await authorize_subject_option_seed(
					seed_request(TIENDA, secret, { entries: [orders_entry] }),
					'status-option-control',
					'seed_defaults',
					real,
				);
				expect(denied).toBeInstanceOf(Response);
				expect((denied as Response).status).toBe(403);
				expect(((await (denied as Response).json()) as { code: string }).code).toBe('forbidden');
			}
		} finally {
			if (prev_secret === undefined) delete process.env.CORE_SUBJECT_GATEWAY_SECRET;
			else process.env.CORE_SUBJECT_GATEWAY_SECRET = prev_secret;
			if (prev_mode === undefined) delete process.env.CORE_SUBJECT_SECRET_MODE;
			else process.env.CORE_SUBJECT_SECRET_MODE = prev_mode;
		}
	});
});

function memory_store() {
	const data: Record<string, ImperiumDoc[]> = { configuration: [] };
	let n = 0;
	const store = {
		has(resource: string) {
			return Object.hasOwn(data, resource);
		},
		async find_id(resource: string, id: string) {
			return (data[resource] ?? []).find((row) => String(row._id) === String(id)) ?? null;
		},
		async find_where(resource: string, where: Record<string, unknown>) {
			return (
				(data[resource] ?? []).find((row) =>
					Object.entries(where).every(([key, value]) => row[key] === value),
				) ?? null
			);
		},
		async *scan(resource: string, opts?: { where?: Record<string, unknown> }) {
			let rows = data[resource] ?? [];
			if (opts?.where) {
				rows = rows.filter((row) =>
					Object.entries(opts.where ?? {}).every(([key, value]) => row[key] === value),
				);
			}
			yield rows;
		},
		async insert(resource: string, doc: ImperiumDoc) {
			n += 1;
			const row = { ...doc, _id: doc._id ?? `507f1f77bcf86cd7994${String(n).padStart(5, '0')}` };
			data[resource] = data[resource] ?? [];
			data[resource].push(row);
			return row;
		},
		async update(resource: string, id: string, patch: ImperiumDoc) {
			const row = (data[resource] ?? []).find((item) => String(item._id) === String(id));
			if (!row) return null;
			Object.assign(row, patch);
			return row;
		},
		data,
	};
	return store as unknown as ImperiumStore & { data: Record<string, ImperiumDoc[]> };
}

describe('sesión humana', () => {
	test('sigue sembrando entries y los builtins del núcleo', async () => {
		expect(await gate(seed_request(null, '', { entries: [orders_entry] }))).toBeNull();
		const store = memory_store();
		const ctx = (body: Record<string, unknown>) =>
			({ store, params: {}, actor: { _id: 'user' }, body, url: new URL('http://test/api/status-option-control/seed-defaults') }) as never;
		const seeded = await seed_status_defaults(
			ctx({
				entries: [
					{
						model_id: 'Ticket',
						module_name: 'tickets',
						status_fields: ['status'],
						options: [
							{ value: 'abierto', label: 'Abierto', field_name: 'status' },
							{ value: 'cerrado', label: 'Cerrado', field_name: 'status' },
						],
					},
				],
			}),
		);
		expect(seeded.data[0]?.inserted).toBe(2);
		const builtins = await seed_status_defaults(ctx({}));
		expect(Number(builtins.data[0]?.inserted)).toBeGreaterThan(0);
		const pedidos = store.data.configuration.find((row) => row.model_id === 'Pedidos');
		const values = (pedidos?.value as { options: Array<{ value: string }> }).options.map((option) => option.value);
		expect(values).toContain('borrador');
	});
});

describe('router.ts: cableado', () => {
	const src = readFileSync(new URL('./router.ts', import.meta.url), 'utf8');

	test('la siembra de una app se autoriza antes de exigir sesión', () => {
		const seed = src.indexOf('await authorize_subject_option_seed(');
		const access = src.indexOf('await assert_http_access(');
		expect(seed).toBeGreaterThan(0);
		expect(access).toBeGreaterThan(seed);
		const branch = src.slice(seed, access);
		expect(branch).toContain('if (subject_seed instanceof Response) return add_cors(req, subject_seed);');
		expect(branch).toContain('if (!subject_seed && !is_public_extra_action(hit.resource, extra_hit?.action))');
		expect(branch).toContain('master_configured: () => Boolean(master_secret())');
		expect(branch).toContain('is_subject_request');
		expect(branch).toContain('technical_id_is_installed(store, sql, caller)');
	});

	test('sin remitente, seed_defaults sigue en la sesión', () => {
		const auth = readFileSync(new URL('./auth.ts', import.meta.url), 'utf8');
		expect(auth).toContain("'status-option-control:seed_defaults'");
		expect(auth).toContain("'general-option-list-control:seed_defaults'");
	});
});
