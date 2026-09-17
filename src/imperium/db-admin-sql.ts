/**
 * Lectura de SQL escrito a mano para la consola del gestor de base de datos.
 *
 * Nada de esto es la frontera de seguridad —esa la pone Postgres con
 * `SET LOCAL ROLE` + `READ ONLY` en `db-admin-console.ts`— pero sí decide qué
 * se le dice al operador antes de correr y qué queda en la bitácora.
 *
 * Por eso se tokeniza de verdad en vez de buscar palabras: `--`, `/* *\/`,
 * cadenas, identificadores entre comillas y `$$ ... $$` esconden todos los
 * puntos y coma y todas las palabras clave que un `split(';')` o un
 * `startsWith('SELECT')` interpretarían al revés.
 */

/** Tramo del texto ya clasificado; el que importa es `code`. */
type Chunk = { kind: 'code' | 'noise'; text: string; start: number };

export type StatementKind =
	| 'read'
	| 'dml'
	| 'ddl'
	| 'utility'
	| 'transaction'
	| 'empty';

export type ParsedStatement = {
	/** Texto de la sentencia, sin el punto y coma final ni espacios sobrantes. */
	sql: string;
	kind: StatementKind;
	/** Primera palabra clave en mayúsculas (`SELECT`, `WITH`, `UPDATE`…). */
	command: string;
	/** `UPDATE`/`DELETE` sin `WHERE` a nivel superior. */
	unbounded_write: boolean;
	/** `SELECT`/`WITH` sin `LIMIT` a nivel superior. */
	needs_limit: boolean;
};

const DDL = new Set([
	'CREATE',
	'ALTER',
	'DROP',
	'TRUNCATE',
	'COMMENT',
	'GRANT',
	'REVOKE',
	'SECURITY',
	'IMPORT',
	'REASSIGN',
]);

const DML = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'COPY']);

const READ = new Set(['SELECT', 'WITH', 'TABLE', 'VALUES', 'SHOW', 'EXPLAIN']);

const TRANSACTION = new Set([
	'BEGIN',
	'COMMIT',
	'ROLLBACK',
	'START',
	'SAVEPOINT',
	'RELEASE',
	'END',
	'ABORT',
	'PREPARE',
]);

/**
 * Parte el texto en tramos de código y de "ruido" (comentarios y literales).
 *
 * El ruido se conserva —hay que devolver la sentencia tal cual la escribió el
 * operador— pero nunca se mira para decidir nada.
 */
function scan(text: string): Chunk[] {
	const chunks: Chunk[] = [];
	let code_start = 0;
	let i = 0;

	const flush_code = (end: number) => {
		if (end > code_start) {
			chunks.push({
				kind: 'code',
				text: text.slice(code_start, end),
				start: code_start,
			});
		}
	};

	while (i < text.length) {
		const two = text.slice(i, i + 2);

		if (two === '--') {
			flush_code(i);
			const nl = text.indexOf('\n', i);
			const end = nl === -1 ? text.length : nl;
			chunks.push({ kind: 'noise', text: text.slice(i, end), start: i });
			i = end;
			code_start = i;
			continue;
		}

		if (two === '/*') {
			flush_code(i);
			// Postgres anida los comentarios de bloque, a diferencia de SQL
			// estándar: `/* /* */ */` es UN comentario, y cortar en el primer
			// `*/` dejaría el resto como código.
			let depth = 1;
			let j = i + 2;
			while (j < text.length && depth > 0) {
				if (text.slice(j, j + 2) === '/*') {
					depth += 1;
					j += 2;
				} else if (text.slice(j, j + 2) === '*/') {
					depth -= 1;
					j += 2;
				} else {
					j += 1;
				}
			}
			chunks.push({ kind: 'noise', text: text.slice(i, j), start: i });
			i = j;
			code_start = i;
			continue;
		}

		const ch = text[i]!;

		if (ch === "'" || ch === '"') {
			flush_code(i);
			let j = i + 1;
			while (j < text.length) {
				if (text[j] === ch) {
					// Comilla duplicada: sigue dentro del literal.
					if (text[j + 1] === ch) {
						j += 2;
						continue;
					}
					j += 1;
					break;
				}
				// `E'\''` — la barra invertida escapa dentro de cadenas.
				if (ch === "'" && text[j] === '\\') {
					j += 2;
					continue;
				}
				j += 1;
			}
			chunks.push({ kind: 'noise', text: text.slice(i, j), start: i });
			i = j;
			code_start = i;
			continue;
		}

		if (ch === '$') {
			const tag = dollar_tag(text, i);
			if (tag) {
				flush_code(i);
				const close = text.indexOf(tag, i + tag.length);
				const j = close === -1 ? text.length : close + tag.length;
				chunks.push({ kind: 'noise', text: text.slice(i, j), start: i });
				i = j;
				code_start = i;
				continue;
			}
		}

		i += 1;
	}

	flush_code(text.length);
	return chunks;
}

