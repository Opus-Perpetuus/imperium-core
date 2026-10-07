import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
	chrome_paper_args,
	close_shared_pdf_browser,
	html_to_pdf_bytes,
	html_to_pdf_response,
	paper_size_inches,
	pdf_content_disposition,
	pdf_options_from_input,
	looks_like_pdf,
	resolve_chrome_executable,
	sanitize_pdf_filename,
	wrap_html_for_pdf,
} from './reports-pdf.ts';

/* Los casos con Chrome real tardan más con la máquina cargada. */
setDefaultTimeout(90_000);
/* bun test no emite 'exit': sin esto el Chrome compartido queda huérfano. */
afterAll(close_shared_pdf_browser);

describe('wrap_html_for_pdf', () => {
	test('wraps a list-export fragment in a full document with @page margins', () => {
		const html = wrap_html_for_pdf(
			`<style>.t td{border:1px solid #ccc}</style><section><table><tr><td>RC-1</td></tr></table></section>`,
			{ orientation: 'landscape', pageSize: 'a4' },
		);
		expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
		expect(html).toContain('size: 11.69in 8.27in;');
		/* Márgenes de hoja (se repiten en cada página), no padding del body. */
		expect(html).toContain('margin: 10mm 10mm 10mm 10mm;');
		expect(html).not.toMatch(/\nbody \{[^}]*padding/);
		expect(html).toContain('thead { display: table-header-group; }');
		expect(html).toContain('<td>RC-1</td>');
		expect(html).not.toMatch(/<html[\s\S]*<html/i);
	});

	test('keeps <style> from the head of a full document', () => {
		const html = wrap_html_for_pdf(
			`<html><head><style>.logo{color:red}</style></head><body><p class="logo">x</p></body></html>`,
		);
		expect(html).toContain('.logo{color:red}');
	});

	test('turns designer page breaks into CSS breaks', () => {
		const html = wrap_html_for_pdf('<p>a</p><!--designer-page-break--><p>b</p>');
		expect(html).toContain('<p>a</p><div class="report-page-break"></div><p>b</p>');
	});

	test('page numbers and footer text go into @page margin boxes', () => {
		const html = wrap_html_for_pdf('<p>x</p>', {
			pageNumbers: true,
			footerText: 'Reporte "A"',
			marginBottomMm: 4,
		});
		expect(html).toContain('@bottom-right { content: "Página " counter(page) " de " counter(pages);');
		expect(html).toContain('@bottom-left { content: "Reporte \\"A\\"";');
		/* Con pie hace falta margen para que se vea. */
		expect(html).toContain('margin: 10mm 10mm 10mm 10mm;');
	});

	test('extracts body from a full HTML document instead of nesting html/html', () => {
		const html = wrap_html_for_pdf(
			`<!DOCTYPE html><html><head></head><body><h1>Hola</h1></body></html>`,
		);
		expect(html).toContain('<h1>Hola</h1>');
		expect((html.match(/<html/gi) ?? []).length).toBe(1);
	});
});

describe('paper_size_inches', () => {
	test('custom size in mm (credencial 85.6 × 53.98)', () => {
		expect(paper_size_inches({ pageSize: 'custom', widthMm: 85.6, heightMm: 53.98 })).toEqual({
			width: 3.3701,
			height: 2.1252,
		});
		expect(
			paper_size_inches({ pageSize: 'custom', widthMm: 85.6, heightMm: 53.98, orientation: 'landscape' }),
		).toEqual({ width: 2.1252, height: 3.3701 });
	});
});

describe('pdf_options_from_input', () => {
	test('reads a stored reports-pdf-setting row', () => {
		expect(
			pdf_options_from_input({
				page_size_preset: 'custom',
				custom_width_mm: 50.8,
				custom_height_mm: 63.5,
				margin_top_mm: 0,
				display_header_footer: true,
				scale_percent: 90,
			}),
		).toMatchObject({
			pageSize: 'custom',
			widthMm: 50.8,
			heightMm: 63.5,
			marginTopMm: 0,
			pageNumbers: true,
			scale: 0.9,
		});
	});
});

describe('pdf_content_disposition', () => {
	test('keeps accents in filename* and an ASCII fallback', () => {
		const header = pdf_content_disposition('Credencial José Núñez.pdf');
		expect(header).toContain('filename="Credencial_Jose_Nunez.pdf"');
		expect(header).toContain(`filename*=UTF-8''${encodeURIComponent('Credencial_José_Núñez.pdf')}`);
	});
});

