const OBJECT_ID_HEX = /^[a-fA-F0-9]{24}$/;
/** Id que genera el kit (`new_id`): `prefijo_` + 16 hex. */
const KIT_RECORD_ID = /^[a-z][a-z0-9-]*_[a-f0-9]{16}$/;
/** Id estable de un alta sincronizada, p. ej. `sync-comercial-prod-20260918`. */
const SYNC_RECORD_ID = /^sync(?:-[a-z0-9]{1,40}){1,12}$/i;

/**
 * Referencia válida: ObjectId de Mongo, id de una fila creada por una app,
 * o id estable de sincronización. Vacío y texto suelto no cuentan.
 */
export function is_record_id(value: string): boolean {
	return OBJECT_ID_HEX.test(value) || KIT_RECORD_ID.test(value) || SYNC_RECORD_ID.test(value);
}
