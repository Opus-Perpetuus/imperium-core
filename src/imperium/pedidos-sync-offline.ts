export type DecisionSyncOffline =
	| { decision: 'crear' }
	| { decision: 'duplicado'; motivo: 'uuid' | 'folio' };

export function decidir_sync_offline(input: {
	ya_existe_uuid: boolean;
	ya_existe_folio: boolean;
	folio_visto_en_lote: boolean;
	folio: string;
}): DecisionSyncOffline {
	if (input.ya_existe_uuid) return { decision: 'duplicado', motivo: 'uuid' };
	const folio = input.folio.trim();
	if (!folio) return { decision: 'crear' };
	if (input.folio_visto_en_lote || input.ya_existe_folio) {
		return { decision: 'duplicado', motivo: 'folio' };
	}
	return { decision: 'crear' };
}
