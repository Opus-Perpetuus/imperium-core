/**
 * Motor de plantillas de reporte: subconjunto de Handlebars con bloques
 * anidados de verdad.
 *
 * - `{{campo}}`, `{{ref.campo}}`, `{{campo|formato}}`, `{{campo|formato:arg}}`
 * - `{{#each lista}}…{{else}}…{{/each}}` con `{{this}}`, `{{@index}}`,
 *   `{{@number}}`, `{{@first}}`, `{{@last}}` y `{{../campo}}`
 * - `{{#if cond}}…{{else}}…{{/if}}` y `{{#unless cond}}…{{/unless}}`;
 *   `cond` admite `campo`, `!campo` y `campo ==|!=|>|<|>=|<= valor`
 * - `{{#each registros}}` recorre todos los registros de un PDF por lote
 *
 * Los valores se escapan como HTML; `|html` inserta el valor tal cual.
 */

export type TemplateNode =
	| { kind: 'text'; text: string }
	| { kind: 'each'; path: string; body: TemplateNode[]; otherwise: TemplateNode[] }
	| {
			kind: 'if';
			condition: string;
			negate: boolean;
			body: TemplateNode[];
			otherwise: TemplateNode[];
	  };

type BlockNode = Exclude<TemplateNode, { kind: 'text' }>;

