//   #region FIELD-VALUES: nombres que no se listan
//
// Una sola regla para el kit (define_crud) y el núcleo (CRUD y tracker global):
// `GET …/field-values/<campo>` devuelve los valores distintos de una columna a
// cualquiera con lectura del recurso. Credenciales, PII y blobs no salen por
// ahí; el filtro de esa columna en la lista pasa a texto libre (`fv_denied`).

/** `clientSecret` → `client_secret`; `APIKey` → `api_key`. */
export function snake_field_name(field: string): string {
  return field
    .trim()
    .replace(/([A-Z]+)([A-Z][a-z0-9])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
}

/** Credenciales: el valor mismo es el secreto. */
const CREDENTIAL_WORDS = [
  "password", "passwd", "pwd", "pass", "secret", "secrets", "token", "tokens",
  "api_key", "apikey", "private_key", "secret_key", "credential", "credentials", "pin",
  "contrasena", "contraseña", "contrasenas", "contraseñas",
  // Medios de pago.
  "tarjeta", "tarjetas", "card_number", "cvv", "cvc", "iban",
];

/** PII: identificadores fiscales y bancarios, firmas, contacto, domicilio, nacimiento, salario, coordenadas. */
const PII_WORDS = [
  "rfc", "curp", "nss", "clabe", "firma", "firmas", "signature", "signatures",
  "ine", "pasaporte", "passport",
  "email", "emails", "e_mail", "correo", "phone", "telefono", "celular", "movil", "mobile",
  "tel", "cel", "whatsapp",
  "domicilio", "direccion", "address",
  // Domicilio partido.
  "calle", "colonia", "codigo_postal", "postal_code", "zip_code", "zipcode", "cp",
  "numero_exterior", "num_ext", "numero_interior", "num_int",
  // Domicilio partido en inglés y ligas a mapas (rh, ciudadanos, logística, contactos).
  "street", "streets", "street_address", "neighborhood", "neighborhoods", "neighbourhood",
  "exterior_number", "interior_number", "number_exterior", "number_interior",
  "number_external", "number_internal", "ext_no", "int_no",
  "url_maps", "maps_url", "google_maps", "maps_link",
  "nacimiento", "fecha_nac", "birth", "birthday", "birthdate", "dob",
  "salario", "salary", "sueldo",
  "lat", "lng", "lon", "latitude", "longitude", "latitud", "longitud",
  "coords", "coordinates", "coordenadas",
];

/** Cuenta bancaria: solo nombres completos (`cuenta` sola es ambigua en contabilidad). */
const WHOLE_NAMES = new Set([
  "cuenta", "cuenta_bancaria", "numero_cuenta", "no_cuenta", "num_cuenta",
  "bank_account", "account_number",
  // Número exterior/interior del domicilio (`contrato.exterior`); `habitus_exterior` no.
  "exterior", "interior",
]);

/**
 * Delegación/alcaldía: texto libre (`employee.boroughs`) es parte del domicilio;
 * con ref al catálogo (`citizen-report.borough`) el valor es el id y pasa.
 */
const AREA_RE = /(^|_)(borough|boroughs)(_|$)/;

/**
 * Cuenta bancaria compuesta: `banco_cuenta`, `cuenta_deposito`,
 * `cuenta_bancaria`, `numero_cuenta`, `bank_account_no`. `cuenta_contable`
 * (contabilidad) y `banco` (nombre del banco) no.
 */
const ACCOUNT_WORDS = new Set(["cuenta", "cuentas", "account", "accounts"]);
const BANK_QUALIFIERS = new Set([
  "banco", "bancos", "bancaria", "bancario", "bank", "deposito", "depositos", "deposit",
  "numero", "num", "no", "nro", "number", "clabe", "iban", "swift",
]);

/**
 * Último segmento que describe al dato sin ser el dato: `pin_type`,
 * `token_type`, `pin_length`, `reset_password_kind`, `whatsapp_activo`.
 * `token_value` y `pin_hash` no entran: son el secreto.
 */
const METADATA_SUFFIXES = new Set([
  "type", "types", "kind", "length", "len", "version", "count", "format", "mode",
  "activo", "active", "enabled", "required", "expires", "at",
]);

/**
 * Plantilla: `whatsapp_plantilla` o `anuncio_plantilla` describen el mensaje,
 * pero `password_template` o `token_plantilla` pueden guardar el secreto mismo:
 * con credencial se niegan.
 */
const TEMPLATE_SUFFIXES = new Set(["plantilla", "plantillas", "template", "templates"]);

/**
 * `_id`/`_ref` solo liberan una FK real (ref en el schema): `domicilio_id`
 * con ref al directorio sí; `email_ref`, `secret_ref` o `rfc_id` sueltos
 * guardan el dato mismo y siguen negados.
 */
const KEY_SUFFIXES = new Set(["id", "ids", "ref", "refs"]);

/**
 * Ubicación: suelta (`ubicacion`, `contacto_ubicacion`, `location`) puede ser
 * dirección o coordenadas; con sufijo (`ubicacion_codigo`, `ubicacion_destino`)
 * es el catálogo de almacén y pasa. `*_home` (`partner_home`, `client_home`) es
 * domicilio; `home_page` no. `zip` suelto (`billing_zip`) es código postal;
 * `zip_file` no.
 */
const BARE_PLACE_RE = /(^|_)(ubicacion|ubicaciones|location|locations|geo|geolocation|geolocalizacion|home|zip)$/;

export type FieldNameOptions = {
  /** El campo es una FK real (ref en el schema). */
  is_reference?: boolean;
  /** Booleano: sus valores (true/false) no revelan el dato (`home`, `has_pin`). */
  is_boolean?: boolean;
};

/** Blobs json por nombre: configuración con credenciales o documentos enteros. */
export const JSON_BLOB_FIELDS: ReadonlySet<string> = new Set(["config_json", "custom_data", "payload", "spec_json"]);

function word_re(words: readonly string[]): RegExp {
  return new RegExp(`(^|_)(${words.join("|")})(_|$)`);
}
const CREDENTIAL_RE = word_re(CREDENTIAL_WORDS);
const PII_RE = word_re(PII_WORDS);

/** Un segmento (sin puntos) que por su nombre no admite field-values. */
export function field_name_denied(field: string, opts: FieldNameOptions = {}): boolean {
  const snake = snake_field_name(field);
  if (!snake) return false;
  if (JSON_BLOB_FIELDS.has(snake) || snake.endsWith("_json")) return true;
  if (opts.is_boolean === true) return false;
  if (WHOLE_NAMES.has(snake)) return true;
  const parts = snake.split("_").filter(Boolean);
  if (parts.some((p) => ACCOUNT_WORDS.has(p)) && parts.some((p) => BANK_QUALIFIERS.has(p))) return true;
  const last = parts[parts.length - 1] ?? "";
  if (parts.length > 1 && TEMPLATE_SUFFIXES.has(last)) return CREDENTIAL_RE.test(parts.slice(0, -1).join("_"));
  if (parts.length > 1 && METADATA_SUFFIXES.has(last)) return false;
  if (parts.length > 1 && KEY_SUFFIXES.has(last) && opts.is_reference === true) return false;
  if (AREA_RE.test(snake)) return opts.is_reference !== true;
  return CREDENTIAL_RE.test(snake) || PII_RE.test(snake) || BARE_PLACE_RE.test(snake);
}
//   #endregion
