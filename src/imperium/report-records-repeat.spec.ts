import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { close_shared_pdf_browser, html_to_pdf_response, resolve_chrome_executable } from './reports-pdf.ts';
import type { ImperiumStore } from './store.ts';
import {
	REPORT_RECORD_PAGE_BREAK,
	interpolate_report_records,
	render_report_from_pages,
} from './reports-flow.ts';

// Ficha de un pedido (sin delimitador): con N pedidos marcados el PDF lleva la
// ficha N veces, una por hoja. Antes salía solo la del primero.
const FICHA = '<section class="ficha"><h1>PEDIDO {{folio_interno}}</h1><p>{{name}}</p></section>';
const PEDIDOS = [
	{ folio_interno: 101, name: 'Pedido A' },
	{ folio_interno: 102, name: 'Pedido B' },
	{ folio_interno: 103, name: 'Pedido C' },
];
setDefaultTimeout(90_000);
afterAll(close_shared_pdf_browser);

const NOW = new Date(2026, 10, 18, 12, 0, 0);
/** Sin productos instalados: render_report_from_pages no hidrata nada. */
const store = { has: () => false, is_resource_installed: () => false } as unknown as ImperiumStore;

async function* paginas(docs: Record<string, unknown>[]) {
	yield docs as never;
}

const fichas = (html: string) => html.match(/<section class="ficha">/g)?.length ?? 0;

describe('ficha por registro con varios seleccionados', () => {
	test('render_report_from_pages repite la ficha por pedido, cada una en su hoja', async () => {
		const out = await render_report_from_pages(store, FICHA, paginas(PEDIDOS), 'Ana', NOW, {});
		expect(out.count).toBe(3);
		expect(fichas(out.html)).toBe(3);
		expect(out.html.split(REPORT_RECORD_PAGE_BREAK).length).toBe(3);
		for (const p of PEDIDOS) expect(out.html).toContain(`PEDIDO ${p.folio_interno}`);
		expect(out.html.endsWith(REPORT_RECORD_PAGE_BREAK)).toBeFalse();
	});

	test('con un solo pedido no agrega saltos', async () => {
		const out = await render_report_from_pages(store, FICHA, paginas(PEDIDOS.slice(0, 1)), 'Ana', NOW, {});
		expect(out.html).not.toContain(REPORT_RECORD_PAGE_BREAK);
		expect(fichas(out.html)).toBe(1);
	});

	test('interpolate_report_records hace lo mismo', async () => {
		const html = await interpolate_report_records(FICHA, PEDIDOS, 'Ana', NOW);
		expect(fichas(html)).toBe(3);
		expect(html).toContain('PEDIDO 103');
	});

	test('una plantilla con delimitador sigue usando su delimitador', async () => {
		const html = await interpolate_report_records('<p>{{name}}</p>{{report_item_delimiter}}', PEDIDOS, 'Ana', NOW);
		expect(html).toBe('<p>Pedido A</p><p>Pedido B</p><p>Pedido C</p>');
	});
});

test('el PDF de 3 pedidos sale con 3 hojas, una ficha por hoja (#261)', async () => {
	if (!resolve_chrome_executable()) throw new Error('Chrome/Chromium is required to generate PDFs');
	const out = await render_report_from_pages(store, FICHA, paginas(PEDIDOS), 'Ana', NOW, {});
	const res = await html_to_pdf_response(out.html, 'pedidos.pdf', { pageSize: 'letter' });
	const tmp = `/tmp/imperium-261-${Date.now()}.pdf`;
	await Bun.write(tmp, new Uint8Array(await res.arrayBuffer()));
	const info = await Bun.$`pdfinfo ${tmp}`.text();
	expect(Number(info.match(/Pages:\s+(\d+)/)?.[1])).toBe(3);
	for (let page = 1; page <= 3; page++) {
		const text = await Bun.$`pdftotext -f ${page} -l ${page} ${tmp} -`.text();
		expect(text).toContain(`PEDIDO ${100 + page}`);
	}
});