describe('chrome_paper_args', () => {
	test('uses A4 landscape inches so Chrome does not clip the table', () => {
		expect(chrome_paper_args({ orientation: 'landscape', pageSize: 'a4' })).toEqual([
			'--paper-width=11.69',
			'--paper-height=8.27',
			'--window-size=1122,794',
		]);
		expect(chrome_paper_args({ orientation: 'portrait', pageSize: 'a4' })).toEqual([
			'--paper-width=8.27',
			'--paper-height=11.69',
			'--window-size=794,1122',
		]);
	});
});

describe('sanitize_pdf_filename', () => {
	test('strips quotes and path separators', () => {
		expect(sanitize_pdf_filename('a/"b\\c.pdf')).toBe('abc.pdf');
		expect(sanitize_pdf_filename('reporte')).toBe('reporte.pdf');
	});
});

describe('looks_like_pdf', () => {
	test('accepts %PDF- magic and rejects HTML', () => {
		expect(looks_like_pdf(Buffer.from('%PDF-1.4\n'))).toBe(true);
		expect(looks_like_pdf(Buffer.from('<html><body>no</body></html>'))).toBe(
			false,
		);
	});
});

describe('html_to_pdf_response', () => {
	test('returns a real PDF, never HTML labeled as PDF', async () => {
		if (!resolve_chrome_executable()) {
			throw new Error('Chrome/Chromium is required to generate list PDFs');
		}
		const res = await html_to_pdf_response(
			`<style>.view-list-pdf-export td{border:1px solid #ccc}</style>
			<section class="view-list-pdf-export">
				<h1>Reportes ciudadanos</h1>
				<table><thead><tr><th>Folio</th></tr></thead>
				<tbody><tr><td>RC-1</td></tr></tbody></table>
			</section>`,
			'reportes-ciudadanos.pdf',
			{ orientation: 'landscape' },
		);
		expect(res.headers.get('content-type')).toContain('application/pdf');
		expect(res.headers.get('content-type')).not.toContain('text/html');
		const bytes = new Uint8Array(await res.arrayBuffer());
		expect(looks_like_pdf(bytes)).toBe(true);
		expect(bytes.byteLength).toBeGreaterThan(100);
	});

	test('landscape list PDF is wide enough that the last column is not clipped', async () => {
		if (!resolve_chrome_executable()) {
			throw new Error('Chrome/Chromium is required to generate list PDFs');
		}
		const headers = ['Folio', 'Estado', 'Ciudadano', 'Direccion', 'Telefono', 'Descripcion', 'Empleado', 'Asignado'];
		const cells = ['AGP-100', 'Pendiente', 'Juan Perez', 'Calle 1 colonia centro', '3311111111', 'Fuga de agua', 'Jannet De Anda', 'ASIGNADOX'];
		const html = `<section class="view-list-pdf-export"><table><thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody><tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr></tbody></table></section>`;
		const res = await html_to_pdf_response(html, 'lista.pdf', {
			orientation: 'landscape',
			pageSize: 'a4',
		});
		const bytes = new Uint8Array(await res.arrayBuffer());
		expect(looks_like_pdf(bytes)).toBe(true);
		const latin = Buffer.from(bytes).toString('latin1');
		const box = latin.match(/\/MediaBox\s*\[\s*[\d.]+\s+[\d.]+\s+([\d.]+)\s+([\d.]+)\s*\]/);
		expect(box).toBeTruthy();
		const width = Number(box![1]);
		const height = Number(box![2]);
		expect(width).toBeGreaterThan(height);
		const tmp = `/tmp/imperium-pdf-spec-${Date.now()}.pdf`;
		await Bun.write(tmp, bytes);
		const text = await Bun.$`pdftotext -layout ${tmp} -`.text();
		expect(text).toContain('ASIGNADOX');
	});

	test('keeps Spanish accents and landscape MediaBox', async () => {
		if (!resolve_chrome_executable()) {
			throw new Error('Chrome/Chromium is required to generate list PDFs');
		}
		const html = `<section><h1>Fecha de creación</h1><p>Miércoles 9, septiembre 2026. Teléfono y dirección de Nicolás.</p></section>`;
		const res = await html_to_pdf_response(html, 'acentos.pdf', {
			orientation: 'landscape',
			pageSize: 'a4',
			marginTopMm: 12,
			marginRightMm: 12,
			marginBottomMm: 12,
			marginLeftMm: 12,
		});
		const bytes = new Uint8Array(await res.arrayBuffer());
		expect(looks_like_pdf(bytes)).toBe(true);
		const latin = Buffer.from(bytes).toString('latin1');
		const box = latin.match(/\/MediaBox\s*\[\s*[\d.]+\s+[\d.]+\s+([\d.]+)\s+([\d.]+)\s*\]/);
		expect(box).toBeTruthy();
		expect(Number(box![1])).toBeGreaterThan(Number(box![2]));
		const tmp = `/tmp/imperium-pdf-accent-${Date.now()}.pdf`;
		await Bun.write(tmp, bytes);
		const text = await Bun.$`pdftotext -layout ${tmp} -`.text();
		expect(text).toContain('Miércoles');
		expect(text).toContain('creación');
		expect(text).toContain('Nicolás');
		expect(text).not.toContain('MiÃ©');
		expect(text).not.toContain('creaciÃ');
	});

	test('every page keeps its top margin (multi-page list)', async () => {
		const rows = Array.from({ length: 120 }, (_, i) => `<tr><td>Fila ${i + 1}</td></tr>`).join('');
		const bytes = await html_to_pdf_bytes(`<table><thead><tr><th>Encabezado</th></tr></thead><tbody>${rows}</tbody></table>`, {
			marginTopMm: 30,
			marginBottomMm: 30,
			pageNumbers: true,
		});
		const tmp = `/tmp/imperium-pdf-margins-${Date.now()}.pdf`;
		await Bun.write(tmp, bytes);
		const pages = Number((await Bun.$`pdfinfo ${tmp}`.text()).match(/Pages:\s+(\d+)/)![1]);
		expect(pages).toBeGreaterThan(1);
		/* Página 2: el encabezado de la tabla se repite y arranca debajo del margen. */
		const bbox = await Bun.$`pdftotext -f 2 -l 2 -bbox ${tmp} -`.text();
		const header = bbox.match(/yMin="([\d.]+)"[^>]*>Encabezado</);
		expect(header).toBeTruthy();
		expect(Number(header![1])).toBeGreaterThan((30 / 25.4) * 72 - 2);
		const text = await Bun.$`pdftotext -layout ${tmp} -`.text();
		expect(text).toContain(`Página 2 de ${pages}`);
	});

	test('custom sheet size reaches the PDF MediaBox', async () => {
		const bytes = await html_to_pdf_bytes('<p>Credencial</p>', {
			pageSize: 'custom',
			widthMm: 85.6,
			heightMm: 53.98,
			marginTopMm: 0,
			marginRightMm: 0,
			marginBottomMm: 0,
			marginLeftMm: 0,
		});
		const latin = Buffer.from(bytes).toString('latin1');
		const box = latin.match(/\/MediaBox\s*\[\s*[\d.]+\s+[\d.]+\s+([\d.]+)\s+([\d.]+)\s*\]/);
		expect(Math.round(Number(box![1]))).toBe(243);
		expect(Math.round(Number(box![2]))).toBe(153);
	});
});

