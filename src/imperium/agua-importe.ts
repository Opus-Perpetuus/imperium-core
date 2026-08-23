/**
 * Cálculo de importe de lecturas — mismo contrato que
 * backend/src/plugins/agua/agua-importe.service.ts
 */
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
	const { rows } = await store.find_many('tarifa', {
		where: { id_tarifa },
		take: 20000,
		sort: 'consumo_minimo:asc',
	});
	if (!rows.length) return { consumo_mts3, importe: 0 };
	return {
		consumo_mts3,
		importe: importe_from_bracket(consumo_mts3, rows[0] ? pick_bracket(rows, consumo_mts3) : {}),
	};
}
