import { describe, expect, test } from 'bun:test';
import { field_values_denied } from './field-values.ts';

describe('field-values no lista credenciales ni blobs json', () => {
	test('credenciales, por nombre, aun dentro de payload', () => {
		for (const field of [
			'password',
			'reset_password_token_hash',
			'pin_hash',
			'client_secret',
			'access_token',
			'api_key',
			'private_key',
			'credentials',
			'payload.api_token',
			'custom_data.secret',
		]) {
			expect(field_values_denied('user', field)).toBe(true);
		}
	});

	test('blobs json enteros: por nombre o por tipo de columna', () => {
		expect(field_values_denied('payment-gateways', 'config_json')).toBe(true);
		expect(field_values_denied('payment-gateways', 'config_json.mode')).toBe(true);
		expect(field_values_denied('x', 'spec_json.a')).toBe(true);
		expect(field_values_denied('x', 'custom_data')).toBe(true);
		expect(field_values_denied('x', 'payload')).toBe(true);
		expect(field_values_denied('x', 'ajustes', [{ name: 'ajustes', pg: 'jsonb' }])).toBe(true);
	});

	test('lo normal sigue: estado, nombre, subcampo de payload', () => {
		expect(field_values_denied('pedidos', 'estado')).toBe(false);
		expect(field_values_denied('x', 'name', [{ name: 'name', pg: 'text' }])).toBe(false);
		expect(field_values_denied('x', 'payload.estado')).toBe(false);
		expect(field_values_denied('x', 'tokenizer_model')).toBe(false);
	});

	test('camelCase, PII y firmas', () => {
		for (const field of [
			'clientSecret', 'accessToken', 'apiKey', 'APIKey', 'pinHash', 'passwordHash', 'secretKey', 'smtp_pass',
			'payload.accessToken', 'custom_data.clientSecret',
			'rfc', 'proveedor_rfc', 'emisorRfc', 'curp', 'nss', 'clabe',
			'firma', 'firma_digital', 'firmaDigital', 'signature', 'withdrawalSignature', 'delivery_signature', 'img_signature_owner',
		]) {
			expect(field_values_denied('x', field)).toBe(true);
		}
		for (const field of ['firmado_at', 'nssa', 'passenger_no', 'clientName', 'pinned', 'payload.estadoActual']) {
			expect(field_values_denied('x', field)).toBe(false);
		}
		expect(field_values_denied('x', 'rfc', [], new Set(['x:rfc']))).toBe(false);
		expect(field_values_denied('x', 'firma_digital', [], new Set(['x:firma_digital']))).toBe(false);
	});

	test('opción explícita: recurso:campo en la lista de permitidos', () => {
		const allow = new Set(['x:ajustes']);
		expect(field_values_denied('x', 'ajustes', [{ name: 'ajustes', pg: 'jsonb' }], allow)).toBe(false);
		expect(field_values_denied('y', 'ajustes', [{ name: 'ajustes', pg: 'jsonb' }], allow)).toBe(true);
	});

	test('metadatos de credencial y hashes de contenido NO se niegan', () => {
		for (const field of ['pin_type', 'token_type', 'pin_length', 'html_element_hash', 'foto_hash', 'whatsapp_activo', 'whatsapp_plantilla', 'banco', 'clave', 'clave_unidad', 'ubicacion_codigo', 'ubicacion_destino', 'home_page', 'payload.estado', 'payload.event_type']) {
			expect([field, field_values_denied('r', field)]).toEqual([field, false]);
		}
	});

	test('token_value, rfc y PII de contacto/domicilio/nacimiento/salario/cuenta/coordenadas: negados', () => {
		for (const field of ['token_value', 'receptor_rfc', 'emisor_rfc', 'contacto.rfc', 'email', 'customer_email', 'payload.email', 'telefono', 'citizen_phone', 'domicilio_completo', 'direccion', 'fecha_nacimiento', 'salario_diario', 'cuenta', 'latitude', 'lng', 'coordinates']) {
			expect([field, field_values_denied('r', field)]).toEqual([field, true]);
		}
		expect(field_values_denied('pedido', 'customer_email', [], new Set(['pedido:customer_email']))).toBe(false);
	});

	test('fase 3: domicilio partido, whatsapp, ubicación suelta, *_home, documentos y pagos: negados', () => {
		for (const field of ['calle', 'colonia', 'codigo_postal', 'postal_code', 'cp', 'numero_exterior', 'num_ext', 'numero_interior', 'num_int', 'whatsapp', 'ubicacion', 'contacto.ubicacion', 'location', 'partner_home', 'client_home', 'contrasena', 'contraseña', 'tarjeta', 'card_number', 'cvv', 'iban', 'ine', 'pasaporte', 'fecha_nac', 'tel', 'cel', 'payload.calle']) {
			expect([field, field_values_denied('r', field)]).toEqual([field, true]);
		}
	});

	test('_id/_ref con nombre sensible: negado salvo FK real en field_refs', () => {
		const refs = { domicilio_id: 'Domicilio', rfc_id: 'Rfc', 'contacto.domicilio_id': 'Domicilio', partner_id: 'Partner', product_id: 'Product', provider_id: 'Provider' };
		for (const field of ['email_ref', 'secret_ref', 'lat_ref', 'rfc_id', 'domicilio_id']) {
			expect([field, field_values_denied('r', field)]).toEqual([field, true]);
		}
		for (const field of ['email_ref', 'secret_ref', 'lat_ref']) {
			expect([field, field_values_denied('r', field, [], undefined, refs)]).toEqual([field, true]);
		}
		for (const field of ['domicilio_id', 'rfc_id', 'contacto.domicilio_id']) {
			expect([field, field_values_denied('r', field, [], undefined, refs)]).toEqual([field, false]);
		}
		// FK reales de pos (partner_id), pos-promotion (product_id), sync/jobs (provider_id) y `ref`.
		for (const [resource, field] of [['pos', 'partner_id'], ['pos-promotion', 'product_id'], ['sync-jobs', 'provider_id'], ['sync-jobs', 'ref']]) {
			expect([field, field_values_denied(resource, field)]).toEqual([field, false]);
			expect([field, field_values_denied(resource, field, [], undefined, refs)]).toEqual([field, false]);
		}
	});
});

