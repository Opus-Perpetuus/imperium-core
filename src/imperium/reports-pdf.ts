/**
 * HTML → PDF for `/reports/generate-pdf` and generate-full-pdf.
 * Never returns HTML with a PDF content-type: the Angular client would
 * download that as `.pdf` and the reader would fail to open it.
 */
import { existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPORT_PRINT_CSS } from './report-print-css.ts';

export type PdfRenderOptions = {
	filename?: string;
	pageSize?: string;
	orientation?: string;
	/** Solo con `pageSize: 'custom'`. */
	widthMm?: number;
	heightMm?: number;
	marginTopMm?: number;
	marginRightMm?: number;
	marginBottomMm?: number;
	marginLeftMm?: number;
	/** Pie "Página X de Y" en cada hoja (caja de margen `@page`). */
	pageNumbers?: boolean;
	/** Texto fijo en el encabezado / pie de cada hoja. */
	headerText?: string;
	footerText?: string;
	/** Escala de impresión 0.1–2 (1 = 100 %). */
	scale?: number;
};

/** Lee las opciones de hoja del body (`generate-pdf`) o de un `pdf_setting`. */
export function pdf_options_from_input(input: Record<string, unknown>): PdfRenderOptions {
	const pick = (...keys: string[]) => {
		for (const key of keys) {
			const value = input[key];
			if (value !== undefined && value !== null && value !== '') return value;
		}
		return undefined;
	};
	const num = (...keys: string[]) => {
		const value = pick(...keys);
		if (value === undefined) return undefined;
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	};
	const bool = (...keys: string[]) => {
		const value = pick(...keys);
		if (value === undefined) return undefined;
		return value === true || value === 'true' || value === 1 || value === '1';
	};
	const text = (...keys: string[]) => {
		const value = pick(...keys);
		return value === undefined ? undefined : String(value);
	};
	const scale_percent = num('scale_percent');
	return {
		pageSize: text('pageSize', 'page_size_preset', 'page_size'),
		orientation: text('orientation'),
		widthMm: num('widthMm', 'custom_width_mm'),
		heightMm: num('heightMm', 'custom_height_mm'),
		marginTopMm: num('marginTopMm', 'margin_top_mm'),
		marginRightMm: num('marginRightMm', 'margin_right_mm'),
		marginBottomMm: num('marginBottomMm', 'margin_bottom_mm'),
		marginLeftMm: num('marginLeftMm', 'margin_left_mm'),
		pageNumbers: bool('pageNumbers', 'page_numbers', 'displayHeaderFooter', 'display_header_footer'),
		headerText: text('headerText', 'header_text'),
		footerText: text('footerText', 'footer_text'),
		scale: num('scale') ?? (scale_percent !== undefined ? scale_percent / 100 : undefined),
	};
}

const PDF_MAGIC = '%PDF-';

export const PDF_BLOCKED_URLS = [
	'file://*',
	'*://localhost*',
	'*://127.*',
	'*://0.0.0.0*',
	'*://10.*',
	'*://192.168.*',
	/* `setBlockedURLs` solo entiende `*`: 172.16/12 va octeto a octeto. */
	...Array.from({ length: 16 }, (_unused, index) => `*://172.${16 + index}.*`),
	'*://169.254.*',
	'*://[::1]*',
	'*://postgres*',
	'*://core*',
	'*://subject-*',
];

export function looks_like_pdf(bytes: Uint8Array | ArrayBuffer | Buffer): boolean {
	const view =
		bytes instanceof ArrayBuffer
			? new Uint8Array(bytes)
			: bytes instanceof Uint8Array
				? bytes
				: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (view.byteLength < 5) return false;
	return (
		String.fromCharCode(view[0]!, view[1]!, view[2]!, view[3]!, view[4]!) ===
		PDF_MAGIC
	);
}

