import { describe, expect, test } from 'bun:test';
import type { ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';
import official from './official-seed-fingerprints.json';
import pedido_seeds from './pedido-report-seeds.json';
import {
	SEED_FIELDS_FIELD,
	SEED_FINGERPRINT_FIELD,
	decide_override_seed,
	seed_content_fields,
	seed_fingerprint,
	upsert_override_seed,
	type OfficialFingerprints,
} from './seed-override.ts';

function fake_store(rows: ImperiumDoc[] = []) {
	const writes: { op: 'insert' | 'update'; doc: ImperiumDoc }[] = [];
	const store = {
		async find_where(_resource: string, where: Record<string, unknown>) {
			const ref = where._ref ?? where.ref;
			return rows.find((row) => row._ref === ref) ?? null;
		},
		async insert(_resource: string, doc: ImperiumDoc) {
			const row = { ...doc, _id: `id-${rows.length + 1}` };
			rows.push(row);
			writes.push({ op: 'insert', doc });
			return row;
		},
		async update(_resource: string, id: string, patch: ImperiumDoc) {
			const row = rows.find((r) => r._id === id)!;
			Object.assign(row, patch);
			writes.push({ op: 'update', doc: patch });
			return row;
		},
	} as unknown as ImperiumStore;
	return { store, rows, writes };
}

function fake_log() {
	const lines: { level: 'info' | 'warn'; text: string }[] = [];
	return {
		lines,
		info: (text: string) => lines.push({ level: 'info', text }),
		warn: (text: string) => lines.push({ level: 'warn', text }),
	};
}

const V1 = {
	_ref: 'reports-demo-0',
	name: 'Demo | Formato',
	related_model: 'Pedidos',
	page_size: 'Letter',
	html_content: '<p>v1 {{folio}}</p>',
	is_active: true,
};
const V2 = { ...V1, html_content: '<p>v2 {{folio}} {{observaciones}}</p>' };
const fields = seed_content_fields(V1);
const OFFICIAL: OfficialFingerprints = {
	[V1._ref]: [{ fields, hashes: [seed_fingerprint(V1, fields)] }],
};

describe('semillas con override no pisan registros personalizados', () => {
	test('no existe: se crea con la huella de la semilla aplicada', async () => {
		const { store, rows } = fake_store();
		const decision = await upsert_override_seed(store, 'reports', 'Reports', { ...V2 }, { official: OFFICIAL, log: fake_log() });
		expect(decision.action).toBe('crear');
		expect(rows).toHaveLength(1);
		expect(rows[0]!.html_content).toBe(V2.html_content);
		expect(rows[0]![SEED_FINGERPRINT_FIELD]).toBe(seed_fingerprint(V2, fields));
		expect(rows[0]![SEED_FIELDS_FIELD]).toEqual(fields);
	});

	test('igual a una semilla oficial anterior (sin estampa): se actualiza', async () => {
		// Registro sembrado antes de existir la estampa; la BD regresa page_size y números como texto.
		const { store, rows } = fake_store([{ ...V1, _id: 'r1', is_active: 'true' }]);
		const log = fake_log();
		const decision = await upsert_override_seed(store, 'reports', 'Reports', { ...V2 }, { official: OFFICIAL, log });
		expect(decision.action).toBe('actualizar');
		expect(decision.motivo).toContain('semilla oficial anterior');
		expect(rows[0]!.html_content).toBe(V2.html_content);
		expect(rows[0]![SEED_FINGERPRINT_FIELD]).toBe(seed_fingerprint(V2, fields));
		expect(log.lines).toEqual([{ level: 'info', text: expect.stringContaining('«Demo | Formato»') }]);
	});

	test('sin cambios desde la semilla estampada (aunque no esté en la lista): se actualiza', async () => {
		const { store } = fake_store();
		await upsert_override_seed(store, 'reports', 'Reports', { ...V1 }, { official: {}, log: fake_log() });
		const decision = await upsert_override_seed(store, 'reports', 'Reports', { ...V2 }, { official: {}, log: fake_log() });
		expect(decision.action).toBe('actualizar');
		expect(decision.motivo).toContain('sin cambios');
	});

	test('personalizado por el cliente: se respeta y queda en el log con el nombre del report', async () => {
		const custom = { ...V1, _id: 'r1', html_content: '<p>Mi formato {{folio}}</p>' };
		const { store, rows, writes } = fake_store([{ ...custom }]);
		const log = fake_log();
		const decision = await upsert_override_seed(store, 'reports', 'Reports', { ...V2 }, { official: OFFICIAL, log });
		expect(decision.action).toBe('personalizado');
		expect(writes).toEqual([]);
		expect(rows[0]!.html_content).toBe(custom.html_content);
		expect(log.lines).toHaveLength(1);
		expect(log.lines[0]!.level).toBe('warn');
		expect(log.lines[0]!.text).toContain('Reports «Demo | Formato» (reports-demo-0)');
		expect(log.lines[0]!.text).toContain('personalizado por el cliente');
	});

	test('personalizado después de estampado: también se respeta', async () => {
		const { store, rows } = fake_store();
		await upsert_override_seed(store, 'reports', 'Reports', { ...V1 }, { official: {}, log: fake_log() });
		rows[0]!.html_content = '<p>editado en el Designer</p>';
		const decision = await upsert_override_seed(store, 'reports', 'Reports', { ...V2 }, { official: OFFICIAL, log: fake_log() });
		expect(decision.action).toBe('personalizado');
		expect(rows[0]!.html_content).toBe('<p>editado en el Designer</p>');
	});

	test('ya al día: no reescribe el contenido; «Forzar recreación» sí pisa lo personalizado', async () => {
		const { store, writes } = fake_store([{ ...V2, _id: 'r1', [SEED_FINGERPRINT_FIELD]: seed_fingerprint(V2, fields), [SEED_FIELDS_FIELD]: fields }]);
		expect((await upsert_override_seed(store, 'reports', 'Reports', { ...V2 }, { official: OFFICIAL, log: fake_log() })).action).toBe('al-dia');
		expect(writes).toEqual([]);

		const custom = fake_store([{ ...V1, _id: 'r1', html_content: '<p>mío</p>' }]);
		await upsert_override_seed(custom.store, 'reports', 'Reports', { ...V2 }, { official: OFFICIAL, force: true, log: fake_log() });
		expect(custom.rows[0]!.html_content).toBe(V2.html_content);
	});

	test('las huellas oficiales incluyen la versión actual y anteriores de Pedido y Hoja de surtido', () => {
		for (const seed of pedido_seeds) {
			const entries = (official as OfficialFingerprints)[seed.doc._ref] ?? [];
			const hashes = entries.flatMap((e) => e.hashes);
			expect(hashes).toContain(seed_fingerprint(seed.doc, seed_content_fields(seed.doc)));
			expect(hashes.length).toBeGreaterThan(1);
			// Un registro igual a la semilla actual está al día con la lista real.
			expect(decide_override_seed({ ...seed.doc, _id: 'x' }, seed.doc).action).toBe('al-dia');
		}
	});
});
