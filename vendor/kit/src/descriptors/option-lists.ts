/**
 * Listas que no son estatus. El estatus del formulario es `input-status`
 * (status-option-control). Todo lo demás (select, radio, choice, datalist)
 * apunta aquí con `optionsSource`.
 *
 * Repair (solo crea faltantes, no reescribe instancias viejas):
 * - POST /api/status-option-control/seed-defaults          acción `seed_defaults`
 * - POST /api/general-option-list-control/seed-defaults    acción `seed_defaults`
 */

export const STATUS_OPTION_SEED_PATH = "/api/status-option-control/seed-defaults";
export const GENERAL_OPTION_LIST_SEED_PATH =
  "/api/general-option-list-control/seed-defaults";
export const OPTION_SEED_ACTION = "seed_defaults";

export type OptionSeedItem = {
  value: string;
  label: string;
  description?: string;
  color?: string;
  icon?: string;
  type?: string;
  field_name?: string;
};

export type GeneralOptionListSeed = {
  model_id: string;
  module_id?: string;
  module_name?: string;
  lists: Array<{
    list_key: string;
    label?: string;
    field_name?: string;
    options: OptionSeedItem[];
  }>;
};

export type StatusOptionSeed = {
  model_id: string;
  module_id?: string;
  module_name?: string;
  status_fields?: string[];
  options: OptionSeedItem[];
  /**
   * Valores sembrados que ya no se usan: el núcleo los quita del catálogo de
   * `status_fields` (nunca los creados por el usuario). Mandar solo después de
   * migrar los registros que los tenían. Un núcleo viejo lo ignora.
   */
  retire_values?: string[];
};

/** `optionsSource` de un campo que no es estatus. `as=options` → `{ value, label }[]`. */
export function general_option_list_options_source(
  model_id: string,
  list_key: string,
): string {
  const query = new URLSearchParams({
    model_id,
    list_key,
    as: "options",
  });
  return `api://general-option-list-control/options?${query.toString()}`;
}