export function sanitize_pdf_filename(raw: string | undefined): string {
	const base = String(raw ?? 'report.pdf')
		.replace(/["\r\n\\/]+/g, '')
		.replace(/[^\w.\-]+/g, '_')
		.replace(/^_+|_+$/g, '')
		.slice(0, 180);
	const name = base || 'report.pdf';
	return name.toLowerCase().endsWith('.pdf') ? name : `${name}.pdf`;
}

/** `filename` ASCII para clientes viejos y `filename*` UTF-8 con acentos. */
export function pdf_content_disposition(raw: string | undefined): string {
	const ascii = sanitize_pdf_filename(
		String(raw ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, ''),
	);
	const unicode = String(raw ?? '')
		.replace(/["\r\n\\/]+/g, '')
		.replace(/[^\p{L}\p{N}.\-]+/gu, '_')
		.replace(/^_+|_+$/g, '')
		.slice(0, 180);
	const pretty = unicode ? (unicode.toLowerCase().endsWith('.pdf') ? unicode : `${unicode}.pdf`) : ascii;
	return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(pretty)}`;
}

export function wrap_html_for_pdf(
	html: string,
	options: PdfRenderOptions = {},
): string {
	const raw = typeof html === 'string' ? html.trim() : '';
	const body_match = raw.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
	const head_match = raw.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
	/* Los <style> del <head> de un documento completo también cuentan. */
	const head_styles = head_match
		? [...head_match[1]!.matchAll(/<style[^>]*>[\s\S]*?<\/style>/gi)].map((m) => m[0]).join('\n')
		: '';
	const body = normalize_page_breaks((body_match ? body_match[1]! : raw).trim());
	const margins = pdf_margins_mm(options);
	const inches = paper_size_inches(options);
	return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
<title>Report</title>
<style>
${REPORT_PRINT_CSS}
* { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
@page {
	size: ${inches.width}in ${inches.height}in;
	margin: ${margins.top}mm ${margins.right}mm ${margins.bottom}mm ${margins.left}mm;
${page_margin_boxes(options)}}
</style>
${head_styles}
</head>
<body>
${body}
</body>
</html>`;
}

/** Los saltos que guarda el diseñador (comentario o marcador) pasan a CSS. */
export function normalize_page_breaks(html: string): string {
	return html
		.replace(/<!--\s*designer-page-break\s*-->/gi, '<div class="report-page-break"></div>')
		.replace(/\{\{\s*salto_de_pagina\s*\}\}/gi, '<div class="report-page-break"></div>');
}

function css_string(value: string): string {
	return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ')}"`;
}

/** Encabezado / pie repetidos en cada hoja con cajas de margen de `@page`. */
function page_margin_boxes(options: PdfRenderOptions): string {
	const box = (at: string, content: string) =>
		`\t@${at} { content: ${content}; font-family: "Open Sans", "DejaVu Sans", Arial, sans-serif; font-size: 7.5pt; color: #7b8794; }\n`;
	let out = '';
	const header = String(options.headerText ?? '').trim();
	const footer = String(options.footerText ?? '').trim();
	if (header) out += box('top-center', css_string(header));
	if (footer) out += box('bottom-left', css_string(footer));
	if (options.pageNumbers) {
		out += box('bottom-right', '"Página " counter(page) " de " counter(pages)');
	}
	return out;
}

export function pdf_margins_mm(options: PdfRenderOptions = {}) {
	const decorated = Boolean(options.pageNumbers || String(options.footerText ?? '').trim());
	const headed = Boolean(String(options.headerText ?? '').trim());
	const top = clamp_mm(options.marginTopMm, 10);
	const bottom = clamp_mm(options.marginBottomMm, 10);
	return {
		/* Encabezado y pie viven dentro del margen: sin espacio no se ven. */
		top: headed ? Math.max(top, 10) : top,
		right: clamp_mm(options.marginRightMm, 10),
		bottom: decorated ? Math.max(bottom, 10) : bottom,
		left: clamp_mm(options.marginLeftMm, 10),
	};
}

export function resolve_chrome_executable(): string | undefined {
	const candidates = [
		process.env.PUPPETEER_EXECUTABLE_PATH,
		process.env.CHROME_PATH,
		process.env.CHROMIUM_PATH,
		`${process.env.HOME ?? ''}/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome`,
		'/usr/bin/google-chrome-stable',
		'/usr/bin/google-chrome',
		'/usr/bin/chromium',
		'/usr/bin/chromium-browser',
	]
		.map((value) => String(value ?? '').trim())
		.filter(Boolean);
	return candidates.find((path) => existsSync(path));
}

export async function html_to_pdf_bytes(
	html: string,
	options: PdfRenderOptions = {},
): Promise<Uint8Array> {
	const wrapped = wrap_html_for_pdf(html, options);
	if (!wrapped.replace(/<[^>]+>/g, '').trim() && !/<img\b/i.test(wrapped)) {
		throw new Error('Plantilla HTML vacía. Proporciona contenido para generar PDF.');
	}
	const chrome = resolve_chrome_executable();
	if (chrome) {
		const from_cdp = await print_with_chrome_cdp(chrome, wrapped, options);
		if (from_cdp) return from_cdp;
		const from_cli = await print_with_chrome_cli(chrome, wrapped, options);
		if (from_cli) return from_cli;
	}
	const from_puppeteer = await print_with_puppeteer(chrome, wrapped, options);
	if (from_puppeteer) return from_puppeteer;
	throw new Error(
		chrome
			? 'El generador de PDF no respondió a tiempo. Intenta de nuevo en unos segundos.'
			: 'No se pudo generar el PDF. Instala Chrome/Chromium o define CHROME_PATH.',
	);
}

export async function html_to_pdf_response(
	html: string,
	filename?: string,
	options: PdfRenderOptions = {},
): Promise<Response> {
	const bytes = await html_to_pdf_bytes(html, options);
	return new Response(bytes, {
		headers: {
			'content-type': 'application/pdf',
			'content-disposition': pdf_content_disposition(filename || options.filename),
		},
	});
}

function map_page_size(page_size?: string): string {
	const size = String(page_size || 'a4').trim().toLowerCase();
	if (size === 'letter' || size === 'carta') return 'Letter';
	if (size === 'legal' || size === 'oficio') return 'Legal';
	if (size === 'custom' || size === 'personalizado') return 'custom';
	return 'A4';
}

function round_in(value: number): number {
	return Math.round(value * 10000) / 10000;
}

/** Hojas personalizadas: de una etiqueta de 20 mm a un plano de 1.2 m. */
function clamp_dimension_mm(value: unknown, fallback: number): number {
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
	return Math.max(20, Math.min(1200, parsed));
}

function clamp_mm(value: unknown, fallback: number): number {
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || Number.isNaN(parsed)) return fallback;
	return Math.max(0, Math.min(100, parsed));
}

export function paper_size_inches(
	options: PdfRenderOptions = {},
): { width: number; height: number } {
	const landscape = options.orientation === 'landscape';
	const size = map_page_size(options.pageSize);
	if (size === 'custom') {
		const width_mm = clamp_dimension_mm(options.widthMm, 210);
		const height_mm = clamp_dimension_mm(options.heightMm, 297);
		const width = round_in(width_mm / 25.4);
		const height = round_in(height_mm / 25.4);
		return landscape ? { width: height, height: width } : { width, height };
	}
	const portrait_in: Record<string, [number, number]> = {
		A4: [8.27, 11.69],
		Letter: [8.5, 11],
		Legal: [8.5, 14],
	};
	const [short_edge, long_edge] = portrait_in[size] ?? portrait_in.A4!;
	return {
		width: landscape ? long_edge : short_edge,
		height: landscape ? short_edge : long_edge,
	};
}

export function paper_viewport_px(
	options: PdfRenderOptions = {},
): { width: number; height: number } {
	const inches = paper_size_inches(options);
	return {
		width: Math.round(inches.width * 96),
		height: Math.round(inches.height * 96),
	};
}

type CdpResult = { id?: number; error?: { message?: string }; result?: Record<string, unknown> };

type SharedChrome = { proc: ReturnType<typeof Bun.spawn>; port: number };

let shared_chrome: Promise<SharedChrome | null> | null = null;
let shared_idle_timer: ReturnType<typeof setTimeout> | null = null;
let shared_jobs = 0;
/** Tras este tiempo sin PDFs, el Chrome compartido se cierra. */
const SHARED_CHROME_IDLE_MS = 90_000;

/**
 * Un solo Chrome para todos los PDF (una pestaña por trabajo). Lanzar uno por
 * PDF costaba ~1 s de arranque y, con varios a la vez en un servidor cargado,
 * se pasaban del tiempo y el PDF fallaba.
 */
function shared_browser(chrome: string): Promise<SharedChrome | null> {
	if (shared_chrome) return shared_chrome;
	const launching: Promise<SharedChrome | null> = (async () => {
		const port = 41000 + Math.floor(Math.random() * 10000);
		const proc = Bun.spawn(
			[
				chrome,
				'--headless=new',
				'--disable-gpu',
				'--no-sandbox',
				'--disable-dev-shm-usage',
				'--force-device-scale-factor=1',
				'--no-first-run',
				'--no-default-browser-check',
				`--remote-debugging-port=${port}`,
				'about:blank',
			],
			{ stdout: 'ignore', stderr: 'ignore' },
		);
		proc.unref();
		/* Con el puerto de depuración, Chrome no muere con su padre: si el proceso
		 * sale antes de cerrarlo por inactividad (fin de bun test, apagado), se
		 * cierra aquí o queda huérfano para siempre. */
		const kill_on_exit = () => {
			try {
				proc.kill();
			} catch {
				/* ya salió */
			}
		};
		process.once('exit', kill_on_exit);
		/* Solo olvida el Chrome si sigue siendo el vigente: uno viejo que muere
		 * tarde no debe dejar huérfano al que lo reemplazó. */
		void proc.exited.then(() => {
			process.off('exit', kill_on_exit);
			if (shared_chrome === launching) shared_chrome = null;
		});
		if (!(await wait_for_cdp(port, 30_000))) {
			try {
				proc.kill();
			} catch {
				/* ya salió */
			}
			if (shared_chrome === launching) shared_chrome = null;
			return null;
		}
		return { proc, port };
	})();
	shared_chrome = launching;
	return launching;
}

function release_shared_browser() {
	if (shared_idle_timer) clearTimeout(shared_idle_timer);
	shared_idle_timer = setTimeout(() => {
		if (shared_jobs > 0) return;
		void shared_chrome?.then((browser) => {
			try {
				browser?.proc.kill();
			} catch {
				/* ya salió */
			}
		});
		shared_chrome = null;
	}, SHARED_CHROME_IDLE_MS);
	shared_idle_timer.unref?.();
}

/** Cierra ya el Chrome compartido. bun test no emite 'exit' al terminar: sus
 * specs lo llaman en afterAll. */
export async function close_shared_pdf_browser(): Promise<void> {
	if (shared_idle_timer) clearTimeout(shared_idle_timer);
	shared_idle_timer = null;
	const current = shared_chrome;
	shared_chrome = null;
	const browser = await current?.catch(() => null);
	try {
		browser?.proc.kill();
	} catch {
		/* ya salió */
	}
}

function discard_shared_browser(failed: Promise<SharedChrome | null> | null) {
	/* Si otro trabajo ya lo reemplazó, no se toca el nuevo; si aún hay PDFs
	 * imprimiéndose en él, tampoco: el último que falle lo descarta. */
	if (!failed || shared_chrome !== failed || shared_jobs > 0) return;
	const current = shared_chrome;
	shared_chrome = null;
	void current?.then((browser) => {
		try {
			browser?.proc.kill();
		} catch {
			/* ya salió */
		}
	});
}

async function print_with_chrome_cdp(
	chrome: string,
	html: string,
	options: PdfRenderOptions = {},
): Promise<Uint8Array | null> {
	for (let attempt = 0; attempt < 2; attempt++) {
		shared_jobs++;
		const launching = shared_browser(chrome);
		try {
			const browser = await launching;
			if (!browser) return null;
			const bytes = await print_in_new_tab(browser.port, html, options);
			if (bytes) return bytes;
		} catch {
			/* un Chrome colgado o caído se descarta y se reintenta una vez */
		} finally {
			shared_jobs--;
			release_shared_browser();
		}
		discard_shared_browser(launching);
	}
	return null;
}

async function print_in_new_tab(
	port: number,
	html: string,
	options: PdfRenderOptions,
): Promise<Uint8Array | null> {
	const target = (await (
		await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })
	).json()) as { id?: string; webSocketDebuggerUrl?: string };
	const ws_url = target.webSocketDebuggerUrl;
	if (!ws_url || !target.id) return null;
	const ws = new WebSocket(ws_url);
	try {
		await new Promise<void>((resolve, reject) => {
			ws.addEventListener('open', () => resolve());
			ws.addEventListener('error', () => reject(new Error('cdp websocket')));
		});

		let next_id = 0;
		const pending = new Map<number, (msg: CdpResult) => void>();
		ws.addEventListener('message', (event) => {
			const msg = JSON.parse(String(event.data)) as CdpResult;
			if (typeof msg.id === 'number') {
				pending.get(msg.id)?.(msg);
				pending.delete(msg.id);
			}
		});
		const send = async (method: string, params?: Record<string, unknown>, timeout_ms = 60_000) => {
			const id = ++next_id;
			const result = await new Promise<CdpResult>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error(`cdp timeout ${method}`)), timeout_ms);
				pending.set(id, (msg) => {
					clearTimeout(timer);
					resolve(msg);
				});
				ws.send(JSON.stringify({ id, method, params }));
			});
			if (result.error) {
				throw new Error(result.error.message || method);
			}
			return result.result ?? {};
		};

		await send('Page.enable');
		/* La plantilla la escribe un usuario: que no pueda leer archivos del
		 * contenedor ni llegar a servicios internos (SSRF) desde el PDF. */
		await send('Network.enable').catch(() => null);
		await send('Network.setBlockedURLs', { urls: PDF_BLOCKED_URLS }).catch(() => null);
		const tree = (await send('Page.getFrameTree')) as {
			frameTree?: { frame?: { id?: string } };
		};
		const frame_id = tree.frameTree?.frame?.id;
		if (!frame_id) return null;
		await send('Page.setDocumentContent', { frameId: frame_id, html });
		/* Imágenes (data URL de adjuntos, QR) y fuentes tienen que estar
		 * decodificadas antes de imprimir o salen huecos en el PDF. */
		await send('Runtime.evaluate', {
			expression: `Promise.race([
				Promise.all([
					document.fonts ? document.fonts.ready : null,
					...Array.from(document.images).map((img) => img.complete ? null : new Promise((done) => { img.onload = img.onerror = done; })),
				]),
				new Promise((done) => setTimeout(done, 8000)),
			]).then(() => true)`,
			awaitPromise: true,
		}).catch(() => null);

		const inches = paper_size_inches(options);
		const margins = pdf_margins_mm(options);
		const scale = Number(options.scale);
		const printed = (await send(
			'Page.printToPDF',
			{
				printBackground: true,
				/* El @page del documento manda: tamaño, márgenes en cada hoja y las
				 * cajas de margen (encabezado, pie, "Página X de Y"). */
				preferCSSPageSize: true,
				paperWidth: inches.width,
				paperHeight: inches.height,
				marginTop: margins.top / 25.4,
				marginBottom: margins.bottom / 25.4,
				marginLeft: margins.left / 25.4,
				marginRight: margins.right / 25.4,
				scale: Number.isFinite(scale) && scale > 0 ? Math.max(0.1, Math.min(2, scale)) : 1,
			},
			120_000,
		)) as { data?: string };
		if (!printed.data) return null;
		const bytes = Buffer.from(printed.data, 'base64');
		return looks_like_pdf(bytes) ? new Uint8Array(bytes) : null;
	} finally {
		try {
			ws.close();
		} catch {
			/* ya cerrado */
		}
		await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`).catch(() => null);
	}
}

async function wait_for_cdp(port: number, timeout_ms: number): Promise<boolean> {
	const deadline = Date.now() + timeout_ms;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`http://127.0.0.1:${port}/json/version`);
			if (res.ok) return true;
		} catch {
			/* still booting */
		}
		await Bun.sleep(50);
	}
	return false;
}

