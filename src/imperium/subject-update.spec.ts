import { describe, expect, test, afterEach } from 'bun:test';
import {
	compose_update_args,
	image_tag,
	subject_image_ref,
	subject_tag_env,
	subject_tag_env_name,
} from './subject-runtime.ts';
import {
	subject_image_tag,
	subject_update_available,
	visible_lifecycle_status,
} from './subjects-admin.ts';
import { coerce_auto_update_flag } from './subject-auto-update.ts';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
	for (const key of Object.keys(process.env)) {
		if (key.startsWith('IMPERIUM_SUBJECT_TAG')) delete process.env[key];
	}
	Object.assign(process.env, ORIGINAL_ENV);
});

describe('selector de versión por app', () => {
	test('el nombre de la variable casa con el que interpola el compose', () => {
		expect(subject_tag_env_name('pos')).toBe('IMPERIUM_SUBJECT_TAG_POS');
		expect(subject_tag_env_name('configuraciones-de-vista')).toBe(
			'IMPERIUM_SUBJECT_TAG_CONFIGURACIONES_DE_VISTA',
		);
	});

	test('un tag vacío no se publica: manda el pin del compose', () => {
		expect(subject_tag_env('pos', null)).toEqual({});
		expect(subject_tag_env('pos', '')).toEqual({});
		// `${VAR:-default}` cae al default también con la variable vacía, así
		// que publicarla en blanco sería peor que no publicarla.
		expect(subject_tag_env('pos', 'no-es-una-imagen')).toEqual({});
	});

	test('con imagen válida publica solo el tag', () => {
		expect(
			subject_tag_env('pos', 'ghcr.io/opus-perpetuus/subject-pos:0.1.2'),
		).toEqual({ IMPERIUM_SUBJECT_TAG_POS: '0.1.2' });
	});

	test('image_tag solo acepta imágenes del registro propio', () => {
		expect(image_tag('ghcr.io/opus-perpetuus/subject-pos:0.1.2')).toBe(
			'0.1.2',
		);
		expect(image_tag('docker.io/otro/cosa:1.0')).toBe('');
		expect(image_tag(null)).toBe('');
	});
});

describe('precedencia de subject_image_ref', () => {
	test('la imagen concreta gana al tag global', () => {
		// Regresión: el global reescribía el tag de TODAS las apps, así que el
		// `docker rmi` del desinstalar apuntaba a una imagen que no corría.
		process.env.IMPERIUM_SUBJECT_TAG = '0.1.0';
		expect(
			subject_image_ref({
				slug: 'tienda',
				image: 'ghcr.io/opus-perpetuus/subject-tienda:0.4.7',
			}),
		).toBe('ghcr.io/opus-perpetuus/subject-tienda:0.4.7');
	});

	test('el selector por app gana a todo', () => {
		process.env.IMPERIUM_SUBJECT_TAG = '0.1.0';
		process.env.IMPERIUM_SUBJECT_TAG_TIENDA = '9.9.9';
		expect(
			subject_image_ref({
				slug: 'tienda',
				image: 'ghcr.io/opus-perpetuus/subject-tienda:0.4.7',
			}),
		).toBe('ghcr.io/opus-perpetuus/subject-tienda:9.9.9');
	});

	test('sin imagen conocida el global sigue sirviendo para pinar la flota', () => {
		process.env.IMPERIUM_SUBJECT_TAG = '0.2.0';
		expect(subject_image_ref({ slug: 'pos' })).toBe(
			'ghcr.io/opus-perpetuus/subject-pos:0.2.0',
		);
	});
});

describe('compose_update_args', () => {
	test('recrea a la fuerza y vuelve a bajar la imagen', () => {
		// Sin --force-recreate, republicar el MISMO tag deja el contenedor
		// viejo en pie; sin --pull always no se entera de que el tag se movió.
		expect(compose_update_args('subject-pos', [])).toEqual([
			'up',
			'-d',
			'--no-deps',
			'--force-recreate',
			'--pull',
			'always',
			'subject-pos',
		]);
	});

	test('rechaza un servicio que no es una app', () => {
		expect(() => compose_update_args('postgres', [])).toThrow();
	});
});

describe('detección de actualización', () => {
	const A = 'ghcr.io/opus-perpetuus/subject-pos:0.1.2';
	const B = 'ghcr.io/opus-perpetuus/subject-pos:0.1.3';

	test('hay actualización cuando el catálogo pide otra imagen', () => {
		expect(subject_update_available(true, A, B)).toBe(true);
	});

	test('no la hay si coinciden', () => {
		expect(subject_update_available(true, A, A)).toBe(false);
	});

	test('una app sin instalar nunca tiene actualización', () => {
		expect(subject_update_available(false, A, B)).toBe(false);
	});

	test('sin imagen instalada conocida no se inventa una actualización', () => {
		// Instalada antes de que existiera la columna: no se sabe qué corre, y
		// anunciar "actualizable" sería adivinar.
		expect(subject_update_available(true, null, B)).toBe(false);
		expect(subject_update_available(true, '', B)).toBe(false);
	});

	test('subject_image_tag saca el tag', () => {
		expect(subject_image_tag(A)).toBe('0.1.2');
		expect(subject_image_tag(null)).toBe('');
		expect(subject_image_tag('sin-tag')).toBe('');
	});
});

describe('estado updating', () => {
	test('es busy mientras hay job', () => {
		expect(visible_lifecycle_status('updating', true, true)).toEqual({
			status: 'updating',
			busy: true,
		});
	});

	test('un updating huérfano vuelve a instalada, nunca a desinstalada', () => {
		// Actualizar no desinstala: si el proceso murió a media actualización
		// la app sigue estando, con su imagen anterior.
		expect(visible_lifecycle_status('updating', true, false)).toEqual({
			status: 'installed',
			busy: false,
		});
	});
});

describe('interruptor de auto-actualización', () => {
	test('nace apagado ante cualquier duda', () => {
		expect(coerce_auto_update_flag(undefined)).toBe(false);
		expect(coerce_auto_update_flag(null)).toBe(false);
		expect(coerce_auto_update_flag('')).toBe(false);
		expect(coerce_auto_update_flag({})).toBe(false);
	});

	test('solo un SÍ explícito enciende', () => {
		expect(coerce_auto_update_flag(true)).toBe(true);
		expect(coerce_auto_update_flag('true')).toBe(true);
		expect(coerce_auto_update_flag('SI')).toBe(true);
		expect(coerce_auto_update_flag('sí')).toBe(true);
		expect(coerce_auto_update_flag(1)).toBe(true);
	});

	test('una fila migrada de Mongo llega envuelta y NO debe encender', () => {
		// `Boolean('"false"')` es true: sin desenvolver, el flag se encendía
		// solo en cualquier instancia migrada.
		expect(coerce_auto_update_flag('"false"')).toBe(false);
		expect(coerce_auto_update_flag('"\\"false\\""')).toBe(false);
		expect(coerce_auto_update_flag('"true"')).toBe(true);
	});
});
