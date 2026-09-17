import { describe, expect, it } from 'bun:test';
import {
	apply_row_limit,
	classify_statement,
	split_statements,
} from './db-admin-sql.ts';

describe('split_statements', () => {
	it('separa por punto y coma', () => {
		expect(split_statements('SELECT 1; SELECT 2')).toEqual([
			'SELECT 1',
			'SELECT 2',
		]);
	});

	it('ignora el punto y coma dentro de una cadena', () => {
		expect(split_statements("SELECT 'a;b'")).toEqual(["SELECT 'a;b'"]);
	});

	it('ignora el punto y coma dentro de un comentario de línea', () => {
		expect(split_statements('SELECT 1 -- ; no cuenta\n')).toEqual([
			'SELECT 1 -- ; no cuenta',
		]);
	});

	it('ignora el punto y coma dentro de un comentario de bloque', () => {
		expect(split_statements('SELECT /* ; */ 1')).toEqual(['SELECT /* ; */ 1']);
	});

	it('trata los comentarios de bloque anidados como uno solo', () => {
		expect(split_statements('SELECT /* a /* b */ ; */ 1')).toEqual([
			'SELECT /* a /* b */ ; */ 1',
		]);
	});

	it('ignora el punto y coma dentro de un bloque con etiqueta', () => {
		const sql = 'DO $x$ BEGIN PERFORM 1; END $x$';
		expect(split_statements(sql)).toEqual([sql]);
	});

	it('ignora el punto y coma dentro de un identificador entrecomillado', () => {
		expect(split_statements('SELECT * FROM "raro;nombre"')).toEqual([
			'SELECT * FROM "raro;nombre"',
		]);
	});

	it('descarta el sobrante vacío tras el último punto y coma', () => {
		expect(split_statements('SELECT 1;  \n ')).toEqual(['SELECT 1']);
	});

	it('ve la segunda sentencia escondida tras un comentario', () => {
		expect(split_statements('SELECT 1 /* x */; DROP TABLE users')).toEqual([
			'SELECT 1 /* x */',
			'DROP TABLE users',
		]);
	});
});

describe('classify_statement', () => {
	it('reconoce una lectura', () => {
		const st = classify_statement('SELECT * FROM users');
		expect(st.kind).toBe('read');
		expect(st.command).toBe('SELECT');
		expect(st.needs_limit).toBe(true);
	});

	it('no pide límite si ya lo trae', () => {
		expect(classify_statement('SELECT 1 LIMIT 10').needs_limit).toBe(false);
	});

	it('no confunde un LIMIT de subconsulta con el de arriba', () => {
		const st = classify_statement(
			'SELECT * FROM (SELECT 1 LIMIT 5) AS t',
		);
		expect(st.needs_limit).toBe(true);
	});

	it('no se deja engañar por un comentario inicial', () => {
		const st = classify_statement('/* inocente */ DELETE FROM users');
		expect(st.kind).toBe('dml');
		expect(st.command).toBe('DELETE');
	});

	it('marca como escritura un CTE que borra', () => {
		const st = classify_statement(
			'WITH x AS (DELETE FROM users RETURNING *) SELECT * FROM x',
		);
		expect(st.kind).toBe('dml');
	});

	it('marca como DDL un SELECT INTO', () => {
		expect(classify_statement('SELECT * INTO copia FROM users').kind).toBe(
			'ddl',
		);
	});

	it('no confunde INSERT INTO con SELECT INTO', () => {
		expect(classify_statement('INSERT INTO users VALUES (1)').kind).toBe('dml');
	});

	it('detecta un UPDATE sin WHERE', () => {
		expect(classify_statement('UPDATE users SET a = 1').unbounded_write).toBe(
			true,
		);
	});

	it('no marca un UPDATE con WHERE', () => {
		expect(
			classify_statement('UPDATE users SET a = 1 WHERE id = 2').unbounded_write,
		).toBe(false);
	});

	it('no acepta un WHERE de subconsulta como acotamiento', () => {
		const st = classify_statement(
			'DELETE FROM users USING (SELECT id FROM baja WHERE x) AS b',
		);
		expect(st.unbounded_write).toBe(true);
	});

	it('no ve un WHERE que solo existe dentro de una cadena', () => {
		const st = classify_statement("UPDATE users SET nota = 'WHERE'");
		expect(st.unbounded_write).toBe(true);
	});

	it('clasifica DDL', () => {
		expect(classify_statement('DROP TABLE users').kind).toBe('ddl');
		expect(classify_statement('TRUNCATE users').kind).toBe('ddl');
		expect(classify_statement('ALTER TABLE users ADD c int').kind).toBe('ddl');
	});

	it('clasifica utilidades y transacciones', () => {
		expect(classify_statement('VACUUM users').kind).toBe('utility');
		expect(classify_statement('BEGIN').kind).toBe('transaction');
	});

	it('trata el texto vacío como vacío', () => {
		expect(classify_statement('   -- nada\n').kind).toBe('empty');
	});
});

describe('apply_row_limit', () => {
	it('envuelve la lectura sin límite', () => {
		const sql = apply_row_limit(classify_statement('SELECT * FROM users'), 500);
		expect(sql).toContain('LIMIT 500');
		expect(sql).toContain('imperium_consola');
	});

	it('respeta el límite que ya escribió el operador', () => {
		const st = classify_statement('SELECT * FROM users LIMIT 3');
		expect(apply_row_limit(st, 500)).toBe('SELECT * FROM users LIMIT 3');
	});

	it('envuelve un UNION entero, no solo la última rama', () => {
		const st = classify_statement('SELECT 1 UNION SELECT 2');
		const sql = apply_row_limit(st, 10);
		expect(sql.endsWith('LIMIT 10')).toBe(true);
		expect(sql).toContain('SELECT 1 UNION SELECT 2');
	});

	it('no toca una escritura', () => {
		const st = classify_statement('UPDATE users SET a = 1');
		expect(apply_row_limit(st, 10)).toBe('UPDATE users SET a = 1');
	});
});
