/**
 * Extracción / generación IA — mismo contrato que
 * backend/src/services/ai-extraction.
 */
import type { ImperiumStore } from './store.ts';

const OPENCODE_DEFAULT_BASE_URL = 'https://opencode.ai/zen/v1';
const OPENCODE_DEFAULT_MODEL = 'deepseek-v4-flash-free';
const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_DEFAULT_MODEL = 'claude-opus-4-8';
const MAX_TOKENS = 16000;
const REQUEST_TIMEOUT_MS = 120_000;

export type AiFile = { filename?: string; mime: string; content_base64: string };

function cfg_text(value: unknown, fallback = '') {
	return String(value ?? fallback).replace(/^"+|"+$/g, '').trim() || fallback;
}

async function cfg(store: ImperiumStore, ref: string) {
	return cfg_text((await store.find_where('configuration', { ref }))?.value);
}

export async function ai_settings(store: ImperiumStore) {
	return {
		provider: (await cfg(store, 'configuration-ai-extraction-provider')) || 'opencode',
		opencode_endpoint: await cfg(store, 'configuration-ai-extraction-opencode-endpoint'),
		opencode_api_key: await cfg(store, 'configuration-ai-extraction-opencode-api-key'),
		opencode_model: await cfg(store, 'configuration-ai-extraction-opencode-model'),
		anthropic_api_key: await cfg(store, 'configuration-ai-extraction-anthropic-api-key'),
		anthropic_model: await cfg(store, 'configuration-ai-extraction-anthropic-model'),
	};
}

function parse_response(raw_text: string): Record<string, unknown> {
	let text = raw_text.trim();
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fenced) text = fenced[1]!.trim();
	const start = text.indexOf('{');
	const end = text.lastIndexOf('}');
	if (start === -1 || end === -1 || end <= start) {
		throw new Error('La respuesta de la IA no contiene un JSON reconocible.');
	}
	try {
		const parsed = JSON.parse(text.slice(start, end + 1));
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			throw new Error('no es un objeto');
		}
		return parsed as Record<string, unknown>;
	} catch {
		throw new Error('La respuesta de la IA no es un JSON válido; intenta de nuevo.');
	}
}

function validate_against_schema(data: Record<string, unknown>, json_schema: Record<string, unknown>) {
	const required = Array.isArray(json_schema.required) ? (json_schema.required as string[]) : [];
	const missing = required.filter((key) => !(key in data));
	if (missing.length) {
		throw new Error(`La respuesta de la IA no incluye los campos requeridos: ${missing.join(', ')}`);
	}
}

async function fetch_json(url: string, init: RequestInit, timeout_ms = REQUEST_TIMEOUT_MS) {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeout_ms);
	try {
		const response = await fetch(url, { ...init, signal: controller.signal });
		return response;
	} catch (error: unknown) {
		if (error instanceof Error && error.name === 'AbortError') {
			throw new Error('Tiempo de espera agotado al contactar el servidor de IA.');
		}
		throw error;
	} finally {
		clearTimeout(timeout);
	}
}