/** Pulgadas para Chromium `--paper-width` / `--paper-height`. El CLI no honra `@page` solo. */
export function chrome_paper_args(options: PdfRenderOptions = {}): string[] {
	const inches = paper_size_inches(options);
	const viewport = paper_viewport_px(options);
	return [
		`--paper-width=${inches.width}`,
		`--paper-height=${inches.height}`,
		`--window-size=${viewport.width},${viewport.height}`,
	];
}

async function print_with_chrome_cli(
	chrome: string,
	html: string,
	options: PdfRenderOptions = {},
): Promise<Uint8Array | null> {
	const stamp = crypto.randomUUID();
	const html_path = join(tmpdir(), `imperium-pdf-${stamp}.html`);
	const pdf_path = join(tmpdir(), `imperium-pdf-${stamp}.pdf`);
	try {
		await Bun.write(html_path, `\uFEFF${html}`);
		const proc = Bun.spawn(
			[
				chrome,
				'--headless=new',
				'--disable-gpu',
				'--no-sandbox',
				'--disable-dev-shm-usage',
				'--no-pdf-header-footer',
				'--force-device-scale-factor=1',
				...chrome_paper_args(options),
				`--print-to-pdf=${pdf_path}`,
				`file://${html_path}`,
			],
			{ stdout: 'ignore', stderr: 'pipe' },
		);
		const timeout = setTimeout(() => {
			try {
				proc.kill();
			} catch {
				/* already exited */
			}
		}, 60_000);
		const code = await proc.exited;
		clearTimeout(timeout);
		if (code !== 0 || !existsSync(pdf_path)) return null;
		const pdf = new Uint8Array(await Bun.file(pdf_path).arrayBuffer());
		return looks_like_pdf(pdf) ? pdf : null;
	} catch {
		return null;
	} finally {
		safe_unlink(html_path);
		safe_unlink(pdf_path);
	}
}

