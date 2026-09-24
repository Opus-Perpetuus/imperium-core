import sharp from 'sharp';

export const APP_PROXY_BODY_MAX = 8 * 1024 * 1024;
export const APP_PROXY_MAX_PIXELS = 48_000_000;
export const APP_PROXY_MAX_IMAGES = 4;
const IMAGEN_LADO_MAXIMO = 4000;
const MENSAJE_TOPE = 'La petición supera el tamaño permitido (8 MB).';
const MENSAJE_PIXELES = 'La imagen supera el máximo de píxeles permitido.';
const MENSAJE_CANTIDAD = 'La petición incluye demasiadas imágenes.';
const MENSAJE_PROCESO = 'No se pudo procesar la imagen.';

const SHARP_LIMIT = {
	limitInputPixels: APP_PROXY_MAX_PIXELS,
	failOn: 'none' as const,
};

export class AppProxyRequestError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

export class AppProxyBodyTooLarge extends AppProxyRequestError {
	constructor() {
		super(413, MENSAJE_TOPE);
	}
}

export function reject_oversized_content_length(
	content_length: string | null,
): void {
	if (content_length == null) return;
	const declared = Number(content_length.trim());
	if (Number.isFinite(declared) && declared > APP_PROXY_BODY_MAX) {
		throw new AppProxyBodyTooLarge();
	}
}

export async function bytes_for_proxy(req: {
	headers: { get(name: string): string | null };
	arrayBuffer(): Promise<ArrayBuffer>;
}): Promise<Uint8Array> {
	reject_oversized_content_length(req.headers.get('content-length'));
	return new Uint8Array(await req.arrayBuffer());
}

export async function guard_app_proxy_body(
	raw: Uint8Array,
	content_type: string | null,
): Promise<Uint8Array> {
	if (raw.byteLength > APP_PROXY_BODY_MAX) throw new AppProxyBodyTooLarge();
	const type = content_type ?? '';
	if (!type.includes('application/json') && !type.includes('+json')) {
		return raw;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder().decode(raw));
	} catch {
		return raw;
	}
	if (count_images(parsed) > APP_PROXY_MAX_IMAGES) {
		throw new AppProxyRequestError(422, MENSAJE_CANTIDAD);
	}
	let dirty = false;
	const next = await walk(parsed, () => {
		dirty = true;
	});
	if (!dirty) return raw;
	const encoded = new TextEncoder().encode(JSON.stringify(next));
	if (encoded.byteLength > APP_PROXY_BODY_MAX) throw new AppProxyBodyTooLarge();
	return encoded;
}

function count_images(value: unknown): number {
	if (typeof value === 'string') {
		return value.startsWith('data:image/') ? 1 : 0;
	}
	if (Array.isArray(value)) {
		return value.reduce((sum, item) => sum + count_images(item), 0);
	}
	if (value && typeof value === 'object') {
		return Object.values(value).reduce<number>(
			(sum, item) => sum + count_images(item),
			0,
		);
	}
	return 0;
}

async function walk(value: unknown, mark: () => void): Promise<unknown> {
	if (typeof value === 'string') return cap_image(value, mark);
	if (Array.isArray(value)) {
		const out: unknown[] = [];
		for (const item of value) out.push(await walk(item, mark));
		return out;
	}
	if (value && typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value)) {
			out[key] = await walk(item, mark);
		}
		return out;
	}
	return value;
}

function raster_pixels(buf: Buffer): { width: number; height: number } | null {
	if (
		buf.length >= 24 &&
		buf[0] === 0x89 &&
		buf.toString('ascii', 1, 4) === 'PNG'
	) {
		return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
	}
	if (buf.length >= 10 && buf.toString('ascii', 0, 3) === 'GIF') {
		return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
	}
	if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
		let i = 2;
		while (i + 9 < buf.length) {
			if (buf[i] !== 0xff) return null;
			const marker = buf[i + 1] ?? 0;
			if (marker === 0xd8 || marker === 0xd9) {
				i += 2;
				continue;
			}
			const len = buf.readUInt16BE(i + 2);
			if (marker >= 0xc0 && marker <= 0xc3) {
				return {
					height: buf.readUInt16BE(i + 5),
					width: buf.readUInt16BE(i + 7),
				};
			}
			if (len < 2) return null;
			i += 2 + len;
		}
	}
	return null;
}

function pixel_limit_error(err: unknown): boolean {
	const message = err instanceof Error ? err.message : String(err);
	return /pixel limit|exceeds pixel/i.test(message);
}

async function cap_image(value: string, mark: () => void): Promise<string> {
	if (!value.startsWith('data:image/')) return value;
	if (value.length > APP_PROXY_BODY_MAX) throw new AppProxyBodyTooLarge();
	const comma = value.indexOf(',');
	if (comma < 0 || !/base64/i.test(value.slice(0, comma))) return value;
	const mime = value.slice(5, comma).split(';')[0] || 'image/jpeg';
	let buf: Buffer;
	try {
		buf = Buffer.from(value.slice(comma + 1), 'base64');
	} catch {
		throw new AppProxyRequestError(400, MENSAJE_PROCESO);
	}
	const header = raster_pixels(buf);
	if (
		header &&
		header.width > 0 &&
		header.height > 0 &&
		header.width * header.height > APP_PROXY_MAX_PIXELS
	) {
		throw new AppProxyRequestError(422, MENSAJE_PIXELES);
	}
	let info: sharp.Metadata;
	try {
		info = await sharp(buf, SHARP_LIMIT).metadata();
	} catch (err) {
		if (pixel_limit_error(err)) {
			throw new AppProxyRequestError(422, MENSAJE_PIXELES);
		}
		throw new AppProxyRequestError(400, MENSAJE_PROCESO);
	}
	const width = info.width ?? header?.width ?? 0;
	const height = info.height ?? header?.height ?? 0;
	if (width > 0 && height > 0 && width * height > APP_PROXY_MAX_PIXELS) {
		throw new AppProxyRequestError(422, MENSAJE_PIXELES);
	}
	if (
		!width ||
		!height ||
		(width <= IMAGEN_LADO_MAXIMO && height <= IMAGEN_LADO_MAXIMO)
	) {
		return value;
	}
	let out: Buffer;
	try {
		out = await sharp(buf, SHARP_LIMIT)
			.rotate()
			.resize({
				width: IMAGEN_LADO_MAXIMO,
				height: IMAGEN_LADO_MAXIMO,
				fit: 'inside',
				withoutEnlargement: true,
			})
			.toBuffer();
	} catch (err) {
		if (pixel_limit_error(err)) {
			throw new AppProxyRequestError(422, MENSAJE_PIXELES);
		}
		throw new AppProxyRequestError(400, MENSAJE_PROCESO);
	}
	const next = `data:${mime};base64,${out.toString('base64')}`;
	if (next.length > APP_PROXY_BODY_MAX) throw new AppProxyBodyTooLarge();
	mark();
	return next;
}
