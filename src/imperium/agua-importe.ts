/**
 * Cálculo de importe de lecturas — mismo contrato que
 * backend/src/plugins/agua/agua-importe.service.ts
 */
import type { ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';

export type ImporteCalculo = {
	consumo_mts3: number;
	importe: number;
};

type Bracket = {
	consumo_minimo?: number;
	consumo_maximo?: number;
	cuota_minima?: number;
	costo_mt3_excedente?: number;
};

export function importe_from_bracket(consumo_mts3: number, bracket: Bracket): number {
	const consumo_minimo = Number(bracket.consumo_minimo ?? 0);
	const cuota_minima = Number(bracket.cuota_minima ?? 0);
	const costo_excedente = Number(bracket.costo_mt3_excedente ?? 0);
	if (consumo_mts3 <= consumo_minimo) return cuota_minima;
	const excedente = consumo_mts3 - consumo_minimo;
	return Math.round((cuota_minima + excedente * costo_excedente) * 100) / 100;
}

export function pick_bracket(brackets: Bracket[], consumo: number): Bracket {
	for (const bracket of brackets) {
		const min = Number(bracket.consumo_minimo ?? 0);
		const max = Number(bracket.consumo_maximo ?? 0);
		const upper = max > 0 ? max : Number.POSITIVE_INFINITY;
		if (consumo >= min && consumo <= upper) return bracket;
	}
	return consumo < Number(brackets[0]?.consumo_minimo ?? 0)
		? brackets[0]!
		: brackets[brackets.length - 1]!;
}

export async function calcular_importe(
	store: ImperiumStore,
	lectura_actual: number,
	lectura_anterior: number,
	id_tarifa?: string,
): Promise<ImporteCalculo> {
	const consumo_raw = Number(lectura_actual ?? 0) - Number(lectura_anterior ?? 0);
	const consumo_mts3 = consumo_raw > 0 ? consumo_raw : 0;
	if (!id_tarifa) return { consumo_mts3, importe: 0 };
	const rows: Bracket[] = [];
	for await (const page of store.scan('tarifa', {
		where: { id_tarifa },
	})) {
		for (const row of page) rows.push(row);
	}
	if (!rows.length) return { consumo_mts3, importe: 0 };
	rows.sort((a, b) => Number(a.consumo_minimo ?? 0) - Number(b.consumo_minimo ?? 0));
	return {
		consumo_mts3,
		importe: importe_from_bracket(consumo_mts3, pick_bracket(rows, consumo_mts3)),
	};
}

export async function prepare_lectura_write(
	store: ImperiumStore,
	doc: ImperiumDoc,
): Promise<ImperiumDoc> {
	const { consumo_mts3, importe } = await calcular_importe(
		store,
		Number(doc.lectura_actual ?? 0),
		Number(doc.lectura_anterior ?? 0),
		doc.id_tarifa ? String(doc.id_tarifa) : undefined,
	);
	return { ...doc, consumo_mts3, importe };
}

export async function after_lectura_create(
	store: ImperiumStore,
	created: ImperiumDoc,
): Promise<void> {
	const numero = String(created.contrato ?? '').trim();
	if (!numero || !store.has('contrato')) return;
	const contrato =
		(await store.find_where('contrato', { contrato: numero })) ??
		(await store.find_where('contrato', { name: numero }));
	if (!contrato?._id) return;
	const importe = Number(created.importe ?? 0);
	await store.update('contrato', String(contrato._id), {
		tomada: true,
		sincronizada: true,
		adeudo: Number(contrato.adeudo ?? 0) + importe,
	});
}