async function print_with_puppeteer(
	chrome: string | undefined,
	html: string,
	options: PdfRenderOptions = {},
): Promise<Uint8Array | null> {
	try {
		const puppeteer = await import('puppeteer').catch(() => null);
		if (!puppeteer) return null;
		const inches = paper_size_inches(options);
		const viewport = paper_viewport_px(options);
		const browser = await puppeteer.default.launch({
			headless: true,
			executablePath: chrome,
			args: [
				'--no-sandbox',
				'--disable-gpu',
				'--disable-dev-shm-usage',
				`--window-size=${viewport.width},${viewport.height}`,
			],
		});
		try {
			const page = await browser.newPage();
			await page.setViewport({
				width: viewport.width,
				height: viewport.height,
				deviceScaleFactor: 1,
			});
			await page.setContent(html, { waitUntil: 'domcontentloaded' });
			const margins = pdf_margins_mm(options);
			const pdf = await page.pdf({
				width: `${inches.width}in`,
				height: `${inches.height}in`,
				margin: {
					top: `${margins.top}mm`,
					right: `${margins.right}mm`,
					bottom: `${margins.bottom}mm`,
					left: `${margins.left}mm`,
				},
				printBackground: true,
				preferCSSPageSize: true,
			});
			const bytes = pdf instanceof Uint8Array ? pdf : new Uint8Array(pdf);
			return looks_like_pdf(bytes) ? bytes : null;
		} finally {
			await browser.close();
		}
	} catch {
		return null;
	}
}

function safe_unlink(path: string) {
	try {
		if (existsSync(path)) unlinkSync(path);
	} catch {
		/* temp file */
	}
}
