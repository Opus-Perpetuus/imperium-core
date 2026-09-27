import { describe, expect, test } from 'bun:test';
import {
	GROUP_REF_ALMACEN,
	GROUP_REF_SURTIDORES,
	GROUP_REF_VENDEDORES,
	GROUP_REF_VENTAS,
} from './group-access.ts';
import { pedido_estado_visible_para_grupos } from './field-values.ts';
import { pedido_order_sql } from './pedidos-list-order.ts';
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
