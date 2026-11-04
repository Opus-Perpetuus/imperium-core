//   #region FIELD-VALUES: nombres que no se listan
//
// Una sola regla para el kit (define_crud) y el núcleo (CRUD y tracker global):
// `GET …/field-values/<campo>` devuelve los valores distintos de una columna a
// quien tenga lectura del recurso. Tres clases (`field_name_access`):
//   - "denied": credenciales, firmas y blobs json; nadie los lista.
//   - "session": PII (contacto, domicilio, identificadores, nombres de
//     personas, datos clínicos, ciudad, placas). Solo con sesión interna
//     válida; anónimo o externo (realm público) → 400.
//   - "open": lo demás, igual que siempre.
// Un campo que no se puede listar pasa a texto libre en la lista (`fv_denied`).

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
/** Firmas: imagen o trazo; no son valores de filtro para nadie. */
const SIGNATURE_WORDS = ["firma", "firmas", "signature", "signatures"];

const PII_WORDS = [
  "rfc", "curp", "nss", "clabe",
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
  // Fase 5. Nombres de personas.
  "apellido", "apellidos", "apellido_paterno", "apellido_materno", "nombre_completo",
  "first_name", "last_name", "full_name", "surname", "given_name", "firmante", "firmantes",
  // Datos clínicos.
  "alergia", "alergias", "allergy", "allergies", "enfermedad", "enfermedades", "disease", "diseases",
  "diagnostico", "diagnosticos", "diagnostica", "diagnosis", "padecimiento", "padecimientos",
  "sintoma", "sintomas", "medicamento", "medicamentos",
  "edad", "age", "sexo", "sex", "genero", "gender", "estado_civil", "marital_status",
  "tipo_sangre", "grupo_sanguineo", "blood_type",
  // Placas de vehículos.
  "placa", "placas", "plate", "plates", "license_plate",
];

/**
 * Ciudad/localidad en texto libre; con ref al catálogo el valor es el id y
 * pasa (igual que la delegación).
 */
const CITY_RE = /(^|_)(localidad|localidades|ciudad|ciudades|city|cities|town|borough|boroughs)(_|$)/;

/**
 * Nombre de una persona: `contacto_nombre`, `nombre_paciente`, `alertante_name`.
 * `nombre` solo (`producto.nombre`) no, salvo en un recurso de personas.
 */
const NAME_WORDS = new Set(["nombre", "nombres", "name", "names"]);
const PERSON_WORDS = new Set([
  "paciente", "pacientes", "patient", "contacto", "contact", "alertante", "familiar", "familiares",
  "cliente", "client", "customer", "ciudadano", "citizen", "empleado", "employee", "alumno", "student",
  "responsable", "propietario", "owner", "conductor", "chofer", "driver", "solicitante", "tutor",
  "beneficiario", "titular", "persona", "person", "medico", "doctor", "voluntario", "reportante",
  "denunciante", "infractor", "testigo", "padre", "madre", "partner", "asignado", "assignee",
]);
/** Recursos cuyas filas son personas: ahí `nombre`/`name` también es PII. */
const PERSON_RESOURCE_RE =
  /(^|[-_])(patient|patients|paciente|pacientes|employee|employees|empleado|empleados|alumno|alumnos|student|students|citizen|citizens|ciudadano|ciudadanos|contacto|contactos|contact|contacts|voluntario|voluntarios|voluntariado|cliente|clientes|customer|customers|persona|personas|tutor|tutores|conductor|conductores|chofer|choferes|driver|drivers|user|users|usuario|usuarios)([-_]|$)/;

/** Cuenta bancaria: solo nombres completos (`cuenta` sola es ambigua en contabilidad). */
const WHOLE_NAMES = new Set([
  "cuenta", "cuenta_bancaria", "numero_cuenta", "no_cuenta", "num_cuenta",
  "bank_account", "account_number",
  // Número exterior/interior del domicilio (`contrato.exterior`); `habitus_exterior` no.
  "exterior", "interior",
]);

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

export type FieldValuesAccess = "open" | "session" | "denied";

export type FieldNameOptions = {
  /** Recurso dueño del campo: en recursos de personas `nombre` también es PII. */
  resource?: string;
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
const SIGNATURE_RE = word_re(SIGNATURE_WORDS);
const PII_RE = word_re(PII_WORDS);
/** `blood_type`/`tipo_sangre` terminan en sufijo de metadato pero son el dato. */
const PII_WHOLE = new Set(["blood_type", "tipo_sangre", "estado_civil", "marital_status"]);

function person_name(parts: string[], resource: string | undefined): boolean {
  if (!parts.some((p) => NAME_WORDS.has(p))) return false;
  if (parts.some((p) => PERSON_WORDS.has(p))) return true;
  return parts.every((p) => NAME_WORDS.has(p)) && PERSON_RESOURCE_RE.test(String(resource ?? "").toLowerCase());
}

/** Clase de acceso de un segmento (sin puntos) por su nombre. */
export function field_name_access(field: string, opts: FieldNameOptions = {}): FieldValuesAccess {
  const snake = snake_field_name(field);
  if (!snake) return "open";
  if (JSON_BLOB_FIELDS.has(snake) || snake.endsWith("_json")) return "denied";
  if (opts.is_boolean === true) return "open";
  const parts = snake.split("_").filter(Boolean);
  const last = parts[parts.length - 1] ?? "";
  if (parts.length > 1 && TEMPLATE_SUFFIXES.has(last)) {
    return CREDENTIAL_RE.test(parts.slice(0, -1).join("_")) ? "denied" : "open";
  }
  if (PII_WHOLE.has(snake)) return "session";
  if (parts.length > 1 && METADATA_SUFFIXES.has(last)) return "open";
  if (WHOLE_NAMES.has(snake)) return "session";
  if (parts.some((p) => ACCOUNT_WORDS.has(p)) && parts.some((p) => BANK_QUALIFIERS.has(p))) return "session";
  if (parts.length > 1 && KEY_SUFFIXES.has(last) && opts.is_reference === true) return "open";
  if (CREDENTIAL_RE.test(snake) || SIGNATURE_RE.test(snake)) return "denied";
  if (CITY_RE.test(snake)) return opts.is_reference === true ? "open" : "session";
  if (PII_RE.test(snake) || BARE_PLACE_RE.test(snake) || person_name(parts, opts.resource)) return "session";
  return "open";
}

/**
 * ¿Se niega a quien no tiene sesión? (`true` también para credenciales.)
 * Para saber si se niega con sesión, usar `field_name_access(...) === "denied"`.
 */
export function field_name_denied(field: string, opts: FieldNameOptions = {}): boolean {
  return field_name_access(field, opts) !== "open";
}
//   #endregion
