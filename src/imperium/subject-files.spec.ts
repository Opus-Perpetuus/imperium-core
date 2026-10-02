import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import type { ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';
import { subject_files } from './subject-files.ts';
import { when_deferred_image_optimize_idle } from './uploads.ts';

let folder = '';
let previous_upload_folder: string | undefined;

beforeEach(() => {
	folder = mkdtempSync(join(tmpdir(), 'imperium-subject-files-'));
	previous_upload_folder = process.env.MULTER_UPLOAD_FOLDER;
	process.env.MULTER_UPLOAD_FOLDER = folder;
});

afterEach(async () => {
	await when_deferred_image_optimize_idle();
	if (previous_upload_folder === undefined) delete process.env.MULTER_UPLOAD_FOLDER;
	else process.env.MULTER_UPLOAD_FOLDER = previous_upload_folder;
});

function memory_store(): { store: ImperiumStore; docs: Map<string, ImperiumDoc> } {
	const docs = new Map<string, ImperiumDoc>();
	const store = {
		has: (name: string) => name === 'attachment-management',
		insert: async (_resource: string, doc: ImperiumDoc) => {
			const id = crypto.randomUUID().replace(/-/g, '').slice(0, 24);
			const saved: ImperiumDoc = { ...doc, _id: id, id };
			docs.set(id, saved);
			return saved;
		},
		update: async (_resource: string, id: string, patch: ImperiumDoc) => {
			const existing = docs.get(id);
			if (!existing) return null;
			const saved: ImperiumDoc = { ...existing, ...patch, _id: id, id };
			docs.set(id, saved);
			return saved;
		},
		remove: async (_resource: string, id: string) => {
			const existing = docs.get(id) ?? null;
			docs.delete(id);
			return existing;
		},
		find_id: async (_resource: string, id: string) => docs.get(id) ?? null,
		find_many: async (_resource: string, opts: { where?: Record<string, unknown> } = {}) => {
			const where = opts.where ?? {};
			const rows = [...docs.values()].filter((doc) =>
				Object.entries(where).every(([key, value]) => doc[key] === value),
			);
			return { rows, total: rows.length };
		},
	};
	return { store: store as unknown as ImperiumStore, docs };
}

async function foto(width: number, height: number): Promise<string> {
	const png = await sharp({
		create: { width, height, channels: 3, background: { r: 200, g: 40, b: 40 } },
	})
		.png()
		.toBuffer();
	return png.toString('base64');
}

describe('archivos de las apps', () => {
	test('guarda los bytes como adjunto y devuelve la URL de /media con una miniatura', async () => {
		const { store, docs } = memory_store();
		const files = subject_files(store);
		const ref = await files.save('subject-herramientas', {
			resource: 'herr-registros',
			record_id: 'registro_1',
			filename: 'herr-registros-registro_1.png',
			content_type: 'image/png',
			data_base64: await foto(900, 600),
		});

		expect(ref.url).toBe(`/api/media/${ref.id}`);
		expect(ref.resource).toBe('herr-registros');
		expect(ref.record_id).toBe('registro_1');
		const doc = docs.get(ref.id)!;
		expect(doc.related_model).toBe('subject-herramientas:herr-registros');
		expect(existsSync(join(folder, String(doc.name_stored)))).toBe(true);

		expect(ref.thumbnail).toStartWith('data:image/jpeg;base64,');
		const mini = await sharp(Buffer.from(ref.thumbnail!.split(',')[1]!, 'base64')).metadata();
		expect(mini.format).toBe('jpeg');
		expect(Math.max(mini.width!, mini.height!)).toBe(200);
	});

	test('una imagen más chica que la miniatura no se agranda', async () => {
		const { store } = memory_store();
		const ref = await subject_files(store).save('subject-herramientas', {
			resource: 'herr-registros',
			record_id: 'r',
			filename: 'chica.png',
			content_type: 'image/png',
			data_base64: await foto(40, 30),
		});
		const mini = await sharp(Buffer.from(ref.thumbnail!.split(',')[1]!, 'base64')).metadata();
		expect([mini.width, mini.height]).toEqual([40, 30]);
	});

	test('un archivo que no es imagen no trae miniatura', async () => {
		const { store } = memory_store();
		const ref = await subject_files(store).save('subject-herramientas', {
			resource: 'herr-agenda',
			record_id: 'r',
			filename: 'nota.txt',
			content_type: 'text/plain',
			data_base64: Buffer.from('hola').toString('base64'),
		});
		expect(ref.thumbnail).toBeUndefined();
		expect(ref.content_type).toStartWith('text/plain');
	});

	test('una app solo lista y borra lo suyo', async () => {
		const { store, docs } = memory_store();
		const files = subject_files(store);
		const ref = await files.save('subject-herramientas', {
			resource: 'herr-registros',
			record_id: 'r1',
			filename: 'a.png',
			content_type: 'image/png',
			data_base64: await foto(10, 10),
		});

		expect((await files.list('subject-herramientas', { resource: 'herr-registros' })).map((f) => f.id)).toEqual([
			ref.id,
		]);
		expect(await files.list('subject-tienda', { resource: 'herr-registros' })).toEqual([]);

		expect(await files.remove('subject-tienda', ref.id)).toBe(false);
		expect(docs.has(ref.id)).toBe(true);

		const stored = String(docs.get(ref.id)!.name_stored);
		await when_deferred_image_optimize_idle();
		expect(await files.remove('subject-herramientas', ref.id)).toBe(true);
		expect(docs.has(ref.id)).toBe(false);
		expect(readdirSync(folder)).not.toContain(stored);
	});

	test('sin recurso no se guarda nada', async () => {
		const { store, docs } = memory_store();
		await expect(
			subject_files(store).save('subject-herramientas', { data_base64: await foto(4, 4) }),
		).rejects.toThrow('Falta el recurso');
		expect(docs.size).toBe(0);
	});
});
