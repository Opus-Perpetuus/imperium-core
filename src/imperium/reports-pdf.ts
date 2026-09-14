/**
 * HTML → PDF for `/reports/generate-pdf` and generate-full-pdf.
 * Never returns HTML with a PDF content-type: the Angular client would
 * download that as `.pdf` and the reader would fail to open it.
 */
import { existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type PdfRenderOptions = {
	filename?: string;
	pageSize?: string;
	orientation?: string;
	marginTopMm?: number;
	marginRightMm?: number;
	marginBottomMm?: number;
	marginLeftMm?: number;
};

const PDF_MAGIC = '%PDF-';

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

export function wrap_html_for_pdf(
	html: string,
	options: PdfRenderOptions = {},
): string {
	const raw = typeof html === 'string' ? html.trim() : '';
	const body_match = raw.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
	const body = (body_match ? body_match[1] : raw).trim();
	const top = clamp_mm(options.marginTopMm, 10);
	const right = clamp_mm(options.marginRightMm, 10);
	const bottom = clamp_mm(options.marginBottomMm, 10);
	const left = clamp_mm(options.marginLeftMm, 10);
	const viewport = paper_viewport_px(options);
	const inches = paper_size_inches(options);
	return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
<meta name="viewport" content="width=${viewport.width}">
<title>Report</title>
<style>
html { width: ${viewport.width}px; }
body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif; background: white; color: #212529; margin: 0; width: ${viewport.width}px; padding: ${top}mm ${right}mm ${bottom}mm ${left}mm; }
img { max-width: 100%; height: auto; }
table { width: 100%; border-collapse: collapse; }
th, td { overflow-wrap: break-word; }
* { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
@page { size: ${inches.width}in ${inches.height}in; margin: 0; }
</style>
</head>
<body>
${body}
</body>
</html>`;
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
		'No se pudo generar el PDF. Instala Chrome/Chromium o define CHROME_PATH.',
	);
}

export async function html_to_pdf_response(
	html: string,
	filename?: string,
	options: PdfRenderOptions = {},
): Promise<Response> {
	const bytes = await html_to_pdf_bytes(html, options);
	const safe_name = sanitize_pdf_filename(filename || options.filename);
	return new Response(bytes, {
		headers: {
			'content-type': 'application/pdf',
			'content-disposition': `attachment; filename="${safe_name}"`,
		},
	});
}

function map_page_size(page_size?: string): string {
	const size = String(page_size || 'a4').trim().toLowerCase();
	if (size === 'letter') return 'Letter';
	if (size === 'legal') return 'Legal';
	return 'A4';
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

async function print_with_chrome_cdp(
	chrome: string,
	html: string,
	options: PdfRenderOptions = {},
): Promise<Uint8Array | null> {
	const port = 41000 + Math.floor(Math.random() * 10000);
	const proc = Bun.spawn(
		[
			chrome,
			'--headless=new',
			'--disable-gpu',
			'--no-sandbox',
			'--disable-dev-shm-usage',
			'--force-device-scale-factor=1',
			`--remote-debugging-port=${port}`,
			'about:blank',
		],
		{ stdout: 'ignore', stderr: 'pipe' },
	);
	try {
		const ready = await wait_for_cdp(port, 12_000);
		if (!ready) return null;
		const pages = (await (
			await fetch(`http://127.0.0.1:${port}/json/list`)
		).json()) as { type?: string; webSocketDebuggerUrl?: string }[];
		const page =
			pages.find((item) => item.type === 'page' && item.webSocketDebuggerUrl) ??
			pages.find((item) => item.webSocketDebuggerUrl);
		const ws_url = page?.webSocketDebuggerUrl;
		if (!ws_url) return null;

		const ws = new WebSocket(ws_url);
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
		const send = async (method: string, params?: Record<string, unknown>) => {
			const id = ++next_id;
			const result = await new Promise<CdpResult>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error(`cdp timeout ${method}`)), 20_000);
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
		const tree = (await send('Page.getFrameTree')) as {
			frameTree?: { frame?: { id?: string } };
		};
		const frame_id = tree.frameTree?.frame?.id;
		if (!frame_id) return null;
		await send('Page.setDocumentContent', { frameId: frame_id, html });

		const inches = paper_size_inches(options);
		const printed = (await send('Page.printToPDF', {
			printBackground: true,
			preferCSSPageSize: false,
			paperWidth: inches.width,
			paperHeight: inches.height,
			marginTop: 0,
			marginBottom: 0,
			marginLeft: 0,
			marginRight: 0,
		})) as { data?: string };
		ws.close();
		if (!printed.data) return null;
		const bytes = Buffer.from(printed.data, 'base64');
		return looks_like_pdf(bytes) ? new Uint8Array(bytes) : null;
	} catch {
		return null;
	} finally {
		try {
			proc.kill();
		} catch {
			/* already exited */
		}
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
			const pdf = await page.pdf({
				width: `${inches.width}in`,
				height: `${inches.height}in`,
				margin: { top: 0, right: 0, bottom: 0, left: 0 },
				printBackground: true,
				preferCSSPageSize: false,
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