async function opencode_chat(
	settings: Awaited<ReturnType<typeof ai_settings>>,
	system: string,
	user_content: string | Record<string, unknown>[],
) {
	if (!settings.opencode_api_key) {
		throw new Error(
			'Configura la API key de opencode (configuration-ai-extraction-opencode-api-key).',
		);
	}
	const base = (settings.opencode_endpoint || OPENCODE_DEFAULT_BASE_URL).replace(/\/+$/, '');
	const response = await fetch_json(`${base}/chat/completions`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${settings.opencode_api_key}`,
		},
		body: JSON.stringify({
			model: settings.opencode_model || OPENCODE_DEFAULT_MODEL,
			max_tokens: MAX_TOKENS,
			messages: [
				{ role: 'system', content: system },
				{ role: 'user', content: user_content },
			],
		}),
	});
	if (!response.ok) {
		const detail = await response.text().catch(() => '');
		throw new Error(`opencode respondió ${response.status}: ${detail || response.statusText}`);
	}
	const data = (await response.json()) as {
		choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
	};
	const raw = data.choices?.[0]?.message?.content;
	const text =
		typeof raw === 'string'
			? raw.trim()
			: Array.isArray(raw)
				? raw.map((part) => part.text ?? '').join('\n').trim()
				: '';
	if (!text) throw new Error('opencode no devolvió texto en la respuesta.');
	return text;
}

async function anthropic_message(
	settings: Awaited<ReturnType<typeof ai_settings>>,
	system: string,
	content: Record<string, unknown>[],
) {
	if (!settings.anthropic_api_key) {
		throw new Error(
			'Configura la API key de Anthropic (configuration-ai-extraction-anthropic-api-key).',
		);
	}
	const response = await fetch_json(`${ANTHROPIC_BASE_URL}/v1/messages`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'x-api-key': settings.anthropic_api_key,
			'anthropic-version': ANTHROPIC_VERSION,
		},
		body: JSON.stringify({
			model: settings.anthropic_model || ANTHROPIC_DEFAULT_MODEL,
			max_tokens: MAX_TOKENS,
			system,
			messages: [{ role: 'user', content }],
		}),
	});
	if (!response.ok) {
		const detail = await response.text().catch(() => '');
		throw new Error(`Anthropic respondió ${response.status}: ${detail || response.statusText}`);
	}
	const data = (await response.json()) as {
		content?: Array<{ type: string; text?: string }>;
		stop_reason?: string;
	};
	if (data.stop_reason === 'refusal') {
		throw new Error(
			'La IA rechazó la solicitud por políticas de seguridad; reformula la petición.',
		);
	}
	if (data.stop_reason === 'max_tokens') {
		throw new Error(
			'La respuesta de la IA excedió el límite de tokens; intenta con un documento más corto.',
		);
	}
	const text = (data.content ?? [])
		.filter((block) => block.type === 'text')
		.map((block) => block.text ?? '')
		.join('\n')
		.trim();
	if (!text) throw new Error('La API de Anthropic no devolvió texto.');
	return text;
}

export async function generate_text(
	store: ImperiumStore,
	request: { instruction?: string; context_text?: string },
) {
	const instruction = String(request.instruction ?? '').trim();
	if (!instruction) throw new Error('Escribe una instrucción para generar el texto.');
	const settings = await ai_settings(store);
	const system =
		'Responde ÚNICAMENTE con el texto solicitado en markdown, sin explicaciones ni comentarios adicionales.';
	const user = [
		instruction,
		request.context_text
			? `Contenido actual del editor (úsalo como contexto):\n${request.context_text}`
			: '',
	]
		.filter(Boolean)
		.join('\n\n');
	if (settings.provider.toLowerCase() === 'anthropic') {
		return (
			await anthropic_message(settings, system, [{ type: 'text', text: user }])
		).trim();
	}
	return (await opencode_chat(settings, system, user)).trim();
}

export async function extract_structured(
	store: ImperiumStore,
	request: {
		instructions: string;
		json_schema: Record<string, unknown>;
		text?: string;
		files?: AiFile[];
	},
) {
	if (!request.text && !(request.files ?? []).length) {
		throw new Error('Se necesita un documento (texto o archivo).');
	}
	const settings = await ai_settings(store);
	const system = [
		request.instructions,
		'Responde ÚNICAMENTE con un JSON válido (sin explicaciones ni markdown) que cumpla exactamente este esquema:',
		JSON.stringify(request.json_schema),
	].join('\n\n');
	const files = request.files ?? [];
	let raw: string;
	if (settings.provider.toLowerCase() === 'anthropic') {
		const content: Record<string, unknown>[] = files.map((file) => {
			const source = { type: 'base64', media_type: file.mime, data: file.content_base64 };
			return file.mime.startsWith('image/')
				? { type: 'image', source }
				: { type: 'document', source };
		});
		content.push({
			type: 'text',
			text: request.text ? `Documento:\n${request.text}` : 'Analiza los archivos adjuntos.',
		});
		raw = await anthropic_message(settings, system, content);
	} else {
		const has_non_image = files.some((file) => !file.mime.startsWith('image/'));
		if (has_non_image) {
			throw new Error(
				"El modelo configurado de opencode no soporta archivos adjuntos; usa el proveedor 'anthropic' o configura un modelo con soporte de archivos.",
			);
		}
		if (!files.length) {
			raw = await opencode_chat(
				settings,
				system,
				request.text ? `Documento:\n${request.text}` : 'Analiza el documento.',
			);
		} else {
			const user_parts: Record<string, unknown>[] = [
				{
					type: 'text',
					text: request.text
						? `Documento:\n${request.text}`
						: 'Analiza los archivos adjuntos.',
				},
			];
			for (const file of files) {
				user_parts.push({
					type: 'image_url',
					image_url: { url: `data:${file.mime};base64,${file.content_base64}` },
				});
			}
			raw = await opencode_chat(settings, system, user_parts);
		}
	}
	const data = parse_response(raw);
	validate_against_schema(data, request.json_schema);
	return data;
}
