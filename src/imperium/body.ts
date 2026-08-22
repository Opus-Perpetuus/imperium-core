/**
 * Cuerpo Imperium: JSON o multipart con `imperium-sic__data__`.
 * El front serializa arreglos como `campo[0]`; se reconstruyen aquí
 * (mismo `processArrayFields` del backend Express).
 */

export function process_array_fields(
	obj: Record<string, unknown>,
): Record<string, unknown> {
	const array_fields: Record<string, unknown[]> = {};
	for (const key of Object.keys(obj)) {
		const match = key.match(/^(\w+)\[(\d+)\]$/);
		if (!match) continue;
		const name = match[1]!;
		const index = Number(match[2]);
		if (!array_fields[name]) array_fields[name] = [];
		array_fields[name][index] = obj[key];
		delete obj[key];
	}
	for (const name of Object.keys(array_fields)) {
		const arr = array_fields[name]!;
		if (arr.length === 1 && arr[0] === '') array_fields[name] = [];
	}
	Object.assign(obj, array_fields);
	return obj;
}

export async function read_imperium_body(
	req: Request,
): Promise<Record<string, unknown>> {
	if (req.method === 'GET' || req.method === 'HEAD') return {};
	const ctype = req.headers.get('content-type') ?? '';
	if (ctype.includes('multipart/form-data') || ctype.includes('application/x-www-form-urlencoded')) {
		const form = await req.formData();
		const files: Record<string, unknown> = {};
		for (const [k, v] of form.entries()) {
			if (typeof v !== 'string') files[k] = v;
		}
		const packed = form.get('imperium-sic__data__');
		if (typeof packed === 'string' && packed.trim()) {
			try {
				const parsed = JSON.parse(packed);
				if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
					return process_array_fields({
						...(parsed as Record<string, unknown>),
						...files,
					});
				}
			} catch {
				/* fall through */
			}
		}
		const out: Record<string, unknown> = { ...files };
		for (const [k, v] of form.entries()) {
			if (typeof v === 'string') out[k] = v;
		}
		return process_array_fields(out);
	}
	const raw = await req.text();
	if (!raw.trim()) return {};
	try {
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			return process_array_fields(parsed as Record<string, unknown>);
		}
		if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
	} catch {
		return {};
	}
	return {};
}

const LIST_RESERVED = new Set([
	'termino',
	'q',
	'desde',
	'skip',
	'limite',
	'take',
	'sort',
	'campoSort',
	'include_inactive',
	'include_historical',
	'show_archived',
	'export_excel',
	'ids',
	'after',
	'cursor',
	'view_list_view',
	'batch_match_field',
	'populate',
]);

export function query_list(url: URL): {
	q: string;
	skip: number;
	take: number;
	sort: string;
	include_inactive: boolean;
	where: Record<string, unknown>;
	ids?: string[];
} {
	const q = (url.searchParams.get('termino') ?? url.searchParams.get('q') ?? '').trim();
	const skip = Math.max(0, Number(url.searchParams.get('desde') ?? url.searchParams.get('skip') ?? 0) || 0);
	let take = Number(url.searchParams.get('limite') ?? url.searchParams.get('take') ?? 100);
	if (!Number.isFinite(take) || take < 1) take = 100;
	take = Math.min(Math.floor(take), 10000);
	const campo = (url.searchParams.get('campoSort') ?? '').trim();
	const sort_raw = (url.searchParams.get('sort') ?? '').trim();
	let sort = '';
	if (campo) {
		const desc = sort_raw === '-1' || sort_raw.toLowerCase() === 'desc';
		sort = `${campo}:${desc ? 'desc' : 'asc'}`;
	} else if (sort_raw && !/^[-]?\d+$/.test(sort_raw)) {
		sort = sort_raw;
	}
	const include_inactive =
		url.searchParams.get('include_inactive') === '1' ||
		url.searchParams.get('include_inactive') === 'true';
	const where: Record<string, unknown> = {};
	for (const [key, value] of url.searchParams.entries()) {
		if (LIST_RESERVED.has(key) || value === '') continue;
		if (key in where) {
			const prev = where[key];
			const arr = Array.isArray((prev as { in?: unknown[] })?.in)
				? [...((prev as { in: unknown[] }).in)]
				: [prev];
			arr.push(value);
			where[key] = { in: arr };
		} else {
			where[key] = value;
		}
	}
	const ids_raw = (url.searchParams.get('ids') ?? '').trim();
	const ids = ids_raw
		? ids_raw.split(',').map((s) => s.trim()).filter(Boolean)
		: undefined;
	return { q, skip, take, sort, include_inactive, where, ids };
}
