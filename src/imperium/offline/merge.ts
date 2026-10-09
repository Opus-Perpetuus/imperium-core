export const CRITICAL_FIELDS = ["rfc", "precio", "credito"] as const;

export function is_critical_field(field: string): boolean {
	return (CRITICAL_FIELDS as readonly string[]).includes(field);
}

export type FieldMerge =
	| { ok: true; merged: Record<string, unknown> }
	| { ok: false; review_fields: string[] };

/** Campos distintos se funden. El mismo campo crítico, tocado en los dos lados, va a revisión. */
export function merge_field_edits(
	base: Record<string, unknown>,
	left: Record<string, unknown>,
	right: Record<string, unknown>,
): FieldMerge {
	const merged: Record<string, unknown> = { ...base };
	const review_fields: string[] = [];
	const fields = new Set([
		...Object.keys(base),
		...Object.keys(left),
		...Object.keys(right),
	]);
	for (const field of fields) {
		const base_value = base[field];
		const left_changed = !same_value(left[field], base_value) && field in left;
		const right_changed = !same_value(right[field], base_value) && field in right;
		if (left_changed && right_changed && !same_value(left[field], right[field])) {
			if (is_critical_field(field)) {
				review_fields.push(field);
				continue;
			}
			review_fields.push(field);
			continue;
		}
		if (left_changed) merged[field] = left[field];
		else if (right_changed) merged[field] = right[field];
	}
	if (review_fields.length > 0) return { ok: false, review_fields };
	return { ok: true, merged };
}

function same_value(left: unknown, right: unknown): boolean {
	return Object.is(left, right);
}