describe('Chrome compartido de los PDF', () => {
	test('muere con el proceso que lo lanzó aunque no haya pasado su tiempo de inactividad', async () => {
		if (!resolve_chrome_executable()) {
			throw new Error('Chrome/Chromium is required to generate list PDFs');
		}
		/* Un proceso aparte imprime un PDF, lista sus hijos (el Chrome compartido)
		 * y sale; bun test terminaba igual y dejaba ese Chrome huérfano. */
		const script = `
			import { readdirSync, readFileSync } from 'node:fs';
			import { html_to_pdf_bytes } from ${JSON.stringify(`${import.meta.dir}/reports-pdf.ts`)};
			await html_to_pdf_bytes('<p>Hola</p>');
			const hijos = readdirSync('/proc/self/task').flatMap((tid) =>
				readFileSync(\`/proc/self/task/\${tid}/children\`, 'utf8').trim().split(/\\s+/).filter(Boolean),
			);
			console.log(hijos.join(' '));
		`;
		const child = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'ignore' });
		const salida = await new Response(child.stdout).text();
		expect(await child.exited).toBe(0);
		const pids = salida.trim().split(/\s+/).filter(Boolean).map(Number);
		expect(pids.length).toBeGreaterThan(0);
		const vivo = (pid: number) => {
			try {
				return !readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.startsWith('Z');
			} catch {
				return false;
			}
		};
		const limite = Date.now() + 10_000;
		while (pids.some(vivo) && Date.now() < limite) await Bun.sleep(200);
		expect(pids.filter(vivo)).toEqual([]);
	});
});
