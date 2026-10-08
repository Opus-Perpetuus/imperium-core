/**
 * Almacén de documentos Imperium sobre los schemas SQL de las apps.
 * Un recurso canónico (products, pedidos) aunque el menú lo repita.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	pg_schema_name,
	PUBLIC_LANDING_ENABLED_REF,
	public_landing_configuration_seed,
} from '@opus-perpetuus/imperium-core-kit';
import {
	as_array,
	as_object,
	from_imperium,
	to_imperium,
	type ImperiumDoc,
} from './envelope.ts';
import { is_record_id } from './record-id.ts';
import { SearchEngine, search_text_from_doc } from './search-engine.ts';
import {
	ACTIVITY_CONTEXTS,
	CHAT_ATTACHMENT_MODELS,
	chat_can,
	chat_role,
	DIRECT_CONVERSATION_SETTINGS,
	invite_state,
	is_chat_attachment,
	is_chat_private_resource,
} from './chat-access.ts';
import { mongo_match_to_sql } from './record-rules.ts';
import { products_inventory_cost } from './products-flow.ts';
import { vehicle_by_status } from './vehicle-flow.ts';
import { delivery_package_by_status } from './delivery-package-flow.ts';
import { pedidos_sales_stats } from './pedidos-flow.ts';
import { pedido_order_sql } from './pedidos-list-order.ts';
import {
	purchase_order_stats,
	with_purchase_order_supplier_name,
} from './purchase-order-flow.ts';
import { planeacion_statistics } from './planeacion-flow.ts';
import { invoice_request_stats } from './invoice-request-flow.ts';
import { physical_count_by_state } from './inventory-physical-count-flow.ts';
import {
	cost_entry_stats,
	inventory_movement_stats_extras,
	stock_quant_stats_extras,
} from './inventory-logistics-flow.ts';
import { location_stats_extras } from './location-flow.ts';
import { delivery_return_by_state } from './delivery-return-flow.ts';
import { record_document_history } from './history.ts';
import {
	advance_increment_sequence,
	type PatternContext,
} from './custom-pattern-render.ts';
import { list_search_columns } from './list-search.ts';
import {
	apply_schema_setters,
	assert_required_fields,
	FieldValidationError,
	required_fields_for,
} from './required-fields.ts';
import { list_projection_keys } from './list-projection.ts';
import { is_base_subject_slug } from './subject-runtime.ts';
import { icon_search_terms_es } from './font-awesome-icon-search-es.ts';

export { is_record_id };

/** Subirla re-siembra el catálogo de íconos una vez en cada servidor. */
const ICON_CATALOG_SEED_VERSION = 2;

export type ExtraCol = {
	name: string;
	mongo?: string;
	pg?: string;
	crud?: string;
	label?: string;
	component?: string;
};

export type ModuleLoc = {
	slug: string;
	technical_id: string;
	resource: string;
	table: string;
	collection: string;
	name: string;
	columns: ExtraCol[];
};

export type SubjectInfo = {
	slug: string;
	name: string;
	path: string;
	menu_ref: string;
	technical_id: string;
	image: string;
	/** Apps que deben estar instaladas antes (technical ids, sin las base). */
	depends_on?: string[];
	modules: Array<{
		resource: string;
		path: string;
		menu_ref: string;
		name: string;
		icon?: string;
	}>;
	/** Árbol extra (carpetas y hojas sin tabla) que reshape materializa. */
	menus?: Array<{
		menu_ref: string;
		name: string;
		path?: string;
		icon: string;
		parent_ref?: string;
		/** Recursos de la app que habilita (`recurso` o `recurso:read`). */
		resources?: string[];
	}>;
};

export const PREFER_OWNER: Record<string, string> = {
	products: 'almacen',
	pedidos: 'ventas',
};

/** Bases Angular (`super('proyectos')`) vs resource del catálogo modular. */
export const RESOURCE_ALIASES: Record<string, string> = {
	proyectos: 'planeacion-proyectos',
	'mis-tareas': 'planeacion-mis-tareas',
	'proyectos-task': 'planeacion-proyectos-task',
	usuario: 'user',
	__time_sheets: 'time-sheets',
};

function round_qty(value: number): number {
	return Math.round((value + Number.EPSILON) * 10000) / 10000;
}

/**
 * El service original (`create_system_movements`) siempre recalcula
 * stock_disponible_resultante = total − apartado. El default Mongoose es 0
 * y no debe quedarse si el total resultante es distinto.
 */
function apply_inventory_movement_ledger(resource: string, doc: ImperiumDoc) {
	const canonical = RESOURCE_ALIASES[resource] ?? resource;
	if (canonical !== 'inventory-movement') return;
	const total = Number(doc.stock_total_resultante ?? 0);
	const apartado = Number(doc.stock_apartado_resultante ?? 0);
	if (!Number.isFinite(total) || !Number.isFinite(apartado)) return;
	doc.stock_disponible_resultante = round_qty(total - apartado);
}

const SQL_NAME_FALLBACKS = [
	'nombre_completo',
	'nombre_paciente',
	'citizen_name',
	'ticket_sequence',
];

/**
 * El SQL del kit exige `name NOT NULL`. Modelos como Patient / MedicalFile no
 * tienen `name` en Mongoose (el form original manda `nombre_completo` /
 * `nombre_paciente`). Sin este relleno el INSERT truena con 23502.
 */
function ensure_sql_name(resource: string, doc: ImperiumDoc) {
	if (doc.name != null && String(doc.name).trim() !== '') return;
	if (required_fields_for(resource).includes('name')) return;
	for (const field of SQL_NAME_FALLBACKS) {
		const value = String(doc[field] ?? '').trim();
		if (value) {
			doc.name = value;
			return;
		}
	}
	doc.name = '';
}

/** Unique de negocio que el original imponía en Mongoose y Postgres aún no indexa. */
const UNIQUE_FIELDS: Record<string, string[]> = {
	user: ['email'],
	products: ['codigo'],
	'physical-device': ['install_uuid'],
	'cfdi-document': ['uuid'],
	pedidos: ['offline_uuid', 'folio_offline'],
	patient: ['numero_expediente'],
	'payroll-concept': ['clave_interna'],
	sku: ['codigo'],
	'ticketing-system-consecutive': ['name'],
	'api-keys': ['api_key'],
	'auto-increment-control': ['_unique_string_reference'],
	'postgres-table-tracker': ['__model_name'],
	contrato: ['contrato'],
	'font-awesome-icon-catalog': ['icon'],
	'user-settings': ['user_id'],
	'interface-restriction': ['html_element_hash'],
	'inventory-internal-location': ['codigo'],
	'violation-mobility-law': ['name'],
	violation: ['code'],
	'module-management-reference': ['reference'],
	'mcp-user-token': ['token_hash'],
	'epson-ticket-template': ['template_key'],
	'chat-conversations': ['conversation_key', 'join_code'],
	'chat-meetings': ['code'],
};

/** Unique solo entre activos (`partialFilterExpression: { is_active: { $ne: false } }`). */
const UNIQUE_FIELDS_ACTIVE: Record<string, string[]> = {
	'custom-field-control': ['module_id'],
};

/** Unique compuesto que el original imponía con índice multi-campo. */
const UNIQUE_COMPOSITES: Record<string, string[][]> = {
	cobranza: [['source_module', 'source_id']],
	'cfdi-catalog': [['catalog', 'code']],
	'custom-user-themes': [['user_id', 'theme_name']],
	'documentation-page': [['slug', 'folder_path']],
	'inventory-lot': [['producto', 'name']],
	messages: [
		['sender_user_id', 'client_id'],
		['conversation_id', 'seq'],
	],
	'chat-members': [['conversation_id', 'user_id']],
	'chat-reactions': [['message_id', 'user_id', 'kind', 'value']],
	'chat-saved': [['user_id', 'message_id']],
	'chat-story-views': [['story_id', 'viewer_id']],
	'chat-meeting-attendance': [['call_id', 'participant_key']],
};

/** Unique compuesto solo entre activos. */
const UNIQUE_COMPOSITES_ACTIVE: Record<string, string[][]> = {
	'user-pin': [['document_model', 'document_id']],
	'home-pin': [['user_id', 'path']],
};

function unique_fields_for(resource: string): string[] {
	return UNIQUE_FIELDS[resource] ?? UNIQUE_FIELDS[RESOURCE_ALIASES[resource] ?? ''] ?? [];
}

function unique_composites_for(resource: string): string[][] {
	return (
		UNIQUE_COMPOSITES[resource] ??
		UNIQUE_COMPOSITES[RESOURCE_ALIASES[resource] ?? ''] ??
		[]
	);
}

function unique_fields_active_for(resource: string): string[] {
	return (
		UNIQUE_FIELDS_ACTIVE[resource] ??
		UNIQUE_FIELDS_ACTIVE[RESOURCE_ALIASES[resource] ?? ''] ??
		[]
	);
}

function unique_composites_active_for(resource: string): string[][] {
	return (
		UNIQUE_COMPOSITES_ACTIVE[resource] ??
		UNIQUE_COMPOSITES_ACTIVE[RESOURCE_ALIASES[resource] ?? ''] ??
		[]
	);
}

function index_name(table_key: string, suffix: string): string {
	const raw = `uq_${table_key}_${suffix}`.replace(/[^a-z0-9_]/gi, '_').slice(0, 63);
	return raw.replace(/_+$/, '') || 'uq_idx';
}

/**
 * Unique de negocio en Postgres (Mongoose lo imponía; aquí no había INDEX).
 * Columna física si existe; si no, expresión sobre `payload`.
 */
export function unique_index_sqls(input: {
	quoted_table: string;
	table_key: string;
	fields: readonly string[];
	composites?: readonly string[][];
	columns: ReadonlySet<string>;
}): string[] {
	const out: string[] = [];
	for (const field of input.fields) {
		const idx = qident(index_name(input.table_key, field));
		if (input.columns.has(field)) {
			const col = qident(field);
			out.push(
				`CREATE UNIQUE INDEX IF NOT EXISTS ${idx} ON ${input.quoted_table} (${col}) WHERE ${col} IS NOT NULL AND btrim(${col}::text) <> ''`,
			);
		} else {
			const expr = `payload ->> '${field.replace(/'/g, "''")}'`;
			out.push(
				`CREATE UNIQUE INDEX IF NOT EXISTS ${idx} ON ${input.quoted_table} ((${expr})) WHERE ${expr} IS NOT NULL AND btrim(${expr}) <> ''`,
			);
		}
	}
	for (const fields of input.composites ?? []) {
		if (!fields.length) continue;
		const idx = qident(index_name(input.table_key, fields.join('_')));
		const cols = fields.map((field) =>
			input.columns.has(field)
				? qident(field)
				: `(payload ->> '${field.replace(/'/g, "''")}')`,
		);
		out.push(
			`CREATE UNIQUE INDEX IF NOT EXISTS ${idx} ON ${input.quoted_table} (${cols.join(', ')})`,
		);
	}
	return out;
}

/** Lookup no-único: el UNIQUE puede fallar si ya hay duplicados; el btree igual acelera el login. */
export function lookup_index_sqls(input: {
	quoted_table: string;
	table_key: string;
	fields: readonly string[];
	columns: ReadonlySet<string>;
}): string[] {
	const out: string[] = [];
	for (const field of input.fields) {
		if (!input.columns.has(field)) continue;
		const idx = qident(index_name(input.table_key, field).replace(/^uq_/, 'ix_'));
		const col = qident(field);
		out.push(`CREATE INDEX IF NOT EXISTS ${idx} ON ${input.quoted_table} (${col})`);
	}
	return out;
}

const LOOKUP_PAYLOAD_FIELDS: Record<string, string[]> = {
	'document-change-history': ['documentId', 'modelName'],
	messages: ['conversationKey'],
};

function lookup_payload_fields_for(resource: string): string[] {
	return (
		LOOKUP_PAYLOAD_FIELDS[resource] ??
		LOOKUP_PAYLOAD_FIELDS[RESOURCE_ALIASES[resource] ?? ''] ??
		[]
	);
}

export function payload_lookup_index_sqls(input: {
	quoted_table: string;
	table_key: string;
	fields: readonly string[];
}): string[] {
	const out: string[] = [];
	for (const field of input.fields) {
		const idx = qident(index_name(input.table_key, field).replace(/^uq_/, 'ix_'));
		const expr = `(payload ->> '${field.replace(/'/g, "''")}')`;
		out.push(`CREATE INDEX IF NOT EXISTS ${idx} ON ${input.quoted_table} (${expr})`);
	}
	return out;
}

/** Página de historial: WHERE documentId + ORDER BY created_at DESC LIMIT n. */
export function history_page_index_sqls(input: {
	quoted_table: string;
	table_key: string;
}): string[] {
	const idx = qident(index_name(input.table_key, 'doc_created').replace(/^uq_/, 'ix_'));
	return [
		`CREATE INDEX IF NOT EXISTS ${idx} ON ${input.quoted_table} ((payload ->> 'documentId'), created_at DESC)`,
	];
}

/** Una subida del chat que aún nadie ligó a un mensaje. */
const CHAT_PENDING_UPLOAD = `payload -> 'chatUpload' IS NOT NULL AND COALESCE(related_record_id, '') = '' AND is_active IS DISTINCT FROM false`;
/** La condición del único parcial de `user-settings`: sin ella, buscar por `user_id` recorre la tabla. */
const SETTINGS_OWNER = "btrim(payload ->> 'user_id') <> ''";
/** Un mensaje 1:1 legado que el respaldo aún no lleva a su conversación; `m` con el alias `m.`. */
const legacy_pending = (m = '') =>
	`${m}conversation_id IS NULL AND ${m}is_active IS DISTINCT FROM false AND ${m}payload ->> 'sourceType' = 'chat' AND ${m}payload ->> 'conversationKey' <> ''`;
/** Lo que aún puede vencer: el mismo filtro que el reclamo de `expire` y de `story`. */
const DUE_PENDING = 'expires_at IS NOT NULL AND state IS NULL AND is_active IS DISTINCT FROM false';
/** Una serie viva que aún tiene ocurrencias: el filtro de `meetings_due_to_advance` y de su índice. */
const RECURRING_PENDING = [
	"state IS DISTINCT FROM 'cancelled'",
	'is_active IS DISTINCT FROM false',
	"jsonb_typeof(payload -> 'recurrence') = 'object'",
	"COALESCE(payload ->> 'recurrenceDone', 'false') <> 'true'",
].join(' AND ');
const CHAT_FILE_MODELS = `related_model IN (${[...CHAT_ATTACHMENT_MODELS].map((model) => `'${model}'`).join(', ')})`;

/** Índices de las páginas del chat (contrato §1) que no son un único simple. */
const CHAT_INDEXES: Record<
	string,
	Array<{ suffix: string; on: string; where?: string; unique?: true; using?: 'gin' }>
> = {
	messages: [
		{ suffix: 'conversation_updated', on: 'conversation_id, updated_at' },
		{ suffix: 'expires', on: 'expires_at', where: 'expires_at IS NOT NULL' },
		// El reclamo de lo vencido (chat_claim_due_sql) sin recorrer lo que ya caducó alguna vez.
		{ suffix: 'expire_due', on: 'expires_at, id', where: DUE_PENDING },
		// Un invitado no tiene sender_user_id: su reintento se reconoce por conversación.
		{ suffix: 'guest_client', on: 'conversation_id, client_id', where: 'sender_user_id IS NULL', unique: true },
		// Borrar un mensaje limpia el texto de las respuestas que lo citan.
		{
			suffix: 'reply_to',
			on: "(payload ->> 'replyToMessageId')",
			where: "(payload ->> 'replyToMessageId') IS NOT NULL",
		},
		// Los lotes del respaldo leen solo lo pendiente, ya en orden de llave; migrado, queda vacío.
		{ suffix: 'backfill_pending', on: "(payload ->> 'conversationKey')", where: legacy_pending() },
		// El contacto de historias (contact_sql) pregunta si el dueño escribió por un directo: sin
		// esto se cruzan todos sus mensajes con todos los del directo. El remitente va primero para
		// que las páginas de un hilo sigan tomando (conversation_id, seq).
		{ suffix: 'sender_conversation', on: 'sender_user_id, conversation_id' },
	],
	'chat-conversations': [{ suffix: 'inbox', on: 'last_message_at DESC, id DESC' }],
	'chat-members': [
		{ suffix: 'user_state', on: 'user_id, state' },
		{ suffix: 'conversation_state', on: 'conversation_id, state' },
	],
	'chat-audit': [{ suffix: 'conversation_created', on: 'conversation_id, created_at DESC' }],
	'chat-scheduled': [{ suffix: 'state_send', on: 'state, send_at' }],
	'chat-saved': [{ suffix: 'state_remind', on: 'state, remind_at' }],
	'chat-stories': [
		{ suffix: 'expires', on: 'expires_at' },
		{ suffix: 'expire_due', on: 'expires_at, id', where: DUE_PENDING },
		{ suffix: 'author_expires', on: 'author_id, expires_at' },
	],
	// El barrido y la resincronización solo recorren lo vivo.
	'chat-calls': [
		{ suffix: 'live', on: 'state', where: "state IN ('ringing', 'active')" },
		// Dos personas que se llaman a la vez no abren dos llamadas en la misma conversación.
		{
			suffix: 'live_conversation',
			on: 'conversation_id',
			where: "state IN ('ringing', 'active') AND meeting_id IS NULL",
			unique: true,
		},
		{ suffix: 'participants', on: "(payload -> 'participantIds') jsonb_path_ops", using: 'gin' },
		{ suffix: 'conversation_started', on: 'conversation_id, started_at DESC' },
		{ suffix: 'meeting', on: 'meeting_id' },
		{ suffix: 'created', on: 'created_at DESC, id DESC' },
	],
	'chat-meetings': [
		{ suffix: 'members', on: "(payload -> 'memberIds') jsonb_path_ops", using: 'gin' },
		{ suffix: 'next_start', on: 'next_start_at' },
		{ suffix: 'host', on: 'host_id' },
		// La pasada de trabajos busca cada 30 s las series por avanzar; sin esto recorre todo el historial.
		{ suffix: 'recurring_due', on: 'next_start_at, id', where: RECURRING_PENDING },
	],
	'chat-meeting-attendance': [{ suffix: 'meeting', on: 'meeting_id' }],
	'chat-meeting-questions': [{ suffix: 'call_created', on: 'call_id, created_at' }],
	'chat-meeting-transcripts': [{ suffix: 'call_seq', on: 'call_id, seq' }],
	// La bandeja de Actividad de cada persona, del más nuevo al más viejo.
	mentions: [
		{ suffix: 'recipient_created', on: "(payload ->> 'mentionedUserId'), created_at DESC, id DESC" },
		{ suffix: 'message', on: "(payload ->> 'messageId')", where: "(payload ->> 'messageId') IS NOT NULL" },
	],
	// La campana de cada persona, de la más nueva a la más vieja (contrato §1.12).
	notifications: [{ suffix: 'recipient_created', on: "(payload ->> 'recipientId'), created_at DESC" }],
	// Un reintento de la subida (mismo client_upload_id) devuelve la misma fila.
	'attachment-management': [
		{
			suffix: 'chat_upload',
			on: "created_by_id, (payload #>> '{chatUpload,clientUploadId}')",
			where: "payload -> 'chatUpload' IS NOT NULL AND is_active IS DISTINCT FROM false",
			unique: true,
		},
		// La limpieza de lo que nadie ligó en 24 h no recorre los demás adjuntos.
		{ suffix: 'chat_pending', on: 'created_at', where: CHAT_PENDING_UPLOAD },
		// Un reenvío comparte el archivo: se borra del disco cuando ninguna fila del chat lo usa.
		{ suffix: 'chat_file', on: 'name_stored', where: CHAT_FILE_MODELS },
	],
};

export function chat_index_sqls(input: {
	resource: string;
	quoted_table: string;
	table_key: string;
}): string[] {
	return (CHAT_INDEXES[input.resource] ?? []).map((index) => {
		const name = index_name(input.table_key, index.suffix);
		const idx = qident(index.unique ? name : name.replace(/^uq_/, 'ix_'));
		const where = index.where ? ` WHERE ${index.where}` : '';
		const using = index.using ? `USING ${index.using} ` : '';
		return `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${idx} ON ${input.quoted_table} ${using}(${index.on})${where}`;
	});
}

/**
 * Respaldo de los 1:1 legados (`chat_backfill_direct`). Un lote es un conjunto de
 * `conversationKey` cuyos mensajes aún no tienen conversación: el WHERE es el cursor.
 * `$1` es el arreglo de llaves del lote (JSON); `$2`, la hora de la corrida.
 */
export function chat_backfill_sqls(tables: { messages: string; conversations: string; members: string }) {
	const { messages, conversations, members } = tables;
	const pending = legacy_pending('m.');
	const in_batch = `IN (SELECT jsonb_array_elements_text($1::jsonb))`;
	const new_id = `left(replace(gen_random_uuid()::text, '-', ''), 24)`;
	const attachments = `CASE WHEN jsonb_typeof(m.payload -> 'attachments') = 'array'
		THEN m.payload -> 'attachments' ELSE '[]'::jsonb END`;
	// Igual que la búsqueda del chat: minúsculas y sin diacríticos (NFD).
	const search_text = `NULLIF(btrim(lower(regexp_replace(normalize(concat_ws(' ', m.payload ->> 'message',
		(SELECT string_agg(a ->> 'name', ' ') FROM jsonb_array_elements(${attachments}) a)), NFD),
		'[\u0300-\u036f]', '', 'g'))), '')`;
	const first_mime = `l.payload #>> '{attachments,0,mimetype}'`;
	return {
		pending_keys: `SELECT DISTINCT m.payload ->> 'conversationKey' AS key
			FROM ${messages} m WHERE ${pending} ORDER BY 1 LIMIT $1`,
		/** `$1` una llave: si aún le queda algo legado; lo encuentra el índice de `conversationKey`. */
		key_pending: `SELECT 1 FROM ${messages} m WHERE m.payload ->> 'conversationKey' = $1 AND ${pending} LIMIT 1`,
		/** `$3`: los ajustes fijos de un directo. */
		conversations: `INSERT INTO ${conversations}
				(id, name, description, is_active, kind, conversation_key, last_seq, payload, created_at, updated_at)
			SELECT ${new_id}, '', '', true,
				CASE WHEN strpos(k.key, '::') > 0 THEN 'direct' ELSE 'self' END,
				k.key, 0,
				jsonb_build_object(
					'createdById', first.sender,
					'memberCount', cardinality(string_to_array(k.key, '::')),
					'participantUserIds', to_jsonb(string_to_array(k.key, '::')),
					'settings', $3::jsonb,
					'pins', '[]'::jsonb,
					'invites', '[]'::jsonb),
				first.created_at, $2
			FROM jsonb_array_elements_text($1::jsonb) AS k(key)
			CROSS JOIN LATERAL (
				SELECT m.payload ->> 'senderUserId' AS sender, m.created_at FROM ${messages} m
				WHERE m.payload ->> 'conversationKey' = k.key AND ${pending}
				ORDER BY m.created_at, m.id LIMIT 1
			) first
			WHERE NOT EXISTS (SELECT 1 FROM ${conversations} c WHERE c.conversation_key = k.key)
			ON CONFLICT DO NOTHING
			RETURNING id`,
		/** Un envío nuevo también sube `last_seq`: el lote lo congela antes de leerlo. */
		lock: `SELECT id FROM ${conversations} WHERE conversation_key ${in_batch} FOR UPDATE`,
		members: `INSERT INTO ${members}
				(id, name, description, is_active, state, conversation_id, user_id, role,
				 last_read_seq, public_read_seq, delivered_seq, payload, created_at, updated_at)
			SELECT ${new_id}, '', '', true, 'active', c.id, u.user_id, 'member', 0, 0, 0,
				jsonb_build_object('joinedAt', c.created_at, 'visibleFromSeq', 0, 'mentionSeqs', '[]'::jsonb,
					'markedUnread', false, 'archived', false, 'notifyLevel', 'default'),
				c.created_at, $2
			FROM ${conversations} c
			CROSS JOIN LATERAL unnest(string_to_array(c.conversation_key, '::')) AS u(user_id)
			WHERE c.conversation_key ${in_batch}
				AND NOT EXISTS (SELECT 1 FROM ${members} b WHERE b.conversation_id = c.id AND b.user_id = u.user_id)
			ON CONFLICT DO NOTHING
			RETURNING id`,
		messages: `WITH ranked AS (
				SELECT m.id, c.id AS conversation_id,
					COALESCE(c.last_seq, 0) + row_number() OVER (PARTITION BY c.id ORDER BY m.created_at, m.id) AS seq
				FROM ${messages} m
				JOIN ${conversations} c ON c.conversation_key = m.payload ->> 'conversationKey'
				WHERE ${pending} AND c.conversation_key ${in_batch}
			)
			UPDATE ${messages} m SET
				conversation_id = r.conversation_id,
				seq = r.seq,
				sender_user_id = NULLIF(m.payload ->> 'senderUserId', ''),
				kind = CASE WHEN jsonb_array_length(${attachments}) > 0 THEN 'media' ELSE 'text' END,
				search_field = ${search_text},
				payload = m.payload || jsonb_build_object('conversationId', r.conversation_id)
			FROM ranked r
			WHERE m.id = r.id
			RETURNING m.id`,
		last_message: `UPDATE ${conversations} c SET
				last_seq = l.seq,
				last_message_at = l.created_at,
				updated_at = $2,
				payload = COALESCE(c.payload, '{}'::jsonb) || jsonb_build_object('lastMessage',
					jsonb_build_object(
						'messageId', l.id, 'seq', l.seq, 'senderId', l.sender_user_id,
						'senderName', COALESCE(l.payload ->> 'senderName', ''), 'kind', l.kind,
						'textPreview', left(COALESCE(l.payload ->> 'message', ''), 160), 'at', l.created_at)
					|| CASE WHEN l.kind = 'media' THEN jsonb_build_object('attachmentKind', CASE
						WHEN (l.payload #>> '{attachments,0,isImage}') = 'true' OR ${first_mime} LIKE 'image/%' THEN 'image'
						WHEN ${first_mime} LIKE 'video/%' THEN 'video'
						WHEN ${first_mime} LIKE 'audio/%' THEN 'audio'
						ELSE 'file' END) ELSE '{}'::jsonb END)
			FROM (
				SELECT DISTINCT ON (m.conversation_id)
					m.conversation_id, m.id, m.seq, m.created_at, m.sender_user_id, m.kind, m.payload
				FROM ${messages} m
				JOIN ${conversations} batch ON batch.id = m.conversation_id
				WHERE batch.conversation_key ${in_batch} AND m.seq IS NOT NULL
				ORDER BY m.conversation_id, m.seq DESC
			) l
			WHERE c.id = l.conversation_id AND l.seq > COALESCE(c.last_seq, 0)`,
		/**
		 * Enviar es leer; los acuses legados eran públicos, así que la marca pública los conserva.
		 * Lo que escribe este núcleo lleva `rev` y su lectura vive solo en las marcas: un acuse
		 * legado nunca lleva la marca más allá de uno de esos que la persona no ha leído.
		 */
		read_marks: `WITH legacy_read AS (
				SELECT m.conversation_id, u.user_id, max(m.seq) AS seq
				FROM ${messages} m
				JOIN ${conversations} c ON c.id = m.conversation_id
				CROSS JOIN LATERAL (
					SELECT m.sender_user_id AS user_id
					UNION
					SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(m.payload -> 'readByUserIds') = 'array'
						THEN m.payload -> 'readByUserIds' ELSE '[]'::jsonb END)
				) u
				WHERE c.conversation_key ${in_batch} AND m.seq IS NOT NULL
				GROUP BY m.conversation_id, u.user_id
			), capped AS (
				SELECT b.id, LEAST(r.seq, COALESCE((
					SELECT min(n.seq) - 1 FROM ${messages} n
					WHERE n.conversation_id = b.conversation_id AND n.seq > COALESCE(b.last_read_seq, 0)
						AND n.payload ? 'rev' AND n.sender_user_id IS DISTINCT FROM b.user_id
				), r.seq)) AS seq
				FROM legacy_read r
				JOIN ${members} b ON b.conversation_id = r.conversation_id AND b.user_id = r.user_id
			)
			UPDATE ${members} b SET
				last_read_seq = x.seq,
				public_read_seq = GREATEST(COALESCE(b.public_read_seq, 0), x.seq),
				delivered_seq = GREATEST(COALESCE(b.delivered_seq, 0), x.seq),
				updated_at = $2
			FROM capped x
			WHERE b.id = x.id AND x.seq > COALESCE(b.last_read_seq, 0)`,
	};
}

/**
 * Un lote del respaldo dentro de una transacción: el bloqueo de las conversaciones va antes de
 * numerar, para que un envío concurrente no tome el mismo `seq`.
 */
async function backfill_keys(
	tx: Bun.SQL,
	sqls: ReturnType<typeof chat_backfill_sqls>,
	keys: string[],
	now: string,
): Promise<{ conversations: number; members: number; messages: number }> {
	const conversations = (await tx.unsafe(sqls.conversations, [keys, now, DIRECT_CONVERSATION_SETTINGS])).length;
	await tx.unsafe(sqls.lock, [keys]);
	const members = (await tx.unsafe(sqls.members, [keys, now])).length;
	const messages = (await tx.unsafe(sqls.messages, [keys])).length;
	await tx.unsafe(sqls.last_message, [keys, now]);
	await tx.unsafe(sqls.read_marks, [keys, now]);
	return { conversations, members, messages };
}

/**
 * Envío del chat en una sola sentencia: sube `last_seq` (el bloqueo de la fila de la
 * conversación ordena los envíos concurrentes), inserta el mensaje con ese `seq`, avanza
 * las marcas del remitente (enviar es leer: quita «no leído» y las menciones pendientes) y,
 * con `attachments`, liga sus subidas. Si algo falla, la sentencia entera se revierte: no
 * quedan huecos.
 *
 * `$1` id, `$2` conversación, `$3` hora, `$4` `lastMessage` sin `seq`, `$5` name, `$6`
 * remitente, `$7` search_field, `$8` payload, `$9` client_id, `$10` kind, `$11` expires_at,
 * `$12` si la marca pública avanza, `$13` quien lee al escribirlo un mensaje sin remitente
 * (el de sistema lo lee quien lo causó), `$14` las subidas a ligar, en orden, y `$15` el programado
 * que las tenía ligadas.
 */
export function chat_insert_message_sql(tables: {
	messages: string;
	conversations: string;
	members: string;
	attachments: string | null;
}): string {
	const { messages, conversations, members, attachments } = tables;
	const bind = attachments
		? `, bound AS (
				UPDATE ${attachments} a SET
					related_model = 'Message',
					related_record_id = ins.id,
					field = 'attachments',
					index_if_is_array = (b.n - 1)::text,
					inside_array = 'true',
					updated_at = $3,
					payload = COALESCE(a.payload, '{}'::jsonb) || jsonb_build_object('chatUpload',
						COALESCE(a.payload -> 'chatUpload', '{}'::jsonb) || jsonb_build_object('boundAt', $3::text))
				FROM ins, jsonb_array_elements_text($14::jsonb) WITH ORDINALITY AS b(id, n)
				WHERE a.id = b.id AND a.created_by_id = ins.sender_user_id
					AND (COALESCE(a.related_record_id, '') = '' OR (a.related_model = 'ChatScheduled' AND a.related_record_id = $15))
			)`
		: '';
	// `$3` es la hora en que empezó la petición, que pudo tardar subiendo archivos: la conversación se
	// fecha al confirmar y nunca hacia atrás, o un `changed_since` tomado entre medias no la vería.
	const confirmed = `to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
	return `WITH bump AS (
			UPDATE ${conversations} SET
				last_seq = COALESCE(last_seq, 0) + 1,
				last_message_at = GREATEST(COALESCE(last_message_at, ''), $3, ${confirmed}),
				updated_at = GREATEST(COALESCE(updated_at, ''), $3, ${confirmed}),
				payload = COALESCE(payload, '{}'::jsonb) || jsonb_build_object('lastMessage',
					$4::jsonb || jsonb_build_object('seq', COALESCE(last_seq, 0) + 1))
			WHERE id = $2 AND is_active IS DISTINCT FROM false
			RETURNING id, last_seq
		), ins AS (
			INSERT INTO ${messages} (id, name, is_active, created_by, search_field, payload, created_at, updated_at,
				conversation_id, seq, sender_user_id, client_id, kind, expires_at)
			SELECT $1, $5, true, $6, $7, $8::jsonb, $3, $3, bump.id, bump.last_seq, $6, $9, $10, $11 FROM bump
			RETURNING *
		), mark AS (
			UPDATE ${members} m SET
				last_read_seq = GREATEST(COALESCE(m.last_read_seq, 0), ins.seq),
				delivered_seq = GREATEST(COALESCE(m.delivered_seq, 0), ins.seq),
				public_read_seq = CASE WHEN $12::boolean
					THEN GREATEST(COALESCE(m.public_read_seq, 0), ins.seq) ELSE m.public_read_seq END,
				payload = COALESCE(m.payload, '{}'::jsonb) || '{"markedUnread": false, "mentionSeqs": []}'::jsonb,
				updated_at = $3
			FROM ins
			WHERE m.conversation_id = ins.conversation_id AND m.user_id = COALESCE(ins.sender_user_id, $13)
		)${bind}
		SELECT * FROM ins`;
}

/**
 * Obtener o crear el directo (o el self) de una llave. Sin destino en ON CONFLICT: el único
 * de `conversation_key` es parcial. `$1` id nuevo, `$2` kind, `$3` llave, `$4` payload, `$5`
 * hora; los miembros: `$1` conversación, `$2` ids (JSON), `$3` payload, `$4` hora.
 */
export function chat_direct_sqls(tables: { conversations: string; members: string }) {
	const { conversations, members } = tables;
	return {
		conversation: `INSERT INTO ${conversations}
				(id, name, description, is_active, kind, conversation_key, last_seq, payload, created_at, updated_at)
			VALUES ($1, '', '', true, $2, $3, 0, $4::jsonb, $5, $5)
			ON CONFLICT DO NOTHING
			RETURNING id`,
		find: `SELECT * FROM ${conversations} WHERE conversation_key = $1 LIMIT 1`,
		members: `INSERT INTO ${members}
				(id, name, description, is_active, state, conversation_id, user_id, role,
				 last_read_seq, public_read_seq, delivered_seq, payload, created_at, updated_at)
			SELECT left(replace(gen_random_uuid()::text, '-', ''), 24), '', '', true, 'active', $1, u.user_id, 'member',
				0, 0, 0, $3::jsonb, $4, $4
			FROM jsonb_array_elements_text($2::jsonb) AS u(user_id)
			WHERE NOT EXISTS (SELECT 1 FROM ${members} b WHERE b.conversation_id = $1 AND b.user_id = u.user_id)
			ON CONFLICT DO NOTHING`,
	};
}

export type ChatMessageInsert = {
	id: string;
	conversation_id: string;
	/** `null` en un mensaje de sistema. */
	sender_user_id: string | null;
	/** Quien causó un mensaje de sistema: lo lee al escribirlo. */
	reader_user_id?: string;
	client_id: string | null;
	kind: string;
	name: string;
	search_field: string | null;
	payload: ImperiumDoc;
	/** `lastMessage` de la conversación; el `seq` lo pone la sentencia. */
	preview: ImperiumDoc;
	expires_at: string | null;
	/** El remitente comparte acuses: su marca pública también avanza. */
	share_read: boolean;
	attachment_ids: string[];
	/** El programado que sale ahora: sus subidas pasan al mensaje. */
	uploads_from?: string;
	now: string;
};

export type ChatUserBrief = { _id: string; name: string; email?: string; img?: string; is_active: boolean };

export type ChatPageDirection = 'tail' | 'before' | 'after' | 'from';

/** Los tipos que escribe el servidor (mensajes de sistema y de llamada): nunca los manda una persona. */
export const CHAT_SERVER_KINDS = ['system', 'call'] as const;
const USER_KIND_SQL = `COALESCE(kind, '') NOT IN (${CHAT_SERVER_KINDS.map((kind) => `'${kind}'`).join(', ')})`;

/** Lo que alguien ocultó para sí («borrar para mí») no le sale a esa persona. */
function not_hidden_for(viewer_param: string): string {
	return `NOT (COALESCE(payload -> 'hiddenForUserIds', '[]'::jsonb) ? ${viewer_param})`;
}

/**
 * Página de un hilo por `seq`; el único `(conversation_id, seq)` la sirve. `$1` conversación,
 * `$2` el `seq` desde el que el lector ve (exclusivo), `$3` límite, `$4` el ancla (antes de
 * ella, después o desde ella; sin ancla, la cola) y el lector al final.
 */
export function chat_message_page_sql(messages: string, direction: ChatPageDirection, user_only = false): string {
	const visible = `SELECT * FROM ${messages}
		WHERE conversation_id = $1 AND seq > $2 AND is_active IS DISTINCT FROM false
			AND ${not_hidden_for(direction === 'tail' ? '$4' : '$5')}${user_only ? ` AND ${USER_KIND_SQL}` : ''}`;
	if (direction === 'tail') return `${visible} ORDER BY seq DESC LIMIT $3`;
	if (direction === 'before') return `${visible} AND seq < $4 ORDER BY seq DESC LIMIT $3`;
	return `${visible} AND seq ${direction === 'after' ? '>' : '>='} $4 ORDER BY seq LIMIT $3`;
}

/**
 * Lo ya cargado (`seq` ≤ `$3`) que cambió después de `$4`; lo sirve `(conversation_id, updated_at)`.
 * `$5` límite y `$6` el lector.
 */
export function chat_changed_messages_sql(messages: string): string {
	return `SELECT * FROM ${messages}
		WHERE conversation_id = $1 AND seq > $2 AND seq <= $3 AND updated_at > $4 AND is_active IS DISTINCT FROM false
			AND ${not_hidden_for('$6')}
		ORDER BY updated_at, id LIMIT $5`;
}

/** Cada cambio de un mensaje sube su `rev`: el cliente descarta un delta con un `rev` que ya tiene. */
function next_rev(alias: string): string {
	return `jsonb_build_object('rev', COALESCE((${alias}.payload ->> 'rev')::int, 0) + 1)`;
}

/** El mensaje vivo y sin lápida, bloqueado: la edición y el borrado leen su «antes» de aquí. */
function live_message_cte(messages: string): string {
	return `old AS (
			SELECT id, conversation_id, seq, kind, payload FROM ${messages}
			WHERE id = $1 AND is_active IS DISTINCT FROM false AND NOT (COALESCE(payload, '{}'::jsonb) ? 'deleted')
			FOR UPDATE
		)`;
}

/**
 * Editar en una sentencia: el texto nuevo, `editedAt`, `editCount` y `rev`; la fila de
 * `chat-audit` con el antes y el después; y la vista previa de la conversación si era su último
 * mensaje. Sin fila: el mensaje no existe, está inactivo o ya tiene lápida.
 *
 * `$1` mensaje, `$2` texto, `$3` search_field, `$4` hora, `$5` lo demás que cambia (JSON),
 * `$6` id de la auditoría, `$7` quien edita y `$8` la vista previa.
 */
export function chat_edit_message_sql(tables: { messages: string; conversations: string; audit: string }): string {
	const { messages, conversations, audit } = tables;
	return `WITH ${live_message_cte(messages)}, upd AS (
			UPDATE ${messages} m SET
				payload = COALESCE(m.payload, '{}'::jsonb) || $5::jsonb || jsonb_build_object(
					'message', $2::text,
					'editedAt', $4::text,
					'editCount', COALESCE((m.payload ->> 'editCount')::int, 0) + 1) || ${next_rev('m')},
				search_field = $3,
				updated_at = $4
			FROM old WHERE m.id = old.id
			RETURNING m.*
		), audit AS (
			INSERT INTO ${audit} (id, name, description, is_active, created_by, conversation_id, message_id, actor_id,
				action, payload, created_at, updated_at)
			SELECT $6, '', '', true, $7, old.conversation_id, old.id, $7, 'edit',
				jsonb_build_object('before', jsonb_build_object('text', COALESCE(old.payload ->> 'message', '')),
					'after', jsonb_build_object('text', $2::text)),
				$4, $4
			FROM old
		), last AS (
			UPDATE ${conversations} c SET
				payload = jsonb_set(c.payload, '{lastMessage,textPreview}', to_jsonb($8::text)),
				updated_at = $4
			FROM old WHERE c.id = old.conversation_id AND c.payload #>> '{lastMessage,messageId}' = old.id
			RETURNING c.payload -> 'lastMessage' AS last_message
		)
		SELECT upd.*, (SELECT last_message FROM last) AS conversation_last_message FROM upd`;
}

/** Lo que una lápida vacía: el contenido y lo que lo describe o lo cita. */
const TOMBSTONE_DROPS = `'{attachments,poll,voice,recordCard,mentions,mediaKinds,links,replyPreview,replyToMessageId,viewOnce,forwardedFrom,storyRef}'::text[]`;

/** El contenido de `old` que la auditoría guarda como «antes» al borrarlo o al caducar. */
const MESSAGE_CONTENT = `jsonb_strip_nulls(jsonb_build_object(
	'kind', old.kind, 'text', old.payload ->> 'message', 'attachments', old.payload -> 'attachments',
	'poll', old.payload -> 'poll', 'voice', old.payload -> 'voice', 'recordCard', old.payload -> 'recordCard',
	'mentions', old.payload -> 'mentions', 'replyToMessageId', old.payload ->> 'replyToMessageId'))`;

/**
 * Borrar para todos en una sentencia: la lápida (`message` vacío, sin contenido, `deleted` y
 * `search_field` nulo), la fila de `chat-audit` con el antes, el texto de las respuestas que lo
 * citan (con su `rev`) y la vista previa de la conversación si era su último mensaje.
 *
 * `$1` mensaje, `$2` hora, `$3` `deleted` (JSON), `$4` id de la auditoría, `$5` quien borra,
 * `$6` la acción (`delete` o `delete_moderator`) y `$7` el remitente si lo borra otro.
 */
export function chat_delete_message_sql(tables: {
	messages: string;
	conversations: string;
	audit: string;
	saved: string;
	members: string;
}): string {
	const { messages, conversations, audit, saved, members } = tables;
	return `WITH ${live_message_cte(messages)}, upd AS (
			UPDATE ${messages} m SET
				payload = (COALESCE(m.payload, '{}'::jsonb) - ${TOMBSTONE_DROPS})
					|| jsonb_build_object('message', '', 'deleted', $3::jsonb) || ${next_rev('m')},
				search_field = NULL,
				updated_at = $2
			FROM old WHERE m.id = old.id
			RETURNING m.*
		), audit AS (
			INSERT INTO ${audit} (id, name, description, is_active, created_by, conversation_id, message_id, actor_id,
				action, payload, created_at, updated_at)
			SELECT $4, '', '', true, $5, old.conversation_id, old.id, $5, $6,
				jsonb_strip_nulls(jsonb_build_object('before', ${MESSAGE_CONTENT}, 'targetUserId', $7::text)),
				$2, $2
			FROM old
		), quotes AS (
			UPDATE ${messages} q SET
				payload = q.payload || jsonb_build_object('replyPreview',
					((q.payload -> 'replyPreview') - 'attachmentKind') || '{"textPreview": null, "deleted": true}'::jsonb)
					|| ${next_rev('q')},
				updated_at = $2
			FROM old
			WHERE q.payload ->> 'replyToMessageId' = old.id AND q.conversation_id = old.conversation_id
				AND q.id <> old.id AND jsonb_typeof(q.payload -> 'replyPreview') = 'object'
			RETURNING jsonb_build_object('id', q.id, 'seq', q.seq, 'rev', q.payload -> 'rev',
				'reply_preview', q.payload -> 'replyPreview', 'updated_at', q.updated_at) AS quote
		), last AS (
			UPDATE ${conversations} c SET
				payload = c.payload || jsonb_build_object('lastMessage',
					((c.payload -> 'lastMessage') - 'attachmentKind') || '{"textPreview": "", "deleted": true}'::jsonb),
				updated_at = $2
			FROM old WHERE c.id = old.conversation_id AND c.payload #>> '{lastMessage,messageId}' = old.id
			RETURNING c.payload -> 'lastMessage' AS last_message
		), ${unsave_text_sql(saved)}, ${unmention_sql(members)}
		SELECT upd.*, (SELECT last_message FROM last) AS conversation_last_message,
			(SELECT COALESCE(jsonb_agg(quote), '[]'::jsonb) FROM quotes) AS quoting
		FROM upd`;
}

/** CTE `unmentioned`: los `seq` de `old` salen de las menciones pendientes de cada miembro. */
function unmention_sql(members: string): string {
	const gone = `(SELECT o.seq::numeric FROM old o WHERE o.conversation_id = m.conversation_id)`;
	return `unmentioned AS (
			UPDATE ${members} m SET payload = m.payload || jsonb_build_object('mentionSeqs', COALESCE(
				(SELECT jsonb_agg(s) FROM ${MENTION_SEQS} WHERE (s #>> '{}')::numeric NOT IN ${gone}), '[]'::jsonb))
			WHERE m.conversation_id IN (SELECT conversation_id FROM old)
				AND EXISTS (SELECT 1 FROM ${MENTION_SEQS} WHERE (s #>> '{}')::numeric IN ${gone})
		)`;
}

/** CTE `saved`: lo guardado de los mensajes de `old` se queda sin el texto de su vista previa. */
function unsave_text_sql(saved: string): string {
	return `saved AS (
			UPDATE ${saved} s SET payload = jsonb_set(s.payload, '{preview,textPreview}', '""'::jsonb)
			FROM old WHERE s.message_id = old.id AND jsonb_typeof(s.payload -> 'preview') = 'object'
		)`;
}

/**
 * «Borrar para mí»: solo agrega al lector a `hiddenForUserIds`. No toca `rev` ni `updated_at`:
 * para los demás el mensaje no cambió. `$1` mensaje, `$2` lector.
 */
export function chat_hide_message_sql(messages: string): string {
	return `UPDATE ${messages} SET
			payload = COALESCE(payload, '{}'::jsonb) || jsonb_build_object('hiddenForUserIds',
				COALESCE(payload -> 'hiddenForUserIds', '[]'::jsonb) || to_jsonb($2::text))
		WHERE id = $1 AND is_active IS DISTINCT FROM false AND ${not_hidden_for('$2')}
		RETURNING id`;
}

/**
 * Abrir un mensaje de ver una vez: agrega al lector y, si comparte acuses, su hora (quien lo envió
 * la ve), y sube `rev`, una sola vez por persona. Sin fila: ya lo abrió o el mensaje ya no está
 * vivo. `$1` mensaje, `$2` lector, `$3` hora, `$4` si se guarda la hora.
 */
export function chat_open_view_once_sql(messages: string): string {
	const opened = `COALESCE(payload #> '{viewOnce,openedByUserIds}', '[]'::jsonb)`;
	const opened_at = `COALESCE(payload #> '{viewOnce,openedAt}', '{}'::jsonb)`;
	return `UPDATE ${messages} m SET
			payload = jsonb_set(
				jsonb_set(m.payload, '{viewOnce,openedByUserIds}', ${opened} || to_jsonb($2::text)),
				'{viewOnce,openedAt}', CASE WHEN $4::boolean THEN ${opened_at} || jsonb_build_object($2::text, $3::text) ELSE ${opened_at} END
			) || ${next_rev('m')},
			updated_at = $3
		WHERE id = $1 AND is_active IS DISTINCT FROM false AND NOT (COALESCE(payload, '{}'::jsonb) ? 'deleted')
			AND jsonb_typeof(payload -> 'viewOnce') = 'object' AND NOT (${opened} ? $2)
		RETURNING *`;
}

const NEW_ROW_ID = `left(replace(gen_random_uuid()::text, '-', ''), 24)`;

/** El mensaje sigue vivo, sin lápida; `FOR UPDATE` ordena las reacciones y los votos sobre él. */
function lock_live_message_sql(messages: string, extra = ''): string {
	return `SELECT id, conversation_id, COALESCE((payload ->> 'rev')::int, 0) AS rev, updated_at FROM ${messages}
		WHERE id = $1 AND is_active IS DISTINCT FROM false AND NOT (COALESCE(payload, '{}'::jsonb) ? 'deleted')${extra}
		FOR UPDATE`;
}

/** `rev` + 1 y `updated_at`, para que el delta y el sync vean el cambio. `$1` mensaje, `$2` hora. */
function bump_message_sql(messages: string): string {
	return `UPDATE ${messages} m SET payload = COALESCE(m.payload, '{}'::jsonb) || ${next_rev('m')}, updated_at = $2
		WHERE id = $1
		RETURNING (m.payload ->> 'rev')::int AS rev, m.updated_at`;
}

/**
 * Reacciones de un mensaje (`chat_toggle_reaction`), dentro de una transacción que primero bloquea
 * el mensaje: así el tope por persona no se pasa con dos pedidos a la vez.
 */
export function chat_reaction_sqls(tables: { messages: string; reactions: string }) {
	const { messages, reactions } = tables;
	return {
		lock: lock_live_message_sql(messages),
		/** `$1` mensaje, `$2` persona. */
		mine: `SELECT value FROM ${reactions} WHERE message_id = $1 AND user_id = $2 AND kind = 'emoji'`,
		/** `$1` mensaje, `$2` conversación, `$3` persona, `$4` emoji, `$5` hora. */
		add: `INSERT INTO ${reactions} (id, name, description, is_active, created_by, message_id, conversation_id, user_id,
				kind, value, payload, created_at, updated_at)
			VALUES (${NEW_ROW_ID}, '', '', true, $3, $1, $2, $3, 'emoji', $4, '{}'::jsonb, $5, $5)
			ON CONFLICT DO NOTHING
			RETURNING id`,
		/** `$1` mensaje, `$2` persona, `$3` emoji. */
		remove: `DELETE FROM ${reactions} WHERE message_id = $1 AND user_id = $2 AND kind = 'emoji' AND value = $3 RETURNING id`,
		bump: bump_message_sql(messages),
		/** `$1` mensaje, `$2` emoji. */
		count: `SELECT count(*)::int AS count FROM ${reactions} WHERE message_id = $1 AND kind = 'emoji' AND value = $2`,
	};
}

/**
 * Votos de una encuesta (`chat_replace_votes`) en una transacción: bloquear el mensaje abierto,
 * quitar lo que ya no se elige y agregar lo nuevo. Con el bloqueo primero, dos votos seguidos de
 * la misma persona no se suman: el segundo ve lo que dejó el primero.
 */
export function chat_vote_sqls(tables: { messages: string; reactions: string }) {
	const { messages, reactions } = tables;
	return {
		lock: lock_live_message_sql(
			messages,
			` AND jsonb_typeof(payload -> 'poll') = 'object' AND (payload #>> '{poll,closedAt}') IS NULL`,
		),
		/** `$1` mensaje, `$2` persona. */
		mine: `SELECT value FROM ${reactions} WHERE message_id = $1 AND user_id = $2 AND kind = 'vote'`,
		/** `$1` mensaje, `$2` persona, `$3` opciones elegidas (JSON). */
		drop: `DELETE FROM ${reactions}
			WHERE message_id = $1 AND user_id = $2 AND kind = 'vote'
				AND value NOT IN (SELECT jsonb_array_elements_text($3::jsonb))
			RETURNING id`,
		/** `$1` mensaje, `$2` conversación, `$3` persona, `$4` opciones elegidas (JSON), `$5` hora. */
		add: `INSERT INTO ${reactions} (id, name, description, is_active, created_by, message_id, conversation_id, user_id,
				kind, value, payload, created_at, updated_at)
			SELECT ${NEW_ROW_ID}, '', '', true, $3, $1, $2, $3, 'vote', v.value, '{}'::jsonb, $5, $5
			FROM jsonb_array_elements_text($4::jsonb) AS v(value)
			ON CONFLICT DO NOTHING
			RETURNING id`,
		bump: bump_message_sql(messages),
	};
}

/** Cerrar una encuesta abierta: `closedAt` y `rev`. `$1` mensaje, `$2` hora. */
export function chat_close_poll_sql(messages: string): string {
	return `UPDATE ${messages} m SET
			payload = jsonb_set(m.payload, '{poll,closedAt}', to_jsonb($2::text)) || ${next_rev('m')},
			updated_at = $2
		WHERE id = $1 AND is_active IS DISTINCT FROM false AND NOT (COALESCE(payload, '{}'::jsonb) ? 'deleted')
			AND jsonb_typeof(payload -> 'poll') = 'object' AND (payload #>> '{poll,closedAt}') IS NULL
		RETURNING *`;
}

/**
 * Votos de las encuestas de una página en una consulta: un renglón por opción y uno por mensaje
 * (`total`) con las personas distintas que votaron. `$1` mensajes (JSON), `$2` lector.
 */
export function chat_poll_tally_sql(reactions: string): string {
	return `SELECT message_id, value AS option_id, grouping(value) = 1 AS total,
			count(DISTINCT user_id)::int AS votes, bool_or(user_id = $2) AS mine,
			jsonb_agg(user_id ORDER BY created_at, id) AS voter_ids
		FROM ${reactions}
		WHERE message_id IN (SELECT jsonb_array_elements_text($1::jsonb)) AND kind = 'vote'
		GROUP BY GROUPING SETS ((message_id, value), (message_id))`;
}

/**
 * Leído y entregado de un mensaje por las marcas de agua de los demás miembros activos.
 * `$1` conversación, `$2` seq del mensaje y `$3` el remitente, que no cuenta.
 */
export function chat_message_receipts_sql(members: string): string {
	const read = 'COALESCE(public_read_seq, 0) >= $2';
	const delivered = 'COALESCE(delivered_seq, 0) >= $2';
	return `SELECT count(*)::int AS member_count,
			count(*) FILTER (WHERE ${read})::int AS read_count,
			count(*) FILTER (WHERE ${delivered})::int AS delivered_count,
			COALESCE(jsonb_agg(user_id ORDER BY user_id) FILTER (WHERE ${read}), '[]'::jsonb) AS read_ids,
			COALESCE(jsonb_agg(user_id ORDER BY user_id) FILTER (WHERE ${delivered}), '[]'::jsonb) AS delivered_ids
		FROM ${members}
		WHERE conversation_id = $1 AND state = 'active' AND is_active IS DISTINCT FROM false
			AND user_id IS DISTINCT FROM $3`;
}

/**
 * Una mención pendiente más para cada miembro activo que aún no leyó ese `seq`; se guardan las
 * 20 más nuevas. `$1` conversación, `$2` personas (JSON), `$3` seq y `$4` hora.
 */
export function chat_add_mention_seqs_sql(members: string): string {
	return `UPDATE ${members} m SET
			payload = COALESCE(m.payload, '{}'::jsonb) || jsonb_build_object('mentionSeqs', (
				SELECT COALESCE(jsonb_agg(s ORDER BY s), '[]'::jsonb) FROM (
					SELECT s FROM (
						SELECT (s #>> '{}')::numeric AS s FROM ${MENTION_SEQS}
						UNION SELECT $3::numeric
					) seqs ORDER BY s DESC LIMIT 20
				) newest)),
			updated_at = $4
		WHERE m.conversation_id = $1 AND m.user_id IN (SELECT jsonb_array_elements_text($2::jsonb))
			AND m.state = 'active' AND COALESCE(m.last_read_seq, 0) < $3
		RETURNING m.user_id`;
}

const ACTIVITY_UNREAD = `COALESCE(payload ->> 'isRead', '') <> 'true'`;

export type ChatActivityQuery = {
	user_id: string;
	context_types?: string[];
	unread?: boolean;
	before?: { at: string; id: string };
	limit: number;
};

/** La bandeja de Actividad de una persona por keyset `(created_at, id)`, del más nuevo al más viejo. */
export function chat_activity_page_sql(mentions: string, query: ChatActivityQuery): { sql: string; params: unknown[] } {
	const params: unknown[] = [query.user_id];
	const param = (value: unknown) => {
		params.push(value);
		return `$${params.length}`;
	};
	const where = [`payload ->> 'mentionedUserId' = $1`, 'is_active IS DISTINCT FROM false'];
	if (query.context_types) {
		where.push(`payload ->> 'contextType' IN (SELECT jsonb_array_elements_text(${param(query.context_types)}::jsonb))`);
	}
	if (query.unread) where.push(ACTIVITY_UNREAD);
	if (query.before) where.push(created_at_keyset_sql(param(query.before.at), param(query.before.id), '<'));
	return {
		sql: `SELECT * FROM ${mentions} WHERE ${where.join(' AND ')}
			ORDER BY created_at DESC, id DESC LIMIT ${param(query.limit)}`,
		params,
	};
}

/** Las no leídas de cada filtro de la bandeja de Actividad en una agregación. `$1` persona. */
export function chat_activity_counts_sql(mentions: string): string {
	const of = (types: string[]) => `payload ->> 'contextType' IN (${types.map((type) => `'${type}'`).join(', ')})`;
	return `SELECT count(*)::int AS "all",
			count(*) FILTER (WHERE ${of(ACTIVITY_CONTEXTS.chat)})::int AS chat,
			count(*) FILTER (WHERE ${of(ACTIVITY_CONTEXTS.history)})::int AS history,
			count(*) FILTER (WHERE ${of(ACTIVITY_CONTEXTS.reactions)})::int AS reactions
		FROM ${mentions}
		WHERE payload ->> 'mentionedUserId' = $1 AND is_active IS DISTINCT FROM false AND ${ACTIVITY_UNREAD}`;
}

/**
 * Marcar leída la actividad de una persona (todas, unas o las de un filtro) y la notificación que
 * cada una tenga ligada. `$1` persona, `$2` ids (JSON o nulo), `$3` contextos (JSON o nulo), `$4` hora.
 */
export function chat_mark_activity_read_sql(tables: { mentions: string; notifications: string }): string {
	return `WITH read AS (
			UPDATE ${tables.mentions} SET payload = COALESCE(payload, '{}'::jsonb) || '{"isRead": true}'::jsonb, updated_at = $4
			WHERE payload ->> 'mentionedUserId' = $1 AND is_active IS DISTINCT FROM false AND ${ACTIVITY_UNREAD}
				AND ($2::jsonb IS NULL OR id IN (SELECT jsonb_array_elements_text($2::jsonb)))
				AND ($3::jsonb IS NULL OR payload ->> 'contextType' IN (SELECT jsonb_array_elements_text($3::jsonb)))
			RETURNING id, payload ->> 'notificationId' AS notification_id
		), linked AS (
			UPDATE ${tables.notifications} n SET payload = COALESCE(n.payload, '{}'::jsonb) || '{"isRead": true}'::jsonb, updated_at = $4
			FROM read WHERE n.id = read.notification_id AND n.payload ->> 'recipientId' = $1
			RETURNING n.id
		)
		SELECT read.id, (SELECT COALESCE(jsonb_agg(id), '[]'::jsonb) FROM linked) AS notification_ids FROM read`;
}

/**
 * Retirar la actividad que apunta a un mensaje (borrado, o una reacción que se quitó). `$1`
 * mensaje, `$2` contexto, `$3` quien la causó y `$4` la reacción (cada filtro nulo no aplica),
 * `$5` hora.
 */
export function chat_retire_activity_sql(mentions: string): string {
	return `UPDATE ${mentions} SET is_active = false, updated_at = $5
		WHERE payload ->> 'messageId' = $1 AND is_active IS DISTINCT FROM false
			AND ($2::text IS NULL OR payload ->> 'contextType' = $2)
			AND ($3::text IS NULL OR payload ->> 'actorId' = $3)
			AND ($4::text IS NULL OR payload ->> 'reaction' = $4)
		RETURNING id, payload ->> 'mentionedUserId' AS user_id`;
}

/** Las reacciones de una página: un renglón por mensaje y emoji. `$1` mensajes (JSON), `$2` lector. */
export function chat_reaction_summary_sql(reactions: string): string {
	return `SELECT message_id, value AS emoji, count(*)::int AS count, bool_or(user_id = $2) AS mine,
			(array_agg(user_id ORDER BY created_at, id))[1:3] AS sample_user_ids
		FROM ${reactions}
		WHERE message_id IN (SELECT jsonb_array_elements_text($1::jsonb)) AND kind = 'emoji'
		GROUP BY message_id, value
		ORDER BY message_id, min(created_at), value`;
}

const MENTION_SEQS = `jsonb_array_elements(CASE WHEN jsonb_typeof(m.payload -> 'mentionSeqs') = 'array'
	THEN m.payload -> 'mentionSeqs' ELSE '[]'::jsonb END) s`;
const UNREAD = 'GREATEST(COALESCE(c.last_seq, 0) - COALESCE(m.last_read_seq, 0), 0)';
const ARCHIVED = `COALESCE(m.payload ->> 'archived', '') = 'true'`;
const MARKED_UNREAD = `COALESCE(m.payload ->> 'markedUnread', '') = 'true'`;
const ACTIVITY = 'COALESCE(c.last_message_at, c.created_at)';
/** Un directo sin mensajes no sale en la bandeja: abrirlo no lo pone en la de la otra persona. */
const NOT_EMPTY_DIRECT = `NOT (c.kind = 'direct' AND COALESCE(c.last_seq, 0) = 0)`;

export type ChatInboxFilter = 'all' | 'unread' | 'mentions' | 'direct' | 'groups' | 'archived';

export type ChatInboxQuery = {
	user_id: string;
	/** Sin filtro también salen las archivadas (resumen y rutas heredadas). */
	filter?: ChatInboxFilter;
	kinds?: string[];
	folder?: string;
	/** Resincronización: sin filtros y con las bajas. */
	changed_since?: string;
	conversation_ids?: string[];
	/** `true`: solo las fijadas, en su orden; `false`: sin ellas. */
	pinned?: boolean;
	cursor?: { at: string; id: string };
	limit: number;
};

/**
 * Bandeja por actividad, en keyset `(última actividad, id)`. Los no leídos salen de las marcas
 * de agua (`last_seq − last_read_seq`): enviar es leer, así que lo propio nunca cuenta.
 */
export function chat_inbox_sql(
	tables: { conversations: string; members: string },
	query: ChatInboxQuery,
): { sql: string; params: unknown[] } {
	const params: unknown[] = [query.user_id];
	const param = (value: unknown) => {
		params.push(value);
		return `$${params.length}`;
	};
	const where = ['m.user_id = $1', 'm.is_active IS DISTINCT FROM false'];
	if (query.changed_since) {
		where.push(
			`m.state IN ('active', 'left', 'removed', 'banned')`,
			`GREATEST(c.updated_at, m.updated_at) > ${param(query.changed_since)}`,
		);
	} else {
		where.push(`m.state = 'active'`, 'c.is_active IS DISTINCT FROM false');
		if (query.filter === 'archived') where.push(ARCHIVED);
		else if (query.filter) where.push(`NOT (${ARCHIVED})`);
		if (query.filter === 'unread') where.push(`(${UNREAD} > 0 OR ${MARKED_UNREAD})`);
		if (query.filter === 'mentions') {
			where.push(`EXISTS (SELECT 1 FROM ${MENTION_SEQS} WHERE (s #>> '{}')::numeric > COALESCE(m.last_read_seq, 0))`);
		}
		if (query.filter === 'direct') where.push(`c.kind IN ('direct', 'self')`);
		if (query.filter === 'groups') where.push(`c.kind IN ('group', 'channel', 'meeting')`);
		if (query.kinds) where.push(`c.kind IN (SELECT jsonb_array_elements_text(${param(query.kinds)}::jsonb))`);
		if (query.folder) where.push(`m.payload ->> 'folder' = ${param(query.folder)}`);
		if (query.pinned !== undefined) {
			where.push(`jsonb_typeof(m.payload -> 'pinnedOrder') ${query.pinned ? '=' : 'IS DISTINCT FROM'} 'number'`);
		}
	}
	if (query.conversation_ids) {
		where.push(`m.conversation_id IN (SELECT jsonb_array_elements_text(${param(query.conversation_ids)}::jsonb))`);
	} else {
		where.push(NOT_EMPTY_DIRECT);
	}
	if (query.cursor) where.push(`(${ACTIVITY}, c.id) < (${param(query.cursor.at)}, ${param(query.cursor.id)})`);
	const order = query.pinned
		? `(m.payload ->> 'pinnedOrder')::numeric, ${ACTIVITY} DESC, c.id DESC`
		: `${ACTIVITY} DESC, c.id DESC`;
	return {
		sql: `SELECT c.*, m.id AS member_id, m.role AS member_role, m.state AS member_state,
				m.last_read_seq, m.public_read_seq, m.delivered_seq, m.payload AS member_payload,
				m.updated_at AS member_updated_at, ${ACTIVITY} AS activity_at, ${UNREAD} AS unread_count,
				COALESCE((SELECT jsonb_agg(s ORDER BY (s #>> '{}')::numeric) FROM ${MENTION_SEQS}
					WHERE (s #>> '{}')::numeric > COALESCE(m.last_read_seq, 0)), '[]'::jsonb) AS unread_mention_seqs
			FROM ${tables.members} m JOIN ${tables.conversations} c ON c.id = m.conversation_id
			WHERE ${where.join(' AND ')}
			ORDER BY ${order}
			LIMIT ${param(query.limit)}`,
		params,
	};
}

/** Los conteos de la bandeja (`ChatInboxCounts`) en una sola agregación. `$1` usuario, `$2` hora. */
export function chat_inbox_counts_sql(tables: { conversations: string; members: string; mentions: string }): string {
	return `SELECT
			count(*) FILTER (WHERE NOT archived)::int AS "all",
			count(*) FILTER (WHERE NOT archived AND (unread > 0 OR marked))::int AS unread,
			count(*) FILTER (WHERE NOT archived AND mentions > 0)::int AS mentions,
			count(*) FILTER (WHERE NOT archived AND kind IN ('direct', 'self'))::int AS direct,
			count(*) FILTER (WHERE NOT archived AND kind IN ('group', 'channel', 'meeting'))::int AS groups,
			count(*) FILTER (WHERE archived)::int AS archived,
			COALESCE(sum(unread) FILTER (WHERE NOT archived AND NOT muted), 0)::int AS unread_messages_total,
			(SELECT count(*) FROM ${tables.mentions}
				WHERE payload ->> 'mentionedUserId' = $1 AND is_active IS DISTINCT FROM false
					AND COALESCE(payload ->> 'isRead', '') <> 'true')::int AS activity_unread
		FROM (
			SELECT c.kind, ${ARCHIVED} AS archived, ${MARKED_UNREAD} AS marked,
				COALESCE(m.payload ->> 'mutedUntil', '') > $2 AS muted, ${UNREAD} AS unread,
				(SELECT count(*) FROM ${MENTION_SEQS} WHERE (s #>> '{}')::numeric > COALESCE(m.last_read_seq, 0)) AS mentions
			FROM ${tables.members} m JOIN ${tables.conversations} c ON c.id = m.conversation_id
			WHERE m.user_id = $1 AND m.state = 'active' AND m.is_active IS DISTINCT FROM false
				AND c.is_active IS DISTINCT FROM false AND ${NOT_EMPTY_DIRECT}
		) t`;
}

/**
 * Marca de leído monótona y acotada a `last_seq`; poda las menciones ya leídas, quita
 * «no leído» y mueve la marca pública solo si el usuario comparte acuses (`$4`). `$1`
 * conversación, `$2` usuario, `$3` seq leído, `$5` hora.
 */
export function chat_mark_read_sql(tables: { conversations: string; members: string }): string {
	const read = 'LEAST(GREATEST(COALESCE(m.last_read_seq, 0), $3), COALESCE(c.last_seq, 0))';
	return `UPDATE ${tables.members} m SET
			last_read_seq = ${read},
			public_read_seq = CASE WHEN $4::boolean
				THEN GREATEST(COALESCE(m.public_read_seq, 0), ${read}) ELSE m.public_read_seq END,
			delivered_seq = GREATEST(COALESCE(m.delivered_seq, 0), ${read}),
			payload = COALESCE(m.payload, '{}'::jsonb) || jsonb_build_object(
				'markedUnread', false,
				'mentionSeqs', COALESCE((SELECT jsonb_agg(s) FROM ${MENTION_SEQS}
					WHERE (s #>> '{}')::numeric > ${read}), '[]'::jsonb)),
			updated_at = $5
		FROM ${tables.conversations} c
		WHERE m.conversation_id = $1 AND m.user_id = $2 AND m.state = 'active' AND c.id = m.conversation_id
		RETURNING m.last_read_seq, m.public_read_seq, m.delivered_seq, c.last_seq, m.payload -> 'mentionSeqs' AS mention_seqs`;
}

/**
 * Entregado en lote al listar la bandeja: lo listado ya llegó. Devuelve, por conversación que
 * avanzó, su nueva marca y a quiénes avisar. `$1` usuario, `$2` conversaciones (JSON).
 */
export function chat_inbox_delivered_sql(tables: { conversations: string; members: string }): string {
	return `WITH moved AS (
			UPDATE ${tables.members} m SET delivered_seq = c.last_seq
			FROM ${tables.conversations} c
			WHERE c.id = m.conversation_id AND m.user_id = $1
				AND m.conversation_id IN (SELECT jsonb_array_elements_text($2::jsonb))
				AND m.state = 'active' AND COALESCE(m.delivered_seq, 0) < COALESCE(c.last_seq, 0)
			RETURNING m.conversation_id, m.delivered_seq
		)
		SELECT moved.conversation_id, moved.delivered_seq AS seq, array_agg(o.user_id) AS member_ids
		FROM moved
		JOIN ${tables.members} o ON o.conversation_id = moved.conversation_id
			AND o.state = 'active' AND o.is_active IS DISTINCT FROM false
		GROUP BY moved.conversation_id, moved.delivered_seq`;
}

/**
 * Entregado hasta donde dice el cliente, nunca más allá de `last_seq`: un `seq` inventado no
 * marca lo que aún no existe. `$1` conversación, `$2` usuario, `$3` seq recibido.
 */
export function chat_delivered_up_to_sql(tables: { conversations: string; members: string }): string {
	const upto = 'LEAST($3::numeric, COALESCE(c.last_seq, 0))';
	return `UPDATE ${tables.members} m SET delivered_seq = ${upto}
		FROM ${tables.conversations} c
		WHERE c.id = m.conversation_id AND m.conversation_id = $1 AND m.user_id = $2 AND m.state = 'active'
			AND COALESCE(m.delivered_seq, 0) < ${upto}
		RETURNING m.delivered_seq`;
}

export type ChatInboxRow = {
	conversation: ImperiumDoc;
	member: ImperiumDoc;
	activity_at: string;
	unread_count: number;
	unread_mention_seqs: number[];
};

export type ChatReadMarks = { user_id: string; last_read_seq: number; public_read_seq: number; delivered_seq: number };

export type ChatReadResult = {
	last_read_seq: number;
	public_read_seq: number;
	delivered_seq: number;
	last_seq: number;
	mention_seqs: number[];
};

export type ChatEditInput = {
	id: string;
	text: string;
	search_field: string | null;
	/** Lo demás del payload que cambia con el texto. */
	merge: ImperiumDoc;
	audit_id: string;
	actor_id: string;
	/** El `textPreview` de la conversación si era su último mensaje. */
	preview: string;
	now: string;
};

export type ChatDeleteInput = {
	id: string;
	deleted: { at: string; byUserId: string; byRole: 'sender' | 'moderator' };
	audit_id: string;
	actor_id: string;
	action: 'delete' | 'delete_moderator';
	target_user_id: string | null;
	now: string;
};

/** Una respuesta cuya cita quedó sin texto porque su original se borró. */
export type ChatQuote = { id: string; seq: number; rev: number; reply_preview: ImperiumDoc; updated_at: string };

export type ChatMessageChange = {
	message: ImperiumDoc;
	/** `lastMessage` de la conversación, si este era su último mensaje. */
	last_message: ImperiumDoc | null;
	quoting: ChatQuote[];
};

export type ChatPurge = {
	purged: Array<{ id: string; conversation_id: string; seq: number }>;
	quoting: Array<ChatQuote & { conversation_id: string }>;
	last_messages: Array<{ conversation_id: string; last_message: ImperiumDoc }>;
	/** `name_stored` de los adjuntos que se dieron de baja; el archivo puede seguir en uso por un reenvío. */
	files: string[];
};

export type ChatReactionToggle =
	| { limited: true }
	| { limited: false; changed: boolean; mine: boolean; count: number; rev: number; updated_at: string };

export type ChatVoteResult =
	| { already_voted: true }
	| { already_voted: false; changed: boolean; rev: number; updated_at: string };

export type ChatPollTally = {
	total_voters: number;
	options: Map<string, { votes: number; mine: boolean; voter_ids: string[] }>;
};

export type ChatReceipts = {
	member_count: number;
	read_count: number;
	delivered_count: number;
	read_ids: string[];
	delivered_ids: string[];
};

/**
 * Si un mensaje tiene medios del tipo `type_param` (`image`, `video`, `audio`, `voice` o `file`,
 * con el tipo que deduce la vista también para los adjuntos legados) o, con `link`, enlaces.
 */
export function chat_media_kind_sql(type_param: string, payload = 'payload'): string {
	const kind = `COALESCE(NULLIF(a ->> 'kind', ''), CASE
		WHEN a ->> 'isImage' = 'true' OR a ->> 'mimetype' LIKE 'image/%' THEN 'image'
		WHEN a ->> 'mimetype' LIKE 'video/%' THEN 'video'
		WHEN a ->> 'mimetype' LIKE 'audio/%' THEN 'audio'
		ELSE 'file' END)`;
	return `CASE WHEN ${type_param} = 'link'
		THEN jsonb_typeof(${payload} -> 'links') = 'array' AND jsonb_array_length(${payload} -> 'links') > 0
		ELSE EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${payload} -> 'attachments') = 'array'
			THEN ${payload} -> 'attachments' ELSE '[]'::jsonb END) a WHERE ${kind} = ${type_param}) END`;
}

export type ChatSearchQuery = {
	user_id: string;
	/** El texto normalizado como `search_field`: minúsculas y sin diacríticos. */
	needle: string;
	conversation_id?: string;
	from?: string;
	/** `file`, `image`, `link` o `voice`. */
	has?: string;
	before?: string;
	after?: string;
	kinds?: string[];
	cursor?: { at: string; id: string };
	limit: number;
};

/**
 * Búsqueda del chat sobre `search_field` (GIN de trigramas) y solo en lo que quien busca ve:
 * miembro activo, desde su `visibleFromSeq` y sin lo que ocultó. Del más nuevo al más viejo por
 * keyset `(created_at, id)`.
 */
export function chat_search_sql(
	tables: { messages: string; members: string; conversations: string },
	query: ChatSearchQuery,
): { sql: string; params: unknown[] } {
	const params: unknown[] = [query.user_id, `%${query.needle.replace(/[\\%_]/g, '\\$&')}%`];
	const param = (value: unknown) => {
		params.push(value);
		return `$${params.length}`;
	};
	const where = [
		'm.search_field ILIKE $2',
		'm.is_active IS DISTINCT FROM false',
		`m.seq > COALESCE((cm.payload ->> 'visibleFromSeq')::numeric, 0)`,
		`NOT (COALESCE(m.payload -> 'hiddenForUserIds', '[]'::jsonb) ? $1)`,
	];
	if (query.conversation_id) where.push(`m.conversation_id = ${param(query.conversation_id)}`);
	if (query.from) where.push(`m.sender_user_id = ${param(query.from)}`);
	if (query.has) where.push(chat_media_kind_sql(`${param(query.has)}::text`, 'm.payload'));
	if (query.before) where.push(`m.created_at < ${param(query.before)}`);
	if (query.after) where.push(`m.created_at > ${param(query.after)}`);
	if (query.kinds) where.push(`c.kind IN (SELECT jsonb_array_elements_text(${param(query.kinds)}::jsonb))`);
	if (query.cursor) where.push(`(m.created_at, m.id) < (${param(query.cursor.at)}, ${param(query.cursor.id)})`);
	return {
		sql: `SELECT m.*, c.conversation_key AS conversation_key_of
			FROM ${tables.messages} m
			JOIN ${tables.members} cm ON cm.conversation_id = m.conversation_id AND cm.user_id = $1
				AND cm.state = 'active' AND cm.is_active IS DISTINCT FROM false
			JOIN ${tables.conversations} c ON c.id = m.conversation_id AND c.is_active IS DISTINCT FROM false
			WHERE ${where.join(' AND ')}
			ORDER BY m.created_at DESC, m.id DESC
			LIMIT ${param(query.limit)}`,
		params,
	};
}

/**
 * Galería de una conversación, del más nuevo al más viejo, por `seq`: la sirve el único
 * `(conversation_id, seq)`. `$1` conversación, `$2` el `seq` desde el que el lector ve
 * (exclusivo), `$3` el lector, `$4` el tipo, `$5` límite y, con `before`, `$6` el ancla.
 */
export function chat_media_page_sql(messages: string, before: boolean): string {
	return `SELECT * FROM ${messages}
		WHERE conversation_id = $1 AND seq > $2 AND is_active IS DISTINCT FROM false
			AND NOT (COALESCE(payload, '{}'::jsonb) ? 'deleted') AND ${not_hidden_for('$3')}
			AND ${chat_media_kind_sql('$4::text')}${before ? ' AND seq < $6' : ''}
		ORDER BY seq DESC LIMIT $5`;
}

/** Lo que vence: dónde vive, qué columna lo dice, el estado de lo pendiente y el de lo reclamado. */
const CHAT_DUE_JOBS = {
	expire: { resource: 'messages', column: 'expires_at', pending: null, claimed: 'expiring' },
	send: { resource: 'chat-scheduled', column: 'send_at', pending: 'pending', claimed: 'sending' },
	remind: { resource: 'chat-saved', column: 'remind_at', pending: 'pending', claimed: 'notified' },
	story: { resource: 'chat-stories', column: 'expires_at', pending: null, claimed: 'expired' },
} as const satisfies Record<string, { resource: string; column: string; pending: string | null; claimed: string }>;

export type ChatDueJob = keyof typeof CHAT_DUE_JOBS;

function due_state(state: string | null): string {
	return state === null ? 'state IS NULL' : `state = '${state}'`;
}

/**
 * Reclamar lo vencido: pasa al estado reclamado con `FOR UPDATE SKIP LOCKED`, así dos pasadas nunca
 * toman lo mismo. `$1` hora, `$2` límite.
 */
export function chat_claim_due_sql(table: string, job: ChatDueJob): string {
	const { column, pending, claimed } = CHAT_DUE_JOBS[job];
	return `UPDATE ${table} SET state = '${claimed}', updated_at = $1
		WHERE id IN (
			SELECT id FROM ${table}
			WHERE ${column} IS NOT NULL AND ${column} <= $1 AND ${due_state(pending)} AND is_active IS DISTINCT FROM false
			ORDER BY ${column}, id
			LIMIT $2
			FOR UPDATE SKIP LOCKED
		)
		RETURNING *`;
}

/**
 * Devolver a pendiente lo reclamado que no terminó: al arrancar, cuando nada está en curso, o lo
 * de una pasada que falló. `$1` ids (JSON), o nulo para todo.
 */
export function chat_release_claims_sql(table: string, job: ChatDueJob): string {
	const { column, pending, claimed } = CHAT_DUE_JOBS[job];
	return `UPDATE ${table} SET state = ${pending === null ? 'NULL' : `'${pending}'`}
		WHERE ${column} IS NOT NULL AND ${due_state(claimed)} AND is_active IS DISTINCT FROM false
			AND ($1::jsonb IS NULL OR id IN (SELECT jsonb_array_elements_text($1::jsonb)))
		RETURNING id`;
}

/**
 * Caducar los mensajes reclamados en una sentencia: sin contenido ni `search_field` y fuera de las
 * páginas; las citas y la vista previa de la conversación pierden su texto, como al borrar. Con
 * retención legal (`$3`) el contenido se copia antes a `chat-audit` y los archivos se quedan; sin
 * ella se dan de baja sus filas de adjunto. `$1` ids (JSON), `$2` hora.
 */
export function chat_purge_messages_sql(tables: {
	messages: string;
	conversations: string;
	audit: string;
	reactions: string;
	attachments: string;
	saved: string;
	members: string;
}): string {
	const { messages, conversations, audit, reactions, attachments, saved, members } = tables;
	return `WITH old AS (
			SELECT id, conversation_id, seq, kind, sender_user_id, payload FROM ${messages}
			WHERE id IN (SELECT jsonb_array_elements_text($1::jsonb)) AND state = 'expiring'
				AND is_active IS DISTINCT FROM false
			FOR UPDATE
		), audit AS (
			INSERT INTO ${audit} (id, name, description, is_active, conversation_id, message_id, action, payload,
				created_at, updated_at)
			SELECT ${NEW_ROW_ID}, '', '', true, old.conversation_id, old.id, 'expired',
				jsonb_strip_nulls(jsonb_build_object('before', ${MESSAGE_CONTENT}, 'targetUserId', old.sender_user_id)),
				$2, $2
			FROM old WHERE $3::boolean
		), upd AS (
			UPDATE ${messages} m SET
				payload = (COALESCE(m.payload, '{}'::jsonb) - ${TOMBSTONE_DROPS}) || '{"message": ""}'::jsonb || ${next_rev('m')},
				search_field = NULL,
				is_active = false,
				state = 'expired',
				updated_at = $2
			FROM old WHERE m.id = old.id
			RETURNING m.id, m.conversation_id, m.seq
		), quotes AS (
			UPDATE ${messages} q SET
				payload = q.payload || jsonb_build_object('replyPreview',
					((q.payload -> 'replyPreview') - 'attachmentKind') || '{"textPreview": null, "deleted": true}'::jsonb)
					|| ${next_rev('q')},
				updated_at = $2
			FROM old
			WHERE q.payload ->> 'replyToMessageId' = old.id AND q.conversation_id = old.conversation_id
				AND q.id NOT IN (SELECT id FROM old) AND jsonb_typeof(q.payload -> 'replyPreview') = 'object'
			RETURNING jsonb_build_object('conversation_id', q.conversation_id, 'id', q.id, 'seq', q.seq,
				'rev', q.payload -> 'rev', 'reply_preview', q.payload -> 'replyPreview', 'updated_at', q.updated_at) AS quote
		), last AS (
			UPDATE ${conversations} c SET
				payload = c.payload || jsonb_build_object('lastMessage',
					((c.payload -> 'lastMessage') - 'attachmentKind') || '{"textPreview": "", "deleted": true}'::jsonb),
				updated_at = $2
			FROM old WHERE c.id = old.conversation_id AND c.payload #>> '{lastMessage,messageId}' = old.id
			RETURNING jsonb_build_object('conversation_id', c.id, 'last_message', c.payload -> 'lastMessage') AS last
		), files AS (
			UPDATE ${attachments} a SET is_active = false, updated_at = $2
			FROM old
			WHERE NOT $3::boolean AND a.is_active IS DISTINCT FROM false
				AND a.id IN (SELECT jsonb_array_elements(CASE WHEN jsonb_typeof(old.payload -> 'attachments') = 'array'
					THEN old.payload -> 'attachments' ELSE '[]'::jsonb END) ->> 'attachmentId')
			RETURNING a.name_stored
		), unreacted AS (
			DELETE FROM ${reactions} r USING old WHERE r.message_id = old.id
		), ${unsave_text_sql(saved)}, ${unmention_sql(members)}
		SELECT
			(SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id, 'conversation_id', conversation_id, 'seq', seq)), '[]'::jsonb)
				FROM upd) AS purged,
			(SELECT COALESCE(jsonb_agg(quote), '[]'::jsonb) FROM quotes) AS quoting,
			(SELECT COALESCE(jsonb_agg(last), '[]'::jsonb) FROM last) AS last_messages,
			(SELECT COALESCE(jsonb_agg(name_stored), '[]'::jsonb) FROM files WHERE name_stored IS NOT NULL) AS files`;
}

/**
 * Dar de baja las subidas del chat que nadie ligó antes de `$1`, con `FOR UPDATE SKIP LOCKED`.
 * `$2` hora, `$3` límite.
 */
export function chat_discard_orphan_uploads_sql(attachments: string): string {
	return `UPDATE ${attachments} SET is_active = false, updated_at = $2
		WHERE id IN (
			SELECT id FROM ${attachments}
			WHERE ${CHAT_PENDING_UPLOAD} AND created_at < $1
			ORDER BY created_at
			LIMIT $3
			FOR UPDATE SKIP LOCKED
		)
		RETURNING id, name_stored`;
}

/**
 * Ligar subidas propias aún sin ligar a otro registro del chat, todas o ninguna. `$1` ids (JSON),
 * `$2` dueño, `$3` modelo, `$4` registro, `$5` hora.
 */
export function chat_bind_uploads_sql(attachments: string): string {
	return `WITH free AS (
			SELECT id FROM ${attachments}
			WHERE id IN (SELECT jsonb_array_elements_text($1::jsonb)) AND created_by_id = $2
				AND COALESCE(related_record_id, '') = '' AND is_active IS DISTINCT FROM false
			FOR UPDATE
		)
		UPDATE ${attachments} a SET related_model = $3, related_record_id = $4, updated_at = $5
		FROM free WHERE a.id = free.id AND (SELECT count(*) FROM free) = jsonb_array_length($1::jsonb)
		RETURNING a.id`;
}

/**
 * Devolver a pendiente una subida propia ligada a ese registro, como la dejó `create_chat_upload`:
 * sin ligar, la limpieza de 24 h la da de baja. `$1` id, `$2` dueño, `$3` modelo, `$4` registro, `$5` hora.
 */
export function chat_release_upload_sql(attachments: string): string {
	return `UPDATE ${attachments} SET related_model = 'Message', related_record_id = '', updated_at = $5
		WHERE id = $1 AND created_by_id = $2 AND related_model = $3 AND related_record_id = $4
			AND payload -> 'chatUpload' IS NOT NULL AND is_active IS DISTINCT FROM false
		RETURNING id`;
}

/**
 * Un programado que sigue en el estado esperado: editarlo o cancelarlo mientras está pendiente, o
 * cerrarlo tras el envío. `$1` id, `$2` remitente (o nulo), `$3` estado esperado, `$4` estado nuevo
 * (o nulo), `$5` `send_at` nuevo (o nulo), `$6` lo que se mezcla al payload, `$7` hora.
 */
export function chat_update_scheduled_sql(scheduled: string): string {
	return `UPDATE ${scheduled} SET
			state = COALESCE($4, state),
			send_at = COALESCE($5, send_at),
			payload = COALESCE(payload, '{}'::jsonb) || $6::jsonb,
			updated_at = $7
		WHERE id = $1 AND ($2::text IS NULL OR sender_user_id = $2) AND state = $3 AND is_active IS DISTINCT FROM false
		RETURNING *`;
}

/**
 * Guardar un mensaje: uno por persona y mensaje; guardarlo otra vez aplica la nota o el
 * recordatorio que traiga. `$1` id nuevo, `$2` persona, `$3` mensaje, `$4` recordatorio (o nulo),
 * `$5` payload, `$6` hora.
 */
export function chat_save_message_sql(saved: string): string {
	return `INSERT INTO ${saved} AS s (id, name, description, is_active, state, user_id, message_id, remind_at, payload,
			created_at, updated_at)
		VALUES ($1, '', '', true, 'pending', $2, $3, $4, $5::jsonb, $6, $6)
		ON CONFLICT (user_id, message_id) DO UPDATE SET
			payload = COALESCE(s.payload, '{}'::jsonb) || EXCLUDED.payload,
			remind_at = COALESCE(EXCLUDED.remind_at, s.remind_at),
			state = CASE WHEN EXCLUDED.remind_at IS NOT NULL THEN 'pending' ELSE s.state END,
			updated_at = EXCLUDED.updated_at
		RETURNING *`;
}

/**
 * `viewer` es contacto de `owner` si `owner` le escribió por su directo: abrir un directo no
 * deja mensaje ni avisa, así que solo cuenta lo que decidió quien es dueño de la privacidad. La
 * llave del directo son los dos ids en orden binario, como la arma el núcleo.
 */
function contact_sql(owner: string, viewer: string, tables: { conversations: string; messages: string }): string {
	return `EXISTS (
			SELECT 1 FROM ${tables.conversations} d
			JOIN ${tables.messages} dm ON dm.conversation_id = d.id AND dm.sender_user_id = ${owner}::text
			WHERE d.kind = 'direct' AND d.is_active IS DISTINCT FROM false
				AND d.conversation_key = CASE WHEN ${owner}::text COLLATE "C" < ${viewer}::text COLLATE "C"
					THEN ${owner}::text || '::' || ${viewer}::text ELSE ${viewer}::text || '::' || ${owner}::text END)`;
}

/** De los dueños `$2` (arreglo JSON), quienes tienen al lector `$1` por contacto. */
export function chat_contact_owners_sql(tables: { conversations: string; messages: string }): string {
	return `SELECT o.id FROM jsonb_array_elements_text($2::jsonb) AS o(id) WHERE ${contact_sql('o.id', '$1', tables)}`;
}

/**
 * La audiencia de una historia `s` para el lector `viewer` (contrato §1.8): la organización, los
 * usuarios elegidos o los contactos del autor; nunca los excluidos.
 */
function story_audience_sql(viewer: string, tables: ChatStoryTables): string {
	return `NOT (COALESCE(s.payload #> '{audience,excludeIds}', '[]'::jsonb) ? ${viewer})
		AND CASE s.payload #>> '{audience,kind}'
			WHEN 'users' THEN COALESCE(s.payload #> '{audience,userIds}', '[]'::jsonb) ? ${viewer}
			WHEN 'contacts' THEN ${contact_sql('s.author_id', viewer, tables)}
			ELSE true END`;
}

export type ChatStoryTables = { stories: string; views: string; conversations: string; messages: string };

export type ChatStoryFeedQuery = {
	viewer_id: string;
	now: string;
	/** `stories_muted_author_ids`: van al final. */
	muted: string[];
	cursor?: { muted: boolean; at: string; id: string };
	limit: number;
};

/**
 * Los autores con historias vigentes que el lector puede ver, sin las propias, por keyset
 * `(silenciado, última historia, autor)`: los silenciados al final. Lo vigente es lo de 24 h, así
 * que el índice de `expires_at` acota lo que se lee.
 */
export function chat_story_feed_sql(tables: ChatStoryTables, query: ChatStoryFeedQuery): { sql: string; params: unknown[] } {
	const params: unknown[] = [query.viewer_id, query.now, query.muted];
	const param = (value: unknown) => {
		params.push(value);
		return `$${params.length}`;
	};
	const cursor = query.cursor;
	const after = cursor
		? (() => {
				const muted = param(cursor.muted);
				return `WHERE muted > ${muted}::boolean OR (muted = ${muted}::boolean AND (latest_at, author_id) < (${param(cursor.at)}, ${param(cursor.id)}))`;
			})()
		: '';
	return {
		sql: `WITH visible AS (
				SELECT s.author_id, s.created_at,
					EXISTS (SELECT 1 FROM ${tables.views} w WHERE w.story_id = s.id AND w.viewer_id = $1) AS seen
				FROM ${tables.stories} s
				WHERE s.expires_at > $2 AND s.is_active IS DISTINCT FROM false AND s.author_id <> $1
					AND ${story_audience_sql('$1', tables)}
			), authors AS (
				SELECT author_id, max(created_at) AS latest_at, bool_or(NOT seen) AS has_unseen,
					author_id IN (SELECT jsonb_array_elements_text($3::jsonb)) AS muted
				FROM visible GROUP BY author_id
			)
			SELECT * FROM authors ${after}
			ORDER BY muted, latest_at DESC, author_id DESC
			LIMIT ${param(query.limit)}`,
		params,
	};
}

/** Las historias vigentes de esos autores que el lector ve (las propias siempre), con su vista. `$1` lector, `$2` autores (JSON), `$3` hora. */
export function chat_story_items_sql(tables: ChatStoryTables): string {
	return `SELECT s.*, w.viewed_at AS my_viewed_at, w.payload ->> 'reaction' AS my_reaction
		FROM ${tables.stories} s
		LEFT JOIN ${tables.views} w ON w.story_id = s.id AND w.viewer_id = $1
		WHERE s.author_id IN (SELECT jsonb_array_elements_text($2::jsonb)) AND s.expires_at > $3
			AND s.is_active IS DISTINCT FROM false
			AND (s.author_id = $1 OR ${story_audience_sql('$1', tables)})
		ORDER BY s.author_id, s.created_at, s.id`;
}

/** Una historia si el lector es su autor o está en su audiencia, vigente o no. `$1` lector, `$2` historia. */
export function chat_story_visible_sql(tables: ChatStoryTables): string {
	return `SELECT s.* FROM ${tables.stories} s
		WHERE s.id = $2 AND s.is_active IS DISTINCT FROM false
			AND (s.author_id = $1 OR ${story_audience_sql('$1', tables)})`;
}

/**
 * Una vista por persona e historia; verla otra vez solo cambia la reacción. `$1` historia, `$2`
 * lector, `$3` hora, `$4` payload (`anonymous` y, si viene, `reaction`).
 */
export function chat_view_story_sql(views: string): string {
	return `INSERT INTO ${views} AS v (id, name, description, is_active, story_id, viewer_id, viewed_at, payload, created_at, updated_at)
		VALUES (${NEW_ROW_ID}, '', '', true, $1, $2, $3, $4::jsonb, $3, $3)
		ON CONFLICT (story_id, viewer_id) DO UPDATE SET
			payload = COALESCE(v.payload, '{}'::jsonb) || EXCLUDED.payload,
			updated_at = EXCLUDED.updated_at
		RETURNING *`;
}

/**
 * Dar de baja historias sin su texto, con sus vistas y las filas de su archivo, en una sentencia:
 * las propias que su autor borra o las vencidas que el latido reclamó. `$1` ids (JSON), `$2` hora y
 * `$3` el autor (o nulo: entonces solo las reclamadas).
 */
export function chat_drop_stories_sql(tables: { stories: string; views: string; attachments: string }): string {
	return `WITH old AS (
			SELECT id, payload FROM ${tables.stories}
			WHERE id IN (SELECT jsonb_array_elements_text($1::jsonb)) AND is_active IS DISTINCT FROM false
				AND (CASE WHEN $3::text IS NULL THEN state = 'expired' ELSE author_id = $3 END)
			FOR UPDATE
		), upd AS (
			UPDATE ${tables.stories} s SET
				is_active = false,
				payload = COALESCE(s.payload, '{}'::jsonb) - '{text,caption,background}'::text[],
				updated_at = $2
			FROM old WHERE s.id = old.id
			RETURNING s.id
		), unviewed AS (
			DELETE FROM ${tables.views} v USING old WHERE v.story_id = old.id
		), files AS (
			UPDATE ${tables.attachments} a SET is_active = false, updated_at = $2
			FROM old WHERE a.id = old.payload ->> 'attachmentId' AND a.is_active IS DISTINCT FROM false
			RETURNING a.name_stored
		)
		SELECT (SELECT COALESCE(jsonb_agg(id), '[]'::jsonb) FROM upd) AS ids,
			(SELECT COALESCE(jsonb_agg(name_stored), '[]'::jsonb) FROM files WHERE name_stored IS NOT NULL) AS files`;
}

/** `null` quita la nota o el recordatorio; con un recordatorio nuevo vuelve a quedar pendiente. */
export type ChatSavedPatch = { note?: string | null; remind_at?: string | null; done?: boolean };

export function chat_update_saved_sql(
	saved: string,
	patch: ChatSavedPatch,
	target: { id: string; user_id: string; now: string },
): { sql: string; params: unknown[] } {
	const params: unknown[] = [target.id, target.user_id, target.now];
	const param = (value: unknown) => {
		params.push(value);
		return `$${params.length}`;
	};
	const sets = ['updated_at = $3'];
	if (patch.note === null) sets.push(`payload = COALESCE(payload, '{}'::jsonb) - 'note'`);
	else if (patch.note !== undefined) {
		sets.push(`payload = COALESCE(payload, '{}'::jsonb) || jsonb_build_object('note', ${param(patch.note)}::text)`);
	}
	if (patch.remind_at !== undefined) sets.push(`remind_at = ${param(patch.remind_at)}`);
	if (patch.done) sets.push(`state = 'done'`);
	else if (patch.remind_at) sets.push(`state = 'pending'`);
	return {
		sql: `UPDATE ${saved} SET ${sets.join(', ')} WHERE id = $1 AND user_id = $2 AND is_active IS DISTINCT FROM false RETURNING *`,
		params,
	};
}

/** Lo que trae una membresía nueva (o un regreso); lo demás del payload son las preferencias de la persona. */
const MEMBERSHIP_KEYS = `ARRAY['joinedAt', 'leftAt', 'requestedAt', 'restrictedUntil', 'invitedById', 'visibleFromSeq', 'mentionSeqs', 'markedUnread']`;
const ACTIVE_MEMBER = `state = 'active' AND is_active IS DISTINCT FROM false`;

/**
 * Membresía de un grupo dentro de una transacción que primero bloquea la conversación: los
 * cambios de una misma conversación se ordenan y `memberCount` sale de las filas activas.
 */
export function chat_membership_sqls(tables: { conversations: string; members: string }) {
	const { conversations, members } = tables;
	return {
		/** `$1` conversación. */
		lock: `SELECT * FROM ${conversations} WHERE id = $1 AND is_active IS DISTINCT FROM false FOR UPDATE`,
		/** `$1` id, `$2` título, `$3` descripción, `$4` quien lo crea, `$5` kind, `$6` payload, `$7` hora. */
		group: `INSERT INTO ${conversations} (id, name, description, is_active, created_by, kind, conversation_key,
				last_seq, payload, created_at, updated_at)
			VALUES ($1, $2, $3, true, $4, $5, 'conv:' || $1::text, 0, $6::jsonb, $7, $7)`,
		/** `$1` conversación, `$2` personas (JSON). */
		current: `SELECT user_id, state, role FROM ${members}
			WHERE conversation_id = $1 AND user_id IN (SELECT jsonb_array_elements_text($2::jsonb))`,
		/** `$1` conversación. */
		active_count: `SELECT count(*)::int AS n FROM ${members} WHERE conversation_id = $1 AND ${ACTIVE_MEMBER}`,
		/**
		 * Alta, regreso o solicitud. La fila de quien salió, lo quitaron o pidió entrar se reutiliza
		 * con sus preferencias; quien ya está activo o baneado no cambia. `$1` conversación, `$2`
		 * personas `{user_id, role, invited_by}` (JSON), `$3` estado, `$4` marcas iniciales, `$5` lo
		 * nuevo de la membresía (JSON), `$6` hora.
		 */
		join: `INSERT INTO ${members} AS b (id, name, description, is_active, state, conversation_id, user_id, role,
				last_read_seq, public_read_seq, delivered_seq, payload, created_at, updated_at)
			SELECT ${NEW_ROW_ID}, '', '', true, $3, $1, u.user_id, COALESCE(u.role, 'member'), $4, 0, $4,
				'{"archived": false, "notifyLevel": "default"}'::jsonb || $5::jsonb
					|| jsonb_strip_nulls(jsonb_build_object('invitedById', u.invited_by)),
				$6, $6
			FROM jsonb_to_recordset($2::jsonb) AS u(user_id text, role text, invited_by text)
			ON CONFLICT (conversation_id, user_id) DO UPDATE SET
				state = EXCLUDED.state,
				role = EXCLUDED.role,
				is_active = true,
				last_read_seq = EXCLUDED.last_read_seq,
				delivered_seq = EXCLUDED.delivered_seq,
				payload = EXCLUDED.payload || (COALESCE(b.payload, '{}'::jsonb) - ${MEMBERSHIP_KEYS}),
				updated_at = EXCLUDED.updated_at
			WHERE b.state NOT IN ('active', 'banned')
			RETURNING *`,
		/** `$1` conversación, `$2` persona. */
		member: `SELECT * FROM ${members} WHERE conversation_id = $1 AND user_id = $2 FOR UPDATE`,
		/** Salir, quitar o banear; el dueño que sale deja de serlo. `$1` conversación, `$2` persona, `$3` estado, `$4` hora. */
		leave: `UPDATE ${members} SET
				state = $3,
				role = CASE WHEN role = 'owner' THEN 'member' ELSE role END,
				payload = COALESCE(payload, '{}'::jsonb) || jsonb_build_object('leftAt', $4::text),
				updated_at = $4
			WHERE conversation_id = $1 AND user_id = $2
			RETURNING *`,
		/** El administrador más antiguo o, si no hay, el miembro más antiguo. `$1` conversación, `$2` quien sale. */
		successor: `SELECT user_id FROM ${members}
			WHERE conversation_id = $1 AND user_id <> $2 AND ${ACTIVE_MEMBER}
			ORDER BY role = 'admin' DESC, COALESCE(payload ->> 'joinedAt', created_at), created_at, id
			LIMIT 1`,
		/** `$1` conversación, `$2` persona, `$3` rol, `$4` hora. */
		set_role: `UPDATE ${members} SET role = $3, updated_at = $4
			WHERE conversation_id = $1 AND user_id = $2 AND ${ACTIVE_MEMBER}
			RETURNING *`,
		/** `$1` conversación, `$2` hora. */
		count: `UPDATE ${conversations} c SET
				payload = COALESCE(c.payload, '{}'::jsonb) || jsonb_build_object('memberCount',
					(SELECT count(*) FROM ${members} m
						WHERE m.conversation_id = c.id AND m.state = 'active' AND m.is_active IS DISTINCT FROM false)),
				updated_at = $2
			WHERE c.id = $1
			RETURNING *`,
		/** Nadie quedó. `$1` conversación, `$2` hora. */
		close: `UPDATE ${conversations} SET is_active = false, updated_at = $2 WHERE id = $1 RETURNING *`,
		/** Un uso más del enlace. `$1` conversación, `$2` enlace, `$3` hora. */
		use_invite: `UPDATE ${conversations} SET
				payload = jsonb_set(payload, '{invites}', (
					SELECT jsonb_agg(CASE WHEN e.invite ->> 'id' = $2
						THEN e.invite || jsonb_build_object('uses', COALESCE((e.invite ->> 'uses')::int, 0) + 1)
						ELSE e.invite END ORDER BY e.n)
					FROM jsonb_array_elements(payload -> 'invites') WITH ORDINALITY AS e(invite, n))),
				updated_at = $3
			WHERE id = $1`,
		/** Los enlaces y el prefijo, que se fija una vez. `$1` conversación, `$2` prefijo, `$3` enlaces (JSON), `$4` hora. */
		invites: `UPDATE ${conversations} SET
				join_code = COALESCE(join_code, $2),
				payload = jsonb_set(COALESCE(payload, '{}'::jsonb), '{invites}', $3::jsonb),
				updated_at = $4
			WHERE id = $1
			RETURNING *`,
		/** `$1` conversación, `$2` fijados (JSON), `$3` hora. */
		pins: `UPDATE ${conversations} SET
				payload = jsonb_set(COALESCE(payload, '{}'::jsonb), '{pins}', $2::jsonb),
				updated_at = $3
			WHERE id = $1
			RETURNING *`,
		/** Rechazar una solicitud de unión. `$1` conversación, `$2` persona, `$3` hora. */
		deny: `UPDATE ${members} SET
				state = 'removed',
				payload = COALESCE(payload, '{}'::jsonb) || jsonb_build_object('leftAt', $3::text),
				updated_at = $3
			WHERE conversation_id = $1 AND user_id = $2 AND state = 'requested'
			RETURNING *`,
	};
}

/**
 * Rol o restricción de un miembro activo, solo si aún tiene el rol con el que se autorizó el
 * cambio: un traspaso o una baja que llegó antes lo deja sin efecto. `$1` conversación, `$2`
 * persona, `$3` rol esperado, `$4` rol nuevo (nulo no cambia), `$5` si cambia la restricción,
 * `$6` hasta cuándo (nulo la quita), `$7` hora.
 */
export function chat_update_member_sql(members: string): string {
	return `UPDATE ${members} SET
			role = COALESCE($4, role),
			payload = CASE WHEN $5::boolean
				THEN (COALESCE(payload, '{}'::jsonb) - 'restrictedUntil')
					|| jsonb_strip_nulls(jsonb_build_object('restrictedUntil', $6::text))
				ELSE payload END,
			updated_at = $7
		WHERE conversation_id = $1 AND user_id = $2 AND role = $3 AND ${ACTIVE_MEMBER}
		RETURNING *`;
}

/**
 * Título, descripción, ajustes y avatar de un grupo en una sentencia, con el antes para la
 * auditoría y para retirar el avatar anterior. `$1` conversación, `$2` título y `$3`
 * descripción (nulos no cambian), `$4` ajustes que cambian (JSON o nulo), `$5` lo que se agrega
 * al payload, `$6` las claves que se quitan (JSON), `$7` hora.
 */
export function chat_update_conversation_sql(conversations: string): string {
	return `WITH old AS (
			SELECT id, name, description, payload FROM ${conversations}
			WHERE id = $1 AND is_active IS DISTINCT FROM false FOR UPDATE
		)
		UPDATE ${conversations} c SET
			name = COALESCE($2, c.name),
			description = COALESCE($3, c.description),
			payload = (COALESCE(c.payload, '{}'::jsonb) - ARRAY(SELECT jsonb_array_elements_text($6::jsonb)))
				|| $5::jsonb
				|| CASE WHEN $4::jsonb IS NULL THEN '{}'::jsonb
					ELSE jsonb_build_object('settings', COALESCE(c.payload -> 'settings', '{}'::jsonb) || $4::jsonb) END,
			updated_at = $7
		FROM old WHERE c.id = old.id
		RETURNING c.*, old.name AS before_name, old.description AS before_description, old.payload AS before_payload`;
}

/**
 * Preferencias de una persona en una conversación. `$4` fija (`true`: al final de sus fijadas,
 * si caben en `$5`), desfija (`false`) o no toca (nulo). `$1` conversación, `$2` persona, `$3`
 * lo que cambia (JSON), `$6` hora. Sin fila: ya no es miembro activo o no cabe otra fijada.
 */
export function chat_update_prefs_sql(members: string): string {
	const pinned_of_user = `FROM ${members} o
		WHERE o.user_id = $2 AND o.state = 'active' AND jsonb_typeof(o.payload -> 'pinnedOrder') = 'number'`;
	const pinned = `jsonb_typeof(m.payload -> 'pinnedOrder') = 'number'`;
	return `UPDATE ${members} m SET
			payload = COALESCE(m.payload, '{}'::jsonb) || $3::jsonb || CASE
				WHEN $4::boolean IS NULL OR ($4 AND ${pinned}) THEN '{}'::jsonb
				WHEN NOT $4 THEN '{"pinnedOrder": null}'::jsonb
				ELSE jsonb_build_object('pinnedOrder',
					COALESCE((SELECT max((o.payload ->> 'pinnedOrder')::numeric) ${pinned_of_user}), 0) + 1)
			END,
			updated_at = $6
		WHERE m.conversation_id = $1 AND m.user_id = $2 AND m.state = 'active'
			AND ($4 IS NOT TRUE OR ${pinned} OR (SELECT count(*) ${pinned_of_user}) < $5)
		RETURNING *`;
}

export type ChatMemberQuery = {
	conversation_id: string;
	states: string[];
	role?: string;
	/** Nombre o correo. */
	q?: string;
	cursor?: { at: string; id: string };
	limit: number;
};

/** Miembros por keyset `(created_at, id)`, en el orden en que entraron, con lo mínimo de cada persona. */
export function chat_member_page_sql(
	tables: { members: string; users: string },
	query: ChatMemberQuery,
): { sql: string; params: unknown[] } {
	const params: unknown[] = [query.conversation_id, query.states];
	const param = (value: unknown) => {
		params.push(value);
		return `$${params.length}`;
	};
	const where = [
		'm.conversation_id = $1',
		'm.is_active IS DISTINCT FROM false',
		'm.state IN (SELECT jsonb_array_elements_text($2::jsonb))',
	];
	if (query.role) where.push(`m.role = ${param(query.role)}`);
	if (query.q) {
		const like = param(`%${query.q.replace(/[\\%_]/g, '\\$&')}%`);
		where.push(`(u.name ILIKE ${like} OR u.email ILIKE ${like})`);
	}
	if (query.cursor) where.push(`(m.created_at, m.id) > (${param(query.cursor.at)}, ${param(query.cursor.id)})`);
	return {
		sql: `SELECT m.*, u.id AS user_found, u.name AS user_name, u.email AS user_email, u.img AS user_img,
				u.is_active AS user_active
			FROM ${tables.members} m LEFT JOIN ${tables.users} u ON u.id = m.user_id
			WHERE ${where.join(' AND ')}
			ORDER BY m.created_at, m.id
			LIMIT ${param(query.limit)}`,
		params,
	};
}

/**
 * Escritura con compare-and-swap sobre `payload.v` (contrato §1.9): solo cambia la fila si nadie
 * la escribió desde que se leyó, y sube `v`. `$1` id, `$2` el `v` leído, `$3` state (o null),
 * `$4` lo que se mezcla en el payload, `$5` la hora y desde `$6`, las columnas físicas en orden.
 */
export function update_versioned_sql(table: string, columns: readonly string[]): string {
	const sets = columns.map((column, i) => `${qident(column)} = $${6 + i}, `).join('');
	return `UPDATE ${table} SET
			state = COALESCE($3::text, state), ${sets}
			payload = COALESCE(payload, '{}'::jsonb) || $4::jsonb || jsonb_build_object('v', $2::int + 1),
			updated_at = $5
		WHERE id = $1 AND COALESCE((payload ->> 'v')::int, 0) = $2::int AND is_active IS DISTINCT FROM false
		RETURNING *`;
}

/**
 * Pone o quita un texto de un arreglo del payload en una sentencia, sobre la versión vigente de la
 * fila: dos votos a la vez no se pisan. `$1` id, `$2` campo, `$3` valor, `$4` true pone, false quita
 * y null conmuta, `$5` la hora; con `count_field`, ese campo guarda el largo del arreglo.
 */
export function payload_set_toggle_sql(table: string, count_field: string | null): string {
	const list = `COALESCE(payload -> $2::text, '[]'::jsonb)`;
	const on = `COALESCE($4::boolean, NOT (${list} ? $3::text))`;
	const next = `CASE WHEN ${on}
			THEN (CASE WHEN ${list} ? $3::text THEN ${list} ELSE ${list} || to_jsonb($3::text) END)
			ELSE ${list} - $3::text END`;
	const count = count_field ? `, '${count_field.replace(/'/g, "''")}', jsonb_array_length(${next})` : '';
	return `UPDATE ${table} SET
			payload = COALESCE(payload, '{}'::jsonb) || jsonb_build_object($2::text, ${next}${count}),
			updated_at = $5
		WHERE id = $1 AND is_active IS DISTINCT FROM false
		RETURNING *`;
}

/** Historial de llamadas de una persona, del más nuevo al más viejo, por el GIN de `participantIds`. */
export function calls_page_for_user_sql(
	calls: string,
	query: { user_id: string; cursor?: { at: string; id: string }; limit: number },
): { sql: string; params: unknown[] } {
	const params: unknown[] = [query.user_id, query.limit];
	const where = [`(payload -> 'participantIds') @> jsonb_build_array($1::text)`, 'is_active IS DISTINCT FROM false'];
	if (query.cursor) {
		params.push(query.cursor.at, query.cursor.id);
		where.push('(created_at, id) < ($3, $4)');
	}
	return {
		sql: `SELECT * FROM ${calls} WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT $2`,
		params,
	};
}

export type MeetingScope = 'proximas' | 'salas' | 'pasadas';

const NOT_PERSISTENT = `COALESCE(payload ->> 'persistent', 'false') <> 'true'`;

/**
 * Reuniones de un miembro por pestaña: las próximas por inicio ascendente; las salas
 * persistentes y las pasadas, de la más nueva a la más vieja. `since` separa próximas de
 * pasadas; el cursor es la llave de orden de la última fila y su id.
 */
export function meetings_page_for_member_sql(
	meetings: string,
	query: { user_id: string; scope: MeetingScope; since: string; cursor?: { at: string; id: string }; limit: number },
): { sql: string; params: unknown[] } {
	const params: unknown[] = [query.user_id, query.limit];
	const param = (value: unknown) => {
		params.push(value);
		return `$${params.length}`;
	};
	const where = [`(payload -> 'memberIds') @> jsonb_build_array($1::text)`, 'is_active IS DISTINCT FROM false'];
	let key: string;
	let order: 'ASC' | 'DESC';
	if (query.scope === 'proximas') {
		// Una reunión en curso sigue en próximas aunque su inicio ya haya pasado.
		where.push(NOT_PERSISTENT, `state IS DISTINCT FROM 'cancelled'`, `(state = 'live' OR next_start_at >= ${param(query.since)})`);
		key = 'next_start_at';
		order = 'ASC';
	} else if (query.scope === 'salas') {
		where.push(`payload ->> 'persistent' = 'true'`, `state IS DISTINCT FROM 'cancelled'`);
		key = 'created_at';
		order = 'DESC';
	} else {
		where.push(
			NOT_PERSISTENT,
			`state IS DISTINCT FROM 'live'`,
			`(state = 'cancelled' OR next_start_at IS NULL OR next_start_at < ${param(query.since)})`,
		);
		key = 'COALESCE(next_start_at, created_at)';
		order = 'DESC';
	}
	if (query.cursor) {
		where.push(`(${key}, id) ${order === 'ASC' ? '>' : '<'} (${param(query.cursor.at)}, ${param(query.cursor.id)})`);
	}
	return {
		sql: `SELECT *, ${key} AS page_key FROM ${meetings} WHERE ${where.join(' AND ')}
			ORDER BY ${key} ${order}, id ${order} LIMIT $2`,
		params,
	};
}

/**
 * Reclama el recordatorio de las reuniones que empiezan en (`$1`, `$2`] y no se avisaron para ese
 * inicio. Sube `v`: una edición leída antes del reclamo no pisa `remindedFor`. `$3` tope, `$4` hora.
 */
export function meetings_claim_reminders_sql(meetings: string): string {
	return `UPDATE ${meetings} SET
			payload = COALESCE(payload, '{}'::jsonb) || jsonb_build_object(
				'remindedFor', next_start_at, 'v', COALESCE((payload ->> 'v')::int, 0) + 1),
			updated_at = $4
		WHERE id IN (
			SELECT id FROM ${meetings}
			WHERE next_start_at > $1 AND next_start_at <= $2 AND state = 'scheduled'
				AND payload ->> 'remindedFor' IS DISTINCT FROM next_start_at AND is_active IS DISTINCT FROM false
			ORDER BY next_start_at, id
			LIMIT $3
			FOR UPDATE SKIP LOCKED
		)
		RETURNING *`;
}

/** Reuniones con recurrencia cuya ocurrencia vigente ya terminó a la hora `$1`; `$2` tope. */
export function meetings_due_to_advance_sql(meetings: string): string {
	return `SELECT * FROM ${meetings}
		WHERE next_start_at < $1 AND ${RECURRING_PENDING}
			AND next_start_at::timestamptz + make_interval(mins => COALESCE((payload ->> 'durationMin')::int, 60))
				<= $1::timestamptz
		ORDER BY next_start_at, id
		LIMIT $2`;
}

/**
 * Las preguntas de una llamada, de la más votada a la menos y, a igual voto, por llegada. `$1`
 * llamada, `$2` los estados que se ven, `$3` quien ve además las suyas aunque no se vean, `$4` tope.
 */
export function meeting_questions_sql(questions: string): string {
	return `SELECT * FROM ${questions}
		WHERE call_id = $1 AND is_active IS DISTINCT FROM false
			AND (state IN (SELECT jsonb_array_elements_text($2::jsonb)) OR (state = 'pending' AND payload ->> 'authorKey' = $3))
		ORDER BY COALESCE((payload ->> 'votes')::int, 0) DESC, created_at, id
		LIMIT $4`;
}

/**
 * Marca leído el mensaje `$2` solo a quien ya iba al día (`last_read_seq = $2 − 1`): un mensaje
 * del servidor que no le toca leer no le salta lo que tenía pendiente. `$3` a quiénes, `$4` quiénes
 * comparten acuses, `$5` la hora.
 */
export function chat_catch_up_read_sql(tables: { conversations: string; members: string }): string {
	return `UPDATE ${tables.members} m SET
			last_read_seq = $2,
			delivered_seq = GREATEST(COALESCE(m.delivered_seq, 0), $2),
			public_read_seq = CASE WHEN m.user_id IN (SELECT jsonb_array_elements_text($4::jsonb))
				THEN GREATEST(COALESCE(m.public_read_seq, 0), $2) ELSE m.public_read_seq END,
			updated_at = $5
		FROM ${tables.conversations} c
		WHERE m.conversation_id = $1 AND c.id = m.conversation_id AND m.state = 'active'
			AND m.user_id IN (SELECT jsonb_array_elements_text($3::jsonb))
			AND COALESCE(m.last_read_seq, 0) = $2 - 1
		RETURNING m.user_id, c.last_seq, jsonb_array_length(COALESCE(m.payload -> 'mentionSeqs', '[]'::jsonb)) AS mentions`;
}

/** La llamada viva de la conversación, o se quita si sigue siendo `$3` (una más nueva no se borra). */
export function chat_set_active_call_sql(conversations: string): string {
	return `UPDATE ${conversations} SET
			payload = CASE WHEN $2::jsonb IS NULL THEN COALESCE(payload, '{}'::jsonb) - 'activeCall'
				ELSE COALESCE(payload, '{}'::jsonb) || jsonb_build_object('activeCall', $2::jsonb) END,
			updated_at = GREATEST(COALESCE(updated_at, ''), $4)
		WHERE id = $1 AND ($2::jsonb IS NOT NULL OR payload #>> '{activeCall,callId}' = $3)
		RETURNING id`;
}

/** Lo que la asistencia acumula entre escrituras; lo demás de `$6` (rol, nombre, resultado) reemplaza. */
const ATTENDANCE_SUMS = ['totalS', 'waitedS', 'reconnections', 'hands', 'reactions', 'questions', 'cameraS'];

/**
 * Asistencia de una persona en una llamada: la primera salida crea la fila y las siguientes suman
 * sus intervalos (los últimos 50), tiempos y contadores. `$6` trae lo de esta salida.
 */
export function call_attendance_upsert_sql(attendance: string): string {
	const intervals = `COALESCE(a.payload -> 'intervals', '[]'::jsonb) || COALESCE($6::jsonb -> 'intervals', '[]'::jsonb)`;
	const add = (field: string) =>
		`'${field}', COALESCE((a.payload ->> '${field}')::numeric, 0) + COALESCE(($6::jsonb ->> '${field}')::numeric, 0)`;
	const replaced = ['intervals', ...ATTENDANCE_SUMS].map((field) => `'${field}'`).join(', ');
	return `INSERT INTO ${attendance} AS a (id, name, is_active, call_id, meeting_id, participant_key, payload, created_at, updated_at)
		VALUES ($1, $2, true, $3, $4, $5, $6::jsonb, $7, $7)
		ON CONFLICT (call_id, participant_key) DO UPDATE SET
			payload = a.payload || ($6::jsonb - ARRAY[${replaced}]) || jsonb_build_object(
				'intervals', (SELECT COALESCE(jsonb_agg(x ORDER BY n), '[]'::jsonb)
					FROM jsonb_array_elements(${intervals}) WITH ORDINALITY AS t(x, n)
					WHERE n > jsonb_array_length(${intervals}) - 50),
				${ATTENDANCE_SUMS.map(add).join(',\n\t\t\t\t')}),
			updated_at = $7
		RETURNING *`;
}

export type ChatJoinResult =
	| { status: 'missing' | 'full' | 'not_requested' | 'invite_not_found' | 'invite_expired' | 'invite_exhausted' }
	| { status: 'banned'; user_ids: string[] }
	/** `joined`: las filas que entraron o pidieron entrar; `previous`, el estado de antes de cada persona. */
	| { status: 'ok'; conversation: ImperiumDoc; joined: ImperiumDoc[]; previous: Record<string, string> };

export type ChatLeaveResult =
	| { status: 'not_member' | 'not_member_target' }
	| { status: 'ok'; conversation: ImperiumDoc; successor_id: string | null; closed: boolean };

export type ChatTransferResult =
	| { status: 'not_owner' | 'not_member_target' }
	| { status: 'ok'; owner: ImperiumDoc; previous: ImperiumDoc };

/**
 * Keyset temporal: `(created_at, id) > ($at, $id)`, o `<` para ir del más nuevo al
 * más viejo. `created_at` es TEXT ISO; el predicado no casteá — coincide con
 * `ORDER BY created_at, id` (lex = cronológico en ISO-8601).
 */
export function created_at_keyset_sql(at_param: string, id_param: string, op: '>' | '<' = '>'): string {
	return `(created_at, id) ${op} (${at_param}, ${id_param})`;
}

/**
 * Keyset FIFO de lotes: `(fecha_entrada, created_at, id) > (...)`.
 * TEXT ISO; el predicado no casteá. Empate = created_at, luego id.
 */
export function fecha_entrada_keyset_sql(
	fecha_param: string,
	created_param: string,
	id_param: string,
): string {
	return `(fecha_entrada, created_at, id) > (${fecha_param}, ${created_param}, ${id_param})`;
}

/** Un `MAX` numérico: dígitos enteros o cola numérica (`SES-12` → 12). */
export function max_numeric_expr(field_sql: string): string {
	return `MAX(CASE
		WHEN ${field_sql}::text ~ '^[0-9]+(\\.[0-9]+)?$' THEN ${field_sql}::numeric
		WHEN ${field_sql}::text ~ '[0-9]+$' THEN (regexp_match(${field_sql}::text, '([0-9]+)$'))[1]::numeric
		ELSE NULL
	END)`;
}

/**
 * `GROUP BY` de un campo escalar (columna o `payload ->>`). Una fila por
 * valor distinto + COUNT. No hidrata docs. Refs/objetos no van por aquí:
 * `payload ->>` de `{_id, name}` no es el id de `serialize_field_value`.
 */
export function value_counts_sql(
	quoted_table: string,
	expr: string,
	include_inactive: boolean,
	scoped = '',
): string {
	const active = include_inactive ? '' : 'is_active IS DISTINCT FROM false AND ';
	const scope = scoped ? `${scoped} AND ` : '';
	return `SELECT ${expr} AS v, COUNT(*)::int AS n
		FROM ${quoted_table}
		WHERE ${active}${scope}${expr} IS NOT NULL
		  AND btrim(${expr}::text) <> ''
		  AND ${expr}::text NOT IN ('-', 'ERR!')
		GROUP BY 1`;
}

/**
 * Lote que convierte JSONB string-wrapped (`"{\"a\":1}"`) en objeto.
 * Así `payload ->>` y los btrees de expresión vuelven a ver las claves.
 */
/** Un `\\u0000` en el texto no cabe en jsonb (22P05): esas filas se quedan como string. */
function unwrappable_where(col: string): string {
	return `jsonb_typeof(${col}) = 'string'
		  AND (${col} #>> '{}') ~ '^[[:space:]]*[\\{\\[]'
		  AND strpos((${col} #>> '{}'), '\\u0000') = 0`;
}

export function unwrap_jsonb_string_sql(quoted_table: string, column: string): string {
	const col = qident(column);
	return `UPDATE ${quoted_table} AS t
		SET ${col} = (t.${col} #>> '{}')::jsonb
		FROM (
			SELECT id FROM ${quoted_table}
			WHERE ${unwrappable_where(col)}
			LIMIT 1000
		) s
		WHERE t.id = s.id
		RETURNING t.id`;
}

export function string_jsonb_ids_sql(quoted_table: string, column: string): string {
	const col = qident(column);
	return `SELECT id FROM ${quoted_table}
		WHERE ${unwrappable_where(col)}
		LIMIT 1000`;
}

export function unwrap_jsonb_string_one_sql(quoted_table: string, column: string): string {
	const col = qident(column);
	return `UPDATE ${quoted_table}
		SET ${col} = (${col} #>> '{}')::jsonb
		WHERE id = $1
		  AND jsonb_typeof(${col}) = 'string'
		RETURNING id`;
}

/**
 * Bun.SQL pone el SQLSTATE en `errno` y `ERR_POSTGRES_SERVER_ERROR` en `code`.
 * Usar solo `code` deja pasar 42P01 y tumba el boot de toda la API.
 */
export function is_missing_relation(err: unknown): boolean {
	if (err === null || err === undefined || typeof err !== 'object') {
		return /relation ".+" does not exist/i.test(String(err ?? ''));
	}
	const rec = err as { code?: string; errno?: string; message?: string };
	const code = String(rec.code ?? '');
	const errno = String(rec.errno ?? '');
	if (code === '42P01' || errno === '42P01' || code === '42703' || errno === '42703') {
		return true;
	}
	return /relation ".+" does not exist/i.test(String(rec.message ?? ''));
}

/**
 * Bun.SQL pone el SQLSTATE en `errno` (`23505`) y `ERR_POSTGRES_SERVER_ERROR` en `code`.
 * El unwrap de jsonb string-wrapped choca unique si ya existe la fila objeto.
 */
export function is_unique_violation(err: unknown): boolean {
	if (err === null || err === undefined || typeof err !== 'object') {
		return /duplicate key value violates unique constraint/i.test(String(err ?? ''));
	}
	const rec = err as { code?: string; errno?: string; message?: string };
	const code = String(rec.code ?? '');
	const errno = String(rec.errno ?? '');
	if (code === '23505' || errno === '23505') return true;
	return /duplicate key value violates unique constraint/i.test(String(rec.message ?? ''));
}

export function json_unwrap_error_action(
	err: unknown,
): 'skip-table' | 'lenient' | 'throw' {
	if (is_missing_relation(err)) return 'skip-table';
	if (is_unique_violation(err)) return 'lenient';
	return 'throw';
}

type RefBook = {
	fields: Record<string, Record<string, string>>;
	models: Record<string, string>;
};

const REFS: RefBook = JSON.parse(
	readFileSync(join(import.meta.dir, 'refs.json'), 'utf8'),
) as RefBook;

function field_map_for(resource: string): Record<string, string> | undefined {
	return REFS.fields[resource] ?? REFS.fields[RESOURCE_ALIASES[resource] ?? ''];
}

/** Modelo mongoose de una columna-ref (p. ej. citizen-report.assinged_to → Employee). */
export function related_model_for_field(
	resource: string,
	field: string,
): string | undefined {
	const map = field_map_for(resource);
	const root = field.split('.')[0] ?? field;
	return (
		map?.[field] ??
		map?.[root] ??
		(root === 'created_by' ? 'User' : undefined)
	);
}

const OBJECT_ID_HEX = /^[a-fA-F0-9]{24}$/;

function objectid_model_label(resource: string) {
	const canonical = RESOURCE_ALIASES[resource] ?? resource;
	return canonical.replace(/(^|-)([a-z])/g, (_, __, letter: string) => letter.toUpperCase());
}

function objectid_cast_message(value: unknown, path: string) {
	const type = value === null ? 'null' : Array.isArray(value) ? 'Array' : typeof value;
	const shown = typeof value === 'string' ? value : JSON.stringify(value);
	return `Cast to ObjectId failed for value "${shown}" (type ${type}) at path "${path}" because of "BSONError"`;
}

function assert_objectid_leaf(
	value: unknown,
	path: string,
	add: (path: string, raw: unknown) => void,
) {
	if (value == null || value === '') return;
	if (Array.isArray(value)) {
		value.forEach((item, index) => assert_objectid_leaf(item, `${path}.${index}`, add));
		return;
	}
	if (typeof value === 'object') {
		const id = ref_id(value);
		if (!id) return;
		if (!is_record_id(id)) add(path, id);
		return;
	}
	const text = String(value).trim();
	if (!text) return;
	if (!is_record_id(text)) add(path, value);
}

function visit_objectid_path(
	value: unknown,
	segs: string[],
	path: string,
	add: (path: string, raw: unknown) => void,
) {
	if (!segs.length) {
		assert_objectid_leaf(value, path, add);
		return;
	}
	if (value == null) return;
	if (Array.isArray(value)) {
		value.forEach((item, index) => {
			visit_objectid_path(item, segs, path ? `${path}.${index}` : String(index), add);
		});
		return;
	}
	if (typeof value !== 'object') return;
	const [head, ...rest] = segs;
	if (!head) return;
	const next = path ? `${path}.${head}` : head;
	visit_objectid_path((value as Record<string, unknown>)[head], rest, next, add);
}

/**
 * Replica el CastError de Mongoose 9 (ObjectId inválido → ValidationError + field_errors).
 */
export function assert_objectid_refs(
	resource: string,
	doc: ImperiumDoc,
	only_keys?: string[],
) {
	const field_map = field_map_for(resource);
	if (!field_map) return;
	const scoped = only_keys ? new Set(only_keys) : null;
	const field_errors: Record<string, string[]> = {};
	const add = (path: string, raw: unknown) => {
		const message = objectid_cast_message(raw, path);
		if (!field_errors[path]) field_errors[path] = [];
		if (!field_errors[path].includes(message)) field_errors[path].push(message);
	};
	for (const field of Object.keys(field_map)) {
		const top = field.split('.')[0] ?? field;
		if (scoped && !scoped.has(field) && !scoped.has(top)) continue;
		visit_objectid_path(doc, field.split('.'), '', add);
	}
	if (!Object.keys(field_errors).length) return;
	const detail = Object.entries(field_errors)
		.map(([field, messages]) => `${field}: ${messages[0]}`)
		.join(', ');
	throw new FieldValidationError(
		field_errors,
		`${objectid_model_label(resource)} validation failed: ${detail}`,
	);
}

/** Campos que el original guarda como id string (sin $lookup a name). */
const LIST_REF_KEEP_AS_ID = new Set(['invoice_request_id', 'cfdi_document_id']);
/** Original `on_populate_get_name_and_id: false`: el $lookup se queda como objeto. */
const LIST_KEEP_POPULATED_REFS = new Set([
	'employee',
	'vehicle',
	'pos-session',
	'custom-field-control',
]);

/** `__get_statistics` del scaffold con `charts.daily_stats` (línea 30 días). */
const DAILY_LINE_CHART = new Set([
	'cfdi-document',
	'cfdi-catalog',
	'cfdi-issuer-profile',
	'cfdi',
	'payments',
	'dynamic-dashboard',
	'payroll-concept',
	'payroll-period',
	'payroll-receipt',
	'labor-schedule',
	'labor-incident',
	'nomina',
]);

const GENERAL = new Set([
	'id',
	'name',
	'description',
	'is_active',
	'state',
	'ref',
	'search_field',
	'created_by',
	'custom_data',
	'payload',
	'created_at',
	'updated_at',
]);

export function qident(name: string): string {
	if (!/^[a-z_][a-z0-9_]*$/i.test(name)) throw new Error(`bad ident ${name}`);
	return `"${name.replace(/"/g, '""')}"`;
}

const LIST_SQL_ALWAYS_PHYSICAL = [
	'id',
	'name',
	'description',
	'is_active',
	'state',
	'ref',
	'search_field',
	'created_by',
	'custom_data',
	'created_at',
	'updated_at',
] as const;

const LIST_SQL_ALWAYS_PAYLOAD = [
	'parent_task',
	'parent_task_id',
	'is_global',
	'assigned_user_ids',
	'assigned_user_group_ids',
	'tags',
	'etiquetas',
] as const;

/** Claves que `finalize_rows` lee antes de `project_list_docs`. */
const LIST_SQL_DECORATE_PAYLOAD: Record<string, readonly string[]> = {
	'inventory-reception': ['articulos', 'purchase_order', 'orden_compra'],
	'inventory-physical-count': ['lineas'],
	'inventory-stock-quant': ['producto', 'ubicacion'],
	'custom-field-control': ['fields'],
};

function physical_list_name(key: string): string {
	if (key === '_id' || key === 'id') return 'id';
	if (key === '_ref' || key === 'ref') return 'ref';
	if (key === 'createdAt') return 'created_at';
	if (key === 'updatedAt') return 'updated_at';
	return key;
}

function payload_list_expr(): string {
	return `CASE
		WHEN jsonb_typeof(payload) = 'object' THEN payload
		WHEN jsonb_typeof(payload) = 'string' THEN COALESCE((payload #>> '{}')::jsonb, '{}'::jsonb)
		ELSE '{}'::jsonb
	END`;
}

/**
 * Extrae texto de payload objeto o string-wrapped. No es sargable
 * (CASE); usar solo en caminos que aún no desenvuelven el JSONB.
 */
export function payload_text_expr(field: string): string {
	if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(field)) {
		throw new Error(`bad ident ${field}`);
	}
	const root = `(${payload_list_expr()})`;
	if (!field.includes('.')) return `${root} ->> ${literal(field)}`;
	return `${root} #>> '{${field.split('.').join(',')}}'`;
}

/**
 * Longitud de un arreglo en payload (objeto o string-wrapped).
 * CASE unwrap: solo proyección, no predicado sargable.
 */
export function json_array_length_sql(field: string): string {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(field)) throw new Error(`bad ident ${field}`);
	const arr = `(${payload_list_expr()}) -> ${literal(field)}`;
	return `CASE WHEN jsonb_typeof(${arr}) = 'array' THEN jsonb_array_length(${arr}) ELSE 0 END`;
}

/**
 * Stats de turnos: caja / servicio / duración. Sin `search_field`.
 * `created_at` entra por el SELECT de `scan_select_sql`.
 */
export const TURN_STATS_FIELDS = [
	'status',
	'state',
	'assigned_box',
	'services',
	'customer_type',
	'time_box',
	'time',
];

/**
 * Stats de quejas: KPIs / series. Sin `search_field` ni evidencia.
 * `created_at` entra por el SELECT de `scan_select_sql`.
 * `citizen_name` alimenta la etiqueta de reincidencia (la identidad sigue
 * siendo el teléfono). `name` / `assinged_to` van al Excel de registros.
 * Las refs se resuelven por página con populate lite.
 */
export const CITIZEN_REPORT_STATS_FIELDS = [
	'name',
	'status',
	'priority',
	'employee_taken_the_report',
	'assinged_to',
	'department',
	'reporting_medium',
	'citizen_report_problem',
	'borough',
	'report_coordinates',
	'latitude',
	'longitude',
	'citizen_phone',
	'citizen_name',
	'updated_at',
];

/** Cards del tablero de guías. Sin `steps` (el blob). */
export const INTERACTIVE_MANUAL_CARD_FIELDS = [
	'name',
	'description',
	'icon',
	'module_model_id',
	'is_default_for_module',
	'assigned_user_ids',
	'assigned_group_ids',
];

/** `order` de documentation-page (payload). Numérico, no texto. */
export function documentation_page_order_sql(): string {
	const expr = `(${payload_text_expr('order')})`;
	return `CASE WHEN ${expr} ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN ${expr}::numeric ELSE 0 END`;
}

export function documentation_page_current_sql(params: unknown[], lookup: {
	slug: string;
	folder: string;
	section: string;
}): string {
	params.push(lookup.slug);
	const clauses = [
		'is_active IS DISTINCT FROM false',
		`${payload_text_expr('slug')} = $${params.length}`,
	];
	if (lookup.folder) {
		params.push(lookup.folder);
		clauses.push(`${payload_text_expr('folder_path')} = $${params.length}`);
	}
	if (lookup.section) {
		params.push(lookup.section);
		clauses.push(`${payload_text_expr('section')} = $${params.length}`);
	}
	return ` WHERE ${clauses.join(' AND ')}`;
}

export function documentation_page_neighbor_sql(
	dir: 'prev' | 'next',
	params: unknown[],
	cursor: { section: string; order: number; id: string },
): string {
	const section_expr = payload_text_expr('section');
	const order_expr = documentation_page_order_sql();
	params.push(cursor.section, cursor.order, cursor.id);
	const sec = `$${params.length - 2}`;
	const ord = `$${params.length - 1}`;
	const id = `$${params.length}`;
	const cmp = dir === 'prev'
		? `(${section_expr} < ${sec}
			OR (${section_expr} = ${sec} AND ${order_expr} < ${ord})
			OR (${section_expr} = ${sec} AND ${order_expr} = ${ord} AND id < ${id}))`
		: `(${section_expr} > ${sec}
			OR (${section_expr} = ${sec} AND ${order_expr} > ${ord})
			OR (${section_expr} = ${sec} AND ${order_expr} = ${ord} AND id > ${id}))`;
	const order = dir === 'prev'
		? `${section_expr} DESC, ${order_expr} DESC, id DESC`
		: `${section_expr} ASC, ${order_expr} ASC, id ASC`;
	return ` WHERE is_active IS DISTINCT FROM false AND ${cmp} ORDER BY ${order} LIMIT 1`;
}

/**
 * Extrae texto de payload objeto. Sargable (`payload ->>` / `#>>`).
 * Solo debug-log, que `ensure_object_json_cells` desenvuelve al boot.
 * No usar en `field_extract`: el CASE rompería el btree del historial.
 */
export function debug_payload_expr(field: string): string {
	if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(field)) {
		throw new Error(`bad ident ${field}`);
	}
	if (!field.includes('.')) return `payload ->> ${literal(field)}`;
	return `payload #>> '{${field.split('.').join(',')}}'`;
}

export type DebugLogFilter = {
	levels: string[];
	search: string;
	user: string;
	origin_file: string;
	request_results: string[];
	date_from: string;
	date_to: string;
};

const DEBUG_LOG_SORTS: Record<string, string> = {
	createdAt: 'created_at',
	created_at: 'created_at',
	level: 'level',
	message: 'message',
	'origin.file': 'origin.file',
	'request_context.response.status_code': 'request_context.response.status_code',
	'request_context.response.duration_ms': 'request_context.response.duration_ms',
};

function debug_log_sort_sql(field: string, dir: 'ASC' | 'DESC'): string {
	const key = DEBUG_LOG_SORTS[field] ?? 'created_at';
	if (key === 'created_at') return `created_at ${dir} NULLS LAST, id ${dir}`;
	if (key === 'request_context.response.status_code' || key === 'request_context.response.duration_ms') {
		const expr = debug_payload_expr(key);
		return `CASE WHEN ${expr} ~ '^[0-9]+(\\.[0-9]+)?$' THEN ${expr}::numeric END ${dir} NULLS LAST, id ${dir}`;
	}
	return `${debug_payload_expr(key)} ${dir} NULLS LAST, id ${dir}`;
}

/**
 * Página de consola: escalares + mensaje recortado. Sin call_stack,
 * metadata ni user_agent. El detalle hace find_id.
 */
export function debug_log_list_select_sql(): string {
	const root = `(${payload_list_expr()})`;
	const ctx = `${root} -> 'request_context'`;
	const resp = `(${ctx}) -> 'response'`;
	const slim_response = `CASE
		WHEN jsonb_typeof(${resp}) = 'object' THEN jsonb_strip_nulls(jsonb_build_object(
			'result', ${resp} -> 'result',
			'result_label', ${resp} -> 'result_label',
			'status_code', ${resp} -> 'status_code',
			'status_group', ${resp} -> 'status_group',
			'status_text', ${resp} -> 'status_text',
			'response_message', to_jsonb(left(${resp} ->> 'response_message', 240)),
			'duration_ms', ${resp} -> 'duration_ms'
		))
		ELSE NULL
	END`;
	const slim_ctx = `CASE
		WHEN jsonb_typeof(${ctx}) = 'object' THEN jsonb_strip_nulls(jsonb_build_object(
			'method', ${ctx} -> 'method',
			'label', ${ctx} -> 'label',
			'url', ${ctx} -> 'url',
			'route', ${ctx} -> 'route',
			'origin', ${ctx} -> 'origin',
			'ip', ${ctx} -> 'ip',
			'user', ${ctx} -> 'user',
			'response', ${slim_response}
		))
		ELSE NULL
	END`;
	return `"id", "name", "created_at", "is_active",
		jsonb_strip_nulls(jsonb_build_object(
			'level', ${root} -> 'level',
			'label', ${root} -> 'label',
			'request_label', ${root} -> 'request_label',
			'origin', ${root} -> 'origin',
			'process', ${root} -> 'process',
			'message', to_jsonb(left(${root} ->> 'message', 2000)),
			'formatted_message', to_jsonb(left(${root} ->> 'formatted_message', 2000)),
			'formatted_message_ansi', to_jsonb(left(${root} ->> 'formatted_message_ansi', 2000)),
			'request_context', ${slim_ctx}
		)) AS payload`;
}

function debug_log_status_sql(lo: number, hi: number): string {
	const expr = debug_payload_expr('request_context.response.status_code');
	return `(CASE WHEN ${expr} ~ '^[0-9]+$' THEN ${expr}::int END BETWEEN ${lo} AND ${hi})`;
}

export function debug_log_filter_sql(filter: DebugLogFilter, params: unknown[]): string {
	const clauses: string[] = [];
	if (filter.levels.length) {
		const marks = filter.levels.map((level) => {
			params.push(level);
			return `$${params.length}`;
		});
		clauses.push(`${debug_payload_expr('level')} IN (${marks.join(', ')})`);
	}
	if (filter.date_from) {
		params.push(filter.date_from);
		clauses.push(`created_at >= $${params.length}`);
	}
	if (filter.date_to) {
		params.push(filter.date_to);
		clauses.push(`created_at <= $${params.length}`);
	}
	if (filter.search) {
		params.push(`%${filter.search}%`);
		const n = `$${params.length}`;
		clauses.push(`(
			name ILIKE ${n}
			OR search_field ILIKE ${n}
			OR ${debug_payload_expr('message')} ILIKE ${n}
			OR (payload -> 'origin')::text ILIKE ${n}
		)`);
	}
	if (filter.user) {
		params.push(`%${filter.user}%`);
		const n = `$${params.length}`;
		clauses.push(`(
			created_by ILIKE ${n}
			OR ${debug_payload_expr('user')} ILIKE ${n}
			OR ${debug_payload_expr('request_context.user.name')} ILIKE ${n}
			OR ${debug_payload_expr('request_context.user.email')} ILIKE ${n}
		)`);
	}
	if (filter.origin_file) {
		params.push(`%${filter.origin_file}%`);
		const n = `$${params.length}`;
		clauses.push(`(
			${debug_payload_expr('origin.file')} ILIKE ${n}
			OR ${debug_payload_expr('origin_file')} ILIKE ${n}
		)`);
	}
	if (filter.request_results.length) {
		const result_expr = `lower(${debug_payload_expr('request_context.response.result')})`;
		const branches = filter.request_results.map((value) => {
			if (value === 'success') {
				return `(${debug_log_status_sql(200, 299)} OR ${result_expr} IN ('success', 'ok'))`;
			}
			if (value === 'warning') {
				return `(${debug_log_status_sql(300, 399)} OR ${result_expr} IN ('warning', 'notice', 'redirect', 'redirection'))`;
			}
			if (value === 'error') {
				return `(${debug_log_status_sql(400, 599)} OR ${result_expr} IN ('error', 'danger'))`;
			}
			params.push(value);
			return `${result_expr} = $${params.length}`;
		});
		clauses.push(`(${branches.join(' OR ')})`);
	}
	return clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
}

export type DebugLogRelatedLookup = {
	routes: string[];
	method: string;
	status_code?: number;
	created_after?: string;
	created_before?: string;
};

/**
 * Lookup de un request log. Ruta/método/status/ventana en SQL.
 * El caller hidrata ≤ 10 filas; no el universo.
 */
export function debug_log_related_sql(lookup: DebugLogRelatedLookup, params: unknown[]): string {
	const clauses: string[] = [];
	params.push('error', 'request');
	clauses.push(`${debug_payload_expr('level')} IN ($${params.length - 1}, $${params.length})`);
	if (lookup.created_after) {
		params.push(lookup.created_after);
		clauses.push(`created_at >= $${params.length}`);
	}
	if (lookup.created_before) {
		params.push(lookup.created_before);
		clauses.push(`created_at <= $${params.length}`);
	}
	const routes = lookup.routes.filter((route) => route.length > 0).slice(0, 8);
	if (routes.length) {
		const marks = routes.map((route) => {
			params.push(route);
			return `$${params.length}`;
		});
		clauses.push(`${debug_payload_expr('request_context.route')} IN (${marks.join(', ')})`);
	}
	if (lookup.method) {
		params.push(lookup.method);
		clauses.push(`upper(${debug_payload_expr('request_context.method')}) = $${params.length}`);
	}
	if (lookup.status_code != null) {
		params.push(String(lookup.status_code));
		clauses.push(`${debug_payload_expr('request_context.response.status_code')} = $${params.length}`);
	}
	return clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
}

/**
 * SELECT de lista UI: columnas físicas de la proyección + payload recortado.
 * Sin spec (recurso desconocido) → null, el caller usa `*`.
 */
export function list_select_sql(resource: string, cols: Set<string>): string | null {
	const keys = list_projection_keys(resource);
	if (!keys.length) return null;
	const wanted = new Set<string>(keys);
	for (const key of LIST_SQL_ALWAYS_PAYLOAD) wanted.add(key);
	const canonical = RESOURCE_ALIASES[resource] ?? resource;
	for (const key of LIST_SQL_DECORATE_PAYLOAD[resource] ?? LIST_SQL_DECORATE_PAYLOAD[canonical] ?? []) {
		wanted.add(key);
	}
	for (const field of Object.keys(field_map_for(resource) ?? {})) {
		wanted.add(field);
		wanted.add(`${field}_id`);
	}
	const physical: string[] = [];
	const seen = new Set<string>();
	for (const col of LIST_SQL_ALWAYS_PHYSICAL) {
		if (!cols.has(col)) continue;
		if (col === 'name' && cols.has('payload')) {
			physical.push(
				`COALESCE(NULLIF(${qident('name')}, ''), (${payload_list_expr()}) ->> 'name') AS name`,
			);
		} else {
			physical.push(qident(col));
		}
		seen.add(col);
	}
	const payload_keys: string[] = [];
	const seen_payload = new Set<string>();
	const consider = (key: string) => {
		const physical_name = physical_list_name(key);
		if (physical_name === 'payload' || physical_name === 'custom_data') return;
		if (cols.has(physical_name)) {
			if (seen.has(physical_name)) return;
			physical.push(qident(physical_name));
			seen.add(physical_name);
			return;
		}
		if (seen_payload.has(physical_name)) return;
		seen_payload.add(physical_name);
		payload_keys.push(physical_name);
	};
	for (const key of wanted) consider(key);
	if (cols.has('payload')) {
		const literals = payload_keys
			.filter((key) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
			.map((key) => `'${key}'`)
			.join(', ');
		physical.push(
			literals
				? `(SELECT COALESCE(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
					FROM jsonb_each(${payload_list_expr()}) e
					WHERE e.key IN (${literals})) AS payload`
				: `'{}'::jsonb AS payload`,
		);
	}
	return physical.length ? physical.join(', ') : null;
}

const POPULATE_LITE_PHYSICAL = ['id', 'name', 'description', 'is_active', 'ref'] as const;

/**
 * SELECT de refs para lista: id + name. flatten_list_docs tira el resto.
 * `name` físico vacío (migración) se completa desde payload, igual que
 * `list_select_sql`; si no, el filtro de asignado lista ids.
 */
export function populate_lite_select_sql(cols: Set<string>): string {
	const physical: string[] = [];
	for (const col of POPULATE_LITE_PHYSICAL) {
		if (!cols.has(col)) continue;
		if (col === 'name' && cols.has('payload')) {
			physical.push(
				`COALESCE(NULLIF(${qident('name')}, ''), (${payload_list_expr()}) ->> 'name') AS name`,
			);
		} else {
			physical.push(qident(col));
		}
	}
	if (cols.has('payload')) {
		physical.push(`(SELECT COALESCE(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
			FROM jsonb_each(${payload_list_expr()}) e
			WHERE e.key IN ('name')) AS payload`);
	}
	return physical.length ? physical.join(', ') : '*';
}

/**
 * SELECT de un barrido que solo necesita unas claves: id + keyset + payload recortado.
 */
export function scan_select_sql(cols: Set<string>, keys: string[]): string {
	const physical: string[] = [];
	const seen = new Set<string>();
	for (const col of ['id', 'created_at', 'fecha_entrada', 'is_active'] as const) {
		if (!cols.has(col)) continue;
		physical.push(qident(col));
		seen.add(col);
	}
	const payload_keys: string[] = [];
	const seen_payload = new Set<string>();
	for (const key of keys) {
		const root = key.split('.')[0] ?? key;
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(root)) continue;
		const physical_name = physical_list_name(root);
		if (cols.has(physical_name)) {
			if (seen.has(physical_name)) continue;
			physical.push(qident(physical_name));
			seen.add(physical_name);
			continue;
		}
		if (seen_payload.has(physical_name)) continue;
		seen_payload.add(physical_name);
		payload_keys.push(physical_name);
	}
	if (cols.has('payload')) {
		const literals = payload_keys.map((key) => `'${key}'`).join(', ');
		physical.push(
			literals
				? `(SELECT COALESCE(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
					FROM jsonb_each(${payload_list_expr()}) e
					WHERE e.key IN (${literals})) AS payload`
				: `'{}'::jsonb AS payload`,
		);
	}
	return physical.length ? physical.join(', ') : '*';
}

/**
 * SELECT de un barrido que debe devolver el set salvo unas claves
 * pesadas (lotes, markdown, …). Columnas físicas + payload sin esas keys.
 */
export function scan_omit_sql(cols: Set<string>, omit: string[]): string {
	const banned = new Set<string>();
	for (const key of omit) {
		const root = key.split('.')[0] ?? key;
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(root)) continue;
		banned.add(physical_list_name(root));
	}
	const physical: string[] = [];
	for (const col of cols) {
		if (col === 'payload') continue;
		if (banned.has(col)) continue;
		physical.push(qident(col));
	}
	if (cols.has('payload')) {
		const literals = [...banned].map((key) => `'${key}'`).join(', ');
		physical.push(
			literals
				? `(SELECT COALESCE(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
					FROM jsonb_each(${payload_list_expr()}) e
					WHERE e.key NOT IN (${literals})) AS payload`
				: 'payload',
		);
	}
	return physical.length ? physical.join(', ') : '*';
}

/** Recursos del chat sin app en el catálogo: viven bajo `configuracion`, como `messages`. */
const CHAT_ORPHANS = [
	'chat-conversations',
	'chat-members',
	'chat-reactions',
	'chat-audit',
	'chat-scheduled',
	'chat-saved',
	'chat-stories',
	'chat-story-views',
	'chat-calls',
	'chat-meetings',
	'chat-meeting-attendance',
	'chat-meeting-questions',
	'chat-meeting-transcripts',
];

const physical_cols = (types: Record<string, 'text' | 'real'>): ExtraCol[] =>
	Object.entries(types).map(([name, pg]) => ({ name, pg }));

/** Lo que el chat filtra, ordena o hace único va en columna, no en `payload`. */
const ORPHAN_COLUMNS: Record<string, ExtraCol[]> = {
	'user-settings': [
		{
			name: 'table_configs',
			mongo: 'table_configs',
			pg: 'json',
			crud: 'json',
			component: 'input-json',
			label: 'table configs',
		},
	],
	messages: physical_cols({
		conversation_id: 'text',
		seq: 'real',
		sender_user_id: 'text',
		client_id: 'text',
		kind: 'text',
		expires_at: 'text',
	}),
	'chat-conversations': physical_cols({
		kind: 'text',
		conversation_key: 'text',
		last_seq: 'real',
		last_message_at: 'text',
		join_code: 'text',
	}),
	'chat-members': physical_cols({
		conversation_id: 'text',
		user_id: 'text',
		role: 'text',
		last_read_seq: 'real',
		public_read_seq: 'real',
		delivered_seq: 'real',
	}),
	'chat-reactions': physical_cols({
		message_id: 'text',
		conversation_id: 'text',
		user_id: 'text',
		kind: 'text',
		value: 'text',
	}),
	'chat-audit': physical_cols({ conversation_id: 'text', message_id: 'text', actor_id: 'text', action: 'text' }),
	'chat-scheduled': physical_cols({ conversation_id: 'text', sender_user_id: 'text', send_at: 'text' }),
	'chat-saved': physical_cols({ user_id: 'text', message_id: 'text', remind_at: 'text' }),
	'chat-stories': physical_cols({ author_id: 'text', expires_at: 'text' }),
	'chat-story-views': physical_cols({ story_id: 'text', viewer_id: 'text', viewed_at: 'text' }),
	'chat-calls': physical_cols({
		conversation_id: 'text',
		meeting_id: 'text',
		kind: 'text',
		started_at: 'text',
		ended_at: 'text',
	}),
	'chat-meetings': physical_cols({ code: 'text', host_id: 'text', next_start_at: 'text' }),
	'chat-meeting-attendance': physical_cols({ call_id: 'text', meeting_id: 'text', participant_key: 'text' }),
	'chat-meeting-questions': physical_cols({ call_id: 'text', meeting_id: 'text' }),
	'chat-meeting-transcripts': physical_cols({ call_id: 'text', meeting_id: 'text', seq: 'real' }),
};

export class ImperiumStore {
	readonly locs = new Map<string, ModuleLoc>();
	readonly all_locs: ModuleLoc[] = [];
	readonly subjects: SubjectInfo[] = [];
	/**
	 * Technical ids de las apps instaladas. `null` hasta la primera carga:
	 * mientras tanto todo cuenta como instalado, como antes de este caché.
	 */
	private installed_subjects: Set<string> | null = null;

	constructor(
		private readonly sql: Bun.SQL,
		catalog_path: string,
	) {
		const catalog = JSON.parse(readFileSync(catalog_path, 'utf8')) as {
			subjects: Array<{
				slug: string;
				name?: string;
				path?: string;
				menu_ref?: string;
				technical_id: string;
				image?: string;
				depends_on?: string[];
				modules?: Array<{
					resource: string;
					table: string;
					collection: string;
					name: string;
					path?: string;
					menu_ref?: string;
					icon?: string;
					columns?: ExtraCol[];
				}>;
				menus?: Array<{
					menu_ref: string;
					name: string;
					path?: string;
					icon: string;
					parent_ref?: string;
					resources?: string[];
				}>;
			}>;
		};
		for (const s of catalog.subjects) {
			this.subjects.push({
				slug: s.slug,
				name: s.name ?? s.slug,
				path: s.path ?? '',
				menu_ref: s.menu_ref ?? `${s.slug}-menu-root`,
				technical_id: s.technical_id ?? `subject-${s.slug}`,
				image: s.image ?? '',
				depends_on: [...(s.depends_on ?? [])],
				modules: (s.modules ?? []).map((m) => ({
					resource: m.resource,
					path: m.path ?? `/${m.resource}`,
					menu_ref: m.menu_ref ?? '',
					name: m.name,
					icon: m.icon,
				})),
				menus: s.menus,
			});
			for (const m of s.modules ?? []) {
				const loc: ModuleLoc = {
					slug: s.slug,
					technical_id: s.technical_id,
					resource: m.resource,
					table: m.table,
					collection: m.collection,
					name: m.name,
					columns: m.columns ?? [],
				};
				this.all_locs.push(loc);
				const prefer = PREFER_OWNER[m.resource];
				if (prefer && prefer !== s.slug && this.locs.has(m.resource)) continue;
				if (!this.locs.has(m.resource) || prefer === s.slug) {
					this.locs.set(m.resource, loc);
				}
			}
		}
		for (const [alias, resource] of Object.entries(RESOURCE_ALIASES)) {
			const loc = this.locs.get(resource);
			if (loc && !this.locs.has(alias)) this.locs.set(alias, loc);
		}
		const host =
			this.all_locs.find((l) => l.slug === 'configuracion') ?? this.all_locs[0];
		if (host) {
			const orphans = [
				'messages',
				'notifications',
				'mentions',
				'user-settings',
				'custom-user-themes',
				'documentation-page',
				'document-change-history',
				'interactive-manual',
				'cobranza-payment',
				'module-management-reference',
				'font-awesome-icon-catalog',
				'mcp-user-token',
				'proyectos-time-log',
				'user-print-template',
				'time-sheets',
				...CHAT_ORPHANS,
			];
			for (const resource of orphans) {
				if (this.locs.has(resource)) continue;
				const loc: ModuleLoc = {
					slug: host.slug,
					technical_id: host.technical_id,
					resource,
					table: resource.replace(/-/g, '_'),
					collection: resource,
					name: resource,
					columns: [...(ORPHAN_COLUMNS[resource] ?? [])],
				};
				this.all_locs.push(loc);
				this.locs.set(resource, loc);
			}
			const icons = this.locs.get('font-awesome-icon-catalog');
			if (icons) icons.collection = '__font_awesome_icon_catalog';
			const print_templates = this.locs.get('user-print-template');
			if (print_templates) print_templates.collection = '__plantillas_de_usuario';
			const time_logs = this.locs.get('proyectos-time-log');
			if (time_logs) {
				const planeacion = this.all_locs.find((l) => l.slug === 'planeacion');
				if (planeacion) {
					time_logs.slug = planeacion.slug;
					time_logs.technical_id = planeacion.technical_id;
				}
				time_logs.table = 'proyectos_time_log';
				time_logs.collection = 'proyectos-time-log';
			}
			const time_sheets = this.locs.get('time-sheets');
			if (time_sheets) time_sheets.collection = '__time_sheets';
			const tokens = this.locs.get('mcp-user-token');
			if (tokens) tokens.collection = 'mcp_user_tokens';
			for (const [alias, resource] of Object.entries(RESOURCE_ALIASES)) {
				const loc = this.locs.get(resource);
				if (loc && !this.locs.has(alias)) this.locs.set(alias, loc);
			}
		}
	}

	async ensure_search_indexes(): Promise<void> {
		try {
			await this.sql.unsafe('CREATE EXTENSION IF NOT EXISTS pg_trgm');
		} catch {
			return;
		}
		for (const loc of this.locs.values()) {
			const idx = `trgm_${loc.table}_search`.slice(0, 63);
			try {
				await this.sql.unsafe(
					`CREATE INDEX IF NOT EXISTS ${qident(idx)} ON ${this.qt(loc.resource)} USING gin (${qident('search_field')} gin_trgm_ops)`,
				);
			} catch {
				/* table may not exist yet for some locs */
			}
		}
	}

	async ensure_unique_indexes(): Promise<void> {
		const seen = new Set<string>();
		for (const loc of this.locs.values()) {
			if (seen.has(loc.resource)) continue;
			seen.add(loc.resource);
			const sqls = [
				...unique_index_sqls({
					quoted_table: this.qt(loc.resource),
					table_key: loc.table,
					fields: unique_fields_for(loc.resource),
					composites: unique_composites_for(loc.resource),
					columns: this.column_names(loc.resource),
				}),
				...lookup_index_sqls({
					quoted_table: this.qt(loc.resource),
					table_key: loc.table,
					fields: unique_fields_for(loc.resource),
					columns: this.column_names(loc.resource),
				}),
				...payload_lookup_index_sqls({
					quoted_table: this.qt(loc.resource),
					table_key: loc.table,
					fields: lookup_payload_fields_for(loc.resource),
				}),
				...(loc.resource === 'document-change-history'
					? history_page_index_sqls({
							quoted_table: this.qt(loc.resource),
							table_key: loc.table,
						})
					: []),
				...chat_index_sqls({
					resource: loc.resource,
					quoted_table: this.qt(loc.resource),
					table_key: loc.table,
				}),
			];
			for (const sql of sqls) {
				try {
					await this.sql.unsafe(sql);
				} catch {
					/* tabla o columna aún no existen */
				}
			}
		}
	}

	/**
	 * Lleva los 1:1 legados al modelo de conversaciones: su directo o self, sus miembros y
	 * el `seq` de cada mensaje por `(created_at, id)`. Cada lote entra entero o no entra,
	 * así que se puede cortar y volver a correr: lo ya respaldado deja de ser candidato.
	 */
	async chat_backfill_direct(batch = 500): Promise<{ conversations: number; members: number; messages: number }> {
		const done = { conversations: 0, members: 0, messages: 0 };
		if (!this.has('messages') || !this.has('chat-conversations') || !this.has('chat-members')) return done;
		const sqls = chat_backfill_sqls({
			messages: this.qt('messages'),
			conversations: this.qt('chat-conversations'),
			members: this.qt('chat-members'),
		});
		for (;;) {
			const pending = (await this.sql.unsafe(sqls.pending_keys, [batch])) as Array<{ key: string }>;
			if (!pending.length) return done;
			const keys = pending.map((row) => row.key);
			const moved = await this.sql.begin((tx) => backfill_keys(tx, sqls, keys, new Date().toISOString()));
			done.conversations += moved.conversations;
			done.members += moved.members;
			done.messages += moved.messages;
			// Un lote sin avance volvería a salir igual: mejor parar que colgar el arranque.
			if (!moved.messages) return done;
		}
	}

	/** `null`: la conversación ya no existe o está inactiva. Un `client_id` repetido devuelve el ya creado. */
	async chat_insert_message(input: ChatMessageInsert): Promise<{ message: ImperiumDoc; duplicate: boolean } | null> {
		const binds = input.attachment_ids.length > 0;
		const sql = chat_insert_message_sql({
			messages: this.qt('messages'),
			conversations: this.qt('chat-conversations'),
			members: this.qt('chat-members'),
			attachments: binds ? this.qt('attachment-management') : null,
		});
		const params: unknown[] = [
			input.id,
			input.conversation_id,
			input.now,
			input.preview,
			input.name,
			input.sender_user_id,
			input.search_field,
			input.payload,
			input.client_id,
			input.kind,
			input.expires_at,
			input.share_read,
			input.reader_user_id ?? null,
		];
		if (binds) params.push(input.attachment_ids, input.uploads_from ?? null);
		try {
			const rows = await this.sql.unsafe(sql, params);
			const row = rows[0] as Record<string, unknown> | undefined;
			return row ? { message: this.flatten(row, 'messages')!, duplicate: false } : null;
		} catch (err) {
			if (!input.client_id || !input.sender_user_id || !is_unique_violation(err)) throw err;
			const existing = await this.chat_message_by_client_id(input.sender_user_id, input.client_id);
			if (!existing) throw err;
			return { message: existing, duplicate: true };
		}
	}

	async chat_message_by_client_id(sender_user_id: string, client_id: string): Promise<ImperiumDoc | null> {
		const rows = await this.sql.unsafe(
			`SELECT * FROM ${this.qt('messages')} WHERE sender_user_id = $1 AND client_id = $2 LIMIT 1`,
			[sender_user_id, client_id],
		);
		return this.flatten((rows[0] as Record<string, unknown>) ?? null, 'messages');
	}

	/** `conversation_key`: los ids ordenados unidos con `::` (uno solo en el self). */
	async chat_open_direct(input: {
		conversation_key: string;
		user_ids: string[];
		created_by: string;
		now: string;
	}): Promise<ImperiumDoc> {
		const sqls = chat_direct_sqls({
			conversations: this.qt('chat-conversations'),
			members: this.qt('chat-members'),
		});
		const conversation = {
			createdById: input.created_by,
			memberCount: input.user_ids.length,
			participantUserIds: input.user_ids,
			settings: DIRECT_CONVERSATION_SETTINGS,
			pins: [],
			invites: [],
		};
		const member = {
			joinedAt: input.now,
			visibleFromSeq: 0,
			mentionSeqs: [],
			markedUnread: false,
			archived: false,
			notifyLevel: 'default',
		};
		const kind = input.user_ids.length > 1 ? 'direct' : 'self';
		const backfill = chat_backfill_sqls({
			messages: this.qt('messages'),
			conversations: this.qt('chat-conversations'),
			members: this.qt('chat-members'),
		});
		const row = await this.sql.begin(async (tx) => {
			const created = await tx.unsafe(sqls.conversation, [
				crypto.randomUUID().replace(/-/g, '').slice(0, 24),
				kind,
				input.conversation_key,
				conversation,
				input.now,
			]);
			// El arranque tolera un respaldo a medias: lo legado de esta llave toma los primeros `seq`
			// antes de que un envío nuevo pueda llegar a la conversación.
			if (created.length && (await tx.unsafe(backfill.key_pending, [input.conversation_key])).length) {
				await backfill_keys(tx, backfill, [input.conversation_key], input.now);
			}
			const [found] = (await tx.unsafe(sqls.find, [input.conversation_key])) as Array<Record<string, unknown>>;
			await tx.unsafe(sqls.members, [found!.id, input.user_ids, member, input.now]);
			return found!;
		});
		return this.flatten(row, 'chat-conversations')!;
	}

	async chat_member_ids(conversation_id: string): Promise<string[]> {
		const rows = (await this.sql.unsafe(
			`SELECT user_id FROM ${this.qt('chat-members')}
			 WHERE conversation_id = $1 AND state = 'active' AND is_active IS DISTINCT FROM false`,
			[conversation_id],
		)) as Array<{ user_id: string }>;
		return rows.map((row) => row.user_id);
	}

	/** Los miembros activos con el seq desde el que ven el historial. */
	async chat_member_visibility(conversation_id: string): Promise<Array<{ user_id: string; visible_from: number }>> {
		return (await this.sql.unsafe(
			`SELECT user_id, COALESCE((payload ->> 'visibleFromSeq')::numeric, 0)::float8 AS visible_from
			 FROM ${this.qt('chat-members')}
			 WHERE conversation_id = $1 AND state = 'active' AND is_active IS DISTINCT FROM false`,
			[conversation_id],
		)) as Array<{ user_id: string; visible_from: number }>;
	}

	/** Devuelve a quiénes les avanzó la marca de entregado. */
	async chat_mark_delivered(conversation_id: string, user_ids: string[], seq: number): Promise<string[]> {
		if (!user_ids.length) return [];
		const rows = (await this.sql.unsafe(
			`UPDATE ${this.qt('chat-members')} SET delivered_seq = $3
			 WHERE conversation_id = $1 AND user_id IN (SELECT jsonb_array_elements_text($2::jsonb))
			   AND state = 'active' AND COALESCE(delivered_seq, 0) < $3
			 RETURNING user_id`,
			[conversation_id, user_ids, seq],
		)) as Array<{ user_id: string }>;
		return rows.map((row) => row.user_id);
	}

	/** Lo que una vista del chat muestra de una persona; nunca el documento de usuario. */
	async chat_users_brief(ids: string[]): Promise<ChatUserBrief[]> {
		const wanted = [...new Set(ids.filter(Boolean))];
		if (!wanted.length || !this.has('user')) return [];
		const rows = (await this.sql.unsafe(
			`SELECT id, name, email, img, is_active FROM ${this.qt('user')}
			 WHERE id IN (SELECT jsonb_array_elements_text($1::jsonb))`,
			[wanted],
		)) as Array<Record<string, unknown>>;
		return rows.map((row) => ({
			_id: String(row.id),
			name: String(row.name ?? ''),
			...(row.email ? { email: String(row.email) } : {}),
			...(row.img ? { img: String(row.img) } : {}),
			is_active: row.is_active !== false,
		}));
	}

	async chat_upload_by_client_id(owner_id: string, client_upload_id: string): Promise<ImperiumDoc | null> {
		const rows = await this.sql.unsafe(
			`SELECT * FROM ${this.qt('attachment-management')}
			 WHERE created_by_id = $1 AND payload #>> '{chatUpload,clientUploadId}' = $2
			   AND payload -> 'chatUpload' IS NOT NULL AND is_active IS DISTINCT FROM false
			 LIMIT 1`,
			[owner_id, client_upload_id],
		);
		return this.flatten((rows[0] as Record<string, unknown>) ?? null, 'attachment-management');
	}

	/** `chat_preferences.privacy` de `user-settings`; vacío si el usuario nunca lo guardó. */
	async chat_privacy(user_id: string): Promise<Record<string, unknown>> {
		if (!this.has('user-settings')) return {};
		const rows = (await this.sql.unsafe(
			`SELECT payload #> '{chat_preferences,privacy}' AS privacy FROM ${this.qt('user-settings')}
			 WHERE payload ->> 'user_id' = $1 AND ${SETTINGS_OWNER} ORDER BY id LIMIT 1`,
			[user_id],
		)) as Array<{ privacy: unknown }>;
		return as_object(rows[0]?.privacy);
	}

	/** `chat_preferences.privacy` y `presence_status` de varios usuarios en una consulta; sin fila, no salen. */
	async chat_privacy_many(
		user_ids: string[],
	): Promise<Map<string, { privacy: Record<string, unknown>; presence_status: string }>> {
		const wanted = [...new Set(user_ids.filter(Boolean))];
		const out = new Map<string, { privacy: Record<string, unknown>; presence_status: string }>();
		if (!wanted.length || !this.has('user-settings')) return out;
		const rows = (await this.sql.unsafe(
			`SELECT DISTINCT ON (payload ->> 'user_id') payload ->> 'user_id' AS user_id,
				payload #> '{chat_preferences,privacy}' AS privacy,
				payload #>> '{chat_preferences,presence_status}' AS presence_status
			 FROM ${this.qt('user-settings')}
			 WHERE payload ->> 'user_id' IN (SELECT jsonb_array_elements_text($1::jsonb)) AND ${SETTINGS_OWNER}
			 ORDER BY payload ->> 'user_id', id`,
			[wanted],
		)) as Array<{ user_id: string; privacy: unknown; presence_status: string | null }>;
		for (const row of rows) {
			out.set(row.user_id, { privacy: as_object(row.privacy), presence_status: row.presence_status ?? '' });
		}
		return out;
	}

	/** La nueva marca de entregado, o `null` si no avanzó (o ya no es miembro activo). */
	async chat_mark_delivered_up_to(conversation_id: string, user_id: string, seq: number): Promise<number | null> {
		const [row] = (await this.sql.unsafe(
			chat_delivered_up_to_sql({ conversations: this.qt('chat-conversations'), members: this.qt('chat-members') }),
			[conversation_id, user_id, seq],
		)) as Array<{ delivered_seq: number }>;
		return row ? Number(row.delivered_seq) : null;
	}

	/** Filas en orden ascendente; `more` dice si quedaban más en la dirección pedida. */
	async chat_message_page(input: {
		conversation_id: string;
		visible_from: number;
		viewer_id: string;
		limit: number;
		direction: ChatPageDirection;
		seq?: number;
		user_only?: boolean;
	}): Promise<{ rows: ImperiumDoc[]; more: boolean }> {
		const params: unknown[] = [input.conversation_id, input.visible_from, input.limit + 1];
		if (input.direction !== 'tail') params.push(input.seq);
		params.push(input.viewer_id);
		const rows = (await this.sql.unsafe(
			chat_message_page_sql(this.qt('messages'), input.direction, input.user_only),
			params,
		)) as Array<Record<string, unknown>>;
		const page = rows.slice(0, input.limit).map((row) => this.flatten(row, 'messages')!);
		if (input.direction === 'tail' || input.direction === 'before') page.reverse();
		return { rows: page, more: rows.length > input.limit };
	}

	/** El último mensaje de una persona en cada conversación; cada uno lo sirve `(conversation_id, seq)`. */
	async chat_latest_user_messages(conversation_ids: string[]): Promise<ImperiumDoc[]> {
		if (!conversation_ids.length) return [];
		const rows = (await this.sql.unsafe(
			`SELECT m.* FROM (SELECT jsonb_array_elements_text($1::jsonb) AS id) c
			 CROSS JOIN LATERAL (
				SELECT * FROM ${this.qt('messages')}
				WHERE conversation_id = c.id AND is_active IS DISTINCT FROM false AND ${USER_KIND_SQL}
				ORDER BY seq DESC LIMIT 1
			 ) m`,
			[conversation_ids],
		)) as Array<Record<string, unknown>>;
		return rows.map((row) => this.flatten(row, 'messages')!);
	}

	async chat_changed_messages(input: {
		conversation_id: string;
		visible_from: number;
		viewer_id: string;
		up_to_seq: number;
		since: string;
		limit: number;
	}): Promise<{ rows: ImperiumDoc[]; more: boolean }> {
		const rows = (await this.sql.unsafe(chat_changed_messages_sql(this.qt('messages')), [
			input.conversation_id,
			input.visible_from,
			input.up_to_seq,
			input.since,
			input.limit + 1,
			input.viewer_id,
		])) as Array<Record<string, unknown>>;
		return {
			rows: rows.slice(0, input.limit).map((row) => this.flatten(row, 'messages')!),
			more: rows.length > input.limit,
		};
	}

	/** `ChatReactionView[]` por mensaje. */
	async chat_reaction_summary(message_ids: string[], viewer_id: string): Promise<Map<string, ImperiumDoc[]>> {
		const out = new Map<string, ImperiumDoc[]>();
		if (!message_ids.length || !this.has('chat-reactions')) return out;
		const rows = (await this.sql.unsafe(chat_reaction_summary_sql(this.qt('chat-reactions')), [
			message_ids,
			viewer_id,
		])) as Array<Record<string, unknown>>;
		for (const row of rows) {
			const id = String(row.message_id);
			out.set(id, [
				...(out.get(id) ?? []),
				{
					emoji: String(row.emoji),
					count: Number(row.count),
					mine: row.mine === true,
					sample_user_ids: as_array(row.sample_user_ids).map(String),
				},
			]);
		}
		return out;
	}

	async chat_conversation_page(query: ChatInboxQuery): Promise<ChatInboxRow[]> {
		const { sql, params } = chat_inbox_sql(
			{ conversations: this.qt('chat-conversations'), members: this.qt('chat-members') },
			query,
		);
		const rows = (await this.sql.unsafe(sql, params)) as Array<Record<string, unknown>>;
		return rows.map((row) => {
			const {
				member_id,
				member_role,
				member_state,
				last_read_seq,
				public_read_seq,
				delivered_seq,
				member_payload,
				member_updated_at,
				activity_at,
				unread_count,
				unread_mention_seqs,
				...conversation
			} = row;
			return {
				conversation: this.flatten(conversation, 'chat-conversations')!,
				member: {
					...as_object(member_payload),
					_id: String(member_id),
					role: member_role,
					state: member_state,
					last_read_seq: Number(last_read_seq ?? 0),
					public_read_seq: Number(public_read_seq ?? 0),
					delivered_seq: Number(delivered_seq ?? 0),
					updated_at: member_updated_at,
				},
				activity_at: String(activity_at),
				unread_count: Number(unread_count),
				unread_mention_seqs: as_array(unread_mention_seqs).map(Number),
			};
		});
	}

	async chat_inbox_counts(user_id: string, now: string): Promise<Record<string, number>> {
		const [row] = (await this.sql.unsafe(
			chat_inbox_counts_sql({
				conversations: this.qt('chat-conversations'),
				members: this.qt('chat-members'),
				mentions: this.qt('mentions'),
			}),
			[user_id, now],
		)) as Array<Record<string, unknown>>;
		return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value)]));
	}

	/** `null` si el usuario ya no es miembro activo. */
	async chat_mark_read(input: {
		conversation_id: string;
		user_id: string;
		seq: number;
		share_read: boolean;
		now: string;
	}): Promise<ChatReadResult | null> {
		const [row] = (await this.sql.unsafe(
			chat_mark_read_sql({ conversations: this.qt('chat-conversations'), members: this.qt('chat-members') }),
			[input.conversation_id, input.user_id, input.seq, input.share_read, input.now],
		)) as Array<Record<string, unknown>>;
		if (!row) return null;
		return {
			last_read_seq: Number(row.last_read_seq ?? 0),
			public_read_seq: Number(row.public_read_seq ?? 0),
			delivered_seq: Number(row.delivered_seq ?? 0),
			last_seq: Number(row.last_seq ?? 0),
			mention_seqs: as_array(row.mention_seqs).map(Number),
		};
	}

	/** `false` si el usuario ya no es miembro activo. */
	async chat_mark_unread(conversation_id: string, user_id: string, now: string): Promise<boolean> {
		const rows = await this.sql.unsafe(
			`UPDATE ${this.qt('chat-members')}
			 SET payload = COALESCE(payload, '{}'::jsonb) || '{"markedUnread": true}'::jsonb, updated_at = $3
			 WHERE conversation_id = $1 AND user_id = $2 AND state = 'active'
			 RETURNING id`,
			[conversation_id, user_id, now],
		);
		return rows.length > 0;
	}

	/** Quiénes no comparten acuses de lectura: tampoco ven los ajenos. */
	async chat_receipts_off(user_ids: string[]): Promise<Set<string>> {
		if (!user_ids.length || !this.has('user-settings')) return new Set();
		const rows = (await this.sql.unsafe(
			`SELECT payload ->> 'user_id' AS user_id FROM ${this.qt('user-settings')}
			 WHERE payload ->> 'user_id' IN (SELECT jsonb_array_elements_text($1::jsonb)) AND ${SETTINGS_OWNER}
			   AND payload #> '{chat_preferences,privacy,read_receipts}' = 'false'::jsonb`,
			[user_ids],
		)) as Array<{ user_id: string }>;
		return new Set(rows.map((row) => row.user_id));
	}

	async chat_read_marks(conversation_id: string): Promise<ChatReadMarks[]> {
		const rows = (await this.sql.unsafe(
			`SELECT user_id, last_read_seq, public_read_seq, delivered_seq FROM ${this.qt('chat-members')}
			 WHERE conversation_id = $1 AND state = 'active' AND is_active IS DISTINCT FROM false
			 ORDER BY user_id`,
			[conversation_id],
		)) as Array<Record<string, unknown>>;
		return rows.map((row) => ({
			user_id: String(row.user_id),
			last_read_seq: Number(row.last_read_seq ?? 0),
			public_read_seq: Number(row.public_read_seq ?? 0),
			delivered_seq: Number(row.delivered_seq ?? 0),
		}));
	}

	async chat_mark_inbox_delivered(
		user_id: string,
		conversation_ids: string[],
	): Promise<Array<{ conversation_id: string; seq: number; member_ids: string[] }>> {
		if (!conversation_ids.length) return [];
		const rows = (await this.sql.unsafe(
			chat_inbox_delivered_sql({ conversations: this.qt('chat-conversations'), members: this.qt('chat-members') }),
			[user_id, conversation_ids],
		)) as Array<Record<string, unknown>>;
		return rows.map((row) => ({
			conversation_id: String(row.conversation_id),
			seq: Number(row.seq),
			member_ids: as_array(row.member_ids).map(String),
		}));
	}

	private chat_mutation_tables() {
		return {
			messages: this.qt('messages'),
			conversations: this.qt('chat-conversations'),
			audit: this.qt('chat-audit'),
			saved: this.qt('chat-saved'),
			members: this.qt('chat-members'),
		};
	}

	/** `null`: el mensaje no existe, está inactivo o ya tiene lápida. */
	async chat_edit_message(input: ChatEditInput): Promise<ChatMessageChange | null> {
		const [row] = (await this.sql.unsafe(chat_edit_message_sql(this.chat_mutation_tables()), [
			input.id,
			input.text,
			input.search_field,
			input.now,
			input.merge,
			input.audit_id,
			input.actor_id,
			input.preview,
		])) as Array<Record<string, unknown>>;
		if (!row) return null;
		const { conversation_last_message, ...message } = row;
		return {
			message: this.flatten(message, 'messages')!,
			last_message: conversation_last_message ? as_object(conversation_last_message) : null,
			quoting: [],
		};
	}

	/** `null`: el mensaje no existe, está inactivo o ya tiene lápida. */
	async chat_delete_message(input: ChatDeleteInput): Promise<ChatMessageChange | null> {
		const [row] = (await this.sql.unsafe(chat_delete_message_sql(this.chat_mutation_tables()), [
			input.id,
			input.now,
			input.deleted,
			input.audit_id,
			input.actor_id,
			input.action,
			input.target_user_id,
		])) as Array<Record<string, unknown>>;
		if (!row) return null;
		const { conversation_last_message, quoting, ...message } = row;
		return {
			message: this.flatten(message, 'messages')!,
			last_message: conversation_last_message ? as_object(conversation_last_message) : null,
			quoting: as_array(quoting).map((item) => {
				const quote = as_object(item);
				return {
					id: String(quote.id),
					seq: Number(quote.seq),
					rev: Number(quote.rev) || 0,
					reply_preview: as_object(quote.reply_preview),
					updated_at: String(quote.updated_at),
				};
			}),
		};
	}

	/** `null`: el mensaje ya no está vivo. `on` sin valor conmuta. */
	async chat_toggle_reaction(input: {
		message_id: string;
		user_id: string;
		emoji: string;
		on?: boolean;
		/** Emojis distintos por persona y mensaje. */
		limit: number;
		now: string;
	}): Promise<ChatReactionToggle | null> {
		const sqls = chat_reaction_sqls({ messages: this.qt('messages'), reactions: this.qt('chat-reactions') });
		return this.sql.begin(async (tx): Promise<ChatReactionToggle | null> => {
			const [locked] = (await tx.unsafe(sqls.lock, [input.message_id])) as Array<Record<string, unknown>>;
			if (!locked) return null;
			const mine = ((await tx.unsafe(sqls.mine, [input.message_id, input.user_id])) as Array<{ value: string }>).map(
				(row) => row.value,
			);
			const had = mine.includes(input.emoji);
			const want = input.on ?? !had;
			if (want && !had && mine.length >= input.limit) return { limited: true };
			let changed = false;
			if (want && !had) {
				const added = await tx.unsafe(sqls.add, [
					input.message_id,
					locked.conversation_id,
					input.user_id,
					input.emoji,
					input.now,
				]);
				changed = added.length > 0;
			}
			if (!want && had) changed = (await tx.unsafe(sqls.remove, [input.message_id, input.user_id, input.emoji])).length > 0;
			const [mark] = changed
				? ((await tx.unsafe(sqls.bump, [input.message_id, input.now])) as Array<Record<string, unknown>>)
				: [locked];
			const [counted] = (await tx.unsafe(sqls.count, [input.message_id, input.emoji])) as Array<{ count: number }>;
			return {
				limited: false,
				changed,
				mine: want,
				count: Number(counted.count),
				rev: Number(mark.rev),
				updated_at: String(mark.updated_at ?? ''),
			};
		});
	}

	/**
	 * Reemplaza los votos de una persona (vale el último; `[]` los retira). `null`: la encuesta ya no
	 * está abierta o el mensaje ya no está vivo. Con `final` (cuestionario) la respuesta no cambia.
	 */
	async chat_replace_votes(input: {
		message_id: string;
		user_id: string;
		option_ids: string[];
		final: boolean;
		now: string;
	}): Promise<ChatVoteResult | null> {
		const sqls = chat_vote_sqls({ messages: this.qt('messages'), reactions: this.qt('chat-reactions') });
		return this.sql.begin(async (tx): Promise<ChatVoteResult | null> => {
			const [locked] = (await tx.unsafe(sqls.lock, [input.message_id])) as Array<Record<string, unknown>>;
			if (!locked) return null;
			const mine = ((await tx.unsafe(sqls.mine, [input.message_id, input.user_id])) as Array<{ value: string }>).map(
				(row) => row.value,
			);
			const same = mine.length === input.option_ids.length && input.option_ids.every((id) => mine.includes(id));
			if (input.final && mine.length && !same) return { already_voted: true };
			const dropped = await tx.unsafe(sqls.drop, [input.message_id, input.user_id, input.option_ids]);
			const added = await tx.unsafe(sqls.add, [
				input.message_id,
				locked.conversation_id,
				input.user_id,
				input.option_ids,
				input.now,
			]);
			const changed = dropped.length + added.length > 0;
			const [mark] = changed
				? ((await tx.unsafe(sqls.bump, [input.message_id, input.now])) as Array<Record<string, unknown>>)
				: [locked];
			return { already_voted: false, changed, rev: Number(mark.rev), updated_at: String(mark.updated_at ?? '') };
		});
	}

	/** `null`: ya estaba cerrada, no es una encuesta o el mensaje ya no está vivo. */
	async chat_close_poll(message_id: string, now: string): Promise<ImperiumDoc | null> {
		const [row] = (await this.sql.unsafe(chat_close_poll_sql(this.qt('messages')), [message_id, now])) as Array<
			Record<string, unknown>
		>;
		return this.flatten(row ?? null, 'messages');
	}

	async chat_poll_tally(message_ids: string[], viewer_id: string): Promise<Map<string, ChatPollTally>> {
		const out = new Map<string, ChatPollTally>();
		if (!message_ids.length) return out;
		const rows = (await this.sql.unsafe(chat_poll_tally_sql(this.qt('chat-reactions')), [
			message_ids,
			viewer_id,
		])) as Array<Record<string, unknown>>;
		for (const row of rows) {
			const id = String(row.message_id);
			const tally = out.get(id) ?? { total_voters: 0, options: new Map() };
			if (row.total === true) tally.total_voters = Number(row.votes);
			else {
				tally.options.set(String(row.option_id), {
					votes: Number(row.votes),
					mine: row.mine === true,
					voter_ids: as_array(row.voter_ids).map(String),
				});
			}
			out.set(id, tally);
		}
		return out;
	}

	/** A quiénes les quedó la mención pendiente: miembros activos que aún no leyeron ese `seq`. */
	async chat_add_mention_seqs(conversation_id: string, user_ids: string[], seq: number, now: string): Promise<string[]> {
		if (!user_ids.length) return [];
		const rows = (await this.sql.unsafe(chat_add_mention_seqs_sql(this.qt('chat-members')), [
			conversation_id,
			user_ids,
			seq,
			now,
		])) as Array<{ user_id: string }>;
		return rows.map((row) => row.user_id);
	}

	/** Filas de Actividad (`mentions`) en una sentencia; devuelve el id de cada una con su destinatario. */
	async insert_activity(payloads: ImperiumDoc[]): Promise<Array<{ id: string; user_id: string }>> {
		if (!payloads.length) return [];
		return (await this.sql.unsafe(
			`INSERT INTO ${this.qt('mentions')} (id, name, is_active, payload, created_at, updated_at)
			 SELECT ${NEW_ROW_ID}, 'mención', true, p, $2, $2 FROM jsonb_array_elements($1::jsonb) AS p
			 RETURNING id, payload ->> 'mentionedUserId' AS user_id`,
			[payloads, new Date().toISOString()],
		)) as Array<{ id: string; user_id: string }>;
	}

	/** Quita `seq` de las menciones pendientes de los miembros que no están en `keep_user_ids`. */
	async chat_drop_mention_seq(conversation_id: string, seq: number, keep_user_ids: string[]): Promise<void> {
		await this.sql.unsafe(
			`UPDATE ${this.qt('chat-members')} m SET payload = m.payload || jsonb_build_object('mentionSeqs', COALESCE(
				(SELECT jsonb_agg(s) FROM ${MENTION_SEQS} WHERE (s #>> '{}')::numeric <> $2), '[]'::jsonb))
			 WHERE m.conversation_id = $1 AND m.user_id NOT IN (SELECT jsonb_array_elements_text($3::jsonb))
				AND jsonb_typeof(m.payload -> 'mentionSeqs') = 'array' AND m.payload -> 'mentionSeqs' @> to_jsonb($2::numeric)`,
			[conversation_id, seq, keep_user_ids],
		);
	}

	async chat_activity_page(query: ChatActivityQuery): Promise<ImperiumDoc[]> {
		if (!this.has('mentions')) return [];
		const { sql, params } = chat_activity_page_sql(this.qt('mentions'), query);
		const rows = (await this.sql.unsafe(sql, params)) as Array<Record<string, unknown>>;
		return rows.map((row) => this.flatten(row, 'mentions')!);
	}

	async chat_activity_counts(user_id: string): Promise<Record<'all' | 'chat' | 'history' | 'reactions', number>> {
		const counts = { all: 0, chat: 0, history: 0, reactions: 0 };
		if (!this.has('mentions')) return counts;
		const [row] = (await this.sql.unsafe(chat_activity_counts_sql(this.qt('mentions')), [user_id])) as Array<
			Record<string, unknown>
		>;
		for (const key of Object.keys(counts) as Array<keyof typeof counts>) counts[key] = Number(row[key]);
		return counts;
	}

	/** Sin `ids` ni `context_types`, toda la actividad sin leer de esa persona. */
	async chat_mark_activity_read(input: {
		user_id: string;
		ids?: string[];
		context_types?: string[];
		now: string;
	}): Promise<{ ids: string[]; notification_ids: string[] }> {
		if (!this.has('mentions') || !this.has('notifications')) return { ids: [], notification_ids: [] };
		const rows = (await this.sql.unsafe(
			chat_mark_activity_read_sql({ mentions: this.qt('mentions'), notifications: this.qt('notifications') }),
			[input.user_id, input.ids ?? null, input.context_types ?? null, input.now],
		)) as Array<Record<string, unknown>>;
		return {
			ids: rows.map((row) => String(row.id)),
			notification_ids: as_array(rows[0]?.notification_ids).map(String),
		};
	}

	async chat_retire_activity(input: {
		message_id: string;
		context_type?: string;
		actor_id?: string;
		reaction?: string;
		now: string;
	}): Promise<Array<{ id: string; user_id: string }>> {
		if (!this.has('mentions')) return [];
		const rows = (await this.sql.unsafe(chat_retire_activity_sql(this.qt('mentions')), [
			input.message_id,
			input.context_type ?? null,
			input.actor_id ?? null,
			input.reaction ?? null,
			input.now,
		])) as Array<Record<string, unknown>>;
		return rows.map((row) => ({ id: String(row.id), user_id: String(row.user_id) }));
	}

	/** `false` si ya estaba oculto para esa persona o el mensaje ya no está activo. */
	async chat_hide_message(message_id: string, user_id: string): Promise<boolean> {
		const rows = await this.sql.unsafe(chat_hide_message_sql(this.qt('messages')), [message_id, user_id]);
		return rows.length > 0;
	}

	/** `null`: esa persona ya lo abrió o el mensaje ya no está vivo. */
	async chat_open_view_once(message_id: string, user_id: string, now: string, record_at = true): Promise<ImperiumDoc | null> {
		const [row] = (await this.sql.unsafe(chat_open_view_once_sql(this.qt('messages')), [message_id, user_id, now, record_at])) as Array<
			Record<string, unknown>
		>;
		return this.flatten(row ?? null, 'messages');
	}

	async chat_message_receipts(conversation_id: string, seq: number, sender_id: string | null): Promise<ChatReceipts> {
		const [row] = (await this.sql.unsafe(chat_message_receipts_sql(this.qt('chat-members')), [
			conversation_id,
			seq,
			sender_id,
		])) as Array<Record<string, unknown>>;
		return {
			member_count: Number(row.member_count),
			read_count: Number(row.read_count),
			delivered_count: Number(row.delivered_count),
			read_ids: as_array(row.read_ids).map(String),
			delivered_ids: as_array(row.delivered_ids).map(String),
		};
	}

	private chat_membership() {
		return chat_membership_sqls({ conversations: this.qt('chat-conversations'), members: this.qt('chat-members') });
	}

	/** Un grupo o un canal con sus miembros, en una transacción. */
	async chat_create_group(input: {
		id: string;
		kind: string;
		title: string;
		description: string;
		created_by: string;
		payload: ImperiumDoc;
		members: Array<{ user_id: string; role: string; invited_by?: string }>;
		now: string;
	}): Promise<ImperiumDoc> {
		const sqls = this.chat_membership();
		const row = await this.sql.begin(async (tx) => {
			await tx.unsafe(sqls.group, [
				input.id,
				input.title,
				input.description,
				input.created_by,
				input.kind,
				input.payload,
				input.now,
			]);
			await tx.unsafe(sqls.join, [
				input.id,
				input.members,
				'active',
				0,
				{ joinedAt: input.now, visibleFromSeq: 0, mentionSeqs: [], markedUnread: false },
				input.now,
			]);
			const [counted] = (await tx.unsafe(sqls.count, [input.id, input.now])) as Array<Record<string, unknown>>;
			return counted!;
		});
		return this.flatten(row, 'chat-conversations')!;
	}

	/**
	 * Alta (`active`) o solicitud (`requested`) de personas en un grupo. Quien ya estaba no cambia;
	 * con un baneado o sin cupo no entra nadie. Quien entra ve el historial desde ahí si el grupo
	 * no lo comparte y empieza sin no leídos. Con `invite_id`, el enlace tiene que seguir sirviendo
	 * y gasta un uso solo si alguien entra o pide entrar.
	 */
	async chat_join_members(input: {
		conversation_id: string;
		user_ids: string[];
		state: 'active' | 'requested';
		invited_by?: string;
		max_members: number;
		/** Aprobar: solo entra quien ya pidió entrar. */
		only_requested?: boolean;
		invite_id?: string;
		now: string;
	}): Promise<ChatJoinResult> {
		const sqls = this.chat_membership();
		return this.sql.begin(async (tx): Promise<ChatJoinResult> => {
			const [locked] = (await tx.unsafe(sqls.lock, [input.conversation_id])) as Array<Record<string, unknown>>;
			if (!locked) return { status: 'missing' };
			if (input.invite_id) {
				const invite = as_array(as_object(locked.payload).invites)
					.map(as_object)
					.find((item) => item.id === input.invite_id);
				const state = invite ? invite_state(invite, input.now) : 'revoked';
				if (!invite || state === 'revoked') return { status: 'invite_not_found' };
				if (state !== 'live') return { status: `invite_${state}` };
				// El enlace vale lo que su autor: si ya no está o ya no puede invitar, deja de servir.
				const [creator] = (await tx.unsafe(sqls.current, [input.conversation_id, [String(invite.createdById)]])) as Array<{
					state: string;
					role: string;
				}>;
				const settings = as_object(as_object(locked.payload).settings);
				if (creator?.state !== 'active' || !chat_can(chat_role(creator.role), settings, 'create_invite')) {
					return { status: 'invite_not_found' };
				}
			}
			const current = (await tx.unsafe(sqls.current, [input.conversation_id, input.user_ids])) as Array<{
				user_id: string;
				state: string;
			}>;
			const previous = Object.fromEntries(current.map((row) => [row.user_id, row.state]));
			const banned = input.user_ids.filter((id) => previous[id] === 'banned');
			if (banned.length) return { status: 'banned', user_ids: banned };
			if (input.only_requested && input.user_ids.some((id) => previous[id] !== 'requested')) {
				return { status: 'not_requested' };
			}
			const entering = input.user_ids.filter((id) => previous[id] !== 'active' && previous[id] !== input.state);
			if (!entering.length) {
				return { status: 'ok', conversation: this.flatten(locked, 'chat-conversations')!, joined: [], previous };
			}
			if (input.state === 'active') {
				const [counted] = (await tx.unsafe(sqls.active_count, [input.conversation_id])) as Array<{ n: number }>;
				if (Number(counted.n) + entering.length > input.max_members) return { status: 'full' };
			}
			const last_seq = Number(locked.last_seq) || 0;
			const shares_history = as_object(as_object(locked.payload).settings).historyVisibleToNewMembers !== false;
			const membership =
				input.state === 'active'
					? { joinedAt: input.now, visibleFromSeq: shares_history ? 0 : last_seq, mentionSeqs: [], markedUnread: false }
					: { requestedAt: input.now, mentionSeqs: [], markedUnread: false };
			const joined = await tx.unsafe(sqls.join, [
				input.conversation_id,
				entering.map((user_id) => ({ user_id, invited_by: input.invited_by ?? null })),
				input.state,
				input.state === 'active' ? last_seq : 0,
				membership,
				input.now,
			]);
			if (input.invite_id) await tx.unsafe(sqls.use_invite, [input.conversation_id, input.invite_id, input.now]);
			const [conversation] = (await tx.unsafe(sqls.count, [input.conversation_id, input.now])) as Array<
				Record<string, unknown>
			>;
			return {
				status: 'ok',
				conversation: this.flatten(conversation!, 'chat-conversations')!,
				joined: (joined as Array<Record<string, unknown>>).map((row) => this.flatten(row, 'chat-members')!),
				previous,
			};
		});
	}

	/**
	 * Cambia los enlaces de invitación de un grupo con la conversación bloqueada: `update` recibe los
	 * de ahora y devuelve los nuevos, o `null` si no proceden. El prefijo de los enlaces se fija la
	 * primera vez.
	 */
	async chat_update_invites(input: {
		conversation_id: string;
		join_code: string | null;
		now: string;
		update: (invites: ImperiumDoc[]) => ImperiumDoc[] | null;
	}): Promise<{ status: 'missing' | 'rejected' } | { status: 'ok'; conversation: ImperiumDoc }> {
		const sqls = this.chat_membership();
		return this.sql.begin(async (tx) => {
			const [locked] = (await tx.unsafe(sqls.lock, [input.conversation_id])) as Array<Record<string, unknown>>;
			if (!locked) return { status: 'missing' as const };
			const invites = input.update(as_array(as_object(locked.payload).invites).map(as_object));
			if (!invites) return { status: 'rejected' as const };
			const [row] = (await tx.unsafe(sqls.invites, [input.conversation_id, input.join_code, invites, input.now])) as Array<
				Record<string, unknown>
			>;
			return { status: 'ok' as const, conversation: this.flatten(row!, 'chat-conversations')! };
		});
	}

	/** Como `chat_update_invites`, para los mensajes fijados. */
	async chat_update_pins(input: {
		conversation_id: string;
		now: string;
		update: (pins: ImperiumDoc[]) => ImperiumDoc[] | null;
	}): Promise<{ status: 'missing' | 'rejected' } | { status: 'ok'; conversation: ImperiumDoc }> {
		const sqls = this.chat_membership();
		return this.sql.begin(async (tx) => {
			const [locked] = (await tx.unsafe(sqls.lock, [input.conversation_id])) as Array<Record<string, unknown>>;
			if (!locked) return { status: 'missing' as const };
			const pins = input.update(as_array(as_object(locked.payload).pins).map(as_object));
			if (!pins) return { status: 'rejected' as const };
			const [row] = (await tx.unsafe(sqls.pins, [input.conversation_id, pins, input.now])) as Array<Record<string, unknown>>;
			return { status: 'ok' as const, conversation: this.flatten(row!, 'chat-conversations')! };
		});
	}

	/** Filas del más nuevo al más viejo; `more` dice si quedaban más. */
	async chat_media_page(input: {
		conversation_id: string;
		visible_from: number;
		viewer_id: string;
		type: string;
		before_seq?: number;
		limit: number;
	}): Promise<{ rows: ImperiumDoc[]; more: boolean }> {
		const params: unknown[] = [input.conversation_id, input.visible_from, input.viewer_id, input.type, input.limit + 1];
		if (input.before_seq !== undefined) params.push(input.before_seq);
		const rows = (await this.sql.unsafe(
			chat_media_page_sql(this.qt('messages'), input.before_seq !== undefined),
			params,
		)) as Array<Record<string, unknown>>;
		return {
			rows: rows.slice(0, input.limit).map((row) => this.flatten(row, 'messages')!),
			more: rows.length > input.limit,
		};
	}

	async chat_search(query: ChatSearchQuery): Promise<Array<{ message: ImperiumDoc; conversation_key: string }>> {
		const { sql, params } = chat_search_sql(
			{ messages: this.qt('messages'), members: this.qt('chat-members'), conversations: this.qt('chat-conversations') },
			query,
		);
		const rows = (await this.sql.unsafe(sql, params)) as Array<Record<string, unknown>>;
		return rows.map(({ conversation_key_of, ...message }) => ({
			message: this.flatten(message, 'messages')!,
			conversation_key: String(conversation_key_of ?? ''),
		}));
	}

	async chat_claim_due(job: ChatDueJob, now: string, limit: number): Promise<ImperiumDoc[]> {
		const { resource } = CHAT_DUE_JOBS[job];
		const rows = (await this.sql.unsafe(chat_claim_due_sql(this.qt(resource), job), [now, limit])) as Array<
			Record<string, unknown>
		>;
		return rows.map((row) => this.flatten(row, resource)!);
	}

	/** Sin `ids`, todo lo reclamado de ese trabajo. */
	async chat_release_claims(job: ChatDueJob, ids: string[] | null = null): Promise<number> {
		const { resource } = CHAT_DUE_JOBS[job];
		return (await this.sql.unsafe(chat_release_claims_sql(this.qt(resource), job), [ids])).length;
	}

	async chat_purge_messages(input: { ids: string[]; now: string; legal_hold: boolean }): Promise<ChatPurge> {
		const [row] = (await this.sql.unsafe(
			chat_purge_messages_sql({
				messages: this.qt('messages'),
				conversations: this.qt('chat-conversations'),
				audit: this.qt('chat-audit'),
				reactions: this.qt('chat-reactions'),
				attachments: this.qt('attachment-management'),
				saved: this.qt('chat-saved'),
				members: this.qt('chat-members'),
			}),
			[input.ids, input.now, input.legal_hold],
		)) as Array<Record<string, unknown>>;
		return {
			purged: as_array(row.purged).map((item) => {
				const purged = as_object(item);
				return { id: String(purged.id), conversation_id: String(purged.conversation_id), seq: Number(purged.seq) };
			}),
			quoting: as_array(row.quoting).map((item) => {
				const quote = as_object(item);
				return {
					conversation_id: String(quote.conversation_id),
					id: String(quote.id),
					seq: Number(quote.seq),
					rev: Number(quote.rev) || 0,
					reply_preview: as_object(quote.reply_preview),
					updated_at: String(quote.updated_at),
				};
			}),
			last_messages: as_array(row.last_messages).map((item) => {
				const last = as_object(item);
				return { conversation_id: String(last.conversation_id), last_message: as_object(last.last_message) };
			}),
			files: as_array(row.files).map(String),
		};
	}

	/** Las subidas sin ligar desde antes de `before`, ya dadas de baja. */
	async chat_discard_orphan_uploads(before: string, now: string, limit: number): Promise<Array<{ id: string; name_stored: string }>> {
		const rows = (await this.sql.unsafe(chat_discard_orphan_uploads_sql(this.qt('attachment-management')), [
			before,
			now,
			limit,
		])) as Array<{ id: string; name_stored: string | null }>;
		return rows.map((row) => ({ id: String(row.id), name_stored: String(row.name_stored ?? '') }));
	}

	/** De estos archivos, los que alguna fila de adjunto del chat sigue usando. */
	async chat_files_in_use(names: string[]): Promise<Set<string>> {
		const wanted = [...new Set(names.filter(Boolean))];
		if (!wanted.length) return new Set();
		const rows = (await this.sql.unsafe(
			`SELECT DISTINCT name_stored FROM ${this.qt('attachment-management')}
			 WHERE name_stored IN (SELECT jsonb_array_elements_text($1::jsonb)) AND ${CHAT_FILE_MODELS}
			   AND is_active IS DISTINCT FROM false`,
			[wanted],
		)) as Array<{ name_stored: string }>;
		return new Set(rows.map((row) => row.name_stored));
	}

	/** `false` si alguna ya no estaba libre: entonces no se ligó ninguna. */
	async chat_bind_uploads(ids: string[], owner_id: string, model: string, record_id: string, now: string): Promise<boolean> {
		if (!ids.length) return true;
		const rows = await this.sql.unsafe(chat_bind_uploads_sql(this.qt('attachment-management')), [
			ids,
			owner_id,
			model,
			record_id,
			now,
		]);
		return rows.length === ids.length;
	}

	/** `false` si no estaba ligada a ese registro o no es de ese dueño. */
	async chat_release_upload(input: { id: string; owner_id: string; model: string; record_id: string; now: string }): Promise<boolean> {
		const rows = await this.sql.unsafe(chat_release_upload_sql(this.qt('attachment-management')), [
			input.id,
			input.owner_id,
			input.model,
			input.record_id,
			input.now,
		]);
		return rows.length > 0;
	}

	/** `null`: no existe, no es de ese remitente o ya no está en el estado esperado. */
	async chat_update_scheduled(input: {
		id: string;
		sender_user_id?: string;
		from: string;
		to?: string;
		send_at?: string;
		merge?: ImperiumDoc;
		now: string;
	}): Promise<ImperiumDoc | null> {
		const [row] = (await this.sql.unsafe(chat_update_scheduled_sql(this.qt('chat-scheduled')), [
			input.id,
			input.sender_user_id ?? null,
			input.from,
			input.to ?? null,
			input.send_at ?? null,
			input.merge ?? {},
			input.now,
		])) as Array<Record<string, unknown>>;
		return this.flatten(row ?? null, 'chat-scheduled');
	}

	async chat_save_message(input: {
		id: string;
		user_id: string;
		message_id: string;
		remind_at: string | null;
		payload: ImperiumDoc;
		now: string;
	}): Promise<ImperiumDoc> {
		const [row] = (await this.sql.unsafe(chat_save_message_sql(this.qt('chat-saved')), [
			input.id,
			input.user_id,
			input.message_id,
			input.remind_at,
			input.payload,
			input.now,
		])) as Array<Record<string, unknown>>;
		return this.flatten(row!, 'chat-saved')!;
	}

	/** `null`: no existe o no es de esa persona. */
	async chat_update_saved(id: string, user_id: string, patch: ChatSavedPatch, now: string): Promise<ImperiumDoc | null> {
		const { sql, params } = chat_update_saved_sql(this.qt('chat-saved'), patch, { id, user_id, now });
		const [row] = (await this.sql.unsafe(sql, params)) as Array<Record<string, unknown>>;
		return this.flatten(row ?? null, 'chat-saved');
	}

	/**
	 * De estos guardados, los que quien guardó aún ve: mensaje vivo, sin lápida ni caducado, siendo
	 * miembro activo desde su `visibleFromSeq` y sin haberlo ocultado.
	 */
	async chat_saved_still_visible(ids: string[], now: string): Promise<Set<string>> {
		if (!ids.length) return new Set();
		const rows = (await this.sql.unsafe(
			`SELECT s.id FROM ${this.qt('chat-saved')} s
			 JOIN ${this.qt('messages')} m ON m.id = s.message_id
			 JOIN ${this.qt('chat-members')} cm ON cm.conversation_id = m.conversation_id AND cm.user_id = s.user_id
			 WHERE s.id IN (SELECT jsonb_array_elements_text($1::jsonb))
				AND m.is_active IS DISTINCT FROM false AND NOT (COALESCE(m.payload, '{}'::jsonb) ? 'deleted')
				AND (m.expires_at IS NULL OR m.expires_at > $2)
				AND NOT (COALESCE(m.payload -> 'hiddenForUserIds', '[]'::jsonb) ? s.user_id)
				AND cm.state = 'active' AND cm.is_active IS DISTINCT FROM false
				AND m.seq > COALESCE((cm.payload ->> 'visibleFromSeq')::numeric, 0)`,
			[ids, now],
		)) as Array<{ id: string }>;
		return new Set(rows.map((row) => row.id));
	}

	async chat_delete_saved(id: string, user_id: string): Promise<boolean> {
		const rows = await this.sql.unsafe(`DELETE FROM ${this.qt('chat-saved')} WHERE id = $1 AND user_id = $2 RETURNING id`, [
			id,
			user_id,
		]);
		return rows.length > 0;
	}

	private chat_story_tables(): ChatStoryTables {
		return {
			stories: this.qt('chat-stories'),
			views: this.qt('chat-story-views'),
			conversations: this.qt('chat-conversations'),
			messages: this.qt('messages'),
		};
	}

	/** De `owner_ids`, quienes tienen a `viewer_id` por contacto (ver `contact_sql`). */
	async chat_contact_owners(viewer_id: string, owner_ids: string[]): Promise<string[]> {
		const owners = [...new Set(owner_ids)].filter((id) => id && id !== viewer_id);
		if (!viewer_id || !owners.length) return [];
		const tables = { conversations: this.qt('chat-conversations'), messages: this.qt('messages') };
		const rows = (await this.sql.unsafe(chat_contact_owners_sql(tables), [viewer_id, owners])) as Array<{ id: string }>;
		return rows.map((row) => row.id);
	}

	async chat_story_feed(
		query: ChatStoryFeedQuery,
	): Promise<Array<{ author_id: string; latest_at: string; has_unseen: boolean; muted: boolean }>> {
		const { sql, params } = chat_story_feed_sql(this.chat_story_tables(), query);
		const rows = (await this.sql.unsafe(sql, params)) as Array<Record<string, unknown>>;
		return rows.map((row) => ({
			author_id: String(row.author_id),
			latest_at: String(row.latest_at),
			has_unseen: row.has_unseen === true,
			muted: row.muted === true,
		}));
	}

	/** Cada historia trae `my_viewed_at` y `my_reaction` del lector. */
	async chat_story_items(viewer_id: string, author_ids: string[], now: string): Promise<ImperiumDoc[]> {
		if (!author_ids.length) return [];
		const rows = (await this.sql.unsafe(chat_story_items_sql(this.chat_story_tables()), [viewer_id, author_ids, now])) as Array<
			Record<string, unknown>
		>;
		return rows.map(({ my_viewed_at, my_reaction, ...story }) => ({
			...this.flatten(story, 'chat-stories')!,
			my_viewed_at,
			my_reaction,
		}));
	}

	async chat_story_visible(viewer_id: string, story_id: string): Promise<ImperiumDoc | null> {
		const [row] = (await this.sql.unsafe(chat_story_visible_sql(this.chat_story_tables()), [viewer_id, story_id])) as Array<
			Record<string, unknown>
		>;
		return this.flatten(row ?? null, 'chat-stories');
	}

	async chat_view_story(input: { story_id: string; viewer_id: string; payload: ImperiumDoc; now: string }): Promise<void> {
		await this.sql.unsafe(chat_view_story_sql(this.qt('chat-story-views')), [input.story_id, input.viewer_id, input.now, input.payload]);
	}

	async chat_story_view_counts(story_ids: string[]): Promise<Map<string, number>> {
		if (!story_ids.length) return new Map();
		const rows = (await this.sql.unsafe(
			`SELECT story_id, count(*)::int AS n FROM ${this.qt('chat-story-views')}
			 WHERE story_id IN (SELECT jsonb_array_elements_text($1::jsonb)) GROUP BY story_id`,
			[story_ids],
		)) as Array<{ story_id: string; n: number }>;
		return new Map(rows.map((row) => [row.story_id, Number(row.n)]));
	}

	/** Quienes vieron con su nombre, de lo más nuevo a lo más viejo, y cuántos lo hicieron sin compartirlo. */
	async chat_story_viewers(
		story_id: string,
		limit: number,
	): Promise<{ viewers: Array<{ viewer_id: string; viewed_at: string; reaction: string | null }>; anonymous_count: number }> {
		const views = this.qt('chat-story-views');
		const viewers = (await this.sql.unsafe(
			`SELECT viewer_id, viewed_at, payload ->> 'reaction' AS reaction FROM ${views}
			 WHERE story_id = $1 AND COALESCE(payload ->> 'anonymous', '') <> 'true'
			 ORDER BY viewed_at DESC, id DESC LIMIT $2`,
			[story_id, limit],
		)) as Array<{ viewer_id: string; viewed_at: string; reaction: string | null }>;
		const [counted] = (await this.sql.unsafe(
			`SELECT count(*)::int AS n FROM ${views} WHERE story_id = $1 AND payload ->> 'anonymous' = 'true'`,
			[story_id],
		)) as Array<{ n: number }>;
		return { viewers, anonymous_count: Number(counted.n) };
	}

	/** `chat_preferences.stories_muted_author_ids` de `user-settings`. */
	async chat_muted_story_authors(user_id: string): Promise<string[]> {
		if (!this.has('user-settings')) return [];
		const rows = (await this.sql.unsafe(
			`SELECT payload #> '{chat_preferences,stories_muted_author_ids}' AS muted FROM ${this.qt('user-settings')}
			 WHERE payload ->> 'user_id' = $1 AND ${SETTINGS_OWNER} ORDER BY id LIMIT 1`,
			[user_id],
		)) as Array<{ muted: unknown }>;
		return as_array(rows[0]?.muted).map(String);
	}

	/** Con `author_id`, solo las suyas; sin él, solo las que el latido reclamó al vencer. */
	async chat_drop_stories(ids: string[], now: string, author_id: string | null): Promise<{ ids: string[]; files: string[] }> {
		const [row] = (await this.sql.unsafe(
			chat_drop_stories_sql({
				stories: this.qt('chat-stories'),
				views: this.qt('chat-story-views'),
				attachments: this.qt('attachment-management'),
			}),
			[ids, now, author_id],
		)) as Array<Record<string, unknown>>;
		return { ids: as_array(row.ids).map(String), files: as_array(row.files).map(String) };
	}

	/** `null`: esa persona no tiene una solicitud pendiente. */
	async chat_deny_request(conversation_id: string, user_id: string, now: string): Promise<ImperiumDoc | null> {
		const [row] = (await this.sql.unsafe(this.chat_membership().deny, [conversation_id, user_id, now])) as Array<
			Record<string, unknown>
		>;
		return this.flatten(row ?? null, 'chat-members');
	}

	/** Quitar o banear a alguien con el rol con el que se autorizó; `null` si ese rol o su estado cambiaron. */
	async chat_remove_member(input: {
		conversation_id: string;
		user_id: string;
		expected_role: string;
		state: 'removed' | 'banned';
		now: string;
	}): Promise<{ conversation: ImperiumDoc; member: ImperiumDoc; previous_state: string } | null> {
		const sqls = this.chat_membership();
		return this.sql.begin(async (tx) => {
			const [locked] = (await tx.unsafe(sqls.lock, [input.conversation_id])) as Array<Record<string, unknown>>;
			const [member] = locked
				? ((await tx.unsafe(sqls.member, [input.conversation_id, input.user_id])) as Array<Record<string, unknown>>)
				: [];
			const previous_state = String(member?.state ?? '');
			if (
				!member ||
				member.role !== input.expected_role ||
				previous_state === input.state ||
				(input.state === 'removed' && previous_state !== 'active')
			) {
				return null;
			}
			const [updated] = (await tx.unsafe(sqls.leave, [
				input.conversation_id,
				input.user_id,
				input.state,
				input.now,
			])) as Array<Record<string, unknown>>;
			const [conversation] = (await tx.unsafe(sqls.count, [input.conversation_id, input.now])) as Array<
				Record<string, unknown>
			>;
			return {
				conversation: this.flatten(conversation!, 'chat-conversations')!,
				member: this.flatten(updated!, 'chat-members')!,
				previous_state,
			};
		});
	}

	/**
	 * Salir de un grupo. Si sale el dueño, lo hereda `transfer_to`, el administrador más antiguo o
	 * el miembro más antiguo; si no queda nadie, la conversación se da de baja.
	 */
	async chat_leave_conversation(input: {
		conversation_id: string;
		user_id: string;
		transfer_to?: string;
		now: string;
	}): Promise<ChatLeaveResult> {
		const sqls = this.chat_membership();
		return this.sql.begin(async (tx): Promise<ChatLeaveResult> => {
			const [locked] = (await tx.unsafe(sqls.lock, [input.conversation_id])) as Array<Record<string, unknown>>;
			const [member] = locked
				? ((await tx.unsafe(sqls.member, [input.conversation_id, input.user_id])) as Array<Record<string, unknown>>)
				: [];
			if (!member || member.state !== 'active') return { status: 'not_member' };
			let successor_id: string | null = null;
			if (member.role === 'owner') {
				if (input.transfer_to) {
					const [target] = (await tx.unsafe(sqls.member, [input.conversation_id, input.transfer_to])) as Array<
						Record<string, unknown>
					>;
					if (!target || target.state !== 'active' || input.transfer_to === input.user_id) {
						return { status: 'not_member_target' };
					}
					successor_id = input.transfer_to;
				} else {
					const [next] = (await tx.unsafe(sqls.successor, [input.conversation_id, input.user_id])) as Array<{
						user_id: string;
					}>;
					successor_id = next?.user_id ?? null;
				}
			}
			await tx.unsafe(sqls.leave, [input.conversation_id, input.user_id, 'left', input.now]);
			if (successor_id) await tx.unsafe(sqls.set_role, [input.conversation_id, successor_id, 'owner', input.now]);
			const [counted] = (await tx.unsafe(sqls.count, [input.conversation_id, input.now])) as Array<
				Record<string, unknown>
			>;
			const closed = !Number(as_object(counted!.payload).memberCount);
			const [conversation] = closed
				? ((await tx.unsafe(sqls.close, [input.conversation_id, input.now])) as Array<Record<string, unknown>>)
				: [counted];
			return {
				status: 'ok',
				conversation: this.flatten(conversation!, 'chat-conversations')!,
				successor_id,
				closed,
			};
		});
	}

	/** El dueño pasa a administrador y `to` a dueño, en una transacción. */
	async chat_transfer_owner(input: {
		conversation_id: string;
		from: string;
		to: string;
		now: string;
	}): Promise<ChatTransferResult> {
		const sqls = this.chat_membership();
		return this.sql.begin(async (tx): Promise<ChatTransferResult> => {
			const [locked] = (await tx.unsafe(sqls.lock, [input.conversation_id])) as Array<Record<string, unknown>>;
			const [from] = locked
				? ((await tx.unsafe(sqls.member, [input.conversation_id, input.from])) as Array<Record<string, unknown>>)
				: [];
			if (!from || from.state !== 'active' || from.role !== 'owner') return { status: 'not_owner' };
			const [to] = (await tx.unsafe(sqls.member, [input.conversation_id, input.to])) as Array<Record<string, unknown>>;
			if (!to || to.state !== 'active' || input.to === input.from) return { status: 'not_member_target' };
			const [previous] = await tx.unsafe(sqls.set_role, [input.conversation_id, input.from, 'admin', input.now]);
			const [owner] = await tx.unsafe(sqls.set_role, [input.conversation_id, input.to, 'owner', input.now]);
			return {
				status: 'ok',
				owner: this.flatten(owner as Record<string, unknown>, 'chat-members')!,
				previous: this.flatten(previous as Record<string, unknown>, 'chat-members')!,
			};
		});
	}

	/** `null`: ya no es miembro activo o su rol cambió desde que se autorizó el cambio. */
	async chat_update_member(input: {
		conversation_id: string;
		user_id: string;
		expected_role: string;
		role?: string;
		/** `undefined` no cambia la restricción; `null` la quita. */
		restricted_until?: string | null;
		now: string;
	}): Promise<ImperiumDoc | null> {
		const [row] = (await this.sql.unsafe(chat_update_member_sql(this.qt('chat-members')), [
			input.conversation_id,
			input.user_id,
			input.expected_role,
			input.role ?? null,
			input.restricted_until !== undefined,
			input.restricted_until ?? null,
			input.now,
		])) as Array<Record<string, unknown>>;
		return this.flatten(row ?? null, 'chat-members');
	}

	/** `null`: la conversación ya no está activa. `before` trae el título, la descripción y el payload de antes. */
	async chat_update_conversation(input: {
		id: string;
		title?: string;
		description?: string;
		/** Los ajustes que cambian, en camelCase. */
		settings?: ImperiumDoc;
		merge: ImperiumDoc;
		unset: string[];
		now: string;
	}): Promise<{ conversation: ImperiumDoc; before: ImperiumDoc } | null> {
		const [row] = (await this.sql.unsafe(chat_update_conversation_sql(this.qt('chat-conversations')), [
			input.id,
			input.title ?? null,
			input.description ?? null,
			input.settings ?? null,
			input.merge,
			input.unset,
			input.now,
		])) as Array<Record<string, unknown>>;
		if (!row) return null;
		const { before_name, before_description, before_payload, ...conversation } = row;
		return {
			conversation: this.flatten(conversation, 'chat-conversations')!,
			before: { ...as_object(before_payload), name: before_name, description: before_description },
		};
	}

	/** `null`: ya no es miembro activo o no cabe otra conversación fijada. */
	async chat_update_prefs(input: {
		conversation_id: string;
		user_id: string;
		merge: ImperiumDoc;
		pinned?: boolean;
		max_pinned: number;
		now: string;
	}): Promise<ImperiumDoc | null> {
		const [row] = (await this.sql.unsafe(chat_update_prefs_sql(this.qt('chat-members')), [
			input.conversation_id,
			input.user_id,
			input.merge,
			input.pinned ?? null,
			input.max_pinned,
			input.now,
		])) as Array<Record<string, unknown>>;
		return this.flatten(row ?? null, 'chat-members');
	}

	async chat_member_page(query: ChatMemberQuery): Promise<Array<{ member: ImperiumDoc; user: ChatUserBrief | null }>> {
		const { sql, params } = chat_member_page_sql(
			{ members: this.qt('chat-members'), users: this.qt('user') },
			query,
		);
		const rows = (await this.sql.unsafe(sql, params)) as Array<Record<string, unknown>>;
		return rows.map(({ user_found, user_name, user_email, user_img, user_active, ...member }) => ({
			member: this.flatten(member, 'chat-members')!,
			user:
				user_found == null
					? null
					: {
							_id: String(member.user_id),
							name: String(user_name ?? ''),
							...(user_email ? { email: String(user_email) } : {}),
							...(user_img ? { img: String(user_img) } : {}),
							is_active: user_active !== false,
						},
		}));
	}

	/** `null`: alguien la escribió desde que se leyó (`v` cambió) o ya no está activa. */
	async update_versioned(
		resource: string,
		id: string,
		expected_v: number,
		patch: { state?: string; columns?: Record<string, string | number | null>; payload: ImperiumDoc },
		now: string,
	): Promise<ImperiumDoc | null> {
		const columns = Object.keys(patch.columns ?? {});
		const known = this.column_names(resource);
		const unknown = columns.filter((column) => !known.has(column));
		if (unknown.length) throw new Error(`${resource} no tiene las columnas ${unknown.join(', ')}`);
		const [row] = (await this.sql.unsafe(update_versioned_sql(this.qt(resource), columns), [
			id,
			expected_v,
			patch.state ?? null,
			patch.payload,
			now,
			...columns.map((column) => patch.columns![column]),
		])) as Array<Record<string, unknown>>;
		return this.flatten(row ?? null, resource);
	}

	/** `on`: si el valor quedó en el arreglo; `null` si la fila no existe o está inactiva. */
	async payload_set_toggle(
		resource: string,
		id: string,
		input: { field: string; value: string; on?: boolean; count_field?: string },
		now: string,
	): Promise<{ doc: ImperiumDoc; on: boolean } | null> {
		const [row] = (await this.sql.unsafe(payload_set_toggle_sql(this.qt(resource), input.count_field ?? null), [
			id,
			input.field,
			input.value,
			input.on ?? null,
			now,
		])) as Array<Record<string, unknown>>;
		const doc = this.flatten(row ?? null, resource);
		if (!doc) return null;
		return { doc, on: as_array(doc[input.field]).map(String).includes(input.value) };
	}

	async calls_page_for_user(query: {
		user_id: string;
		cursor?: { at: string; id: string };
		limit: number;
	}): Promise<ImperiumDoc[]> {
		const { sql, params } = calls_page_for_user_sql(this.qt('chat-calls'), query);
		const rows = (await this.sql.unsafe(sql, params)) as Array<Record<string, unknown>>;
		return rows.map((row) => this.flatten(row, 'chat-calls')!);
	}

	/** Cada fila lleva `page_key`, la llave de orden con la que sigue el cursor. */
	async meetings_page_for_member(query: {
		user_id: string;
		scope: MeetingScope;
		since: string;
		cursor?: { at: string; id: string };
		limit: number;
	}): Promise<ImperiumDoc[]> {
		const { sql, params } = meetings_page_for_member_sql(this.qt('chat-meetings'), query);
		const rows = (await this.sql.unsafe(sql, params)) as Array<Record<string, unknown>>;
		return rows.map((row) => this.flatten(row, 'chat-meetings')!);
	}

	async meetings_claim_reminders(input: { now: string; until: string; limit: number }): Promise<ImperiumDoc[]> {
		const rows = (await this.sql.unsafe(meetings_claim_reminders_sql(this.qt('chat-meetings')), [
			input.now,
			input.until,
			input.limit,
			input.now,
		])) as Array<Record<string, unknown>>;
		return rows.map((row) => this.flatten(row, 'chat-meetings')!);
	}

	async meetings_due_to_advance(input: { now: string; limit: number }): Promise<ImperiumDoc[]> {
		const rows = (await this.sql.unsafe(meetings_due_to_advance_sql(this.qt('chat-meetings')), [
			input.now,
			input.limit,
		])) as Array<Record<string, unknown>>;
		return rows.map((row) => this.flatten(row, 'chat-meetings')!);
	}

	async meeting_questions(input: { call_id: string; states: string[]; author_key: string; limit: number }): Promise<ImperiumDoc[]> {
		const rows = (await this.sql.unsafe(meeting_questions_sql(this.qt('chat-meeting-questions')), [
			input.call_id,
			input.states,
			input.author_key,
			input.limit,
		])) as Array<Record<string, unknown>>;
		return rows.map((row) => this.flatten(row, 'chat-meeting-questions')!);
	}

	/** La asistencia de una reunión (o de esas llamadas) en lotes por id (keyset). */
	async meeting_attendance_page(input: { meeting_id: string; call_ids: string[] | null; after_id: string; limit: number }): Promise<ImperiumDoc[]> {
		const rows = (await this.sql.unsafe(
			`SELECT * FROM ${this.qt('chat-meeting-attendance')}
			 WHERE meeting_id = $1 AND is_active IS DISTINCT FROM false AND id > $3
			   AND ($2::jsonb IS NULL OR call_id IN (SELECT jsonb_array_elements_text($2::jsonb)))
			 ORDER BY id LIMIT $4`,
			[input.meeting_id, input.call_ids, input.after_id, input.limit],
		)) as Array<Record<string, unknown>>;
		return rows.map((row) => this.flatten(row, 'chat-meeting-attendance')!);
	}

	async meeting_breakout_call_ids(input: { meeting_id: string; parent_call_id: string; limit: number }): Promise<string[]> {
		const rows = (await this.sql.unsafe(
			`SELECT id FROM ${this.qt('chat-calls')}
			 WHERE meeting_id = $1 AND payload ->> 'parentCallId' = $2 AND is_active IS DISTINCT FROM false
			 ORDER BY id LIMIT $3`,
			[input.meeting_id, input.parent_call_id, input.limit],
		)) as Array<{ id: string }>;
		return rows.map((row) => String(row.id));
	}

	/** Bytes de las grabaciones guardadas (y no borradas) de una reunión, para su tope total. */
	async meeting_recorded_bytes(input: { meeting_id: string; conversation_id: string }): Promise<number> {
		const [row] = (await this.sql.unsafe(
			`SELECT COALESCE(sum(CASE WHEN size_in_kb ~ '^[0-9.]+$' THEN size_in_kb::numeric END), 0) * 1024 AS bytes
			 FROM ${this.qt('attachment-management')}
			 WHERE payload #>> '{chatUpload,meetingId}' = $1 AND payload #>> '{chatUpload,conversationId}' = $2
			   AND is_active IS DISTINCT FROM false`,
			[input.meeting_id, input.conversation_id],
		)) as Array<{ bytes: number | string }>;
		return Math.round(Number(row.bytes));
	}

	/** El `seq` que sigue al último bloque guardado de esa llamada; 0 si no hay. */
	async meeting_transcript_next_seq(call_id: string): Promise<number> {
		const [row] = (await this.sql.unsafe(
			`SELECT COALESCE(max(seq), -1) + 1 AS next FROM ${this.qt('chat-meeting-transcripts')} WHERE call_id = $1`,
			[call_id],
		)) as Array<{ next: number | string }>;
		return Number(row.next);
	}

	/** La transcripción de una llamada por bloques, en orden de `seq` (keyset). */
	async meeting_transcript_page(input: { call_id: string; after_seq: number; limit: number }): Promise<ImperiumDoc[]> {
		const rows = (await this.sql.unsafe(
			`SELECT * FROM ${this.qt('chat-meeting-transcripts')}
			 WHERE call_id = $1 AND seq > $2 AND is_active IS DISTINCT FROM false
			 ORDER BY seq LIMIT $3`,
			[input.call_id, input.after_seq, input.limit],
		)) as Array<Record<string, unknown>>;
		return rows.map((row) => this.flatten(row, 'chat-meeting-transcripts')!);
	}

	async live_call_for_conversation(conversation_id: string): Promise<ImperiumDoc | null> {
		const [row] = (await this.sql.unsafe(
			`SELECT * FROM ${this.qt('chat-calls')}
			 WHERE conversation_id = $1 AND state IN ('ringing', 'active') AND meeting_id IS NULL
			   AND is_active IS DISTINCT FROM false
			 LIMIT 1`,
			[conversation_id],
		)) as Array<Record<string, unknown>>;
		return this.flatten(row ?? null, 'chat-calls');
	}

	/** Las llamadas vivas donde aparece alguna de esas personas; lo vivo es poco y tiene índice parcial. */
	async live_calls_with(user_ids: string[]): Promise<ImperiumDoc[]> {
		if (!user_ids.length) return [];
		const rows = (await this.sql.unsafe(
			`SELECT * FROM ${this.qt('chat-calls')}
			 WHERE state IN ('ringing', 'active') AND is_active IS DISTINCT FROM false
			   AND (payload -> 'participantIds') ?| ARRAY(SELECT jsonb_array_elements_text($1::jsonb))`,
			[user_ids],
		)) as Array<Record<string, unknown>>;
		return rows.map((row) => this.flatten(row, 'chat-calls')!);
	}

	/** `false` si ya no estaba esa llamada (otra más nueva ocupa su lugar). */
	async chat_set_active_call(input: {
		conversation_id: string;
		call_id: string;
		value: ImperiumDoc | null;
		now: string;
	}): Promise<boolean> {
		const rows = await this.sql.unsafe(chat_set_active_call_sql(this.qt('chat-conversations')), [
			input.conversation_id,
			input.value,
			input.call_id,
			input.now,
		]);
		return rows.length > 0;
	}

	/** A quién le quedó leído y lo que su bandeja necesita para ponerse al día. */
	async chat_catch_up_read(input: {
		conversation_id: string;
		seq: number;
		user_ids: string[];
		sharing_ids: string[];
		now: string;
	}): Promise<Array<{ user_id: string; last_seq: number; mentions: number }>> {
		if (!input.user_ids.length) return [];
		const rows = (await this.sql.unsafe(
			chat_catch_up_read_sql({ conversations: this.qt('chat-conversations'), members: this.qt('chat-members') }),
			[input.conversation_id, input.seq, input.user_ids, input.sharing_ids, input.now],
		)) as Array<Record<string, unknown>>;
		return rows.map((row) => ({
			user_id: String(row.user_id),
			last_seq: Number(row.last_seq ?? 0),
			mentions: Number(row.mentions ?? 0),
		}));
	}

	async upsert_call_attendance(input: {
		call_id: string;
		meeting_id: string | null;
		participant_key: string;
		name: string;
		payload: ImperiumDoc;
		now: string;
	}): Promise<ImperiumDoc> {
		const [row] = (await this.sql.unsafe(call_attendance_upsert_sql(this.qt('chat-meeting-attendance')), [
			crypto.randomUUID().replace(/-/g, '').slice(0, 24),
			input.name,
			input.call_id,
			input.meeting_id,
			input.participant_key,
			input.payload,
			input.now,
		])) as Array<Record<string, unknown>>;
		return this.flatten(row!, 'chat-meeting-attendance')!;
	}

	/** Las llamadas que suenan o siguen, por el índice parcial de lo vivo y en lotes por id. */
	async live_calls(input: { after_id?: string; limit: number }): Promise<ImperiumDoc[]> {
		const rows = (await this.sql.unsafe(
			`SELECT * FROM ${this.qt('chat-calls')}
			 WHERE state IN ('ringing', 'active') AND is_active IS DISTINCT FROM false AND id > $1
			 ORDER BY id LIMIT $2`,
			[input.after_id ?? '', input.limit],
		)) as Array<Record<string, unknown>>;
		return rows.map((row) => this.flatten(row, 'chat-calls')!);
	}

	async ensure_object_json_cells(): Promise<void> {
		const seen = new Set<string>();
		for (const loc of this.locs.values()) {
			if (seen.has(loc.resource)) continue;
			seen.add(loc.resource);
			const cols = this.column_names(loc.resource);
			for (const col of this.json_cols(loc.resource)) {
				if (!cols.has(col)) continue;
				try {
					for (;;) {
						const rows = await this.sql.unsafe(
							unwrap_jsonb_string_sql(this.qt(loc.resource), col),
						);
						if (!rows.length) break;
					}
				} catch (err) {
					const action = json_unwrap_error_action(err);
					if (action === 'skip-table') continue;
					if (action === 'lenient') {
						await this.unwrap_json_cells_lenient(loc.resource, col);
						continue;
					}
					throw err;
				}
			}
		}
	}

	async unwrap_json_cells_lenient(resource: string, col: string): Promise<void> {
		const qt = this.qt(resource);
		for (;;) {
			let ids: Array<{ id: string }>;
			try {
				ids = (await this.sql.unsafe(string_jsonb_ids_sql(qt, col))) as Array<{
					id: string;
				}>;
			} catch (err) {
				if (json_unwrap_error_action(err) === 'skip-table') return;
				throw err;
			}
			if (!ids.length) break;
			for (const row of ids) {
				try {
					await this.sql.unsafe(unwrap_jsonb_string_one_sql(qt, col), [row.id]);
				} catch (err) {
					const action = json_unwrap_error_action(err);
					if (action === 'skip-table') return;
					if (action === 'lenient') {
						await this.sql.unsafe(`DELETE FROM ${qt} WHERE id = $1`, [row.id]);
						continue;
					}
					throw err;
				}
			}
		}
	}

	async ensure_defaults(): Promise<void> {
		await this.ensure_orphan_tables();
		await this.ensure_catalog_columns();
		try {
			await this.ensure_postgres_table_tracker_table();
			const { sync_postgres_table_tracker, ensure_postgres_table_tracker_access } =
				await import('./postgres-table-tracker.ts');
			await ensure_postgres_table_tracker_access(this);
			await sync_postgres_table_tracker(this);
		} catch {
			/* schema/tabla aún no disponibles */
		}
		await this.ensure_object_json_cells();
		await this.ensure_search_indexes();
		await this.ensure_unique_indexes();
		try {
			const done = await this.chat_backfill_direct();
			if (done.messages) {
				console.log(
					`[chat] Respaldo de los 1:1: ${done.conversations} conversaciones, ${done.members} miembros, ${done.messages} mensajes`,
				);
			}
		} catch (err) {
			console.warn(
				`[chat] Respaldo de los 1:1 incompleto, sigue en el próximo arranque: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		await this.seed_font_awesome_catalog();
		if (this.has('branchoffice')) {
			const { total } = await this.find_many('branchoffice', { take: 1, include_inactive: true });
			if (!total) {
				await this.insert('branchoffice', {
					name: 'Matriz',
					_ref: 'branchoffice-matriz-0',
					description: 'Sucursal predeterminada',
				});
			}
		}
		await this.seed_default_employee();
		if (this.has('configuration')) {
			try {
				const { apply_missing_configuration_seeds } = await import(
					'./configuration-seed-sync.ts'
				);
				await apply_missing_configuration_seeds(this);
			} catch {
				/* snapshot o tabla ausente */
			}
			try {
				const { disabled_subject_slugs } = await import(
					'./subjects-admin.ts'
				);
				const { ensure_installed_subject_menus } = await import(
					'./subject-menu-seed.ts'
				);
				const disabled = await disabled_subject_slugs(this, this.sql);
				await ensure_installed_subject_menus(
					this,
					this.subjects.filter((sub) => !disabled.has(sub.slug)),
				);
			} catch {
				/* subject_installs o menús ausentes */
			}
			try {
				const landing_flag = await this.find_where('configuration', {
					_ref: PUBLIC_LANDING_ENABLED_REF,
				});
				if (!landing_flag) {
					await this.insert(
						'configuration',
						public_landing_configuration_seed() as ImperiumDoc,
					);
				}
			} catch {
				/* tabla ausente o carrera en _ref; el GET público usa default false */
			}
		}
		if (this.has('access-rights')) {
			const print_right =
				(await this.find_where('access-rights', {
					_ref: 'user-print-template-access-rights-0',
				})) ??
				(await this.find_where('access-rights', { model_id: 'UserPrintTemplate' }));
			if (!print_right) {
				await this.insert('access-rights', {
					_ref: 'user-print-template-access-rights-0',
					name: 'Plantillas de usuario | Permisos generales',
					description: 'Permisos para administrar plantillas del designer',
					model_id: 'UserPrintTemplate',
					allow_read: true,
					allow_create: true,
					allow_update: true,
					allow_delete: true,
				});
			}
		}
		if (process.env.AUTO_REINDEX_SEARCH_ON_STARTUP !== 'false') {
			void this.warmup_search_indexes();
		}
	}

	/**
	 * Empleado "Administrador" ligado al admin. Es de RH: sin RH instalada, o
	 * sin su tabla, se salta; nunca aborta el resto de `ensure_defaults`.
	 */
	async seed_default_employee(): Promise<void> {
		if (!this.has('employee') || !this.is_resource_installed('employee')) return;
		try {
			const { total } = await this.find_many('employee', { take: 1, include_inactive: true });
			if (total) return;
			const employee = await this.insert('employee', {
				name: 'Administrador',
				_ref: 'employee-admin-0',
				description: 'Empleado predeterminado',
				is_active: true,
			});
			if (this.has('user') && employee?._id) {
				const admin =
					(await this.find_where('user', { _ref: 'user-menu-management-0' })) ??
					(await this.find_where('user', { email: 'admin@admin.com' }));
				if (admin?._id && !admin.employee) {
					await this.update('user', String(admin._id), {
						employee: employee._id,
					});
				}
			}
		} catch (err) {
			if (is_missing_relation(err)) return;
			console.warn(
				`[defaults] No se sembró el empleado predeterminado: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	async warmup_search_indexes(): Promise<void> {
		if (!(await SearchEngine.ensure_available())) return;
		const seen = new Set<string>();
		let processed = 0;
		for (const loc of this.all_locs) {
			if (seen.has(loc.collection)) continue;
			seen.add(loc.collection);
			if (is_chat_private_resource(loc.resource)) {
				if (!(await SearchEngine.index_is_empty(loc.collection))) {
					await SearchEngine.clear_index(loc.collection);
				}
				continue;
			}
			if (!(await SearchEngine.index_is_empty(loc.collection))) continue;
			for await (const rows of this.scan(loc.resource, {
				include_inactive: false,
				page_size: 200,
			})) {
				await SearchEngine.index_documents(
					loc.collection,
					rows
						.filter((doc) => loc.resource !== 'attachment-management' || !is_chat_attachment(doc))
						.map((doc) => ({
							id: String(doc._id),
							search_text: search_text_from_doc(doc),
						}))
						.filter((doc) => doc.search_text),
				);
				processed += rows.length;
			}
		}
		if (processed) {
			console.log(`[search] Indexado inicial al motor: ${processed} documentos`);
		}
	}

	async seed_font_awesome_catalog(): Promise<void> {
		if (!this.has('font-awesome-icon-catalog')) return;
		// Copia propia: la imagen del núcleo no lleva `backend/src`.
		const file = join(import.meta.dir, 'font-awesome-icons.data.json');
		if (!existsSync(file)) return;
		const catalog = JSON.parse(readFileSync(file, 'utf8')) as Array<{
			slug: string;
			name: string;
			icon: string;
			prefix: string;
			style: string;
			search_terms?: string[];
		}>;
		const existing = await this.find_many('font-awesome-icon-catalog', {
			take: 1,
			include_inactive: true,
		});
		if (
			existing.total === catalog.length &&
			existing.rows[0]?.seed_version === ICON_CATALOG_SEED_VERSION
		) {
			return;
		}
		const qt = this.qt('font-awesome-icon-catalog');
		await this.sql.unsafe(`DELETE FROM ${qt}`);
		const now = new Date().toISOString();
		for (let i = 0; i < catalog.length; i += 150) {
			const chunk = catalog.slice(i, i + 150);
			const params: unknown[] = [];
			const values = chunk.map((entry) => {
				const search_field = [
					entry.name,
					entry.slug,
					entry.icon,
					...(entry.search_terms ?? []),
					...icon_search_terms_es(entry.slug),
				]
					.join(' ')
					.toLowerCase();
				const id = crypto.randomUUID().replace(/-/g, '').slice(0, 24);
				params.push(
					id,
					entry.name,
					'',
					true,
					entry.slug,
					search_field,
					{
						icon: entry.icon,
						slug: entry.slug,
						prefix: entry.prefix,
						style: entry.style,
						search_terms: entry.search_terms ?? [],
						seed_version: ICON_CATALOG_SEED_VERSION,
					},
					now,
					now,
				);
				const start = params.length - 8;
				return `($${start},$${start + 1},$${start + 2},$${start + 3},$${start + 4},$${start + 5},$${start + 6}::jsonb,$${start + 7},$${start + 8})`;
			});
			await this.sql.unsafe(
				`INSERT INTO ${qt} (id, name, description, is_active, ref, search_field, payload, created_at, updated_at)
         VALUES ${values.join(', ')}`,
				params,
			);
		}
		if (await SearchEngine.ensure_available()) {
			await SearchEngine.clear_index('__font_awesome_icon_catalog');
			for await (const page of this.scan('font-awesome-icon-catalog', {
				include_inactive: true,
				page_size: 200,
			})) {
				const docs = page
					.map((doc) => ({
						id: String(doc._id),
						search_text: search_text_from_doc(doc),
					}))
					.filter((doc) => doc.search_text);
				if (docs.length) {
					await SearchEngine.index_documents('__font_awesome_icon_catalog', docs);
				}
			}
		}
		console.log(`[icons] Catálogo Font Awesome sembrado: ${catalog.length} íconos`);
	}

	async ensure_postgres_table_tracker_table(): Promise<void> {
		if (!this.has('postgres-table-tracker')) return;
		const loc = this.loc('postgres-table-tracker');
		const schema = qident(pg_schema_name(loc.technical_id));
		const qt = this.qt('postgres-table-tracker');
		await this.sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
		await this.sql.unsafe(`
        CREATE TABLE IF NOT EXISTS ${qt} (
          id TEXT PRIMARY KEY,
          name TEXT,
          description TEXT,
          is_active BOOLEAN DEFAULT true,
          state TEXT,
          ref TEXT,
          search_field TEXT,
          created_by TEXT,
          custom_data JSONB DEFAULT '{}'::jsonb,
          payload JSONB DEFAULT '{}'::jsonb,
          created_at TEXT,
          updated_at TEXT
        )
      `);
		await this.ensure_loc_columns('postgres-table-tracker');
	}

	async ensure_missing_catalog_tables(): Promise<void> {
		const wanted: ModuleLoc[] = [];
		const seen = new Set<string>();
		for (const loc of this.locs.values()) {
			if (seen.has(loc.resource)) continue;
			seen.add(loc.resource);
			if (!this.is_resource_installed(loc.resource)) continue;
			wanted.push(loc);
		}
		if (!wanted.length) return;
		let existing = new Set<string>();
		try {
			const rows = (await this.sql.unsafe(
				`SELECT n.nspname AS schema, c.relname AS table
				 FROM pg_class c
				 JOIN pg_namespace n ON n.oid = c.relnamespace
				 WHERE c.relkind = 'r' AND n.nspname LIKE 'subject_%'`,
			)) as Array<{ schema?: unknown; table?: unknown }>;
			existing = new Set(
				rows.map(
					(row) => `${String(row.schema ?? '')}.${String(row.table ?? '')}`,
				),
			);
		} catch {
			return;
		}
		const schemas = new Set<string>();
		for (const loc of wanted) {
			const schema = pg_schema_name(loc.technical_id);
			if (existing.has(`${schema}.${loc.table}`)) continue;
			try {
				if (!schemas.has(schema)) {
					schemas.add(schema);
					await this.sql.unsafe(
						`CREATE SCHEMA IF NOT EXISTS ${qident(schema)}`,
					);
				}
				await this.sql.unsafe(`
        CREATE TABLE IF NOT EXISTS ${this.qt(loc.resource)} (
          id TEXT PRIMARY KEY,
          name TEXT,
          description TEXT,
          is_active BOOLEAN DEFAULT true,
          state TEXT,
          ref TEXT,
          search_field TEXT,
          created_by TEXT,
          custom_data JSONB DEFAULT '{}'::jsonb,
          payload JSONB DEFAULT '{}'::jsonb,
          created_at TEXT,
          updated_at TEXT
        )
      `);
			} catch {
				/* un DDL que falla no frena el resto de las tablas */
			}
		}
	}

	/**
	 * Columnas extra del catálogo (p. ej. table_configs) sobre tablas ya creadas.
	 * Sin esto un INSERT del núcleo falla hasta que el subject vuelva a emitir DDL.
	 */
	async ensure_catalog_columns(): Promise<void> {
		await this.ensure_missing_catalog_tables();
		const seen = new Set<string>();
		for (const loc of this.locs.values()) {
			if (seen.has(loc.resource)) continue;
			seen.add(loc.resource);
			await this.ensure_loc_columns(loc.resource);
		}
	}

	private async ensure_loc_columns(resource: string): Promise<void> {
		if (!this.has(resource)) return;
		const loc = this.loc(resource);
		const qt = this.qt(resource);
		const jsons = this.json_cols(resource);
		for (const col of loc.columns) {
			const name = String(col.name ?? '').trim();
			if (!name || GENERAL.has(name)) continue;
			if (!/^[a-z_][a-z0-9_]*$/i.test(name)) continue;
			const pg = jsons.has(name)
				? 'JSONB'
				: col.pg === 'boolean'
					? 'BOOLEAN'
					: col.pg === 'real' || col.pg === 'number'
						? 'DOUBLE PRECISION'
						: 'TEXT';
			try {
				await this.sql.unsafe(
					`ALTER TABLE ${qt} ADD COLUMN IF NOT EXISTS ${qident(name)} ${pg}`,
				);
			} catch {
				/* columna o tabla aún no aplicables */
			}
			if (col.pg === 'boolean') {
				await this.promote_text_column_to_boolean(loc, name);
			}
		}
	}

	/** Postgres rechaza un boolean de JS en una columna text (42804). */
	private async promote_text_column_to_boolean(loc: ModuleLoc, name: string): Promise<void> {
		const schema = pg_schema_name(loc.technical_id);
		let rows: Array<{ data_type?: string }> = [];
		try {
			rows = (await this.sql.unsafe(
				`SELECT data_type FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
				[schema, loc.table, name],
			)) as Array<{ data_type?: string }>;
		} catch {
			return;
		}
		const data_type = String(rows[0]?.data_type ?? '').toLowerCase();
		if (data_type !== 'text' && data_type !== 'character varying') return;
		const ident = qident(name);
		const using = `CASE WHEN ${ident} IS NULL THEN NULL WHEN lower(btrim(${ident})) IN ('true', 't', '1', 'yes', 'si', 'sí') THEN TRUE ELSE FALSE END`;
		try {
			await this.sql.unsafe(
				`ALTER TABLE ${this.qt(loc.resource)} ALTER COLUMN ${ident} TYPE BOOLEAN USING ${using}`,
			);
		} catch {
			/* columna o tabla aún no aplicables */
		}
	}

	async ensure_orphan_tables(): Promise<void> {
		for (const resource of [
			'messages',
			'notifications',
			'mentions',
			'user-settings',
			'custom-user-themes',
			'documentation-page',
			'document-change-history',
			'interactive-manual',
			'cobranza-payment',
			'module-management-reference',
			'font-awesome-icon-catalog',
			'mcp-user-token',
			'proyectos-time-log',
			'user-print-template',
			'time-sheets',
			'home-pin',
			...CHAT_ORPHANS,
		]) {
			if (!this.locs.has(resource)) continue;
			const qt = this.qt(resource);
			await this.sql.unsafe(`
        CREATE TABLE IF NOT EXISTS ${qt} (
          id TEXT PRIMARY KEY,
          name TEXT,
          description TEXT,
          is_active BOOLEAN DEFAULT true,
          state TEXT,
          ref TEXT,
          search_field TEXT,
          created_by TEXT,
          custom_data JSONB DEFAULT '{}'::jsonb,
          payload JSONB DEFAULT '{}'::jsonb,
          created_at TEXT,
          updated_at TEXT
        )
      `);
			await this.ensure_loc_columns(resource);
		}
	}

	has(resource: string): boolean {
		return this.locs.has(resource);
	}

	/** Reemplaza el caché de apps instaladas (al arrancar). */
	set_installed_subjects(technical_ids: Iterable<string>): void {
		this.installed_subjects = new Set(technical_ids);
	}

	/** Refleja en el caché un `installed` recién escrito en `subject_installs`. */
	mark_subject_installed(technical_id: string, installed: boolean): void {
		if (!this.installed_subjects) return;
		if (installed) this.installed_subjects.add(technical_id);
		else this.installed_subjects.delete(technical_id);
	}

	/**
	 * ¿Está instalada la app dueña del recurso (PREFER_OWNER incluido)? Para
	 * los flujos que cruzan apps. Sin dueño en el catálogo, app base o caché
	 * sin cargar: true.
	 */
	is_resource_installed(resource: string): boolean {
		const loc = this.locs.get(resource);
		if (!loc || !this.installed_subjects || is_base_subject_slug(loc.slug)) return true;
		return this.installed_subjects.has(loc.technical_id);
	}

	/** `is_resource_installed` por `model_id` (`Employee`); un modelo sin recurso cuenta como instalado. */
	is_model_installed(model_id: string): boolean {
		const resource = this.resource_for_model(model_id);
		return !resource || this.is_resource_installed(resource);
	}

	/** Lanza `SubjectNotInstalledError` (404 con la pista de instalar) si la app dueña no está instalada. */
	async assert_resource_installed(resource: string): Promise<void> {
		if (this.is_resource_installed(resource)) return;
		const loc = this.loc(resource);
		// Import dinámico: subjects-admin importa este módulo.
		const { SubjectNotInstalledError } = await import('./subjects-admin.ts');
		const sub = this.subjects.find((s) => s.technical_id === loc.technical_id);
		throw new SubjectNotInstalledError({
			slug: sub?.slug ?? loc.slug,
			name: sub?.name ?? loc.name,
			technical_id: loc.technical_id,
			resource: loc.resource,
		});
	}

	/**
	 * Lista `{ model_name, collection }` como `GET /available-models` del original
	 * (`mongoose.models`, sin nombres `__`, orden alfabético).
	 */
	available_mongoose_models(): Array<{ model_name: string; collection: string }> {
		const resource_to_model = new Map<string, string>();
		for (const [model, resource] of Object.entries(REFS.models)) {
			if (!/^[A-Z]/.test(model) || !this.has(resource)) continue;
			if (!resource_to_model.has(resource)) resource_to_model.set(resource, model);
		}
		const seen = new Set<string>();
		const out: Array<{ model_name: string; collection: string }> = [];
		for (const loc of this.locs.values()) {
			if (loc.resource.startsWith('__')) continue;
			const model_name =
				resource_to_model.get(loc.resource) ??
				(loc.resource === 'branchoffice'
					? 'Branchoffice'
					: loc.resource
							.split('-')
							.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
							.join(''));
			if (!model_name || model_name.startsWith('__') || seen.has(model_name)) continue;
			seen.add(model_name);
			out.push({ model_name, collection: loc.collection });
		}
		out.sort((a, b) => a.model_name.localeCompare(b.model_name));
		return out;
	}

	loc(resource: string): ModuleLoc {
		const hit = this.locs.get(resource);
		if (!hit) throw new Error(`Recurso desconocido: ${resource}`);
		return hit;
	}

	column_names(resource: string): Set<string> {
		const loc = this.loc(resource);
		return new Set([...GENERAL, ...loc.columns.map((c) => c.name)]);
	}

	field_refs(resource: string): Record<string, string> {
		return field_map_for(resource) ?? {};
	}

	/**
	 * Refs simples (sin path anidado) que apuntan a `target`, como el
	 * `_check_references` original que solo mira `schema.obj` con `ref`.
	 */
	incoming_simple_refs(target: string): Array<{ resource: string; field: string }> {
		const out: Array<{ resource: string; field: string }> = [];
		for (const [from, fields] of Object.entries(REFS.fields)) {
			if (from === target || !this.has(from) || !this.is_resource_installed(from)) continue;
			for (const [field, model] of Object.entries(fields)) {
				if (!field || field.includes('.')) continue;
				if (this.resource_for_model(model) === target) {
					out.push({ resource: from, field });
				}
			}
		}
		return out;
	}

	async referencing_counts(
		target: string,
		id: string,
	): Promise<Array<{ resource: string; field: string; conteo: number }>> {
		const hits: Array<{ resource: string; field: string; conteo: number }> = [];
		for (const incoming of this.incoming_simple_refs(target)) {
			let total = 0;
			try {
				({ total } = await this.find_many(incoming.resource, {
					where: { [incoming.field]: id },
					take: 1,
					include_inactive: false,
					populate: false,
				}));
			} catch (err) {
				if (is_missing_relation(err)) continue;
				throw err;
			}
			if (total > 0) hits.push({ ...incoming, conteo: total });
		}
		return hits;
	}

	json_cols(resource: string): Set<string> {
		const loc = this.loc(resource);
		const out = new Set(['custom_data', 'payload']);
		for (const c of loc.columns) if (c.pg === 'json') out.add(c.name);
		return out;
	}

	bool_cols(resource: string): Set<string> {
		const loc = this.loc(resource);
		const out = new Set<string>();
		for (const c of loc.columns) if (c.pg === 'boolean') out.add(c.name);
		return out;
	}

	qt(resource: string): string {
		const loc = this.loc(resource);
		return `${qident(pg_schema_name(loc.technical_id))}.${qident(loc.table)}`;
	}

	/**
	 * Siguiente valor del tracker `__auto_increment_control` (columna
	 * `current_sequence`). Si el recurso tiene la columna, siembra desde el MAX
	 * ya persistido para no reiniciar tras una migración.
	 */
	async next_auto_increment(
		model_name: string,
		increment_field: string,
		opts: { resource?: string; context?: PatternContext } = {},
	): Promise<number> {
		return advance_increment_sequence(this, model_name, increment_field, {
			resource: opts.resource,
			context: opts.context,
			max_numeric: (resource, field) => this.max_numeric(resource, field),
			bump: async (target, floor) => {
				const qt = this.qt('auto-increment-control');
				const now = new Date().toISOString();
				const updated = await this.sql.unsafe(
					`UPDATE ${qt}
					 SET current_sequence = GREATEST(COALESCE(current_sequence, 0), $1) + 1,
					     updated_at = $2
					 WHERE id = $3
					 RETURNING id, current_sequence`,
					[floor, now, String(target._id)],
				);
				const row = updated[0] as { id?: string; current_sequence?: number } | undefined;
				if (row?.current_sequence == null) return floor + 1;
				return Number(row.current_sequence);
			},
		});
	}

	/** `MAX` de un campo numérico (columna o `payload ->>`). Una fila, no N docs. */
	async max_numeric(resource: string, field: string): Promise<number> {
		if (!this.has(resource) || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(field)) return 0;
		const cols = this.column_names(resource);
		// Paréntesis obligatorios: `::` liga más que `->>`, así que sin ellos
		// `payload ->> 'f'::numeric` castea la CLAVE 'f' a numeric y revienta.
		const expr = cols.has(field) ? qident(field) : `(payload ->> ${literal(field)})`;
		const rows = await this.sql.unsafe(
			`SELECT ${max_numeric_expr(expr)} AS m FROM ${this.qt(resource)}`,
		);
		return Number(rows[0]?.m ?? 0) || 0;
	}

	flatten(row: Record<string, unknown> | null, resource?: string): ImperiumDoc | null {
		if (!row) return null;
		const parsed = { ...row };
		const jsons = resource
			? this.json_cols(resource)
			: new Set(['payload', 'custom_data']);
		for (const k of jsons) {
			if (!(k in parsed)) continue;
			parsed[k] = parse_json_cell(parsed[k]);
		}
		/* Columnas extra mal tipadas como text (p. ej. lista-de-precios.product)
		 * llegan como JSON serializado; el original las devolvía como arreglo. */
		if (resource) {
			for (const col of this.loc(resource).columns) {
				if (jsons.has(col.name)) continue;
				if (!(col.name in parsed)) continue;
				/* En BD migradas la columna física `real` puede ser TEXT: el ticket POS
				 * regresaba `subtotal: '3'` y el front tronaba en `.toFixed`. */
				parsed[col.name] =
					col.pg === 'real' || col.pg === 'number'
						? numeric_cell(parsed[col.name])
						: parse_json_cell(parsed[col.name]);
			}
		}
		const doc = to_imperium(parsed);
		if (!doc || !resource) return doc;
		for (const name of this.bool_cols(resource)) {
			if (name in doc) doc[name] = pg_boolean(doc[name]);
		}
		return doc;
	}

		async find_many(
		resource: string,
		opts: {
			q?: string;
			skip?: number;
			take?: number;
			sort?: string;
			include_inactive?: boolean;
			where?: Record<string, unknown>;
			ids?: string[];
			populate?: boolean;
			mongo_match?: Record<string, unknown> | null;
			/** Login/menús: no hace falta paginar; evita un COUNT(*) extra. */
			skip_total?: boolean;
			/** Lista UI: columnas de LIST_PROJECTIONS + payload recortado. */
			list_project?: boolean;
			/** Lookup de populate de lista: id + name, sin COUNT(*). */
			populate_lite?: boolean;
			/** Keyset `(created_at, id)` para scan ordenado por tiempo. */
			after_created?: { at: string; id: string };
			/** Keyset `(created_at, id) <`: la página siguiente, del más nuevo al más viejo. */
			before_created?: { at: string; id: string };
			/** Keyset FIFO `(fecha_entrada, created_at, id)`. */
			after_entrada?: { fecha: string; created: string; id: string };
			/** Barrido: solo estas claves + id/keyset, no SELECT *. */
			scan_fields?: string[];
			/** Barrido: todas las claves salvo estas. */
			scan_omit?: string[];
		} = {},
	): Promise<{ rows: ImperiumDoc[]; total: number }> {
		const loc = this.loc(resource);
		const qt = this.qt(resource);
		const cols = this.column_names(resource);
		const params: unknown[] = [];
		const clauses: string[] = [];
		if (!opts.include_inactive) clauses.push(`is_active IS DISTINCT FROM false`);
		if (opts.q && SearchEngine.is_enabled() && resource !== 'font-awesome-icon-catalog') {
			const ids = await SearchEngine.search_ids(loc.collection, opts.q);
			if (ids !== null && ids.length) {
				const wanted = opts.ids?.length ? ids.filter((id) => opts.ids!.includes(id)) : ids;
				if (wanted.length) opts = { ...opts, q: '', ids: wanted };
			}
		}
		if (opts.ids?.length) {
			const start = params.length + 1;
			params.push(...opts.ids);
			const marks = opts.ids.map((_, i) => `$${start + i}`).join(', ');
			clauses.push(`id IN (${marks})`);
		}
		if (opts.where) {
			for (const [raw_key, v] of Object.entries(opts.where)) {
				if (v === undefined) continue;
				const k = physical_filter_field(cols, raw_key);
				if (v && typeof v === 'object' && !Array.isArray(v) && 'in' in v && Array.isArray((v as { in: unknown[] }).in)) {
					const values = (v as { in: unknown[] }).in.map(String);
					if (!values.length) continue;
					const marks = values.map((item) => {
						params.push(item);
						return `$${params.length}`;
					});
					if (cols.has(k)) clauses.push(`${qident(k)} IN (${marks.join(', ')})`);
					else clauses.push(payload_field_in_sql(k, marks));
					continue;
				}
				if (is_range_filter(v)) {
					const range = v as { gte?: unknown; lte?: unknown; gt?: unknown; lt?: unknown };
					if (range.gte !== undefined && range.gte !== '') {
						params.push(range_bound(String(range.gte), 'gte'));
						clauses.push(range_compare_sql(cols, k, '>=', params.length));
					}
					if (range.lte !== undefined && range.lte !== '') {
						params.push(range_bound(String(range.lte), 'lte'));
						clauses.push(range_compare_sql(cols, k, '<=', params.length));
					}
					if (range.gt !== undefined && range.gt !== '') {
						params.push(range_bound(String(range.gt), 'gte'));
						clauses.push(range_compare_sql(cols, k, '>', params.length));
					}
					if (range.lt !== undefined && range.lt !== '') {
						params.push(range_bound(String(range.lt), 'lte'));
						clauses.push(range_compare_sql(cols, k, '<', params.length));
					}
					continue;
				}
				params.push(v);
				if (cols.has(k)) clauses.push(`${qident(k)} = $${params.length}`);
				else clauses.push(payload_field_eq_sql(k, `$${params.length}`));
			}
		}
		if (opts.mongo_match) {
			const extra = mongo_match_to_sql(opts.mongo_match, cols, params);
			if (extra) clauses.push(extra);
		}
		if (opts.q) {
			const like = `%${opts.q}%`;
			const search_cols = list_search_columns(resource, cols);
			const parts = search_cols.map((c) => {
				params.push(like);
				return `${qident(c)} ILIKE $${params.length}`;
			});
			if (parts.length) clauses.push(`(${parts.join(' OR ')})`);
		}
		if (opts.after_created?.at && opts.after_created.id && cols.has('created_at')) {
			params.push(opts.after_created.at, opts.after_created.id);
			clauses.push(
				created_at_keyset_sql(`$${params.length - 1}`, `$${params.length}`),
			);
		}
		if (opts.before_created?.at && opts.before_created.id && cols.has('created_at')) {
			params.push(opts.before_created.at, opts.before_created.id);
			clauses.push(
				created_at_keyset_sql(`$${params.length - 1}`, `$${params.length}`, '<'),
			);
		}
		if (
			opts.after_entrada?.fecha &&
			opts.after_entrada.created &&
			opts.after_entrada.id &&
			cols.has('fecha_entrada') &&
			cols.has('created_at')
		) {
			params.push(opts.after_entrada.fecha, opts.after_entrada.created, opts.after_entrada.id);
			clauses.push(
				fecha_entrada_keyset_sql(
					`$${params.length - 2}`,
					`$${params.length - 1}`,
					`$${params.length}`,
				),
			);
		}
		const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
		let total = 0;
		if (!opts.skip_total) {
			const count_rows = await this.sql.unsafe(
				`SELECT count(*)::int AS n FROM ${qt}${where}`,
				params,
			);
			total = Number(count_rows[0]?.n ?? 0);
		}
		let order = ' ORDER BY name ASC NULLS LAST, id ASC';
		if (
			opts.after_entrada?.fecha &&
			cols.has('fecha_entrada') &&
			cols.has('created_at')
		) {
			order = ' ORDER BY fecha_entrada ASC NULLS LAST, created_at ASC, id ASC';
		} else if (opts.after_created?.at && cols.has('created_at')) {
			order = ' ORDER BY created_at ASC NULLS LAST, id ASC';
		} else if (opts.before_created?.at && cols.has('created_at')) {
			// Sin NULLS LAST: el keyset ya descarta los NULL y así sirve un índice `created_at DESC`.
			order = ' ORDER BY created_at DESC, id DESC';
		} else if (opts.sort) {
			const m = opts.sort.match(/^([a-zA-Z_][a-zA-Z0-9_]*)(?::(asc|desc))?$/i);
			const raw_campo = (m?.[1] ?? '').replace(/^_/, '');
			const aliases: Record<string, string> = {
				updatedAt: 'updated_at',
				createdAt: 'created_at',
				_id: 'id',
			};
			const campo = aliases[raw_campo] ?? raw_campo;
			const dir = (m?.[2] ?? 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC';
			if (campo && cols.has(campo === 'ref' ? 'ref' : campo)) {
				const col = campo === '_ref' ? 'ref' : campo;
				if (resource === 'pedidos' && (col === 'folio' || col === 'folio_interno')) {
					order = pedido_order_sql(qident(col), dir, col);
				} else {
					order = ` ORDER BY ${qident(col)} ${dir} NULLS LAST`;
				}
				if (col === 'fecha_entrada' && cols.has('created_at')) {
					order += `, created_at ${dir}, id ${dir}`;
				} else if (col === 'created_at') {
					order += `, id ${dir}`;
				}
			}
		}
		const take = opts.take ?? 100;
		const skip = opts.skip ?? 0;
		const select = opts.list_project
			? list_select_sql(resource, cols) ?? '*'
			: opts.populate_lite
				? populate_lite_select_sql(cols)
				: opts.scan_fields?.length
					? scan_select_sql(cols, opts.scan_fields)
					: opts.scan_omit?.length
						? scan_omit_sql(cols, opts.scan_omit)
						: '*';
		const rows = await this.sql.unsafe(
			`SELECT ${select} FROM ${qt}${where}${order} LIMIT ${take} OFFSET ${skip}`,
			params,
		);
		const flattened = rows.map((r) => this.flatten(r as Record<string, unknown>, resource)!);
		const populated =
			opts.populate === false
				? flattened
				: await this.populate_docs(resource, flattened, {
						lite: Boolean(opts.list_project) && !LIST_KEEP_POPULATED_REFS.has(resource),
					});
		if (opts.skip_total) total = populated.length;
		return {
			rows: populated,
			total,
		};
	}

	/**
	 * Barrido interno por keyset (`id > last`, o `(created_at, id)`
	 * si `order: 'created_at'`). Una página en vuelo; no hidrata la
	 * tabla ni hace COUNT(*).
	 */
	async *scan(
		resource: string,
		opts: {
			where?: Record<string, unknown>;
			mongo_match?: Record<string, unknown> | null;
			include_inactive?: boolean;
			page_size?: number;
			q?: string;
			/** FIFO / stats: una página en orden temporal, no O(N) en RAM. */
			order?: 'id' | 'created_at' | 'fecha_entrada';
			/** Solo estas claves + id/keyset. */
			fields?: string[];
			/** Todas las claves salvo estas (set completo, blobs fuera). */
			omit?: string[];
			/** Catálogo de refs: id + name. */
			populate_lite?: boolean;
		} = {},
	): AsyncGenerator<ImperiumDoc[], void, void> {
		const page_size = Math.min(Math.max(opts.page_size ?? 500, 1), 1000);
		const by_lot = opts.order === 'fecha_entrada';
		const by_time = opts.order === 'created_at';
		let after_id = '';
		let after_at = '';
		let after_fecha = '';
		for (;;) {
			const where: Record<string, unknown> = { ...(opts.where ?? {}) };
			if (!by_time && !by_lot && after_id) where.id = { gt: after_id };
			const { rows } = await this.find_many(resource, {
				take: page_size,
				sort: by_lot ? 'fecha_entrada:asc' : by_time ? 'created_at:asc' : 'id:asc',
				populate: false,
				skip_total: true,
				include_inactive: opts.include_inactive,
				where: Object.keys(where).length ? where : undefined,
				mongo_match: opts.mongo_match,
				q: opts.q,
				after_created: by_time && after_at ? { at: after_at, id: after_id } : undefined,
				after_entrada:
					by_lot && after_fecha && after_at
						? { fecha: after_fecha, created: after_at, id: after_id }
						: undefined,
				scan_fields: opts.fields,
				scan_omit: opts.omit,
				populate_lite: opts.populate_lite,
			});
			if (!rows.length) return;
			yield rows;
			const last = rows[rows.length - 1];
			after_id = String(last?._id ?? '');
			if (by_time || by_lot) {
				const raw = last?.createdAt ?? last?.created_at;
				after_at =
					raw instanceof Date ? raw.toISOString() : String(raw ?? '').trim();
				if (!after_at) return;
			}
			if (by_lot) {
				const raw = last?.fecha_entrada ?? last?.fechaEntrada;
				after_fecha =
					raw instanceof Date ? raw.toISOString() : String(raw ?? '').trim();
				if (!after_fecha) return;
			}
			if (!after_id || rows.length < page_size) return;
		}
	}

	/**
	 * Conteos por día (`LEFT(created_at, 10)`). `created_at` es TEXT ISO.
	 * Una fila agregada por día, 0 docs hidratados.
	 */
	async count_by_created_day(
		resource: string,
		opts: {
			from_iso: string;
			to_iso?: string;
			mongo_match?: Record<string, unknown> | null;
			include_inactive?: boolean;
		},
	): Promise<Map<string, number>> {
		if (!this.has(resource)) return new Map();
		const cols = this.column_names(resource);
		if (!cols.has('created_at')) return new Map();
		const qt = this.qt(resource);
		const params: unknown[] = [opts.from_iso];
		const clauses = ['created_at >= $1'];
		if (opts.to_iso) {
			params.push(opts.to_iso);
			clauses.push(`created_at <= $${params.length}`);
		}
		if (!opts.include_inactive) clauses.push('is_active IS DISTINCT FROM false');
		if (opts.mongo_match) {
			const extra = mongo_match_to_sql(opts.mongo_match, cols, params);
			if (extra) clauses.push(extra);
		}
		const rows = await this.sql.unsafe(
			`SELECT LEFT(created_at, 10) AS day, COUNT(*)::int AS n
			FROM ${qt}
			WHERE ${clauses.join(' AND ')}
			GROUP BY 1`,
			params,
		);
		const out = new Map<string, number>();
		for (const row of rows) {
			const day = String((row as { day?: unknown }).day ?? '').slice(0, 10);
			const n = Number((row as { n?: unknown }).n ?? 0);
			if (!day || !Number.isFinite(n) || n <= 0) continue;
			out.set(day, n);
		}
		return out;
	}

	/** COUNT(*) del predicado, sin hidratar filas. */
	async count(
		resource: string,
		opts: {
			where?: Record<string, unknown>;
			mongo_match?: Record<string, unknown> | null;
			include_inactive?: boolean;
			q?: string;
		} = {},
	): Promise<number> {
		const { total } = await this.find_many(resource, {
			where: opts.where,
			mongo_match: opts.mongo_match,
			include_inactive: opts.include_inactive,
			q: opts.q,
			take: 1,
			populate: false,
		});
		return total;
	}

	async find_id(resource: string, id: string): Promise<ImperiumDoc | null> {
		if (id.startsWith('ref----')) {
			return this.find_where(resource, { ref: id.slice(7) });
		}
		const rows = await this.sql.unsafe(
			`SELECT * FROM ${this.qt(resource)} WHERE id = $1 LIMIT 1`,
			[id],
		);
		return this.flatten((rows[0] as Record<string, unknown>) ?? null, resource);
	}

	async find_where(
		resource: string,
		where: Record<string, unknown>,
	): Promise<ImperiumDoc | null> {
		const { rows } = await this.find_many(resource, {
			where,
			take: 1,
			sort: 'id:asc',
			include_inactive: true,
			populate: false,
			skip_total: true,
		});
		return rows[0] ?? null;
	}

	async assert_unique_business_keys(
		resource: string,
		doc: ImperiumDoc,
		except_id?: string,
	) {
		for (const field of unique_fields_for(resource)) {
			const raw = doc[field];
			if (raw === undefined || raw === null) continue;
			const value = String(raw).trim();
			if (!value) continue;
			const found = await this.find_where(resource, { [field]: value });
			if (!found?._id || String(found._id) === String(except_id ?? '')) continue;
			const label = field === '_ref' ? 'la referencia' : `el campo ${field}`;
			throw new Error(`Ya existe un registro con ${label} "${value}".`);
		}
		for (const field of unique_fields_active_for(resource)) {
			const raw = doc[field];
			if (raw === undefined || raw === null) continue;
			const value = String(raw).trim();
			if (!value) continue;
			const { rows } = await this.find_many(resource, {
				where: { [field]: value },
				take: 1,
				include_inactive: false,
				populate: false,
			});
			const found = rows[0];
			if (!found?._id || String(found._id) === String(except_id ?? '')) continue;
			const label = field === '_ref' ? 'la referencia' : `el campo ${field}`;
			throw new Error(`Ya existe un registro con ${label} "${value}".`);
		}
		for (const fields of unique_composites_active_for(resource)) {
			const where: Record<string, unknown> = {};
			let skip = false;
			for (const field of fields) {
				const raw = doc[field];
				if (raw === undefined || raw === null) {
					skip = true;
					break;
				}
				const value = typeof raw === 'string' ? raw.trim() : raw;
				if (value === '') {
					skip = true;
					break;
				}
				where[field] = value;
			}
			if (skip) continue;
			const { rows } = await this.find_many(resource, {
				where,
				take: 1,
				include_inactive: false,
				populate: false,
			});
			const found = rows[0];
			if (!found?._id || String(found._id) === String(except_id ?? '')) continue;
			const field = fields[0] ?? 'campo';
			const value = String(where[field] ?? '').trim();
			const label = field === '_ref' ? 'la referencia' : `el campo ${field}`;
			throw new Error(`Ya existe un registro con ${label} "${value}".`);
		}
		for (const fields of unique_composites_for(resource)) {
			const where: Record<string, unknown> = {};
			let skip = false;
			for (const field of fields) {
				const raw = doc[field];
				if (raw === undefined || raw === null) {
					skip = true;
					break;
				}
				const value = typeof raw === 'string' ? raw.trim() : raw;
				if (value === '') {
					skip = true;
					break;
				}
				where[field] = value;
			}
			if (skip) continue;
			const found = await this.find_where(resource, where);
			if (!found?._id || String(found._id) === String(except_id ?? '')) continue;
			const field = fields[0] ?? 'campo';
			const value = String(where[field] ?? '').trim();
			const label = field === '_ref' ? 'la referencia' : `el campo ${field}`;
			throw new Error(`Ya existe un registro con ${label} "${value}".`);
		}
	}

	async insert(resource: string, doc: ImperiumDoc): Promise<ImperiumDoc> {
		apply_schema_setters(resource, doc);
		apply_inventory_movement_ledger(resource, doc);
		ensure_sql_name(resource, doc);
		assert_required_fields(resource, doc);
		assert_objectid_refs(resource, doc);
		await this.assert_unique_business_keys(resource, doc);
		const cols = this.column_names(resource);
		const jsons = this.json_cols(resource);
		const bools = this.bool_cols(resource);
		const row = from_imperium(doc, cols);
		if (!row.id) row.id = crypto.randomUUID().replace(/-/g, '').slice(0, 24);
		const ts = new Date().toISOString();
		row.created_at ??= ts;
		row.updated_at ??= ts;
		if (row.is_active === undefined) row.is_active = true;
		const keys = Object.keys(row).filter((k) => cols.has(k));
		const values = keys.map((k) => cell(row[k], jsons.has(k), bools.has(k)));
		const qt = this.qt(resource);
		const inserted = await this.sql.unsafe(
			`INSERT INTO ${qt} (${keys.map(qident).join(', ')}) VALUES (${keys.map((k, i) => json_placeholder(i + 1, jsons.has(k))).join(', ')}) RETURNING *`,
			values,
		);
		const created = this.flatten(inserted[0] as Record<string, unknown>, resource)!;
		await this.sync_search(resource, created);
		await record_document_history(this, resource, null, created).catch(() => undefined);
		return created;
	}

	async update(
		resource: string,
		id: string,
		patch: ImperiumDoc,
	): Promise<ImperiumDoc | null> {
		const existing = await this.find_id(resource, id);
		if (!existing) return null;
		const cols = this.column_names(resource);
		const jsons = this.json_cols(resource);
		const bools = this.bool_cols(resource);
		const merged: ImperiumDoc = {
			...existing,
			...patch,
			_id: id,
			payload: { ...as_object(existing), ...as_object(patch) },
		};
		apply_schema_setters(resource, merged, { apply_defaults: false });
		assert_required_fields(resource, merged, Object.keys(patch));
		assert_objectid_refs(resource, merged, Object.keys(patch));
		await this.assert_unique_business_keys(resource, merged, id);
		const row = from_imperium(merged, cols);
		row.id = id;
		row.updated_at = new Date().toISOString();
		const keys = Object.keys(row).filter((k) => cols.has(k) && k !== 'id');
		const values = keys.map((k) => cell(row[k], jsons.has(k), bools.has(k)));
		values.push(id);
		const set = keys.map((k, i) => `${qident(k)} = ${json_placeholder(i + 1, jsons.has(k))}`).join(', ');
		const updated = await this.sql.unsafe(
			`UPDATE ${this.qt(resource)} SET ${set} WHERE id = $${keys.length + 1} RETURNING *`,
			values,
		);
		const saved = this.flatten((updated[0] as Record<string, unknown>) ?? null, resource);
		if (saved) await this.sync_search(resource, saved);
		if (saved) await record_document_history(this, resource, existing, saved).catch(() => undefined);
		return saved;
	}

	/** Como `updateMany({ _id: { $in } }, { is_active: false })` del original. */
	async set_inactive_ids(resource: string, ids: string[]): Promise<number> {
		const wanted = [...new Set(ids.map(String).filter(Boolean))];
		if (!wanted.length || !this.has(resource)) return 0;
		const now = new Date().toISOString();
		const marks = wanted.map((_, i) => `$${i + 2}`).join(', ');
		await this.sql.unsafe(
			`UPDATE ${this.qt(resource)} SET is_active = false, updated_at = $1 WHERE id IN (${marks}) AND is_active IS DISTINCT FROM false`,
			[now, ...wanted],
		);
		return wanted.length;
	}

	/** Como `updateMany({}, { $set: { field } })` del original. */
	async set_payload_field_all(resource: string, field: string, value: unknown): Promise<number> {
		if (!this.has(resource)) return 0;
		if (!/^[a-z_][a-z0-9_]*$/i.test(field)) throw new Error(`bad ident ${field}`);
		const now = new Date().toISOString();
		const rows = await this.sql.unsafe(
			`UPDATE ${this.qt(resource)}
			 SET payload = (
			   CASE
			     WHEN jsonb_typeof(payload) = 'string' THEN COALESCE((payload #>> '{}')::jsonb, '{}'::jsonb)
			     WHEN jsonb_typeof(payload) = 'object' THEN COALESCE(payload, '{}'::jsonb)
			     ELSE '{}'::jsonb
			   END
			 ) || jsonb_build_object($2::text, to_jsonb($3::text)),
			 updated_at = $1
			 RETURNING id`,
			[now, field, String(value ?? '')],
		);
		return rows.length;
	}

	async sync_search(resource: string, doc: ImperiumDoc) {
		if (is_chat_private_resource(resource)) return;
		const collection = this.loc(resource).collection;
		const id = String(doc._id ?? '');
		if (!id) return;
		if (doc.is_active === false || (resource === 'attachment-management' && is_chat_attachment(doc))) {
			await SearchEngine.delete_documents(collection, [id]);
			return;
		}
		const search_text = search_text_from_doc(doc);
		if (!search_text) return;
		await SearchEngine.index_documents(collection, [{ id, search_text }]);
	}

	async remove(resource: string, id: string): Promise<ImperiumDoc | null> {
		return this.update(resource, id, { is_active: false });
	}

	async populate_docs(
		resource: string,
		docs: ImperiumDoc[],
		opts?: { full?: boolean; lite?: boolean },
	): Promise<ImperiumDoc[]> {
		const field_map = field_map_for(resource);
		if (!field_map || !docs.length) return docs;
		const full = Boolean(opts?.full);
		const lite = Boolean(opts?.lite) && !full;
		const needed = new Map<string, Set<string>>();
		for (const [field, model] of Object.entries(field_map)) {
			const target = this.resource_for_model(model);
			if (!target) continue;
			for (const doc of docs) {
				for (const id of collect_ref_ids(doc, field.split('.'))) {
					if (!needed.has(target)) needed.set(target, new Set());
					needed.get(target)!.add(id);
				}
			}
		}
		const loaded = new Map<string, Map<string, ImperiumDoc>>();
		// Destinos sin tabla (app que nunca se instaló): sus ids se quedan como ids.
		const unreachable = new Set<string>();
		for (const [target, ids] of needed) {
			let rows: ImperiumDoc[];
			try {
				({ rows } = await this.find_many(target, {
					ids: [...ids],
					take: ids.size,
					include_inactive: true,
					populate: false,
					skip_total: true,
					populate_lite: lite,
				}));
			} catch (err) {
				if (!is_missing_relation(err)) throw err;
				unreachable.add(target);
				continue;
			}
			loaded.set(
				target,
				new Map(rows.map((r) => [String(r._id), full ? strip_populated_secrets(target, r) : r])),
			);
		}
		const populated = docs.map((doc) => {
			const out = { ...doc };
			for (const [field, model] of Object.entries(field_map)) {
				const target = this.resource_for_model(model);
				if (target && unreachable.has(target)) continue;
				const lookup = target ? loaded.get(target) : undefined;
				apply_populated_path(out, field.split('.'), lookup, full);
			}
			return out;
		});
		return resource === 'purchase-order'
			? with_purchase_order_supplier_name(populated)
			: populated;
	}

	/**
	 * En listados el original deja refs como nombre (lookup) y el id en `campo_id`.
	 * El detalle sigue con el objeto lite para los formularios.
	 */
	flatten_list_docs(resource: string, docs: ImperiumDoc[]): ImperiumDoc[] {
		const field_map = field_map_for(resource);
		if (!field_map || !docs.length) return docs;
		if (LIST_KEEP_POPULATED_REFS.has(resource)) return docs;
		return docs.map((doc) => {
			const out = { ...doc };
			for (const field of Object.keys(field_map)) {
				if (field.includes('.')) continue;
				const val = out[field];
				if (Array.isArray(val)) continue;
				if (!val || typeof val !== 'object') continue;
				const id = ref_id(val);
				if (!id) {
					out[field] = '';
					continue;
				}
				// String denormalizado en el original (no es ObjectId + $lookup).
				// El form de pedidos lee `invoice_request_id` como id.
				if (LIST_REF_KEEP_AS_ID.has(field)) {
					out[field] = id;
					continue;
				}
				const id_key = `${field}_id`;
				if (out[id_key] == null || out[id_key] === '') out[id_key] = id;
				const related = val as ImperiumDoc;
				out[field] = String(
					related.name ?? related.nombreCompleto ?? '',
				).trim();
			}
			return out;
		});
	}

	resource_for_model(model: string): string | null {
		const direct = REFS.models[model] ?? REFS.models[model.toLowerCase()];
		if (direct && this.has(direct)) return direct;
		const kebab = model.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
		if (this.has(kebab)) return kebab;
		if (this.has(`${kebab}s`)) return `${kebab}s`;
		if (this.has(model.toLowerCase())) return model.toLowerCase();
		if (model === 'Employee' && this.has('employee')) return 'employee';
		return null;
	}

	async distinct(
		resource: string,
		field: string,
		q = '',
		mongo_match: Record<string, unknown> | null = null,
	): Promise<unknown[]> {
		const cols = this.column_names(resource);
		const qt = this.qt(resource);
		const expr = cols.has(field) ? qident(field) : payload_distinct_expr(field);
		const params: unknown[] = [];
		const clauses: string[] = [];
		if (q) {
			params.push(`%${q}%`);
			clauses.push(`${expr}::text ILIKE $1`);
		}
		const scoped = mongo_match_to_sql(mongo_match, cols, params);
		if (scoped) clauses.push(scoped);
		const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
		const rows = await this.sql.unsafe(
			`SELECT DISTINCT ${expr} AS v FROM ${qt}${where} LIMIT 200`,
			params,
		);
		return rows.map((r) => (r as { v: unknown }).v).filter((v) => v != null && v !== '');
	}

	/**
	 * Conteos por valor distinto. Una fila agregada por valor, no N docs.
	 * Solo escalares; el caller no lo usa en refs/arrays/paths con punto.
	 */
	async value_counts(
		resource: string,
		field: string,
		opts: { include_inactive?: boolean; mongo_match?: Record<string, unknown> | null } = {},
	): Promise<Array<{ value: string; count: number }>> {
		if (!this.has(resource)) return [];
		if (!/^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)*$/.test(field)) return [];
		const cols = this.column_names(resource);
		const expr = cols.has(field) ? qident(field) : payload_distinct_expr(field);
		const params: unknown[] = [];
		const scoped = mongo_match_to_sql(opts.mongo_match ?? null, cols, params);
		const rows = await this.sql.unsafe(
			value_counts_sql(this.qt(resource), expr, opts.include_inactive === true, scoped),
			params,
		);
		const out: Array<{ value: string; count: number }> = [];
		for (const row of rows) {
			const rec = row as { v: unknown; n: unknown };
			const value = String(rec.v ?? '').trim();
			const count = Number(rec.n ?? 0);
			if (!value || !Number.isFinite(count) || count <= 0) continue;
			out.push({ value, count });
		}
		return out;
	}

	/**
	 * Página de debug-log. Filtros sargables (`payload ->>`).
	 * No hidrata la tabla. Contrato: `data` + `total_elementos`.
	 */
	async debug_log_page(
		filter: DebugLogFilter,
		opts: { skip: number; take: number; sort: string; dir: 'asc' | 'desc' },
	): Promise<{ rows: ImperiumDoc[]; total: number }> {
		if (!this.has('debug-log')) return { rows: [], total: 0 };
		const qt = this.qt('debug-log');
		const params: unknown[] = [];
		const where = debug_log_filter_sql(filter, params);
		const count_rows = await this.sql.unsafe(
			`SELECT count(*)::int AS n FROM ${qt}${where}`,
			params,
		);
		const total = Number(count_rows[0]?.n ?? 0);
		const dir = opts.dir === 'asc' ? 'ASC' : 'DESC';
		const order = debug_log_sort_sql(opts.sort, dir);
		const take = Math.min(Math.max(opts.take, 1), 200);
		const skip = Math.max(opts.skip, 0);
		const rows = await this.sql.unsafe(
			`SELECT ${debug_log_list_select_sql()} FROM ${qt}${where} ORDER BY ${order} LIMIT ${take} OFFSET ${skip}`,
			params,
		);
		return {
			rows: rows.map((row) => this.flatten(row as Record<string, unknown>, 'debug-log')!),
			total,
		};
	}

	/** Agregados de debug-log. Una pasada SQL, 0 docs hidratados. */
	async debug_log_stats(filter: DebugLogFilter): Promise<{
		total: number;
		by_level: Array<{ level: string; count: number; percentage: number }>;
		by_origin: Array<{ file: string; display: string; count: number; percentage: number }>;
		timeline: Array<{ level: string; hour: string; count: number }>;
	}> {
		const empty = { total: 0, by_level: [], by_origin: [], timeline: [] };
		if (!this.has('debug-log')) return empty;
		const qt = this.qt('debug-log');
		const params: unknown[] = [];
		const where = debug_log_filter_sql(filter, params);
		const level_expr = debug_payload_expr('level');
		const file_expr = debug_payload_expr('origin.file');
		const display_expr = debug_payload_expr('origin.display');
		const hour_expr = `to_char((created_at::timestamptz AT TIME ZONE 'America/Mexico_City'), 'YYYY-MM-DD HH24":00"')`;
		const [totals, origins, hours] = await Promise.all([
			this.sql.unsafe(
				`SELECT ${level_expr} AS level, count(*)::int AS n FROM ${qt}${where} GROUP BY 1`,
				params,
			),
			this.sql.unsafe(
				`SELECT COALESCE(${file_expr}, 'unknown') AS file,
					COALESCE(NULLIF(${display_expr}, ''), ${file_expr}, 'unknown') AS display,
					count(*)::int AS n
				FROM ${qt}${where}
				GROUP BY 1, 2
				ORDER BY n DESC
				LIMIT 50`,
				params,
			),
			this.sql.unsafe(
				`SELECT COALESCE(${level_expr}, 'log') AS level, ${hour_expr} AS hour, count(*)::int AS n
				FROM ${qt}${where}
				GROUP BY 1, 2
				ORDER BY 2`,
				params,
			),
		]);
		const by_level_raw = totals.map((row) => {
			const rec = row as { level?: string; n?: number };
			return { level: String(rec.level ?? 'log'), count: Number(rec.n ?? 0) };
		});
		const total = by_level_raw.reduce((sum, row) => sum + row.count, 0);
		const pct = (count: number) =>
			total ? parseFloat(((count / total) * 100).toFixed(2)) : 0;
		return {
			total,
			by_level: by_level_raw
				.map((row) => ({ ...row, percentage: pct(row.count) }))
				.sort((a, b) => b.count - a.count),
			by_origin: origins.map((row) => {
				const rec = row as { file?: string; display?: string; n?: number };
				const count = Number(rec.n ?? 0);
				return {
					file: String(rec.file ?? 'unknown'),
					display: String(rec.display ?? rec.file ?? 'unknown'),
					count,
					percentage: pct(count),
				};
			}),
			timeline: hours.map((row) => {
				const rec = row as { level?: string; hour?: string; n?: number };
				return {
					level: String(rec.level ?? 'log'),
					hour: String(rec.hour ?? ''),
					count: Number(rec.n ?? 0),
				};
			}),
		};
	}

	/**
	 * Hasta 10 request logs que matchean ruta+método. No hidrata la tabla.
	 * El caller elige error-preferente entre esas 10.
	 */
	async debug_log_related(lookup: DebugLogRelatedLookup): Promise<ImperiumDoc[]> {
		if (!this.has('debug-log')) return [];
		if (!lookup.routes.length || !lookup.method) return [];
		const params: unknown[] = [];
		const where = debug_log_related_sql(lookup, params);
		const rows = await this.sql.unsafe(
			`SELECT * FROM ${this.qt('debug-log')}${where}
			ORDER BY created_at DESC NULLS LAST, id DESC
			LIMIT 10`,
			params,
		);
		return rows.map((row) => this.flatten(row as Record<string, unknown>, 'debug-log')!);
	}

	/**
	 * Página actual + vecinos de documentation-page. 3 lecturas LIMIT,
	 * no el catálogo. payload_text_expr: la tabla huérfana aún puede
	 * venir string-wrapped.
	 */
	async documentation_adjacent(lookup: {
		slug: string;
		folder?: string;
		section?: string;
	}): Promise<{ current: ImperiumDoc | null; previous: ImperiumDoc | null; next: ImperiumDoc | null }> {
		const empty = { current: null, previous: null, next: null };
		if (!this.has('documentation-page') || !lookup.slug) return empty;
		const qt = this.qt('documentation-page');
		const current_params: unknown[] = [];
		const current_where = documentation_page_current_sql(current_params, {
			slug: lookup.slug,
			folder: lookup.folder ?? '',
			section: lookup.section ?? '',
		});
		const current_rows = await this.sql.unsafe(
			`SELECT * FROM ${qt}${current_where} ORDER BY id ASC LIMIT 5`,
			current_params,
		);
		const current = this.flatten(
			(current_rows[0] as Record<string, unknown>) ?? null,
			'documentation-page',
		);
		if (!current) return empty;
		const cursor = {
			section: String(current.section ?? ''),
			order: Number(current.order ?? 0) || 0,
			id: String(current._id ?? ''),
		};
		const prev_params: unknown[] = [];
		const next_params: unknown[] = [];
		const [prev_rows, next_rows] = await Promise.all([
			this.sql.unsafe(
				`SELECT * FROM ${qt}${documentation_page_neighbor_sql('prev', prev_params, cursor)}`,
				prev_params,
			),
			this.sql.unsafe(
				`SELECT * FROM ${qt}${documentation_page_neighbor_sql('next', next_params, cursor)}`,
				next_params,
			),
		]);
		return {
			current,
			previous: this.flatten(
				(prev_rows[0] as Record<string, unknown>) ?? null,
				'documentation-page',
			),
			next: this.flatten(
				(next_rows[0] as Record<string, unknown>) ?? null,
				'documentation-page',
			),
		};
	}

	/**
	 * Tablero de guías: cards + `step_count`, sin hidratar `steps`.
	 * Play/export hacen `find_id` del elegido.
	 */
	async interactive_manual_cards(): Promise<ImperiumDoc[]> {
		if (!this.has('interactive-manual')) return [];
		const qt = this.qt('interactive-manual');
		const cols = this.column_names('interactive-manual');
		const select = `${scan_select_sql(cols, INTERACTIVE_MANUAL_CARD_FIELDS)}, ${json_array_length_sql('steps')} AS step_count`;
		const rows = await this.sql.unsafe(
			`SELECT ${select} FROM ${qt} WHERE is_active IS DISTINCT FROM false`,
		);
		return rows
			.map((row) => this.flatten(row as Record<string, unknown>, 'interactive-manual'))
			.filter((row): row is ImperiumDoc => Boolean(row))
			.map((row) => {
				row.step_count = Number(row.step_count ?? 0) || 0;
				return row;
			});
	}

	async stats(
		resource: string,
		url?: URL,
		mongo_match?: Record<string, unknown> | null,
		actor?: ImperiumDoc | null,
	): Promise<Record<string, unknown>> {
		if (resource === 'ticketing-system-turn') return this.turn_stats(mongo_match);
		if (resource === 'citizen-report') return this.citizen_report_stats(url, mongo_match);
		if (resource === 'purchase-order') return purchase_order_stats(this, mongo_match);
		if (resource === 'pedidos' || resource === 'pedidos-surtir') {
			return pedidos_sales_stats(this, url, mongo_match);
		}
		const planning = await planeacion_statistics(this, resource, url, actor, mongo_match);
		if (planning) return planning;
		if (resource === 'invoice-request') return invoice_request_stats(this, mongo_match);
		if (resource === 'inventory-cost-entry') return cost_entry_stats(this, url, mongo_match);
		const qt = this.qt(resource);
		const cols = this.column_names(resource);
		const from = new Date();
		from.setDate(from.getDate() - 30);
		const from_iso = from.toISOString();
		const params: unknown[] = [from_iso];
		const extra = mongo_match ? mongo_match_to_sql(mongo_match, cols, params) : '';
		const where = extra ? ` WHERE ${extra}` : '';
		const rows = await this.sql.unsafe(
			`SELECT
        count(*)::int AS total_records,
        count(*) FILTER (WHERE is_active IS DISTINCT FROM false)::int AS active_records,
        count(*) FILTER (WHERE is_active = false)::int AS inactive_records,
        count(*) FILTER (WHERE created_at >= $1)::int AS recent_records
      FROM ${qt}${where}`,
			params,
		);
		const r = (rows[0] ?? {}) as Record<string, number>;
		const total_records = r.total_records ?? 0;
		const active_records = r.active_records ?? 0;
		const inactive_records = r.inactive_records ?? 0;
		const recent_records_30d = r.recent_records ?? 0;
		const domain: Record<string, unknown> = {};
		if (resource === 'products') {
			domain.total_costo_existencias = await products_inventory_cost(this, mongo_match);
		}
		if (resource === 'vehicle') {
			domain.by_status = await vehicle_by_status(this, mongo_match);
		}
		if (resource === 'delivery-package') {
			domain.by_status = await delivery_package_by_status(this, mongo_match);
		}
		if (resource === 'inventory-physical-count') {
			domain.by_state = await physical_count_by_state(this, mongo_match);
		}
		if (resource === 'inventory-stock-quant') {
			Object.assign(domain, await stock_quant_stats_extras(this, mongo_match));
		}
		if (resource === 'inventory-movement') {
			Object.assign(domain, await inventory_movement_stats_extras(this, mongo_match));
		}
		if (resource === 'inventory-internal-location') {
			Object.assign(domain, await location_stats_extras(this, mongo_match));
		}
		if (resource === 'delivery-return') {
			domain.by_state = await delivery_return_by_state(this, mongo_match);
		}
		const now = new Date();
		const daily_where = extra ? `created_at >= $1 AND ${extra}` : `created_at >= $1`;
		const daily_rows =
			DAILY_LINE_CHART.has(resource) || resource === 'medical-file'
				? await this.sql.unsafe(
						`SELECT LEFT(created_at, 10) AS day, COUNT(*)::int AS n
           FROM ${qt}
           WHERE ${daily_where}
           GROUP BY 1
           ORDER BY 1`,
						params,
					)
				: [];
		if (resource === 'medical-file') {
			return {
				total_records,
				active_records,
				inactive_records,
				date_range: { from, to: now },
				daily_stats: daily_rows.map((row) => ({
					date: String((row as { day?: unknown }).day ?? ''),
					count: Number((row as { n?: unknown }).n ?? 0),
				})),
				last_updated: now,
			};
		}
		if (DAILY_LINE_CHART.has(resource)) {
			return {
				total_records,
				active_records,
				inactive_records,
				date_range: { from, to: now },
				last_updated: now,
				kpis: {
					total_records: { label: 'Total', value: total_records },
					active_records: { label: 'Activos', value: active_records },
					inactive_records: { label: 'Inactivos', value: inactive_records },
				},
				charts: {
					daily_stats: {
						title: 'Registros por día (últimos 30 días)',
						chart_type: 'line',
						data: daily_rows.map((row) => ({
							name: String((row as { day?: unknown }).day ?? ''),
							value: Number((row as { n?: unknown }).n ?? 0),
						})),
					},
				},
				...domain,
			};
		}
		return {
			model_name: resource,
			total_records,
			active_records,
			inactive_records,
			recent_records_30d,
			date_range_30d: { from, to: now },
			last_updated: now,
			kpis: {
				total_records: { label: 'Total', value: total_records },
				active_records: { label: 'Activos', value: active_records },
				inactive_records: { label: 'Inactivos', value: inactive_records },
				recent_records_30d: { label: 'Últimos 30 días', value: recent_records_30d },
			},
			...domain,
		};
	}

	async turn_stats(mongo_match?: Record<string, unknown> | null): Promise<Record<string, unknown>> {
		const from = new Date();
		from.setUTCDate(from.getUTCDate() - 30);
		const completed_match = {
			$or: [{ status: 'completado' }, { state: 'completado' }],
		};
		const match = mongo_match
			? { $and: [mongo_match, completed_match] }
			: completed_match;
		const day_of = (r: ImperiumDoc) => {
			const d = new Date(String(r.createdAt ?? r.created_at ?? ''));
			return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
		};
		const is_completed = (r: ImperiumDoc) =>
			String(r.status ?? r.state ?? '') === 'completado';
		const day_counts = await this.count_by_created_day('ticketing-system-turn', {
			from_iso: from.toISOString(),
			mongo_match: match,
			include_inactive: true,
		});
		const today_key = new Date().toISOString().slice(0, 10);
		let ref_key = today_key;
		if (!(day_counts.get(today_key))) {
			let best = '';
			let n = 0;
			for (const [k, count] of day_counts) {
				if (count > n) {
					n = count;
					best = k;
				}
			}
			if (best) ref_key = best;
		}
		const ref_date = new Date(`${ref_key}T00:00:00.000Z`);
		const seven_keys: string[] = [];
		for (let i = 6; i >= 0; i--) {
			const d = new Date(ref_date);
			d.setUTCDate(d.getUTCDate() - i);
			seven_keys.push(d.toISOString().slice(0, 10));
		}
		const by_day = new Map<string, ImperiumDoc[]>();
		for await (const page of this.scan('ticketing-system-turn', {
			where: {
				created_at: {
					gte: `${seven_keys[0]}T00:00:00.000Z`,
					lte: `${ref_key}T23:59:59.999Z`,
				},
			},
			mongo_match: match,
			include_inactive: true,
			fields: TURN_STATS_FIELDS,
		})) {
			for (const r of page) {
				if (!is_completed(r)) continue;
				const k = day_of(r);
				if (!k || !seven_keys.includes(k)) continue;
				const list = by_day.get(k) ?? [];
				list.push(r);
				by_day.set(k, list);
			}
		}
		const today_rows = by_day.get(ref_key) ?? [];
		const box_label = (r: ImperiumDoc) => {
			const b = as_object(r.assigned_box);
			return String(b.name ?? 'Sin nombre');
		};
		const box_ref = (r: ImperiumDoc) => {
			const b = as_object(r.assigned_box);
			return b._id ? b : { _id: ref_id(r.assigned_box), name: box_label(r) };
		};
		const daily_map = new Map<
			string,
			{ box_id: unknown; box_name: string; turns_attended: number }
		>();
		for (const r of today_rows) {
			const id = ref_id(r.assigned_box) || 'none';
			const cur = daily_map.get(id) ?? {
				box_id: box_ref(r),
				box_name: box_label(r),
				turns_attended: 0,
			};
			cur.turns_attended += 1;
			daily_map.set(id, cur);
		}
		const daily_stats = [...daily_map.values()];
		const box_ids = new Set<string>();
		for (const k of seven_keys) {
			for (const r of by_day.get(k) ?? []) box_ids.add(ref_id(r.assigned_box) || 'none');
		}
		const seven_days_stats = [...box_ids].map((id) => {
			const sample =
				seven_keys.flatMap((k) => by_day.get(k) ?? []).find(
					(r) => (ref_id(r.assigned_box) || 'none') === id,
				) ?? today_rows[0];
			const daily = seven_keys.map((k) => {
				const day_rows = (by_day.get(k) ?? []).filter(
					(r) => (ref_id(r.assigned_box) || 'none') === id,
				);
				const mins = day_rows.map(turn_duration_minutes).filter((n) => n > 0);
				return {
					day: k,
					total_turns: day_rows.length,
					avg_time_minutes: mins.length
						? Number((mins.reduce((a, b) => a + b, 0) / mins.length).toFixed(2))
						: 0,
				};
			});
			return {
				box_id: sample ? box_ref(sample) : { _id: id, name: 'Sin nombre' },
				box_name: sample ? box_label(sample) : 'Sin nombre',
				daily_stats: daily,
			};
		});
		const average_times = seven_days_stats.map((box) => {
			const mins = box.daily_stats
				.map((d) => Number(d.avg_time_minutes))
				.filter((n) => n > 0);
			return {
				box_id: box.box_id,
				box_name: box.box_name,
				average_time_minutes: mins.length
					? Number((mins.reduce((a, b) => a + b, 0) / mins.length).toFixed(2))
					: 0,
			};
		});
		const service_map = new Map<
			string,
			{ service_type_name: string; turn_count: number; minutes: number[] }
		>();
		for (const r of today_rows) {
			const services = as_array(r.services);
			const name = String(
				as_object(services[0]).name ?? r.service_type ?? 'Sin servicio',
			);
			const cur = service_map.get(name) ?? {
				service_type_name: name,
				turn_count: 0,
				minutes: [],
			};
			cur.turn_count += 1;
			const m = turn_duration_minutes(r);
			if (m > 0) cur.minutes.push(m);
			service_map.set(name, cur);
		}
		const services_stats = [...service_map.values()].map((s) => ({
			service_type_name: s.service_type_name,
			turn_count: s.turn_count,
			average_time_minutes: s.minutes.length
				? Number((s.minutes.reduce((a, b) => a + b, 0) / s.minutes.length).toFixed(2))
				: 0,
		}));
		const ctype_map = new Map<
			string,
			{ customer_type_name: string; customer_type_id: unknown; turn_count: number; minutes: number[] }
		>();
		for (const r of today_rows) {
			const c = as_object(r.customer_type);
			const name = String(c.name ?? 'Sin tipo');
			const cur = ctype_map.get(name) ?? {
				customer_type_name: name,
				customer_type_id: c._id ? c : { _id: ref_id(r.customer_type), name },
				turn_count: 0,
				minutes: [],
			};
			cur.turn_count += 1;
			const m = turn_duration_minutes(r);
			if (m > 0) cur.minutes.push(m);
			ctype_map.set(name, cur);
		}
		const customer_types_stats = [...ctype_map.values()].map((s) => ({
			customer_type_name: s.customer_type_name,
			customer_type_id: s.customer_type_id,
			turn_count: s.turn_count,
			average_time_minutes: s.minutes.length
				? Number((s.minutes.reduce((a, b) => a + b, 0) / s.minutes.length).toFixed(2))
				: 0,
		}));
		const seven_rows = seven_keys.flatMap((k) => by_day.get(k) ?? []);
		const four_keys = seven_keys.slice(-4);
		const four_rows = four_keys.flatMap((k) => by_day.get(k) ?? []);
		const customer_type_rows = four_rows.filter((r) => Boolean(ref_id(r.customer_type)));
		const load_lookup = async (resource: string) =>
			this.has(resource)
				? (
						await this.find_many(resource, {
							take: 200,
							include_inactive: false,
							populate: false,
							skip_total: true,
						})
					).rows
				: [];
		const [boxes, services, customer_types] = await Promise.all([
			load_lookup('ticketing-system-box-config'),
			load_lookup('ticketing-system-service-type'),
			load_lookup('ticketing-system-customer-type'),
		]);
		const range_7 = { from: `${seven_keys[0]}T00:00:00.000Z`, to: `${ref_key}T23:59:59.999Z` };
		const range_4 = {
			from: `${four_keys[0] ?? ref_key}T00:00:00.000Z`,
			to: `${ref_key}T23:59:59.999Z`,
		};
		const range_today = {
			from: `${ref_key}T00:00:00.000Z`,
			to: `${ref_key}T23:59:59.999Z`,
		};
		const turn_export = (
			records: ImperiumDoc[],
			title: string,
			chart_type: 'pie' | 'line',
			unit: string,
			aggregation_method: string,
			aggregation_description: string,
			range: { from: string; to: string },
			lookups: Record<string, ImperiumDoc[]>,
		) => ({
			records,
			metadata: {
				title,
				unit,
				total_records: records.length,
				chart_type,
				aggregation_method,
				aggregation_description,
				query_date_range: range,
				filters_applied: { status: 'completado' },
			},
			lookups,
		});
		return {
			daily_stats,
			average_times,
			raw_turns_today: today_rows,
			total_turns_today: today_rows.length,
			seven_days_stats,
			services_stats,
			customer_types_stats,
			__export_data: {
				daily_turns_pie: turn_export(
					today_rows,
					'Turnos del día por caja',
					'pie',
					'cantidad',
					'count_by_box',
					'Cantidad de turnos agrupados por caja',
					range_today,
					{ boxes },
				),
				average_times_7d_line: turn_export(
					seven_rows,
					'Tiempos promedio últimos 7 días',
					'line',
					'minutos',
					'weighted_average_by_box_and_day',
					'Promedio ponderado de tiempos por caja y día (últimos 7 días)',
					range_7,
					{ boxes },
				),
				turns_last_7d_line: turn_export(
					seven_rows,
					'Total turnos últimos 7 días',
					'line',
					'cantidad',
					'count_by_box_and_day',
					'Cantidad de turnos por caja y día (últimos 7 días)',
					range_7,
					{ boxes },
				),
				avg_times_per_day_line: turn_export(
					seven_rows,
					'Tiempos promedio por día',
					'line',
					'minutos',
					'average_by_day',
					'Tiempo promedio por día (últimos 7 días)',
					range_7,
					{ boxes },
				),
				services_stats_pie: turn_export(
					four_rows,
					'Tiempos por tipo de servicio',
					'pie',
					'minutos',
					'weighted_average_by_service',
					'Promedio ponderado de tiempos por tipo de servicio (últimos 4 días)',
					range_4,
					{ services },
				),
				customer_types_pie: turn_export(
					customer_type_rows,
					'Tiempos por tipo de cliente',
					'pie',
					'minutos',
					'average_by_customer_type',
					'Tiempo promedio por tipo de cliente (últimos 4 días)',
					range_4,
					{ customer_types, boxes },
				),
			},
		};
	}

	async citizen_report_stats(
		url?: URL,
		mongo_match?: Record<string, unknown> | null,
	): Promise<Record<string, unknown>> {
		const date_from = url?.searchParams.get('date_from');
		const date_to = url?.searchParams.get('date_to');
		const priorities = [
			...(url?.searchParams.getAll('priorities[]') ?? []),
			...(url?.searchParams.getAll('priorities') ?? []),
		].filter(Boolean);
		const statuses = [
			...(url?.searchParams.getAll('statuses[]') ?? []),
			...(url?.searchParams.getAll('statuses') ?? []),
		].filter(Boolean);
		const where: Record<string, unknown> = {};
		if (date_from || date_to) {
			where.created_at = {
				...(date_from ? { gte: date_from } : {}),
				...(date_to ? { lte: date_to } : {}),
			};
		}
		if (priorities.length) where.priority = { in: priorities };
		if (statuses.length) where.status = { in: statuses };
		const status_of = (r: ImperiumDoc) => String(r.status ?? '').toLowerCase();
		const priority_of = (r: ImperiumDoc) => String(r.priority ?? '').toUpperCase();
		const ref_name = (v: unknown, fallback: string) => {
			const o = as_object(v);
			const label = String(o.name ?? o.nombreCompleto ?? '').trim();
			if (label) return label;
			if (typeof v === 'string') {
				const s = v.trim();
				if (s && !OBJECT_ID_HEX.test(s)) return s;
			}
			return fallback;
		};
		const slim_ref = (v: unknown) => {
			const label = ref_name(v, '');
			if (!label) return null;
			return { _id: ref_id(v), name: label };
		};
		const day_of = (r: ImperiumDoc) => {
			const d = new Date(String(r.createdAt ?? r.created_at ?? ''));
			return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
		};
		const coord = (r: ImperiumDoc) => {
			const c = as_object(r.report_coordinates);
			const lat = Number(c.latitude ?? c.lat);
			const lon = Number(c.longitude ?? c.lng ?? c.lon);
			if (!Number.isFinite(lat) || !Number.isFinite(lon)) return '';
			return `${lat.toFixed(2)},${lon.toFixed(2)}`;
		};
		const inc = (map: Map<string, number>, name: string) => {
			map.set(name, (map.get(name) ?? 0) + 1);
		};
		const series = (map: Map<string, number>) =>
			[...map.entries()]
				.map(([name, value]) => ({ name, value }))
				.sort((a, b) => b.value - a.value);
		let total_complaints = 0;
		let pending_complaints = 0;
		let urgent_complaints = 0;
		let resolved_complaints = 0;
		const priority_map = new Map<string, number>();
		const status_map = new Map<string, number>();
		const employee_map = new Map<string, number>();
		const department_map = new Map<string, number>();
		const recent_map = new Map<string, number>();
		const medium_map = new Map<string, number>();
		const problem_map = new Map<string, number>();
		const month_map = new Map<string, number>();
		const geo_map = new Map<string, number>();
		const phones = new Map<string, { count: number; name: string }>();
		const resolution = new Map<string, { sum: number; n: number }>();
		const export_records: Record<string, unknown>[] = [];
		const recent_cut = Date.now() - 7 * 24 * 60 * 60 * 1000;
		for await (const page of this.scan('citizen-report', {
			where: Object.keys(where).length ? where : undefined,
			mongo_match,
			include_inactive: false,
			fields: CITIZEN_REPORT_STATS_FIELDS,
		})) {
			const rows = await this.populate_docs('citizen-report', page, { lite: true });
			for (const r of rows) {
				total_complaints += 1;
				const st = status_of(r);
				const pr = priority_of(r);
				if (
					st === 'pendiente' ||
					st === 'en_proceso' ||
					(!st && ['MEDIA', 'ALTA', 'URGENTE', 'CRITICA'].includes(pr))
				) {
					pending_complaints += 1;
				}
				if (['URGENTE', 'CRITICA'].includes(pr)) urgent_complaints += 1;
				if (st === 'terminado' || (!st && pr === 'BAJA')) resolved_complaints += 1;
				inc(priority_map, String(r.priority ?? 'SIN_PRIORIDAD'));
				inc(status_map, String(r.status ?? 'SIN_ESTATUS'));
				inc(employee_map, ref_name(r.employee_taken_the_report, 'Sin asignar'));
				inc(department_map, ref_name(r.department, 'Sin departamento'));
				inc(medium_map, ref_name(r.reporting_medium, 'Sin medio'));
				inc(problem_map, ref_name(r.citizen_report_problem, 'Sin problema'));
				const day = day_of(r);
				if (day) {
					inc(month_map, day.slice(0, 7));
					const t = new Date(String(r.createdAt ?? r.created_at ?? '')).getTime();
					if (Number.isFinite(t) && t >= recent_cut) inc(recent_map, day);
				}
				inc(geo_map, ref_name(r.borough, coord(r) || 'Sin ubicación'));
				export_records.push({
					name: r.name ?? '',
					citizen_name: r.citizen_name ?? '',
					citizen_phone: r.citizen_phone ?? '',
					priority: r.priority ?? '',
					status: r.status ?? '',
					employee_taken_the_report: slim_ref(r.employee_taken_the_report),
					assinged_to: slim_ref(r.assinged_to),
					department: slim_ref(r.department),
					reporting_medium: slim_ref(r.reporting_medium),
					citizen_report_problem: slim_ref(r.citizen_report_problem),
					createdAt: r.createdAt ?? r.created_at ?? '',
				});
				const phone = String(r.citizen_phone ?? '').trim();
				if (phone) {
					const citizen_name = String(r.citizen_name ?? '').trim();
					const cur = phones.get(phone);
					if (cur) {
						cur.count += 1;
						if (!cur.name && citizen_name) cur.name = citizen_name;
					} else {
						phones.set(phone, { count: 1, name: citizen_name });
					}
				}
				if (st !== 'terminado') continue;
				const a = new Date(String(r.createdAt ?? r.created_at ?? '')).getTime();
				const b = new Date(String(r.updatedAt ?? r.updated_at ?? '')).getTime();
				if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) continue;
				const p = pr || 'SIN_PRIORIDAD';
				const cur = resolution.get(p) ?? { sum: 0, n: 0 };
				cur.sum += (b - a) / (1000 * 60 * 60 * 24);
				cur.n += 1;
				resolution.set(p, cur);
			}
		}
		const avg_resolution_time = [...resolution.entries()]
			.map(([name, v]) => ({ name, value: Number((v.sum / v.n).toFixed(1)) }))
			.sort((a, b) => a.name.localeCompare(b.name));
		const citizen_recurrence = [...phones.entries()]
			.filter(([, v]) => v.count > 1)
			.map(([phone, v]) => ({ name: v.name || phone, value: v.count }))
			.sort((a, b) => b.value - a.value)
			.slice(0, 10);
		const export_sheet = (
			title: string,
			chart_type: string,
			lookups: Record<string, string> = {},
		) => ({
			records: export_records,
			metadata: {
				title,
				unit: 'Quejas',
				total_records: export_records.length,
				chart_type,
			},
			lookups,
		});
		return {
			kpis: {
				total_complaints,
				pending_complaints,
				urgent_complaints,
				resolved_complaints,
			},
			charts: {
				priority_distribution: { data: series(priority_map) },
				status_distribution: { data: series(status_map) },
				employee_workload: { data: series(employee_map) },
				department_distribution: { data: series(department_map) },
				recent_activity: { data: series(recent_map).filter((x) => x.name) },
				reporting_medium_distribution: { data: series(medium_map) },
				problem_distribution: { data: series(problem_map) },
				monthly_trend: { data: series(month_map).filter((x) => x.name) },
				geographic_distribution: { data: series(geo_map) },
				avg_resolution_time: { data: avg_resolution_time },
				citizen_recurrence: { data: citizen_recurrence },
			},
			__export_data: {
				priority_distribution: export_sheet('Distribución por Prioridad', 'pie'),
				status_distribution: export_sheet('Distribución por Estatus', 'pie'),
				employee_workload: export_sheet('Carga de Trabajo por Empleado', 'bar', {
					employee_taken_the_report: 'name',
				}),
				department_distribution: export_sheet('Distribución por Departamento', 'pie', {
					department: 'name',
				}),
				recent_activity: export_sheet('Actividad Reciente (7 días)', 'line'),
			},
		};
	}
}

function parse_json_cell(value: unknown): unknown {
	if (typeof value !== 'string') return value;
	const trimmed = value.trim();
	if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return value;
	try {
		return JSON.parse(trimmed);
	} catch {
		return value;
	}
}

function numeric_cell(value: unknown): unknown {
	if (typeof value !== 'string' || !value.trim()) return value;
	const n = Number(value);
	return Number.isFinite(n) ? n : value;
}

function turn_duration_minutes(row: ImperiumDoc): number {
	let raw: unknown = row.time_box;
	if (typeof raw === 'string') {
		try {
			raw = JSON.parse(raw);
		} catch {
			return 0;
		}
	}
	if (!Array.isArray(raw) || raw.length < 2) return 0;
	const a = new Date(String(raw[0])).getTime();
	const b = new Date(String(raw[1])).getTime();
	if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return 0;
	return (b - a) / 60000;
}

function collect_ref_ids(value: unknown, path: string[]): string[] {
	if (typeof value === 'string') {
		const trimmed = value.trim();
		if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
			try {
				return collect_ref_ids(JSON.parse(trimmed), path);
			} catch {
				/* id suelto, no JSON */
			}
		}
	}
	if (!path.length) {
		if (Array.isArray(value)) {
			return value.flatMap((entry) => {
				const id = ref_id(entry);
				return id ? [id] : [];
			});
		}
		const id = ref_id(value);
		return id ? [id] : [];
	}
	if (value == null) return [];
	if (Array.isArray(value)) {
		return value.flatMap((entry) => collect_ref_ids(entry, path));
	}
	if (typeof value !== 'object') return [];
	return collect_ref_ids((value as Record<string, unknown>)[path[0]!], path.slice(1));
}

function populated_lite(hit: ImperiumDoc | undefined, id: string): ImperiumDoc {
	if (!hit) return { _id: id, name: '' };
	return {
		_id: hit._id,
		name: hit.name ?? hit.nombreCompleto ?? '',
		description: hit.description ?? '',
		...(hit.codigo != null ? { codigo: hit.codigo } : {}),
		...(hit.image != null ? { image: hit.image } : {}),
	};
}

/** El populate sin select del original deja el documento; quita secretos de user/PIN. */
function strip_populated_secrets(resource: string, doc: ImperiumDoc): ImperiumDoc {
	const out = { ...doc };
	delete out.pin_hash;
	if (resource === 'user' || resource === 'usuario') {
		delete out.password;
		delete out.reset_password_token_hash;
		delete out.reset_password_expires;
		delete out.reset_password_kind;
		delete out.recovery_token;
		delete out.recovery_expires;
	}
	return out;
}

function pick_populated(
	hit: ImperiumDoc | undefined,
	id: string,
	full: boolean,
): ImperiumDoc {
	if (full) return hit ? { ...hit } : { _id: id, name: '' };
	return populated_lite(hit, id);
}

function apply_populated_path(
	target: Record<string, unknown>,
	path: string[],
	lookup: Map<string, ImperiumDoc> | undefined,
	full = false,
) {
	if (!path.length) return;
	const [head, ...rest] = path;
	const current = target[head!];
	if (typeof current === 'string') {
		const trimmed = current.trim();
		if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
			try {
				target[head!] = JSON.parse(trimmed);
			} catch {
				/* se deja el string */
			}
		}
	}
	if (!rest.length) {
		const val = target[head!];
		if (Array.isArray(val)) {
			target[head!] = val.map((entry) => {
				const id = ref_id(entry);
				return id ? pick_populated(lookup?.get(id), id, full) : entry;
			});
			return;
		}
		const id = ref_id(val);
		if (id) target[head!] = pick_populated(lookup?.get(id), id, full);
		return;
	}
	const val = target[head!];
	if (Array.isArray(val)) {
		target[head!] = val.map((entry) => {
			if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
			const copy = { ...(entry as Record<string, unknown>) };
			apply_populated_path(copy, rest, lookup, full);
			return copy;
		});
		return;
	}
	if (val && typeof val === 'object' && !Array.isArray(val)) {
		const copy = { ...(val as Record<string, unknown>) };
		apply_populated_path(copy, rest, lookup, full);
		target[head!] = copy;
	}
}

function ref_id(value: unknown): string {
	if (value == null || value === '') return '';
	if (typeof value === 'string') {
		const s = value.trim();
		if (s.startsWith('{') || (s.startsWith('"') && s.endsWith('"'))) {
			try {
				return ref_id(JSON.parse(s));
			} catch {
				return s.replace(/^"+|"+$/g, '');
			}
		}
		return s;
	}
	if (typeof value === 'object' && !Array.isArray(value)) {
		const o = value as Record<string, unknown>;
		const id = o._id ?? o.id;
		if (id == null || id === '') return '';
		return String(id).trim();
	}
	return String(value).trim();
}

function json_placeholder(index: number, json: boolean): string {
	return json ? `$${index}::jsonb` : `$${index}`;
}

const FILTER_FIELD_ALIASES: Record<string, string> = {
	updatedAt: 'updated_at',
	createdAt: 'created_at',
	_id: 'id',
	_ref: 'ref',
};

const RANGE_FILTER_TIMEZONE = process.env.APP_TIMEZONE || 'America/Mexico_City';

function physical_filter_field(cols: Set<string>, field: string) {
	const mapped = FILTER_FIELD_ALIASES[field] ?? field;
	if (mapped === 'fecha' && !cols.has('fecha') && cols.has('created_at')) return 'created_at';
	return mapped;
}

function is_range_filter(value: unknown): value is {
	gte?: unknown;
	lte?: unknown;
	gt?: unknown;
	lt?: unknown;
} {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const rec = value as Record<string, unknown>;
	return ('gte' in rec || 'lte' in rec || 'gt' in rec || 'lt' in rec) && !('in' in rec);
}

function range_bound(raw: string, op: 'gte' | 'lte') {
	const text = raw.trim();
	if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
		return zoned_day_bound(text, op === 'lte', RANGE_FILTER_TIMEZONE).toISOString();
	}
	const parsed = new Date(text);
	return Number.isNaN(parsed.getTime()) ? text : parsed.toISOString();
}

function zoned_day_bound(date_only: string, end_of_day: boolean, tz: string) {
	const [year, month, day] = date_only.split('-').map(Number);
	const hour = end_of_day ? 23 : 0;
	const minute = end_of_day ? 59 : 0;
	const second = end_of_day ? 59 : 0;
	const ms = end_of_day ? 999 : 0;
	return local_wall_time_to_utc(year!, month!, day!, hour, minute, second, ms, tz);
}

function local_wall_time_to_utc(
	year: number,
	month: number,
	day: number,
	hour: number,
	minute: number,
	second: number,
	ms: number,
	tz: string,
) {
	let utc = Date.UTC(year, month - 1, day, hour, minute, second, ms);
	for (let i = 0; i < 2; i++) {
		const offset = tz_offset_ms(new Date(utc), tz);
		utc = Date.UTC(year, month - 1, day, hour, minute, second, ms) - offset;
	}
	return new Date(utc);
}

function tz_offset_ms(date: Date, tz: string) {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone: tz,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hourCycle: 'h23',
	}).formatToParts(date);
	const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
	return (
		Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) -
		date.getTime()
	);
}

function range_compare_sql(
	cols: Set<string>,
	field: string,
	op: '>=' | '<=' | '>' | '<',
	index: number,
) {
	if (cols.has(field)) return `${qident(field)} ${op} $${index}`;
	return payload_field_range_sql(field, op, `$${index}`);
}

export function payload_field_range_sql(
	field: string,
	op: '>=' | '<=' | '>' | '<',
	param: string,
): string {
	const key = literal(field);
	return `payload ->> ${key} ${op} ${param}::text`;
}

/** Predicado sargable: el btree `(payload ->> campo)` lo cubre. */
export function payload_field_eq_sql(field: string, param: string): string {
	const key = literal(field);
	return `payload ->> ${key} = ${param}::text`;
}

export function payload_field_in_sql(field: string, marks: string[]): string {
	const key = literal(field);
	return `payload ->> ${key} IN (${marks.join(', ')})`;
}

function payload_distinct_expr(field: string): string {
	if (!field.includes('.')) return `payload ->> ${literal(field)}`;
	const parts = field.split('.').filter((part) => /^[a-z_][a-z0-9_]*$/i.test(part));
	if (!parts.length) throw new Error(`bad ident ${field}`);
	return `payload #>> '{${parts.join(',')}}'`;
}

/**
 * Bind JSONB: objeto/arreglo, no string. Bun.SQL + `::jsonb` re-encoda un string.
 * Entero/boolean van como texto JSON (`123`, `true`): PG no castea integer→jsonb
 * (`cannot cast type integer to jsonb` en counters como current_real_value).
 */
export function json_bind_value(v: unknown): unknown {
	if (v == null) return null;
	if (typeof v === 'number' || typeof v === 'boolean') return JSON.stringify(v);
	return typeof v === 'string' ? parse_json_cell(v) : v;
}

/** 0/1 del switch y el texto legado `true`/`false` de una columna que era text. */
export function pg_boolean(v: unknown): unknown {
	if (typeof v === 'string') {
		const text = v.trim().toLowerCase();
		if (
			text === 'true' ||
			text === 't' ||
			text === '1' ||
			text === 'yes' ||
			text === 'si' ||
			text === 'sí'
		) {
			return true;
		}
		if (
			text === 'false' ||
			text === 'f' ||
			text === '0' ||
			text === 'no' ||
			text === ''
		) {
			return false;
		}
		return v;
	}
	if (v === true || v === 1) return true;
	if (v === false || v === 0) return false;
	return v;
}

function cell(v: unknown, json: boolean, is_bool = false): unknown {
	if (v == null) return null;
	if (is_bool) return pg_boolean(v);
	if (json) return json_bind_value(v);
	if (Array.isArray(v) || (typeof v === 'object' && !(v instanceof Date))) {
		return JSON.stringify(v);
	}
	return v;
}

function literal(s: string): string {
	return `'${s.replace(/'/g, "''")}'`;
}

export function load_catalog_path(): string {
	return (
		process.env.CATALOG_PATH ??
		join(import.meta.dir, '../../catalog.json')
	);
}
