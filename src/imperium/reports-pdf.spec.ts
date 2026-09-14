import { describe, expect, test } from 'bun:test';
import {
	chrome_paper_args,
	html_to_pdf_response,
	looks_like_pdf,
	resolve_chrome_executable,
	sanitize_pdf_filename,
	wrap_html_for_pdf,
} from './reports-pdf.ts';

describe('wrap_html_for_pdf', () => {
	test('wraps a list-export fragment in a full document with @page', () => {
		const html = wrap_html_for_pdf(
			`<style>.t td{border:1px solid #ccc}</style><section><table><tr><td>RC-1</td></tr></table></section>`,
			{ orientation: 'landscape', pageSize: 'a4' },
		);
		expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
		expect(html).toContain('@page { size: 11.69in 8.27in; margin: 0; }');
		expect(html).toContain('padding: 10mm 10mm 10mm 10mm');
		expect(html).toContain('table { width: 100%; border-collapse: collapse; }');
		expect(html).not.toContain('overflow-wrap: anywhere');
		expect(html).not.toContain('table-layout: fixed');
		expect(html).not.toContain('width=device-width');
		expect(html).toContain('width=1122');
		expect(html).toContain('<td>RC-1</td>');
		expect(html).not.toMatch(/<html[\s\S]*<html/i);
	});

	test('extracts body from a full HTML document instead of nesting html/html', () => {
		const html = wrap_html_for_pdf(
			`<!DOCTYPE html><html><head></head><body><h1>Hola</h1></body></html>`,
		);
		expect(html).toContain('<h1>Hola</h1>');
		expect((html.match(/<html/gi) ?? []).length).toBe(1);
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
});
