import { describe, expect, test } from 'bun:test';
import { ImperiumStore, load_catalog_path } from './store.ts';

// En BD migradas la columna física puede ser TEXT aunque el catálogo diga `real`.
const store = new ImperiumStore({} as Bun.SQL, load_catalog_path());

describe('columnas numéricas guardadas como texto', () => {
	test('un ticket POS regresa subtotal, pagado y cambio como número', () => {
		const doc = store.flatten(
			{ id: 'abc', subtotal: '3', total_paid: '3.5', change: '0.50' },
			'pos-tickets',
		);
		expect(doc?.subtotal).toBe(3);
		expect(doc?.total_paid).toBe(3.5);
		expect(doc?.change).toBe(0.5);
	});

	test('vacío o no numérico se queda como llegó', () => {
		const doc = store.flatten({ id: 'abc', subtotal: '', change: 'n/a' }, 'pos-tickets');
		expect(doc?.subtotal).toBe('');
		expect(doc?.change).toBe('n/a');
	});

	test('una columna de texto no se convierte', () => {
		const doc = store.flatten({ id: 'abc', client_name: '123' }, 'pos-tickets');
		expect(doc?.client_name).toBe('123');
	});
});
