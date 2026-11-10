import { describe, expect, test } from 'bun:test';
import {
	GROUP_REF_ALMACEN,
	GROUP_REF_SURTIDORES,
	GROUP_REF_VENDEDORES,
	GROUP_REF_VENTAS,
} from './group-access.ts';
import { pedido_estado_visible_para_grupos } from './field-values.ts';
import { pedido_fecha_order_sql, pedido_order_sql, pedido_search_predicates } from './pedidos-list-order.ts';
import { prepare_pedido_create, prepare_pedido_update } from './pedidos-flow.ts';
import type { ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';
import { decidir_sync_offline } from './pedidos-sync-offline.ts';

describe('filtro de estado del tablero', () => {
	test('almacén y surtidores ven por surtir', () => {
		expect(
			pedido_estado_visible_para_grupos('por_surtir', [GROUP_REF_ALMACEN]),
		).toBe(true);
		expect(
			pedido_estado_visible_para_grupos('por_surtir', [GROUP_REF_SURTIDORES]),
		).toBe(true);
		expect(
			pedido_estado_visible_para_grupos('por_surtir', [GROUP_REF_VENTAS]),
		).toBe(true);
	});

	test('un vendedor no ve por surtir ni surtiendo', () => {
		const refs = [GROUP_REF_VENDEDORES];
		expect(pedido_estado_visible_para_grupos('por_surtir', refs)).toBe(false);
		expect(pedido_estado_visible_para_grupos('surtiendo', refs)).toBe(false);
		expect(pedido_estado_visible_para_grupos('cancelado', refs)).toBe(true);
	});
});

describe('orden de folio', () => {
	test('folio y folio_interno comparan el sufijo como número', () => {
		expect(pedido_order_sql('"folio"', 'ASC', 'folio')).toContain('::numeric');
		expect(pedido_order_sql('"folio_interno"', 'DESC', 'folio_interno')).toContain(
			'::numeric',
		);
		expect(pedido_order_sql('"folio_interno"', 'DESC', 'folio_interno')).toContain(
			'DESC',
		);
	});
});

describe('orden por fecha', () => {
	test('una fecha vacía usa la fecha de alta', () => {
		const sql = pedido_fecha_order_sql('"fecha"', '"created_at"', 'DESC');
		expect(sql).toContain('COALESCE(NULLIF(btrim("fecha"), \'\'), "created_at") DESC');
		expect(sql).toContain('NULLS LAST');
	});
});

describe('búsqueda de pedidos', () => {
	test('el término mira observaciones y el nombre del cliente', () => {
		const parts = pedido_search_predicates('$2', {
			contacto_table: '"subject_ventas"."contacto"',
			contacto_columns: ['contacto', 'contacto_id'],
		});
		const sql = parts.join(' OR ');
		expect(sql).toContain("->> 'observaciones'");
		expect(sql).toContain('jsonb_array_elements');
		expect(sql).toContain('FROM "subject_ventas"."contacto" c');
		expect(sql).toContain('c.id = "contacto"');
		expect(sql).toContain('c.id = "contacto_id"');
		expect(sql).toContain('c.name');
		expect(sql).toContain('ILIKE $2');
	});

	test('sin tabla de contactos no une el catálogo de clientes', () => {
		const sql = pedido_search_predicates('$1').join(' ');
		expect(sql).not.toContain('c.name');
		expect(sql).toContain("->> 'observaciones'");
	});
});

function store_de_pedido(contacto?: ImperiumDoc): ImperiumStore {
	const contactos = contacto ? [contacto] : [];
	return {
		has: (resource: string) => resource === 'contacto' && contactos.length > 0,
		async find_id(resource: string, id: string) {
			if (resource !== 'contacto') return null;
			return contactos.find((row) => String(row._id) === id) ?? null;
		},
		async next_auto_increment() {
			return 7;
		},
	} as unknown as ImperiumStore;
}

describe('alta de pedido', () => {
	test('guarda fecha y el texto para buscar cliente y observación', async () => {
		const store = store_de_pedido({ _id: 'cli-1', name: 'CLIENTE PRUEBA SYNC COMERCIAL' });
		const pedido = await prepare_pedido_create(
			store,
			{
				estado: 'borrador',
				contacto: 'cli-1',
				observaciones: 'PRUEBA ALBA QR 20261107',
				articulos: [{ product: 'p-1', cantidad: 1, precio: 0, observaciones: 'nota de linea' }],
			},
			{ _id: 'admin', name: 'admin' },
		);
		expect(pedido.fecha).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(String(pedido.search_field)).toContain('CLIENTE PRUEBA SYNC COMERCIAL');
		expect(String(pedido.search_field)).toContain('PRUEBA ALBA QR 20261107');
		expect(String(pedido.search_field)).toContain('nota de linea');
	});

	test('no pisa una fecha que ya viene', async () => {
		const store = store_de_pedido();
		const pedido = await prepare_pedido_create(
			store,
			{ fecha: '2025-01-02T00:00:00.000Z', contacto: { _id: 'cli-2', name: 'Mostrador' } },
			{ _id: 'admin', name: 'admin' },
		);
		expect(pedido.fecha).toBe('2025-01-02T00:00:00.000Z');
		expect(String(pedido.search_field)).toContain('Mostrador');
	});

	test('al editar conserva la fecha ya guardada y refresca la búsqueda', async () => {
		const store = store_de_pedido({ _id: 'cli-1', name: 'CLIENTE PRUEBA SYNC COMERCIAL' });
		const pedido = await prepare_pedido_update(
			store,
			{ _id: 'ped-1', estado: 'borrador', contacto: 'cli-1', observaciones: 'nueva nota' },
			{ _id: 'admin', name: 'admin' },
			{
				_id: 'ped-1',
				fecha: '2025-12-01T00:00:00.000Z',
				contacto: 'cli-1',
				observaciones: 'vieja',
			},
		);
		expect(pedido.fecha).toBe('2025-12-01T00:00:00.000Z');
		expect(String(pedido.search_field)).toContain('CLIENTE PRUEBA SYNC COMERCIAL');
		expect(String(pedido.search_field)).toContain('nueva nota');
		expect(String(pedido.search_field)).not.toContain('vieja');
	});
});

describe('sync offline', () => {
	test('el mismo folio local no crea un segundo pedido', () => {
		expect(
			decidir_sync_offline({
				ya_existe_uuid: false,
				ya_existe_folio: true,
				folio_visto_en_lote: false,
				folio: 'Prueba Vendedor-20260927-001558',
			}),
		).toEqual({ decision: 'duplicado', motivo: 'folio' });
		expect(
			decidir_sync_offline({
				ya_existe_uuid: false,
				ya_existe_folio: false,
				folio_visto_en_lote: true,
				folio: 'Prueba Vendedor-20260927-001558',
			}),
		).toEqual({ decision: 'duplicado', motivo: 'folio' });
	});

	test('el mismo uuid sí devuelve su fila', () => {
		expect(
			decidir_sync_offline({
				ya_existe_uuid: true,
				ya_existe_folio: true,
				folio_visto_en_lote: false,
				folio: 'Prueba Vendedor-20260927-001558',
			}),
		).toEqual({ decision: 'duplicado', motivo: 'uuid' });
	});

	test('un folio vacío no se colapsa', () => {
		expect(
			decidir_sync_offline({
				ya_existe_uuid: false,
				ya_existe_folio: true,
				folio_visto_en_lote: true,
				folio: '   ',
			}),
		).toEqual({ decision: 'crear' });
	});

	test('otro uuid con otro folio sí crea', () => {
		expect(
			decidir_sync_offline({
				ya_existe_uuid: false,
				ya_existe_folio: false,
				folio_visto_en_lote: false,
				folio: 'otro-folio',
			}),
		).toEqual({ decision: 'crear' });
	});
});
