import { describe, expect, test } from "bun:test";
import { field_name_denied } from "./field-values-rule.js";
import { field_values_denied } from "./define-crud.js";

describe("field_name_denied: credenciales, PII y blobs; no metadatos", () => {
  test("credenciales siguen negadas (también camelCase)", () => {
    for (const f of [
      "password", "reset_password_token_hash", "pin_hash", "pin", "pin_code", "api_key", "apiKey",
      "clientSecret", "accessToken", "token_value", "smtp_pass", "secretKey", "private_key", "credentials",
    ]) expect([f, field_name_denied(f)]).toEqual([f, true]);
  });

  test("metadatos y hashes de contenido NO se niegan", () => {
    for (const f of [
      "pin_type", "pin_length", "pin_version", "token_type", "reset_password_kind", "reset_password_expires",
      "html_element_hash", "foto_hash", "hash", "event_type", "whatsapp_activo", "whatsapp_plantilla",
      "tokenizer_model", "firmado_at", "pinned", "passenger_no", "nssa", "clientName", "estado", "banco",
      "ubicacion_destino", "ubicacion_codigo", "ubicacion_id", "ubicacion_preferida", "cuenta_contable", "direccionamiento",
      "clave", "clave_unidad", "clave_prod_serv", "codigo", "codigo_barras", "num_empleado", "numero_economico",
      "num_intentos", "hotel", "celda", "linea", "home_page",
    ]) expect([f, field_name_denied(f)]).toEqual([f, false]);
  });

  test("PII: fiscal, firmas, contacto, domicilio, nacimiento, salario, cuenta, coordenadas", () => {
    for (const f of [
      "rfc", "receptor_rfc", "emisorRfc", "proveedor_rfc", "curp", "nss", "clabe",
      "firma", "firma_digital", "firmaDigital", "nombre_medico_firma", "withdrawalSignature", "img_signature_owner",
      "email", "customer_email", "citizenEmail", "correo", "email_contacto",
      "telefono", "telefono_paciente", "citizen_phone", "celular", "alertante_telefono",
      "domicilio_completo", "pedido_contacto_domicilio", "direccion", "direccion_exacta", "delivery_address_coordinates",
      "fecha_nacimiento", "birthdate", "salario_diario", "salary",
      "cuenta", "numero_cuenta", "bank_account",
      "lat", "lng", "lon", "latitude", "longitud", "coordinates",
    ]) expect([f, field_name_denied(f)]).toEqual([f, true]);
  });

  test("blobs json por nombre", () => {
    for (const f of ["config_json", "custom_data", "payload", "spec_json", "images_json", "attributesJson"]) {
      expect([f, field_name_denied(f)]).toEqual([f, true]);
    }
  });

  test("define_crud: field_values:true abre; secret y list:false niegan", () => {
    expect(field_values_denied("email", { type: "string", field_values: true })).toBe(false);
    expect(field_values_denied("receptor_rfc", { type: "string", field_values: true })).toBe(false);
    expect(field_values_denied("pin_type", { type: "string" })).toBe(false);
    expect(field_values_denied("pin_type", { type: "string", secret: true })).toBe(true);
    expect(field_values_denied("foto", { type: "string", list: false })).toBe(true);
  });

  test("domicilio partido, whatsapp, ubicación suelta, *_home y documentos/pagos", () => {
    for (const f of [
      "calle", "colonia", "codigo_postal", "postal_code", "cp", "domicilio_cp", "numero_exterior", "num_ext",
      "numero_interior", "num_int", "whatsapp", "whatsapp_numero", "ubicacion", "contacto_ubicacion", "location",
      "partner_home", "client_home", "home", "contrasena", "contraseña", "nueva_contrasena", "tarjeta",
      "numero_tarjeta", "card_number", "cardNumber", "cvv", "iban", "ine", "clave_ine", "pasaporte", "passport_no",
      "fecha_nac", "tel", "tel_casa", "cel", "contacto_cel",
    ]) expect([f, field_name_denied(f)]).toEqual([f, true]);
  });

  test("_id/_ref no liberan un nombre sensible salvo FK real (ref en el schema)", () => {
    for (const f of ["email_ref", "secret_ref", "lat_ref", "rfc_id", "domicilio_id", "token_ids", "telefono_id"]) {
      expect([f, field_name_denied(f)]).toEqual([f, true]);
      expect([f, field_name_denied(f, { is_reference: false })]).toEqual([f, true]);
    }
    // Con ref en el schema el `_id` es la llave, no el dato.
    expect(field_name_denied("domicilio_id", { is_reference: true })).toBe(false);
    expect(field_name_denied("rfc_id", { is_reference: true })).toBe(false);
    // Una FK no abre el sufijo que no es llave.
    expect(field_name_denied("rfc_value", { is_reference: true })).toBe(true);
    // FK reales de pos/promociones/sync (Marketo) y `ref` siguen pasando, con o sin declarar.
    for (const f of ["partner_id", "product_id", "provider_id", "ref", "_ref", "user_id", "ubicacion_origen_id"]) {
      expect([f, field_name_denied(f)]).toEqual([f, false]);
      expect([f, field_name_denied(f, { is_reference: true })]).toEqual([f, false]);
    }
  });

  test("fase 4: domicilio en inglés, número ext/int suelto, liga a mapas y delegación libre", () => {
    for (const f of [
      "street", "citizen_street", "street_address", "neighborhood", "neighbourhood",
      "exterior_number", "interior_number", "building_number_external", "building_number_internal",
      "ext_no", "int_no", "exterior", "interior", "pedido_contacto_url_maps", "urlMaps", "maps_url", "boroughs",
    ]) expect([f, field_name_denied(f)]).toEqual([f, true]);
    // Delegación con ref al catálogo: el valor es el id.
    expect(field_name_denied("borough", { is_reference: true })).toBe(false);
    expect(field_name_denied("borough")).toBe(true);
    // Sin falsos positivos: exploración clínica, parámetros y nombres de mapa de ruta.
    for (const f of ["habitus_exterior", "neighbor_params", "streetwise", "mapa", "delivery_route_mapa", "interiorismo"]) {
      expect([f, field_name_denied(f)]).toEqual([f, false]);
    }
  });

  test("fase 3b: plantilla con credencial, cuenta bancaria compuesta, zip/home y booleanos", () => {
    for (const f of [
      "password_template", "token_plantilla", "pin_template", "secret_templates", "contrasena_plantilla",
      "banco_cuenta", "cuenta_deposito", "cuenta_bancaria", "numero_cuenta", "bank_account_no", "account_number",
      "cuenta_clabe", "zip", "billing_zip", "zip_code", "home", "partner_home",
    ]) expect([f, field_name_denied(f)]).toEqual([f, true]);
    for (const f of [
      "whatsapp_plantilla", "anuncio_plantilla", "email_template", "is_template", "track_url_template",
      "cuenta_contable", "cuentas_contables", "banco", "banco_nombre", "libro_cuentas", "zip_file", "home_page",
    ]) expect([f, field_name_denied(f)]).toEqual([f, false]);
    // Un booleano no revela el dato: `home`, `has_pin`, `password_set`.
    for (const f of ["home", "has_pin", "password_set", "whatsapp"]) {
      expect([f, field_name_denied(f, { is_boolean: true })]).toEqual([f, false]);
    }
    // Pero un blob json no se abre por ser booleano.
    expect(field_name_denied("payload", { is_boolean: true })).toBe(true);
  });
});
