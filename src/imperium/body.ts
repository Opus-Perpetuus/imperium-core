/**
 * Cuerpo Imperium: JSON o multipart con `imperium-sic__data__`.
 */

export async function read_imperium_body(
	req: Request,
): Promise<Record<string, unknown>> {
	if (req.method === 'GET' || req.method === 'HEAD') return {};
	const ctype = req.headers.get('content-type') ?? '';
	if (ctype.includes('multipart/form-data') || ctype.includes('application/x-www-form-urlencoded')) {
		const form = await req.formData();
		const packed = form.get('imperium-sic__data__');
		if (typeof packed === 'string' && packed.trim()) {
			try {
				const parsed = JSON.parse(packed);
				if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
					return parsed as Record<string, unknown>;
				}
			} catch {
				/* fall through */
			}
		}
		const out: Record<string, unknown> = {};
		for (const [k, v] of form.entries()) {
			if (typeof v === 'string') out[k] = v;
		}
		return out;
	}
	const raw = await req.text();
	if (!raw.trim()) return {};
	try {
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
	} catch {
		return {};
	}
	return {};
}

export function query_list(url: URL): {
	q: string;
	skip: number;
	take: number;
	sort: string;
	include_inactive: boolean;
} {
	const q = (url.searchParams.get('termino') ?? url.searchParams.get('q') ?? '').trim();
	const skip = Math.max(0, Number(url.searchParams.get('desde') ?? url.searchParams.get('skip') ?? 0) || 0);
	let take = Number(url.searchParams.get('limite') ?? url.searchParams.get('take') ?? 100);
	if (!Number.isFinite(take) || take < 1) take = 100;
	take = Math.min(Math.floor(take), 10000);
	const sort = (url.searchParams.get('sort') ?? url.searchParams.get('campoSort') ?? '').trim();
	const include_inactive =
		url.searchParams.get('include_inactive') === '1' ||
		url.searchParams.get('include_inactive') === 'true';
	return { q, skip, take, sort, include_inactive };
}
