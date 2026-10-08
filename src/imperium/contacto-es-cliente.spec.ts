import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { ImperiumStore } from './store.ts';

const CATALOG = join(import.meta.dir, '../../catalog.json');
const CONTACT_ID = 'sync-comercial-contacto-20260918';

type Row = Record<string, unknown>;

class LegacyTextBooleanSql {
	columns = new Map<string, string>();
	rows = new Map<string, Row>();

	async unsafe(sql: string, params: unknown[] = []): Promise<unknown[]> {
		const text = sql.replace(/\s+/g, ' ').trim();
		const added = text.match(
			/ALTER TABLE "([^"]+)"\."([^"]+)" ADD COLUMN IF NOT EXISTS "([^"]+)" ([A-Za-z ]+)/,
		);
		if (added) {
			const key = column_key(added[1]!, added[2]!, added[3]!);
			if (!this.columns.has(key)) this.columns.set(key, sql_type(added[4]!));
			return [];
		}
		if (text.startsWith('SELECT data_type FROM information_schema.columns')) {
			const key = column_key(String(params[0]), String(params[1]), String(params[2]));
			const data_type = this.columns.get(key);
			return data_type ? [{ data_type }] : [];
		}
		const altered = text.match(
			/ALTER TABLE "([^"]+)"\."([^"]+)" ALTER COLUMN "([^"]+)" TYPE BOOLEAN/i,
		);
		if (altered) {
			const key = column_key(altered[1]!, altered[2]!, altered[3]!);
			this.columns.set(key, 'boolean');
			for (const row of this.rows.values()) {
				if (altered[3]! in row) row[altered[3]!] = coerce_stored_boolean(row[altered[3]!]);
			}
			return [];
		}
		const selected = text.match(/^SELECT \* FROM "[^"]+"\."[^"]+" WHERE id = \$1/i);
		if (selected) {
			const row = this.rows.get(String(params[0]));
			return row ? [{ ...row }] : [];
		}
		const updated = text.match(
			/^UPDATE "([^"]+)"\."([^"]+)" SET (.+) WHERE id = \$(\d+) RETURNING \*/i,
		);
		if (updated) {
			const schema = updated[1]!;
			const table = updated[2]!;
			const id = String(params[Number(updated[4]) - 1]);
			const row = this.rows.get(id);
			if (!row) return [];
			for (const assign of updated[3]!.matchAll(/"([^"]+)" = \$(\d+)/g)) {
				const column = assign[1]!;
				const value = params[Number(assign[2]) - 1];
				const kind = this.column_type(schema, table, column);
				if (kind === 'text' && typeof value === 'boolean') {
					throw Object.assign(
						new Error(
							`column "${column}" is of type text but expression is of type boolean`,
						),
						{ errno: '42804' },
					);
				}
				row[column] = value;
			}
			return [{ ...row }];
		}
		return [];
	}

	private column_type(schema: string, table: string, column: string): string {
		const known = this.columns.get(column_key(schema, table, column));
		if (known) return known;
		if (column === 'is_active') return 'boolean';
		if (column === 'payload' || column === 'custom_data') return 'jsonb';
		return 'text';
	}
}

function column_key(schema: string, table: string, column: string): string {
	return `${schema}.${table}.${column}`;
}

function sql_type(raw: string): string {
	const type = raw.trim().toUpperCase();
	if (type.startsWith('BOOL')) return 'boolean';
	if (type.startsWith('DOUBLE') || type === 'REAL') return 'double precision';
	if (type.startsWith('JSONB') || type === 'JSON') return 'jsonb';
	return 'text';
}

function coerce_stored_boolean(value: unknown): unknown {
	if (value == null) return null;
	if (typeof value === 'boolean') return value;
	const text = String(value).trim().toLowerCase();
	if (['true', 't', '1', 'yes', 'si', 'sí'].includes(text)) return true;
	if (text === '') return null;
	return false;
}

