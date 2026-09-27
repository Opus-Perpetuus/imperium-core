import { describe, expect, test } from 'bun:test';
import {
	apply_formatter,
	code128_svg,
	collect_placeholder_uses,
	parse_template,
} from './report-template-engine.ts';
import {
	interpolate_report_records,
	interpolate_report_template,
	shrink_report_image,
	strip_report_delimiters,
	validate_report_template,
} from './reports-flow.ts';

const NOW = new Date(2026, 8, 26, 14, 5, 0);
const render = (template: string, record: Record<string, unknown>) =>
	interpolate_report_template(template, record, 'Ana', NOW);

describe('bloques', () => {
	test('#if dentro de #each se evalúa contra el elemento', async () => {
		const html = await render(
			'{{#each lineas}}<li>{{nombre}}{{#if urgente}} (urgente){{/if}}</li>{{/each}}',
			{ urgente: true, lineas: [{ nombre: 'A', urgente: false }, { nombre: 'B', urgente: true }] },
		);
		expect(html).toBe('<li>A</li><li>B (urgente)</li>');
	});

	test('{{else}} en #if y en #each vacío', async () => {
		expect(await render('{{#if pagado}}Sí{{else}}No{{/if}}', { pagado: false })).toBe('No');
		expect(await render('{{#each lineas}}x{{else}}Sin líneas{{/each}}', { lineas: [] })).toBe('Sin líneas');
		expect(await render('{{#unless activo}}Inactivo{{/unless}}', { activo: false })).toBe('Inactivo');
	});

	test('#if anidado en #if y comparaciones numéricas', async () => {
		const template = '{{#if total > 100}}{{#if total >= 500}}grande{{else}}mediano{{/if}}{{else}}chico{{/if}}';
		expect(await render(template, { total: 50 })).toBe('chico');
		expect(await render(template, { total: 150 })).toBe('mediano');
		expect(await render(template, { total: '500' })).toBe('grande');
		expect(await render('{{#if estado == "Pagado"}}ok{{/if}}', { estado: 'Pagado' })).toBe('ok');
	});

	test('@index, @number, this y ../', async () => {
		const html = await render('{{#each tags}}{{@number}}.{{this}}@{{../cliente}} {{/each}}', {
			cliente: 'Luz',
			tags: ['a', 'b'],
		});
		expect(html).toBe('1.a@Luz 2.b@Luz ');
	});

	test('cierre huérfano y bloque sin cerrar no rompen la plantilla', () => {
		expect(parse_template('a{{/if}}b')).toEqual([{ kind: 'text', text: 'a{{/if}}b' }]);
		const nodes = parse_template('{{#each x}}sin cierre');
		expect(nodes[0]).toMatchObject({ kind: 'each', path: 'x' });
	});
});

describe('valores y formatos', () => {
	test('escapa HTML salvo |html', async () => {
		expect(await render('{{nota}}', { nota: '<b>hola</b>' })).toBe('&lt;b&gt;hola&lt;/b&gt;');
		expect(await render('{{nota|html}}', { nota: '<b>hola</b>' })).toBe('<b>hola</b>');
	});

	test('referencias pobladas muestran su nombre y booleanos Sí/No', async () => {
		expect(await render('{{departamento}} / {{activo}}', { departamento: { _id: 'x', name: 'Obras' }, activo: true })).toBe(
			'Obras / Sí',
		);
	});

	test('formatos de moneda, número, fecha y texto', () => {
		expect(apply_formatter(1234.5, 'moneda', '')).toBe('$1,234.50');
		expect(apply_formatter('1234.567', 'numero', '1')).toBe('1,234.6');
		expect(apply_formatter(0.155, 'porcentaje', '')).toBe('16 %');
		expect(apply_formatter('2026-09-26', 'fecha', '')).toBe('26/09/2026');
		expect(apply_formatter('2026-09-26', 'fecha_larga', '')).toBe('26 de septiembre de 2026');
		expect(apply_formatter('josé pérez', 'capitalizar', '')).toBe('José Pérez');
		expect(apply_formatter('', 'defecto', 'N/A')).toBe('N/A');
		expect(apply_formatter('abcdefghij', 'recortar', '5')).toBe('abcd…');
	});

	test('formatos encadenados en la plantilla', async () => {
		expect(await render('{{total|numero:0|defecto:0}}', { total: 1500.4 })).toBe('1,500');
		expect(await render('{{fecha_actual|fecha}}', {})).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
	});

	test('agregados de listas', async () => {
		const record = { lineas: [{ importe: 10 }, { importe: '20.5' }, { importe: null }] };
		expect(await render('{{lineas|conteo}}', record)).toBe('3');
		expect(await render('{{lineas|suma:importe|moneda}}', record)).toBe('$30.50');
		expect(await render('{{lineas|maximo:importe}}', record)).toBe('20.5');
	});

	test('código de barras Code 128 en SVG', async () => {
		const svg = code128_svg('ABC-123');
		expect(svg).toContain('<svg class="report-barcode"');
		expect(svg).toContain('aria-label="ABC-123"');
		expect(code128_svg('ñ')).toBeNull();
		expect(await render('{{barcode:codigo}}', { codigo: 'P-1' })).toContain('<svg');
	});
});

