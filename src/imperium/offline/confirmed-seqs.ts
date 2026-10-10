// pouch-bridge importa este módulo y no durable.ts: ese archivo abre node:sqlite
// y el build de Angular seguiría el núcleo de servidor.
const TERMINAL = new Set(["applied", "adjusted", "rejected", "conflict"]);

export function confirmed_seqs(
	results: { status?: string }[] | null | undefined,
	mutations: { seq: number }[],
): number[] {
	if (!Array.isArray(results)) return [];
	const seqs: number[] = [];
	for (let index = 0; index < mutations.length; index += 1) {
		const status = results[index]?.status;
		if (status && TERMINAL.has(status)) seqs.push(mutations[index]!.seq);
	}
	return seqs;
}