function legacy_contact_sql(): LegacyTextBooleanSql {
	const sql = new LegacyTextBooleanSql();
	sql.columns.set('subject_ventas.contacto.esCliente', 'text');
	sql.columns.set('subject_ventas.contacto.esProveedor', 'text');
	sql.rows.set(CONTACT_ID, {
		id: CONTACT_ID,
		name: 'CLIENTE PRUEBA SYNC COMERCIAL',
		rfc: '',
		nombre_fiscal: '',
		esCliente: false,
		esProveedor: false,
		facturacion_dividida_habilitada: false,
		facturacion_dividida_monto_maximo: 2000,
		facturacion_requiere_autorizacion_cobranza: false,
		is_active: true,
		payload: {},
	});
	return sql;
}

describe('contacto Es Cliente', () => {
	test('guardar SI persiste el boolean y no pisa el resto del contacto', async () => {
		const sql = legacy_contact_sql();
		const store = new ImperiumStore(sql as unknown as Bun.SQL, CATALOG);
		await store.ensure_catalog_columns();
		const saved = await store.update('contacto', CONTACT_ID, {
			name: 'CLIENTE PRUEBA SYNC COMERCIAL',
			esCliente: true,
			rfc: 'XAXX010101000',
			nombre_fiscal: 'CLIENTE PRUEBA SYNC COMERCIAL',
			facturacion_dividida_habilitada: true,
			facturacion_dividida_monto_maximo: 2000,
			facturacion_requiere_autorizacion_cobranza: true,
		});
		expect(saved?.esCliente).toBe(true);
		expect(saved?.esProveedor).toBe(false);
		expect(saved?.rfc).toBe('XAXX010101000');
		expect(saved?.nombre_fiscal).toBe('CLIENTE PRUEBA SYNC COMERCIAL');
		expect(saved?.facturacion_dividida_habilitada).toBe(true);
		expect(saved?.facturacion_requiere_autorizacion_cobranza).toBe(true);
		expect(saved?.facturacion_dividida_monto_maximo).toBe(2000);

		const again = await store.find_id('contacto', CONTACT_ID);
		expect(again?.esCliente).toBe(true);
		expect(again?.rfc).toBe('XAXX010101000');
	});

	test('un sí guardado como texto true se lee como boolean al recargar', async () => {
		const sql = legacy_contact_sql();
		sql.rows.get(CONTACT_ID)!.esCliente = 'true';
		const store = new ImperiumStore(sql as unknown as Bun.SQL, CATALOG);
		await store.ensure_catalog_columns();
		const again = await store.find_id('contacto', CONTACT_ID);
		expect(again?.esCliente).toBe(true);
	});

	test('el detalle lee Es Proveedor texto true como sí, y el vacío como no', async () => {
		const sql = legacy_contact_sql();
		const row = sql.rows.get(CONTACT_ID)!;
		row.esProveedor = 'true';
		row.esCliente = 'false';
		const store = new ImperiumStore(sql as unknown as Bun.SQL, CATALOG);
		const detail = await store.find_id('contacto', CONTACT_ID);
		expect(detail?.esProveedor).toBe(true);
		expect(detail?.esCliente).toBe(false);

		row.esProveedor = '';
		const empty = await store.find_id('contacto', CONTACT_ID);
		expect(empty?.esProveedor).toBe(false);
	});

	test('guardar Es Proveedor en sí se lee igual en el detalle', async () => {
		const sql = legacy_contact_sql();
		const store = new ImperiumStore(sql as unknown as Bun.SQL, CATALOG);
		await store.ensure_catalog_columns();
		const saved = await store.update('contacto', CONTACT_ID, {
			name: 'CLIENTE PRUEBA SYNC COMERCIAL',
			esProveedor: true,
		});
		expect(saved?.esProveedor).toBe(true);
		const detail = await store.find_id('contacto', CONTACT_ID);
		expect(detail?.esProveedor).toBe(true);
		expect(detail?.esCliente).toBe(false);
	});
});