describe('lista: fv_denied por columna', () => {
	test('marca credenciales, PII y json; no los metadatos', async () => {
		const { list_fv_denied } = await import('./crud.ts');
		const store = {
			has: () => true,
			loc: () => ({
				columns: [
					{ name: 'name', pg: 'text' },
					{ name: 'receptor_rfc', pg: 'text' },
					{ name: 'pin_type', pg: 'text' },
					{ name: 'token_value', pg: 'text' },
					{ name: 'ajustes', pg: 'jsonb' },
					{ name: 'domicilio_id', pg: 'uuid' },
					{ name: 'email_ref', pg: 'text' },
					{ name: 'partner_id', pg: 'uuid' },
				],
			}),
			field_refs: () => ({ domicilio_id: 'Domicilio', partner_id: 'Partner' }),
		};
		expect(list_fv_denied(store as never, 'r', ['_id', 'name', 'customer_email']).sort()).toEqual([
			'ajustes',
			'customer_email',
			'email_ref',
			'receptor_rfc',
			'token_value',
		]);
	});
});

describe('fase 3b: FK real y booleanos por todos los caminos del núcleo', () => {
	test('regla: plantilla con credencial, cuenta bancaria compuesta, zip/home y booleanos', () => {
		for (const field of ['password_template', 'token_plantilla', 'banco_cuenta', 'cuenta_deposito', 'cuenta_bancaria', 'numero_cuenta', 'billing_zip', 'zip', 'home']) {
			expect([field, field_values_denied('r', field)]).toEqual([field, true]);
		}
		for (const field of ['whatsapp_plantilla', 'anuncio_plantilla', 'cuenta_contable', 'banco', 'zip_file', 'home_page']) {
			expect([field, field_values_denied('r', field)]).toEqual([field, false]);
		}
		const columns = [{ name: 'home', pg: 'boolean' }, { name: 'has_pin', pg: 'bool' }, { name: 'zip', pg: 'text' }];
		expect(field_values_denied('r', 'home', columns)).toBe(false);
		expect(field_values_denied('r', 'has_pin', columns)).toBe(false);
		expect(field_values_denied('r', 'zip', columns)).toBe(true);
	});

	test('todo caller de field_values_denied en el núcleo pasa columnas y field_refs', async () => {
		const { readdirSync, readFileSync } = await import('node:fs');
		const { join } = await import('node:path');
		const dir = import.meta.dir;
		const calls: string[] = [];
		for (const file of readdirSync(dir)) {
			if (!file.endsWith('.ts') || file.endsWith('.spec.ts')) continue;
			const src = readFileSync(join(dir, file), 'utf8');
			for (const m of src.matchAll(/\bfield_values_denied\(/g)) {
				const before = src.slice(Math.max(0, (m.index ?? 0) - 20), m.index);
				if (/function\s*$/.test(before)) continue;
				calls.push(`${file}: ${src.slice(m.index, (m.index ?? 0) + 260).replace(/\s+/g, ' ')}`);
			}
			for (const m of src.matchAll(/\bfield_name_denied\(/g)) {
				if (file === 'field-values.ts') continue;
				calls.push(`${file}: field_name_denied fuera de field_values_denied`);
			}
		}
		expect(calls.length).toBeGreaterThanOrEqual(3);
		for (const call of calls) {
			expect([call, /field_value_refs\(|refs\)/.test(call.split(')) {')[0] ?? call)]).toEqual([call, true]);
		}
	});

	test('endpoint CRUD y tracker: domicilio_id con FK real pasa; sin FK, 400', async () => {
		const { postgres_table_tracker_field_values } = await import('./postgres-table-tracker-field-values.ts');
		const tracker = { _id: 'tracker-envio', __model_name: 'Envio', __schema_fields: [] };
		const make_store = (refs: Record<string, string>) => ({
			has: (resource: string) => resource === 'postgres-table-tracker' || resource === 'envio',
			loc: (resource: string) => ({ resource, columns: [{ name: 'domicilio_id', pg: 'text' }, { name: 'home', pg: 'boolean' }] }),
			available_mongoose_models: () => [],
			is_model_installed: () => true,
			resource_for_model: (model: string) => (model === 'Envio' ? 'envio' : null),
			field_refs: () => refs,
			find_id: async () => null,
			find_where: async (_r: string, where: Record<string, unknown>) => (where.__model_name === 'Envio' ? tracker : null),
			value_counts: async () => [{ value: 'domic-1', count: 1 }],
			async *scan() {
				yield [];
			},
		});
		const run = (refs: Record<string, string>, field_path: string) =>
			postgres_table_tracker_field_values({
				store: make_store(refs) as never,
				actor: { _id: 'admin', _ref: 'user-menu-management-0' },
				params: { model_tracker_id: 'Envio', field_path },
				url: new URL(`http://imperium.test/api/postgres-table-tracker/global/Envio/field-values/${field_path}`),
			}).then(
				() => 200,
				(e: unknown) => (e as { status?: number }).status ?? 500,
			);
		expect(await run({ domicilio_id: 'HerrDomicilio' }, 'domicilio_id')).toBe(200);
		expect(await run({}, 'domicilio_id')).toBe(400);
		expect(await run({}, 'home')).toBe(200);

		const { list_fv_denied, field_value_refs } = await import('./crud.ts');
		expect(field_value_refs(make_store({ domicilio_id: 'X' }) as never, 'envio')).toEqual({ domicilio_id: 'X' });
		expect(field_value_refs({} as never, 'envio')).toEqual({});
		expect(list_fv_denied(make_store({ domicilio_id: 'X' }) as never, 'envio', ['domicilio_id', 'home'])).toEqual([]);
		expect(list_fv_denied(make_store({}) as never, 'envio', ['domicilio_id', 'home'])).toEqual(['domicilio_id']);
	});
});

describe('field-values fase 4: PII de todas las apps (orden de Yael 2026-11-04)', () => {
	test('núcleo y tracker niegan rh, pacientes, emergencias, ciudadanos, clientes, user.email y logística', () => {
		const cases: Array<[string, string]> = [
			['employee', 'cuenta'], ['employee', 'salario_diario'], ['employee', 'fecha_nacimiento'],
			['employee', 'street'], ['employee', 'exterior_number'], ['employee', 'interior_number'], ['employee', 'boroughs'],
			['patient', 'telefono_paciente'], ['patient', 'telefono_familiar'], ['patient', 'domicilio_completo'],
			['registro-emergencias', 'alertante_telefono'], ['registro-emergencias', 'direccion_exacta'],
			['citizen-report', 'citizen_email'], ['citizen-report', 'citizen_phone'], ['citizen-report', 'citizen_street'],
			['citizen-report', 'building_number_external'], ['citizen-report', 'neighborhood'],
			['contrato', 'exterior'], ['contrato', 'interior'],
			['contacto', 'email'], ['contacto', 'urlMaps'], ['payments', 'customer_email'], ['user', 'email'],
			['pedidos', 'pedido_contacto_domicilio'], ['pedidos', 'pedido_contacto_url_maps'],
			['envio', 'user.email'], ['envio', 'contacto.street'],
		];
		for (const [resource, field] of cases) {
			expect([resource, field, field_values_denied(resource, field)]).toEqual([resource, field, true]);
		}
		// Delegación con ref al catálogo pasa; sin ref es domicilio.
		expect(field_values_denied('citizen-report', 'borough', [], undefined, { borough: 'Boroughs' })).toBe(false);
		expect(field_values_denied('citizen-report', 'borough')).toBe(true);
		for (const field of ['habitus_exterior', 'status', 'name', 'ubicacion_destino']) {
			expect([field, field_values_denied('medical-file', field)]).toEqual([field, false]);
		}
	});
});
