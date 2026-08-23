/**
 * Plantillas del designer: mismo lock de página que
 * `user-print-template.service.ts` (`apply_report_pdf_setting_lock`).
 */
import { as_object, type ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';

export function is_print_template_resource(resource: string) {
	return resource === 'user-print-template';
}

function text(value: unknown): string {
	return String(value ?? '').trim();
}

function as_bool(value: unknown): boolean {
	if (typeof value === 'boolean') return value;
	return text(value).toLowerCase() === 'true';
}

function map_page_size_preset(value: unknown): string {
	const normalized = text(value).toLowerCase();
	if (normalized === 'letter') return 'letter';
	if (normalized === 'legal') return 'legal';
	if (normalized === 'custom') return 'custom';
	return 'a4';
}

function map_orientation(value: unknown): string {
	return text(value).toLowerCase() === 'landscape' ? 'landscape' : 'portrait';
}

function normalize_margin(value: unknown, fallback = 10): number {
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || Number.isNaN(parsed)) return fallback;
	return Math.max(0, Math.min(100, parsed));
}

/**
 * Si el canvas está en modo reporte, copia tamaño/márgenes de
 * `reports-pdf-setting` y no deja que el usuario los cambie a mano.
 */
export async function prepare_print_template_write(
	store: ImperiumStore,
	incoming: ImperiumDoc,
): Promise<ImperiumDoc> {
	const name = text(incoming.name);
	if (name.length < 4) {
		throw new Error('El nombre debe contener cuatro letras o mas');
	}
	if (!text(incoming.template_html)) {
		throw new Error('Debes definir una plantilla HTML');
	}

	const canvas = as_object(incoming.canvas_schema);
	if (!canvas || !as_bool(canvas.report_mode)) return incoming;

	const setting_id = text(canvas.report_pdf_setting);
	if (!setting_id) return incoming;
	if (!store.has('reports-pdf-setting')) {
		throw new Error('La configuración PDF seleccionada para el reporte no existe');
	}

	const setting = await store.find_id('reports-pdf-setting', setting_id);
	if (!setting) {
		throw new Error('La configuración PDF seleccionada para el reporte no existe');
	}

	return {
		...incoming,
		page_size_preset: map_page_size_preset(setting.page_size_preset),
		orientation: map_orientation(setting.orientation),
		margin_top_mm: normalize_margin(setting.margin_top_mm),
		margin_right_mm: normalize_margin(setting.margin_right_mm),
		margin_bottom_mm: normalize_margin(setting.margin_bottom_mm),
		margin_left_mm: normalize_margin(setting.margin_left_mm),
	};
}