describe('lista de registros', () => {
	test('{{#each registros}} pinta una sola tabla con todos los registros', async () => {
		const html = await interpolate_report_records(
			'<table><thead><tr><th>N</th></tr></thead><tbody>{{#each registros}}<tr><td>{{@number}} {{name}}</td></tr>{{/each}}</tbody></table><p>Total: {{total_registros}}</p>',
			[{ name: 'A' }, { name: 'B' }],
			'Ana',
			NOW,
		);
		expect((html.match(/<thead>/g) ?? []).length).toBe(1);
		expect(html).toContain('<td>1 A</td><td>2 B</td>'.replace('</td><td>', '</td></tr><tr><td>'));
		expect(html).toContain('Total: 2');
	});

	test('el alias en español del delimitador junta todos los registros', async () => {
		const html = await interpolate_report_records(
			'<i>{{name}}</i>{{reporte_delimitador}}',
			[{ name: 'A' }, { name: 'B' }, { name: 'C' }],
			'Ana',
			NOW,
		);
		expect(html).toBe('<i>A</i><i>B</i><i>C</i>');
	});

	test('el nombre del usuario se escapa', async () => {
		expect(await interpolate_report_template('{{usuario_genera}}', {}, 'Ana <b>', NOW)).toBe('Ana &lt;b&gt;');
	});

	test('con un solo registro el delimitador se quita', () => {
		expect(strip_report_delimiters('<i>A</i>{{report_item_delimiter}}')).toBe('<i>A</i>');
	});

	test('el delimitador recursivo sigue funcionando', async () => {
		const html = await interpolate_report_records(
			'<i>{{name}}</i>{{report_item_delimiter}}',
			[{ name: 'A' }, { name: 'B' }],
			'Ana',
			NOW,
		);
		expect(html).toBe('<i>A</i><i>B</i>');
	});
});

describe('imágenes', () => {
	test('una foto grande se reduce y pasa a JPEG', { timeout: 60_000 }, async () => {
		const sharp = (await import('sharp')).default;
		const big = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: '#88aacc' } })
			.png()
			.toBuffer();
		const out = await shrink_report_image(new Uint8Array(big), 'image/png');
		expect(out.mime).toBe('image/jpeg');
		const meta = await sharp(out.body).metadata();
		expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBe(1400);
	});

	test('una imagen con transparencia sigue siendo PNG', { timeout: 60_000 }, async () => {
		const sharp = (await import('sharp')).default;
		const logo = await sharp({ create: { width: 2400, height: 800, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
			.png()
			.toBuffer();
		const out = await shrink_report_image(new Uint8Array(logo), 'image/png');
		expect(out.mime).toBe('image/png');
	});
});

describe('validación', () => {
	const fields = [
		{ field_name: 'name' },
		{ field_name: 'folio' },
		{ field_name: 'cliente', is_reference: true, related_fields: [{ field_name: 'name' }] },
		{
			field_name: 'articulos',
			is_array: true,
			related_fields: [{ field_name: 'cantidad' }, { field_name: 'product.name' }],
		},
	];

	test('subcampos de un #each son válidos dentro del bloque y no fuera', () => {
		const ok = validate_report_template(
			'{{#each articulos}}{{cantidad}} {{product.name}} {{@number}} {{../folio}}{{/each}}',
			fields,
			'Pedido',
		);
		expect(ok.is_valid).toBe(true);
		const bad = validate_report_template('{{cantidad}}', fields, 'Pedido');
		expect(bad.invalid_placeholders.map((issue) => issue.placeholder)).toEqual(['cantidad']);
	});

	test('formatos, imágenes, QR y registros no cuentan como campos desconocidos', () => {
		const result = validate_report_template(
			'{{folio|mayusculas}} {{qr}} {{image:name}} {{#each registros}}{{name}}{{/each}} {{total_registros}}',
			fields,
			'Pedido',
		);
		expect(result.invalid_placeholders).toEqual([]);
	});

	test('collect_placeholder_uses reporta los #each que envuelven cada campo', () => {
		expect(collect_placeholder_uses('{{#each a}}{{#each b}}{{c}}{{/each}}{{/each}}')).toEqual([
			{ path: 'a', loops: [] },
			{ path: 'b', loops: ['a'] },
			{ path: 'c', loops: ['a', 'b'] },
		]);
	});
});
