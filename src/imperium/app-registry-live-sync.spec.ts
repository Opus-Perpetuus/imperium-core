import { describe, expect, it } from 'bun:test';
import { live_manifest_reader, type ManifestRead } from './app-registry-sync.ts';
import { subject_image_ref } from './subject-runtime.ts';

const MANIFEST = { slug: 'planeacion', leaves: [{ segment: 'planeacion-proyectos' }] };

describe('registro al quedar sana una app (sin reiniciar el núcleo)', () => {
	it('lee /manifest del contenedor ya sano', async () => {
		const urls: string[] = [];
		const read = live_manifest_reader('http://subject-planeacion:8080', 'img:1', {
			fetch: (async (url: string) => {
				urls.push(String(url));
				return new Response(JSON.stringify(MANIFEST), { status: 200 });
			}) as unknown as typeof fetch,
			delay_ms: 0,
		});
		const result = await read('planeacion', null);
		expect(urls).toEqual(['http://subject-planeacion:8080/manifest']);
		expect(result).toEqual({ ok: true, manifest: MANIFEST, digest: null });
	});

	it('reintenta mientras arranca y luego cae a la imagen aplicada', async () => {
		let calls = 0;
		const fallback_args: unknown[] = [];
		const read = live_manifest_reader('http://subject-tienda:8080', 'ghcr.io/opus-perpetuus/subject-tienda:0.4.1', {
			fetch: (async () => {
				calls++;
				return new Response('starting', { status: 503 });
			}) as unknown as typeof fetch,
			attempts: 3,
			delay_ms: 0,
			fallback: async (slug, row, image): Promise<ManifestRead> => {
				fallback_args.push(slug, row, image);
				return { ok: false, skipped: true };
			},
		});
		expect(await read('tienda', null)).toEqual({ ok: false, skipped: true });
		expect(calls).toBe(3);
		expect(fallback_args).toEqual(['tienda', null, 'ghcr.io/opus-perpetuus/subject-tienda:0.4.1']);
	});

	it('el cold-sync usa la imagen instalada antes que el IMPERIUM_SUBJECT_TAG global (0.1.0 sin arm64)', () => {
		const prev = process.env.IMPERIUM_SUBJECT_TAG;
		process.env.IMPERIUM_SUBJECT_TAG = '0.1.0';
		try {
			expect(subject_image_ref({ slug: 'planeacion', image: 'ghcr.io/opus-perpetuus/subject-planeacion:0.3.3' })).toBe(
				'ghcr.io/opus-perpetuus/subject-planeacion:0.3.3',
			);
			expect(subject_image_ref({ slug: 'planeacion', image: null })).toBe('ghcr.io/opus-perpetuus/subject-planeacion:0.1.0');
		} finally {
			if (prev === undefined) delete process.env.IMPERIUM_SUBJECT_TAG;
			else process.env.IMPERIUM_SUBJECT_TAG = prev;
		}
	});
});
