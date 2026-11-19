/**
 * #292/#293: guardar el formato oficial del pedido (API o diseñador) fallaba:
 * el validador de escritura solo conocía name/description de una referencia
 * ({{contacto.codigo}}, rfc, calle… «No existe») y no conocía `observaciones`
 * sin pedidos que la tuvieran. La siembra quitaba esos placeholders y dejaba
 * los #if sin cerrar: la tabla de partidas no se imprimía.
 */
import { describe, expect, test } from 'bun:test';
import type { ImperiumDoc } from './envelope.ts';
import seeds from './pedido-report-seeds.json';
import { assert_report_template_write, interpolate_report_template } from './reports-flow.ts';
import type { ImperiumStore } from './store.ts';

const BASE = 'id,name,description,is_active,state,ref,search_field,created_by,custom_data,payload,created_at,updated_at';
/* Columnas reales de kyostenas (subject_ventas), 2026-11-19. */
const COLUMNS: Record<string, string> = {
	pedidos: `${BASE},folio_interno,fecha,contacto,contacto_id,usuario,estado,total,iva,importe,folio,assigned_employee,init_time,end_time,sincronizado,invoice_request_id,invoice_request_name,invoice_request_estado,invoice_request_monto_total,invoice_request_actualizado,ruta,cantidad,cantidad_surtida,precio,product,price_origin,listaDePreciosId,offline_uuid,almacen`,
	contacto: `${BASE},rfc,esCliente,esProveedor,codigo,rutas,usuariosAsignados,listaDePrecios,nombre_fiscal,regimen_fiscal,uso_cfdi_default,calle,numeroInterior,numeroExterior,colonia,codigoPostal,estado,pais,ciudad,urlMaps,ubicacion,latitude,longitude`,
	employee: BASE,
};
const MODELS: Record<string, string> = { Contacto: 'contacto', Employee: 'employee' };
/* Un pedido con partidas y sin observaciones (como el de la siembra). */
const ROWS: ImperiumDoc[] = [
	{ _id: 'p1', name: 'PEDIDO-1', articulos: [{ product: 'x', cantidad: 2, cantidad_surtida: 0, precio: 100, importe: 200, observaciones: '' }] },
];

function fake_store(): ImperiumStore {
	const locs = new Map(Object.entries(COLUMNS).map(([r, cols]) => [r, { columns: cols.split(',').map((name) => ({ name, pg: 'text' })) }]));
	return {
		locs,
		has: (resource: string) => locs.has(resource),
		loc: (resource: string) => locs.get(resource)!,
		field_refs: (resource: string) => (resource === 'pedidos' ? { contacto: 'Contacto', assigned_employee: 'Employee', usuario: 'User', listaDePreciosId: 'ListaDePrecios' } : {}),
		resource_for_model: (model: string) => MODELS[model] ?? null,
		async find_many() {
			return { rows: ROWS, total: ROWS.length };
		},
	} as unknown as ImperiumStore;
}

const official = (seeds as Array<{ doc: ImperiumDoc }>).map((s) => s.doc);

describe('guardar el formato oficial del pedido (#292)', () => {
	test('Pedido y Hoja de surtido se guardan tal cual (contacto.*, observaciones, ruta)', async () => {
		expect(official.length).toBe(2);
		for (const doc of official) {
			await assert_report_template_write(fake_store(), { related_model: 'Pedidos', html_content: doc.html_content });
		}
	});

	test('un campo que no existe en la referencia sigue rechazándose', async () => {
		await expect(
			assert_report_template_write(fake_store(), { related_model: 'Pedidos', html_content: '<p>{{contacto.codgo}}</p>' }),
		).rejects.toThrow(/contacto\.codgo/);
		await expect(
			assert_report_template_write(fake_store(), { related_model: 'Pedidos', html_content: '<p>{{observacion}}</p>' }),
		).rejects.toThrow(/observacion/);
	});

	test('la plantilla guardada imprime Ruta, la tabla de partidas y los estilos de #293', async () => {
		const record = {
			name: 'PEDIDO-1', folio_interno: '76', ruta: 'QA-IA Ruta Centro',
			contacto: { _id: 'c1', name: 'QA-IA Cliente Crédito', codigo: 'C-1' },
			articulos: [{ product: { codigo: 'QAIA-001', name: 'QA-IA Pieza' }, cantidad: 2, cantidad_surtida: 0, precio: 100, importe: 200 }],
		};
		for (const doc of official) {
			const html = await interpolate_report_template(String(doc.html_content), record, 'test');
			expect(html).toMatch(/Ruta:<\/span>\s*QA-IA Ruta Centro/);
			expect(html).toContain('QAIA-001');
			expect(html).toMatch(/class="text-center report-partida"[^>]*>\s*1\s*</);
			expect(html).toMatch(/class="text-center report-cantidad">2</);
		}
	});
});