const BLOCK_TOKEN = /\{\{\s*(#each|#if|#unless|else|\/each|\/if|\/unless)(?=[\s}])\s*([^}]*?)\s*\}\}/g;

/** Nunca lanza: un bloque sin cerrar se cierra al final y un cierre huérfano queda como texto. */
export function parse_template(source: string): TemplateNode[] {
	const root: TemplateNode[] = [];
	const stack: Array<{ node: BlockNode; target: 'body' | 'otherwise' }> = [];
	const container = () => {
		const top = stack[stack.length - 1];
		return top ? top.node[top.target] : root;
	};
	const push_text = (text: string) => {
		if (!text) return;
		const list = container();
		const last = list[list.length - 1];
		if (last?.kind === 'text') last.text += text;
		else list.push({ kind: 'text', text });
	};
	let cursor = 0;
	for (const match of source.matchAll(BLOCK_TOKEN)) {
		const index = match.index ?? 0;
		push_text(source.slice(cursor, index));
		cursor = index + match[0].length;
		const keyword = match[1]!;
		const argument = String(match[2] ?? '').trim();
		if (keyword === '#each') {
			const node: BlockNode = { kind: 'each', path: argument, body: [], otherwise: [] };
			container().push(node);
			stack.push({ node, target: 'body' });
		} else if (keyword === '#if' || keyword === '#unless') {
			const node: BlockNode = {
				kind: 'if',
				condition: argument,
				negate: keyword === '#unless',
				body: [],
				otherwise: [],
			};
			container().push(node);
			stack.push({ node, target: 'body' });
		} else if (keyword === 'else') {
			const top = stack[stack.length - 1];
			if (top && top.target === 'body') top.target = 'otherwise';
			else push_text(match[0]);
		} else {
			const wanted = keyword === '/each' ? 'each' : 'if';
			const top = stack[stack.length - 1];
			if (top && top.node.kind === wanted) stack.pop();
			else push_text(match[0]);
		}
	}
	push_text(source.slice(cursor));
	return root;
}

export type TemplateScope = {
	data: unknown;
	parent: TemplateScope | null;
	index?: number;
	count?: number;
};

function as_record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

/** Recorre `a.b.c`; un arreglo a mitad de ruta toma su primer elemento. */
export function resolve_path(record: unknown, path: string): unknown {
	const segments = path
		.split('.')
		.map((segment) => segment.trim())
		.filter(Boolean);
	let current: unknown = record;
	for (let index = 0; index < segments.length; index++) {
		if (current == null || typeof current !== 'object') return undefined;
		current = as_record(current)[segments[index]!];
		if (Array.isArray(current) && index < segments.length - 1) {
			current = current.length > 0 ? current[0] : undefined;
		}
	}
	return current;
}

function root_scope(scope: TemplateScope): TemplateScope {
	let current = scope;
	while (current.parent) current = current.parent;
	return current;
}

function nearest_loop(scope: TemplateScope): TemplateScope | null {
	for (let current: TemplateScope | null = scope; current; current = current.parent) {
		if (typeof current.index === 'number') return current;
	}
	return null;
}

export function lookup(scope: TemplateScope, raw_path: string): unknown {
	const path = raw_path.trim();
	if (!path) return undefined;
	if (path.startsWith('../')) return lookup(scope.parent ?? scope, path.slice(3));
	if (path.startsWith('@root.')) return lookup(root_scope(scope), path.slice(6));
	if (path.startsWith('@')) {
		const loop = nearest_loop(scope);
		if (!loop) return undefined;
		const index = loop.index ?? 0;
		const count = loop.count ?? 0;
		if (path === '@index') return index;
		if (path === '@number') return index + 1;
		if (path === '@first') return index === 0;
		if (path === '@last') return index === count - 1;
		return undefined;
	}
	if (path === 'this') return scope.data;
	if (path.startsWith('this.')) return resolve_path(scope.data, path.slice(5));
	for (let current: TemplateScope | null = scope; current; current = current.parent) {
		if (current.data && typeof current.data === 'object') {
			const value = resolve_path(current.data, path);
			if (value != null) return value;
		}
	}
	return undefined;
}

export function is_truthy(value: unknown): boolean {
	if (Array.isArray(value)) return value.length > 0;
	if (typeof value === 'boolean') return value;
	if (value == null) return false;
	if (typeof value === 'number') return value !== 0;
	if (typeof value === 'string') {
		const clean = value.trim().toLowerCase();
		return clean.length > 0 && clean !== 'false' && clean !== '0';
	}
	return Boolean(value);
}

const CONDITION = /^(!)?\s*([@\w.\/]+)\s*(==|!=|>=|<=|>|<)?\s*(.*)$/;

function comparable(value: unknown): unknown {
	if (value && typeof value === 'object') {
		const rec = as_record(value);
		return rec._id ?? rec.id ?? rec.name ?? '';
	}
	return value;
}

export function evaluate_condition(condition: string, scope: TemplateScope): boolean {
	const match = condition.trim().match(CONDITION);
	if (!match) return false;
	const negated = match[1] === '!';
	const value = lookup(scope, match[2] ?? '');
	const operator = match[3];
	let result: boolean;
	if (!operator) {
		result = is_truthy(value);
	} else {
		const expected = String(match[4] ?? '')
			.trim()
			.replace(/^['"]|['"]$/g, '');
		const actual = comparable(value);
		const actual_number = Number(actual);
		const expected_number = Number(expected);
		const numeric =
			expected !== '' &&
			actual !== '' &&
			actual != null &&
			Number.isFinite(actual_number) &&
			Number.isFinite(expected_number);
		switch (operator) {
			case '==':
				result = numeric ? actual_number === expected_number : String(actual ?? '') === expected;
				break;
			case '!=':
				result = numeric ? actual_number !== expected_number : String(actual ?? '') !== expected;
				break;
			case '>':
				result = numeric && actual_number > expected_number;
				break;
			case '<':
				result = numeric && actual_number < expected_number;
				break;
			case '>=':
				result = numeric && actual_number >= expected_number;
				break;
			default:
				result = numeric && actual_number <= expected_number;
		}
	}
	return negated ? !result : result;
}

export function escape_html(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

/** Texto visible de un valor: referencias pobladas muestran su nombre. */
export function display_value(value: unknown): string {
	if (value == null) return '';
	if (value instanceof Date) return value.toISOString().split('T')[0] ?? '';
	if (Array.isArray(value)) return value.map(display_value).filter(Boolean).join(', ');
	if (typeof value === 'boolean') return value ? 'Sí' : 'No';
	if (typeof value === 'object') {
		const obj = value as { _bsontype?: string; toHexString?: () => string };
		if (obj._bsontype === 'ObjectId' || typeof obj.toHexString === 'function') {
			if (!('name' in obj) && !('_name' in obj)) return String(value);
		}
		const rec = as_record(value);
		return String(
			rec.name ??
				rec._name ??
				rec.codigo ??
				rec.code ??
				rec.description ??
				rec.descripcion ??
				rec.label ??
				rec.title ??
				rec._id ??
				rec.id ??
				'',
		);
	}
	return String(value);
}

function to_date(value: unknown): Date | null {
	if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
	if (typeof value === 'number') return new Date(value);
	if (typeof value !== 'string' || !value.trim()) return null;
	const clean = value.trim();
	/* `2026-09-26` es fecha civil: sin esto la zona horaria la mueve un día. */
	const civil = clean.match(/^(\d{4})-(\d{2})-(\d{2})$/);
	const date = civil
		? new Date(Number(civil[1]), Number(civil[2]) - 1, Number(civil[3]))
		: new Date(clean);
	return Number.isNaN(date.getTime()) ? null : date;
}

function to_number(value: unknown): number | null {
	if (typeof value === 'number') return Number.isFinite(value) ? value : null;
	if (typeof value === 'string' && value.trim()) {
		const parsed = Number(value.replace(/[,$\s]/g, ''));
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
}

const pad2 = (value: number) => String(value).padStart(2, '0');

/** Formatos disponibles para `{{campo|formato}}` (los lista el diseñador). */
export const REPORT_FORMATTERS: Record<string, string> = {
	moneda: 'Moneda: $1,234.50 (moneda:USD cambia la divisa)',
	numero: 'Número con separadores (numero:0 sin decimales)',
	entero: 'Número entero redondeado',
	porcentaje: 'Porcentaje: 0.15 → 15 %',
	fecha: 'Fecha dd/mm/aaaa',
	fecha_larga: 'Fecha larga: 26 de septiembre de 2026',
	hora: 'Hora hh:mm',
	fecha_hora: 'Fecha y hora dd/mm/aaaa hh:mm',
	mayusculas: 'TEXTO EN MAYÚSCULAS',
	minusculas: 'texto en minúsculas',
	capitalizar: 'Primera Letra De Cada Palabra',
	si_no: 'Booleano como Sí / No',
	defecto: 'Texto si está vacío (defecto:N/A)',
	recortar: 'Corta el texto (recortar:40)',
	html: 'Inserta el valor sin escapar (HTML)',
	conteo: 'Cuántos elementos tiene una lista',
	suma: 'Suma de un subcampo de la lista (suma:importe)',
	promedio: 'Promedio de un subcampo (promedio:importe)',
	minimo: 'Mínimo de un subcampo (minimo:importe)',
	maximo: 'Máximo de un subcampo (maximo:importe)',
};

function aggregate(value: unknown, name: string, field: string): unknown {
	const list = Array.isArray(value) ? value : value == null ? [] : [value];
	if (name === 'conteo') return list.length;
	const numbers = list
		.map((item) => to_number(field ? resolve_path(item, field) : item))
		.filter((number): number is number => number != null);
	if (!numbers.length) return name === 'suma' ? 0 : '';
	if (name === 'suma') return numbers.reduce((sum, number) => sum + number, 0);
	if (name === 'promedio') return numbers.reduce((sum, number) => sum + number, 0) / numbers.length;
	if (name === 'minimo') return Math.min(...numbers);
	return Math.max(...numbers);
}

const MONTHS = [
	'enero',
	'febrero',
	'marzo',
	'abril',
	'mayo',
	'junio',
	'julio',
	'agosto',
	'septiembre',
	'octubre',
	'noviembre',
	'diciembre',
];

export function apply_formatter(value: unknown, name: string, argument: string): unknown {
	switch (name) {
		case 'conteo':
		case 'suma':
		case 'promedio':
		case 'minimo':
		case 'maximo':
			return aggregate(value, name, argument);
		case 'moneda': {
			const number = to_number(value);
			if (number == null) return value;
			const currency = (argument || 'MXN').toUpperCase();
			try {
				return new Intl.NumberFormat('es-MX', { style: 'currency', currency }).format(number);
			} catch {
				return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(number);
			}
		}
		case 'numero': {
			const number = to_number(value);
			if (number == null) return value;
			const digits = argument === '' ? 2 : Math.max(0, Math.min(6, Number(argument) || 0));
			return new Intl.NumberFormat('es-MX', {
				minimumFractionDigits: digits,
				maximumFractionDigits: digits,
			}).format(number);
		}
		case 'entero': {
			const number = to_number(value);
			return number == null ? value : new Intl.NumberFormat('es-MX').format(Math.round(number));
		}
		case 'porcentaje': {
			const number = to_number(value);
			if (number == null) return value;
			const digits = argument === '' ? 0 : Math.max(0, Math.min(4, Number(argument) || 0));
			return `${(number * 100).toFixed(digits)} %`;
		}
		case 'fecha': {
			const date = to_date(value);
			return date ? `${pad2(date.getDate())}/${pad2(date.getMonth() + 1)}/${date.getFullYear()}` : value;
		}
		case 'fecha_larga': {
			const date = to_date(value);
			return date ? `${date.getDate()} de ${MONTHS[date.getMonth()]} de ${date.getFullYear()}` : value;
		}
		case 'hora': {
			const date = to_date(value);
			return date ? `${pad2(date.getHours())}:${pad2(date.getMinutes())}` : value;
		}
		case 'fecha_hora': {
			const date = to_date(value);
			return date
				? `${pad2(date.getDate())}/${pad2(date.getMonth() + 1)}/${date.getFullYear()} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
				: value;
		}
		case 'mayusculas':
			return display_value(value).toLocaleUpperCase('es-MX');
		case 'minusculas':
			return display_value(value).toLocaleLowerCase('es-MX');
		case 'capitalizar':
			return display_value(value)
				.toLocaleLowerCase('es-MX')
				.replace(/(^|\s)(\p{L})/gu, (_all, space: string, letter: string) => space + letter.toLocaleUpperCase('es-MX'));
		case 'si_no':
			return is_truthy(value) ? 'Sí' : 'No';
		case 'defecto':
			return value == null || display_value(value) === '' ? argument : value;
		case 'recortar': {
			const text = display_value(value);
			const size = Math.max(1, Number(argument) || 40);
			return text.length > size ? `${text.slice(0, size - 1)}…` : text;
		}
		default:
			return value;
	}
}

export type ParsedPlaceholder = {
	path: string;
	formatters: Array<{ name: string; argument: string }>;
};

/** `campo | numero:2 | defecto:N/A` → ruta + formatos. */
export function parse_placeholder(expression: string): ParsedPlaceholder {
	const [head, ...rest] = expression.split('|');
	return {
		path: String(head ?? '').trim(),
		formatters: rest
			.map((part) => {
				const clean = part.trim();
				const colon = clean.indexOf(':');
				return colon < 0
					? { name: clean.toLowerCase(), argument: '' }
					: { name: clean.slice(0, colon).trim().toLowerCase(), argument: clean.slice(colon + 1).trim() };
			})
			.filter((formatter) => formatter.name),
	};
}

/** Un `{{…}}` que no es bloque. El grupo 1 es la expresión completa. */
export const PLACEHOLDER_TOKEN = /\{\{\s*([@a-zA-Z0-9_.\/:]+(?:\s*\|\s*[a-z_]+(?:\s*:\s*[^|}]*)?)*)\s*\}\}/g;

export type RenderContext = {
	/** Valores que no salen del registro (`fecha_actual`, `usuario_genera`…). */
	runtime: (path: string) => string | null;
	/** `{{image:campo}}`, `{{qr}}`, `{{barcode:campo}}`: devuelven HTML. */
	special?: (kind: string, path: string, scope: TemplateScope) => Promise<string | null>;
};

async function render_text(text: string, scope: TemplateScope, ctx: RenderContext): Promise<string> {
	let out = '';
	let cursor = 0;
	for (const match of text.matchAll(PLACEHOLDER_TOKEN)) {
		const index = match.index ?? 0;
		out += text.slice(cursor, index);
		cursor = index + match[0].length;
		const expression = String(match[1] ?? '');
		const special = expression.match(/^(image|qr|barcode)(?::([@\w.\/]+))?$/);
		if (special && ctx.special) {
			const html = await ctx.special(special[1]!, String(special[2] ?? ''), scope);
			out += html ?? '';
			continue;
		}
		const { path, formatters } = parse_placeholder(expression);
		const runtime = ctx.runtime(path);
		let value: unknown = runtime != null ? runtime : lookup(scope, path);
		let raw_html = false;
		for (const formatter of formatters) {
			if (formatter.name === 'html') raw_html = true;
			else value = apply_formatter(value, formatter.name, formatter.argument);
		}
		const text_value = display_value(value);
		/* Los delimitadores de lote se dejan tal cual; el resto (p. ej. el
		 * nombre del usuario) se escapa como cualquier valor. */
		const is_delimiter = runtime != null && /^\{\{\s*(report_item_delimiter|reporte_delimitador)\s*\}\}$/.test(runtime);
		out += is_delimiter || raw_html ? text_value : escape_html(text_value);
	}
	return out + text.slice(cursor);
}

export async function render_nodes(
	nodes: TemplateNode[],
	scope: TemplateScope,
	ctx: RenderContext,
): Promise<string> {
	let out = '';
	for (const node of nodes) {
		if (node.kind === 'text') {
			out += await render_text(node.text, scope, ctx);
		} else if (node.kind === 'if') {
			const passes = evaluate_condition(node.condition, scope) !== node.negate;
			out += await render_nodes(passes ? node.body : node.otherwise, scope, ctx);
		} else {
			const list = lookup(scope, node.path);
			if (!Array.isArray(list) || list.length === 0) {
				out += await render_nodes(node.otherwise, scope, ctx);
				continue;
			}
			for (let index = 0; index < list.length; index++) {
				out += await render_nodes(
					node.body,
					{ data: list[index], parent: scope, index, count: list.length },
					ctx,
				);
			}
		}
	}
	return out;
}

/** ¿La plantilla recorre todos los registros del lote? */
export function uses_record_list(template: string): boolean {
	return /\{\{\s*#each\s+registros\s*\}\}/.test(template);
}

export type TemplatePlaceholderUse = {
	/** Expresión sin formatos ni prefijo especial (`image:`, `qr:`…). */
	path: string;
	/** Rutas de los `#each` que la envuelven, de fuera hacia dentro. */
	loops: string[];
};

/** Todos los `{{…}}` de hoja con los `#each` que los rodean (para validar). */
export function collect_placeholder_uses(template: string): TemplatePlaceholderUse[] {
	const uses: TemplatePlaceholderUse[] = [];
	const walk = (nodes: TemplateNode[], loops: string[]) => {
		for (const node of nodes) {
			if (node.kind === 'text') {
				for (const match of node.text.matchAll(PLACEHOLDER_TOKEN)) {
					const expression = String(match[1] ?? '');
					const special = expression.match(/^(image|qr|barcode)(?::([@\w.\/]+))?$/);
					const path = special ? String(special[2] ?? '') : parse_placeholder(expression).path;
					if (path) uses.push({ path, loops });
				}
			} else if (node.kind === 'if') {
				walk(node.body, loops);
				walk(node.otherwise, loops);
			} else {
				uses.push({ path: node.path, loops });
				walk(node.body, [...loops, node.path]);
				walk(node.otherwise, loops);
			}
		}
	};
	walk(parse_template(template), []);
	return uses;
}

/* ─── Código de barras Code 128-B como SVG (etiquetas, sin dependencias) ─── */

const CODE128_PATTERNS = [
	'212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
	'221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
	'221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
	'212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
	'231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
	'231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
	'314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
	'112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
	'111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
	'214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
	'114131', '311141', '411131', '211412', '211214', '211232', '2331112',
];

/** SVG de un Code 128-B (ASCII 32–126); `null` si el texto no se puede codificar. */
export function code128_svg(text: string, height_mm = 12): string | null {
	const clean = String(text ?? '');
	if (!clean || [...clean].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) > 126)) {
		return null;
	}
	const codes = [104, ...[...clean].map((char) => char.charCodeAt(0) - 32)];
	const checksum = codes.reduce((sum, code, index) => sum + code * (index === 0 ? 1 : index), 0) % 103;
	const widths = [...codes, checksum, 106].map((code) => CODE128_PATTERNS[code]!).join('');
	const quiet = 10;
	let x = quiet;
	let bars = '';
	for (let index = 0; index < widths.length; index++) {
		const width = Number(widths[index]);
		if (index % 2 === 0) bars += `<rect x="${x}" y="0" width="${width}" height="50"/>`;
		x += width;
	}
	const total = x + quiet;
	return `<svg class="report-barcode" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} 50" preserveAspectRatio="none" style="display:block;width:100%;max-width:${Math.round(total * 0.33)}mm;height:${height_mm}mm" role="img" aria-label="${escape_html(clean)}"><rect width="${total}" height="50" fill="#fff"/><g fill="#000">${bars}</g></svg>`;
}