/** `$$` o `$etiqueta$` en la posición dada, si lo hay. */
function dollar_tag(text: string, at: number): string | null {
	const match = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(text.slice(at));
	return match ? match[0] : null;
}

/**
 * Separa el texto en sentencias por los `;` que están fuera de literales,
 * comentarios y bloques `$$`.
 */
export function split_statements(text: string): string[] {
	const chunks = scan(text);
	const cuts: number[] = [];
	for (const chunk of chunks) {
		if (chunk.kind !== 'code') continue;
		for (let k = 0; k < chunk.text.length; k += 1) {
			if (chunk.text[k] === ';') cuts.push(chunk.start + k);
		}
	}
	const out: string[] = [];
	let from = 0;
	for (const cut of cuts) {
		out.push(text.slice(from, cut));
		from = cut + 1;
	}
	out.push(text.slice(from));
	return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Palabras clave a nivel superior, en mayúsculas y con la profundidad de paréntesis. */
function keywords(text: string): Array<{ word: string; depth: number }> {
	const out: Array<{ word: string; depth: number }> = [];
	let depth = 0;
	for (const chunk of scan(text)) {
		if (chunk.kind !== 'code') continue;
		let word = '';
		for (const ch of chunk.text) {
			if (/[A-Za-z_]/.test(ch)) {
				word += ch;
				continue;
			}
			if (word) {
				out.push({ word: word.toUpperCase(), depth });
				word = '';
			}
			if (ch === '(') depth += 1;
			else if (ch === ')') depth = Math.max(0, depth - 1);
		}
		if (word) out.push({ word: word.toUpperCase(), depth });
	}
	return out;
}

/**
 * Clasifica una sentencia.
 *
 * `WITH x AS (DELETE … RETURNING *) SELECT …` empieza por `WITH` y escribe: la
 * palabra inicial no basta, hay que mirar si aparece DML dentro del CTE.
 */
export function classify_statement(sql: string): ParsedStatement {
	const trimmed = sql.trim().replace(/;+\s*$/, '').trim();
	const words = keywords(trimmed);
	const first = words[0]?.word ?? '';

	if (!trimmed || !first) {
		return {
			sql: trimmed,
			kind: 'empty',
			command: '',
			unbounded_write: false,
			needs_limit: false,
		};
	}

	let kind: StatementKind;
	if (DDL.has(first)) kind = 'ddl';
	else if (DML.has(first)) kind = 'dml';
	else if (TRANSACTION.has(first)) kind = 'transaction';
	else if (READ.has(first)) {
		// Un CTE que escribe sigue siendo escritura, venga como venga.
		kind = words.some((w) => DML.has(w.word) || DDL.has(w.word))
			? 'dml'
			: 'read';
	} else kind = 'utility';

	// `SELECT … INTO nueva_tabla` crea una tabla con cara de lectura.
	if (kind === 'read' && first === 'SELECT') {
		const into = words.findIndex((w) => w.word === 'INTO' && w.depth === 0);
		if (into >= 0) kind = 'ddl';
	}

	const top = words.filter((w) => w.depth === 0).map((w) => w.word);
	const unbounded_write =
		(first === 'UPDATE' || first === 'DELETE') && !top.includes('WHERE');
	const needs_limit =
		kind === 'read' &&
		(first === 'SELECT' || first === 'WITH' || first === 'TABLE') &&
		!top.includes('LIMIT') &&
		!top.includes('FETCH');

	return { sql: trimmed, kind, command: first, unbounded_write, needs_limit };
}

/**
 * Envuelve una lectura sin `LIMIT` para que no se traiga la tabla entera.
 *
 * Se envuelve en vez de concatenar ` LIMIT n` porque concatenar rompe con
 * `UNION`, `ORDER BY` de la última rama y comentarios al final.
 */
export function apply_row_limit(statement: ParsedStatement, limit: number): string {
	if (!statement.needs_limit) return statement.sql;
	return `SELECT * FROM (\n${statement.sql}\n) AS "imperium_consola" LIMIT ${Math.trunc(limit)}`;
}
