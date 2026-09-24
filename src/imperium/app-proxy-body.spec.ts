import { crc32 } from 'node:zlib';
import { describe, expect, test } from 'bun:test';
import sharp from 'sharp';
import {
	APP_PROXY_BODY_MAX,
	APP_PROXY_MAX_IMAGES,
	AppProxyBodyTooLarge,
	bytes_for_proxy,
	guard_app_proxy_body,
} from './app-proxy-body.ts';

function png_ihdr(width: number, height: number): Buffer {
	const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const data = Buffer.alloc(13);
	data.writeUInt32BE(width, 0);
	data.writeUInt32BE(height, 4);
	data[8] = 8;
	data[9] = 2;
	const type = Buffer.from('IHDR');
	const len = Buffer.alloc(4);
	len.writeUInt32BE(13, 0);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(Buffer.concat([type, data])) >>> 0, 0);
	const iendLen = Buffer.alloc(4);
	const iendType = Buffer.from('IEND');
	const iendCrc = Buffer.alloc(4);
	iendCrc.writeUInt32BE(crc32(iendType) >>> 0, 0);
	return Buffer.concat([sig, len, type, data, crc, iendLen, iendType, iendCrc]);
}

function json_foto(buf: Buffer): Uint8Array {
	const foto = `data:image/png;base64,${buf.toString('base64')}`;
	return new TextEncoder().encode(JSON.stringify({ foto }));
}

describe('cuerpo del proxy de apps', () => {
	test('un cuerpo de más de 8 MB responde 413', async () => {
		const raw = new Uint8Array(APP_PROXY_BODY_MAX + 1);
		await expect(
			guard_app_proxy_body(raw, 'application/octet-stream'),
		).rejects.toBeInstanceOf(AppProxyBodyTooLarge);
		try {
			await guard_app_proxy_body(raw, 'application/octet-stream');
		} catch (err) {
			expect((err as AppProxyBodyTooLarge).status).toBe(413);
			expect((err as Error).message).toContain('8 MB');
		}
	});

	test('un data URL de imagen de más de 8 MB responde 413', async () => {
		const foto = `data:image/png;base64,${'A'.repeat(APP_PROXY_BODY_MAX)}`;
		const raw = new TextEncoder().encode(JSON.stringify({ foto }));
		expect(raw.byteLength).toBeGreaterThan(APP_PROXY_BODY_MAX);
		await expect(
			guard_app_proxy_body(raw, 'application/json'),
		).rejects.toMatchObject({ status: 413 });
	});

	test('una foto de más de 4000 px se reduce antes de reenviarla', async () => {
		const png = await sharp({
			create: {
				width: 4100,
				height: 20,
				channels: 3,
				background: { r: 20, g: 40, b: 60 },
			},
		})
			.png()
			.toBuffer();
		const foto = `data:image/png;base64,${png.toString('base64')}`;
		const raw = new TextEncoder().encode(
			JSON.stringify({ nombre: 'pieza', foto }),
		);
		expect(raw.byteLength).toBeLessThan(APP_PROXY_BODY_MAX);
		const out = await guard_app_proxy_body(raw, 'application/json');
		const parsed = JSON.parse(new TextDecoder().decode(out)) as {
			nombre: string;
			foto: string;
		};
		expect(parsed.nombre).toBe('pieza');
		expect(parsed.foto.startsWith('data:image/png;base64,')).toBe(true);
		const bytes = Buffer.from(parsed.foto.split(',')[1]!, 'base64');
		const meta = await sharp(bytes).metadata();
		expect(meta.width).toBeLessThanOrEqual(4000);
		expect(meta.height).toBeLessThanOrEqual(4000);
		expect(meta.width).toBeLessThan(4100);
	});

	test('un png de muchas megapíxeles y pocos bytes se rechaza sin decodificarlo', async () => {
		const raw = json_foto(png_ihdr(16_000, 16_000));
		expect(raw.byteLength).toBeLessThan(APP_PROXY_BODY_MAX);
		await expect(guard_app_proxy_body(raw, 'application/json')).rejects.toMatchObject(
			{ status: 422, message: expect.stringContaining('píxeles') },
		);
	});

	test('más imágenes de las permitidas se rechazan', async () => {
		const foto = 'data:image/png;base64,AA';
		const body: Record<string, string> = {};
		for (let i = 0; i < APP_PROXY_MAX_IMAGES + 1; i++) body[`f${i}`] = foto;
		const raw = new TextEncoder().encode(JSON.stringify(body));
		await expect(guard_app_proxy_body(raw, 'application/json')).rejects.toMatchObject(
			{ status: 422, message: expect.stringContaining('demasiadas') },
		);
	});

	test('content-length por encima de 8 MB no lee el cuerpo', async () => {
		let leido = false;
		const req = {
			headers: {
				get(name: string) {
					return name === 'content-length'
						? String(APP_PROXY_BODY_MAX + 1)
						: null;
				},
			},
			arrayBuffer() {
				leido = true;
				return Promise.resolve(new ArrayBuffer(0));
			},
		};
		await expect(bytes_for_proxy(req)).rejects.toMatchObject({ status: 413 });
		expect(leido).toBe(false);
	});

	test('si el recorte falla, el código no es 413', async () => {
		const raw = json_foto(png_ihdr(4100, 10));
		await expect(guard_app_proxy_body(raw, 'application/json')).rejects.toMatchObject(
			{ status: 400, message: expect.stringContaining('procesar') },
		);
	});

	test('un json sin imagen sale igual', async () => {
		const raw = new TextEncoder().encode(JSON.stringify({ nombre: 'pieza' }));
		const out = await guard_app_proxy_body(raw, 'application/json');
		expect(new TextDecoder().decode(out)).toBe(
			new TextDecoder().decode(raw),
		);
	});
});
