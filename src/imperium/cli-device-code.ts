/**
 * Inicio de sesión de la CLI por código de dispositivo (RFC 8628, #444).
 *
 * 1. La CLI pide un código: `POST /api/cli/device/code` (público).
 * 2. La persona abre `/api/cli/device` en el navegador con su sesión de la GUI,
 *    escribe el código corto y aprueba (`POST /api/cli/device/approve`).
 * 3. La CLI pregunta cada `interval` segundos en `POST /api/cli/device/token`
 *    y, una vez aprobado, recibe un token `icli_` del mismo usuario. La CLI
 *    nunca ve la contraseña.
 *
 * Los códigos pendientes viven en memoria, como el resto de los límites de
 * tasa: duran diez minutos y un reinicio del núcleo los invalida (la CLI
 * recibe `expired_token` y sale con código 4, sin reintentar sola).
 */
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { gui_session_user } from './auth.ts';
import { request_ip } from './auth-rate-limit.ts';
import { read_imperium_body } from './body.ts';
import { has_cli_gate, issue_token } from './cli-token.ts';
import { as_object, type ImperiumDoc } from './envelope.ts';
import { take_token, type BucketRule } from './rate-bucket.ts';
import type { ImperiumStore } from './store.ts';

export const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';
export const DEVICE_CODE_TTL_S = 600;
export const DEVICE_POLL_INTERVAL_S = 5;
export const DEVICE_SLOW_DOWN_STEP_S = 5;
export const DEVICE_VERIFICATION_PATH = '/api/cli/device';
/** Sin vocales ni dígitos ambiguos (RFC 8628 §6.1): 20^8 combinaciones. */
const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';
const USER_CODE_LENGTH = 8;
const MAX_PENDING = 1000;

const CODE_IP_RULE: BucketRule = { capacity: 10, refill_per_s: 10 / 600 };
const TOKEN_IP_RULE: BucketRule = { capacity: 120, refill_per_s: 1 };
const APPROVE_USER_RULE: BucketRule = { capacity: 10, refill_per_s: 10 / 300 };

type DeviceStatus = 'pending' | 'approved' | 'denied';

type PendingDevice = {
	device_hash: string;
	user_code: string;
	device_name: string;
	created_at: number;
	expires_at: number;
	interval_s: number;
	last_poll_at: number;
	status: DeviceStatus;
	user_id: string | null;
};

const by_device = new Map<string, PendingDevice>();
const by_user_code = new Map<string, string>();

let device_now = (): number => Date.now();
type SessionLookup = (sql: Bun.SQL, req: Request) => Promise<ImperiumDoc | null>;
let session_lookup: SessionLookup = gui_session_user;

/** Pruebas: fija el reloj del flujo de dispositivo. */
export function pin_device_clock(at: number | null): void {
	device_now = at === null ? () => Date.now() : () => at;
}

/** Pruebas: sustituye la búsqueda de la sesión de la GUI. */
export function bind_device_session_lookup(fn: SessionLookup | null): void {
	session_lookup = fn ?? gui_session_user;
}

/** Pruebas: vacía los códigos pendientes. */
export function reset_device_codes(): void {
	by_device.clear();
	by_user_code.clear();
}

function hash(value: string): string {
	return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function normalize_user_code(raw: unknown): string {
	const clean = String(raw ?? '')
		.toUpperCase()
		.replace(/[^A-Z]/g, '');
	if (clean.length !== USER_CODE_LENGTH) return '';
	for (const ch of clean) if (!USER_CODE_ALPHABET.includes(ch)) return '';
	return `${clean.slice(0, 4)}-${clean.slice(4)}`;
}

function new_user_code(): string {
	for (let attempt = 0; attempt < 20; attempt++) {
		let raw = '';
		for (let i = 0; i < USER_CODE_LENGTH; i++) raw += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
		const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
		if (!by_user_code.has(code)) return code;
	}
	throw Object.assign(new Error('No se pudo generar un código; intenta de nuevo.'), { status: 503 });
}

function sweep(now: number): void {
	for (const [key, row] of by_device) {
		if (row.expires_at <= now) {
			by_device.delete(key);
			by_user_code.delete(row.user_code);
		}
	}
}

function forget(row: PendingDevice): void {
	by_device.delete(row.device_hash);
	by_user_code.delete(row.user_code);
}

function oauth_error(status: number, error: string, description: string, extra: Record<string, unknown> = {}): Response {
	return Response.json(
		{ ok: false, error, error_description: description, message: description, ...extra },
		{ status, headers: { 'cache-control': 'no-store' } },
	);
}

function limited(retry_after_s: number): Response {
	return Response.json(
		{
			ok: false,
			error: 'rate_limited',
			error_description: `Demasiadas solicitudes; intenta de nuevo en ${retry_after_s} s.`,
			message: `Demasiadas solicitudes; intenta de nuevo en ${retry_after_s} s.`,
		},
		{ status: 429, headers: { 'retry-after': String(retry_after_s), 'cache-control': 'no-store' } },
	);
}

function text(value: unknown, max = 120): string {
	return String(value ?? '').trim().slice(0, max);
}

async function request_code(req: Request, url: URL): Promise<Response> {
	const gate = take_token(`cli-device:code-ip:${request_ip(req)}`, CODE_IP_RULE, device_now());
	if (!gate.ok) return limited(gate.retry_after_s);
	const now = device_now();
	sweep(now);
	if (by_device.size >= MAX_PENDING) {
		return oauth_error(503, 'temporarily_unavailable', 'Hay demasiados códigos pendientes; intenta en unos minutos.');
	}
	const body = as_object(await read_imperium_body(req).catch(() => ({})));
	const device_name = text(body.device_name ?? body.name) || 'CLI';
	const device_code = randomBytes(32).toString('base64url');
	const user_code = new_user_code();
	const row: PendingDevice = {
		device_hash: hash(device_code),
		user_code,
		device_name,
		created_at: now,
		expires_at: now + DEVICE_CODE_TTL_S * 1000,
		interval_s: DEVICE_POLL_INTERVAL_S,
		last_poll_at: 0,
		status: 'pending',
		user_id: null,
	};
	by_device.set(row.device_hash, row);
	by_user_code.set(user_code, row.device_hash);
	const verification_uri = `${url.origin}${DEVICE_VERIFICATION_PATH}`;
	return Response.json(
		{
			device_code,
			user_code,
			verification_uri,
			verification_uri_complete: `${verification_uri}?user_code=${encodeURIComponent(user_code)}`,
			verification_path: DEVICE_VERIFICATION_PATH,
			expires_in: DEVICE_CODE_TTL_S,
			interval: DEVICE_POLL_INTERVAL_S,
		},
		{ headers: { 'cache-control': 'no-store' } },
	);
}

async function poll_token(store: ImperiumStore, req: Request): Promise<Response> {
	const gate = take_token(`cli-device:token-ip:${request_ip(req)}`, TOKEN_IP_RULE, device_now());
	if (!gate.ok) return limited(gate.retry_after_s);
	const body = as_object(await read_imperium_body(req).catch(() => ({})));
	if (text(body.grant_type, 200) !== DEVICE_GRANT_TYPE) {
		return oauth_error(400, 'unsupported_grant_type', `grant_type debe ser ${DEVICE_GRANT_TYPE}.`);
	}
	const device_code = text(body.device_code, 200);
	const row = device_code ? by_device.get(hash(device_code)) : undefined;
	const now = device_now();
	if (!row) return oauth_error(400, 'invalid_grant', 'El código de dispositivo no es válido o ya se usó.');
	if (row.expires_at <= now) {
		forget(row);
		return oauth_error(400, 'expired_token', 'El código de dispositivo expiró. Vuelve a iniciar sesión.');
	}
	if (row.status === 'denied') {
		forget(row);
		return oauth_error(400, 'access_denied', 'La solicitud se rechazó en el navegador.');
	}
	if (row.status === 'pending') {
		if (row.last_poll_at && now - row.last_poll_at < row.interval_s * 1000) {
			row.interval_s += DEVICE_SLOW_DOWN_STEP_S;
			row.last_poll_at = now;
			return oauth_error(400, 'slow_down', 'Preguntas demasiado seguido; espera más entre intentos.', {
				interval: row.interval_s,
			});
		}
		row.last_poll_at = now;
		return oauth_error(400, 'authorization_pending', 'Aún no se aprueba el código en el navegador.', {
			interval: row.interval_s,
		});
	}
	// Aprobado: un solo uso.
	forget(row);
	const user = row.user_id ? await store.find_id('user', row.user_id) : null;
	if (!user || user.is_active === false || !(await has_cli_gate(store, user))) {
		return oauth_error(400, 'access_denied', 'Tu usuario ya no puede usar la CLI de Imperium.');
	}
	const issued = await issue_token(
		store,
		user,
		{ name: row.device_name, device_name: row.device_name },
		'Token CLI emitido por código de dispositivo.',
	);
	const token = issued.data[0] as Record<string, unknown>;
	return Response.json(
		{
			access_token: token.token,
			token_type: 'Bearer',
			token_prefix: token.token_prefix,
			id: token.id,
			device_name: token.device_name,
			user: { _id: String(user._id ?? ''), name: user.name ?? null, email: user.email ?? null },
		},
		{ headers: { 'cache-control': 'no-store' } },
	);
}

function same_origin(req: Request): boolean {
	const origin = req.headers.get('origin');
	if (!origin) return true;
	const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? '';
	try {
		return new URL(origin).host === host.split(',')[0]!.trim();
	} catch {
		return false;
	}
}

async function approver(store: ImperiumStore, sql: Bun.SQL, req: Request): Promise<ImperiumDoc | Response> {
	const user = await session_lookup(sql, req);
	if (!user) {
		return oauth_error(401, 'session_required', 'Inicia sesión en Imperium desde el navegador para aprobar la CLI.');
	}
	if (!(await has_cli_gate(store, user))) {
		return oauth_error(403, 'cli_gate_denied', 'Tu usuario no puede usar la CLI de Imperium. Contacta a un administrador.');
	}
	return user;
}

function pending_by_code(raw: unknown): PendingDevice | null {
	const code = normalize_user_code(raw);
	if (!code) return null;
	const key = by_user_code.get(code);
	const row = key ? by_device.get(key) : undefined;
	if (!row || row.status !== 'pending' || row.expires_at <= device_now()) return null;
	return row;
}

async function verify_code(store: ImperiumStore, sql: Bun.SQL, req: Request, url: URL): Promise<Response> {
	const user = await approver(store, sql, req);
	if (user instanceof Response) return user;
	const gate = take_token(`cli-device:approve-user:${String(user._id)}`, APPROVE_USER_RULE, device_now());
	if (!gate.ok) return limited(gate.retry_after_s);
	const row = pending_by_code(url.searchParams.get('user_code'));
	if (!row) return oauth_error(404, 'invalid_user_code', 'El código no existe o ya expiró.');
	return Response.json({
		ok: true,
		user_code: row.user_code,
		device_name: row.device_name,
		expires_in: Math.max(0, Math.round((row.expires_at - device_now()) / 1000)),
	});
}

async function approve_code(store: ImperiumStore, sql: Bun.SQL, req: Request): Promise<Response> {
	if (!(req.headers.get('content-type') ?? '').toLowerCase().includes('application/json')) {
		return oauth_error(415, 'unsupported_media_type', 'Envía la aprobación como JSON.');
	}
	if (!same_origin(req)) {
		return oauth_error(403, 'cross_origin', 'La aprobación debe venir de la misma instancia.');
	}
	const user = await approver(store, sql, req);
	if (user instanceof Response) return user;
	const gate = take_token(`cli-device:approve-user:${String(user._id)}`, APPROVE_USER_RULE, device_now());
	if (!gate.ok) return limited(gate.retry_after_s);
	const body = as_object(await read_imperium_body(req).catch(() => ({})));
	const row = pending_by_code(body.user_code);
	if (!row) return oauth_error(404, 'invalid_user_code', 'El código no existe o ya expiró.');
	const deny = body.accion === 'rechazar' || body.deny === true;
	if (deny) {
		row.status = 'denied';
		return Response.json({ ok: true, status: 'denied', message: 'Solicitud rechazada.' });
	}
	row.status = 'approved';
	row.user_id = String(user._id ?? '');
	return Response.json({
		ok: true,
		status: 'approved',
		device_name: row.device_name,
		message: `Listo: «${row.device_name}» ya puede usar la CLI con tu cuenta.`,
	});
}

const PAGE = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Imperium · Conectar la CLI</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;line-height:1.5}
input{font-size:1.5rem;letter-spacing:.2em;text-transform:uppercase;width:12ch;padding:.3rem}
button{font-size:1rem;padding:.4rem 1rem;margin:.5rem .5rem 0 0}#msg{margin-top:1rem}</style></head>
<body><main><h1>Conectar la CLI de Imperium</h1>
<p>Escribe el código que muestra tu terminal. La CLI usará tu cuenta y tus permisos; nunca verá tu contraseña.</p>
<form id="f"><label for="code">Código</label><br><input id="code" name="user_code" autocomplete="off" maxlength="9" required>
<div><button type="submit" name="accion" value="aprobar">Aprobar</button><button type="button" id="deny">Rechazar</button></div></form>
<p id="msg" role="status" aria-live="polite"></p></main>
<script>
const q=new URLSearchParams(location.search);const input=document.getElementById('code');const msg=document.getElementById('msg');
input.value=q.get('user_code')||'';
async function send(accion){msg.textContent='Enviando…';
 const r=await fetch('${DEVICE_VERIFICATION_PATH}/approve',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({user_code:input.value,accion})});
 const j=await r.json().catch(()=>({}));msg.textContent=j.message||j.error_description||('Error '+r.status);
 if(r.status===401){msg.textContent+=' Abre Imperium, inicia sesión y vuelve a esta página.';}}
document.getElementById('f').addEventListener('submit',e=>{e.preventDefault();send('aprobar');});
document.getElementById('deny').addEventListener('click',()=>send('rechazar'));
</script></body></html>`;

/** `rest` es la ruta después de `/api/cli`. Devuelve null si no es del flujo de dispositivo. */
export async function handle_cli_device(
	store: ImperiumStore,
	sql: Bun.SQL,
	req: Request,
	url: URL,
	rest: string,
): Promise<Response | null> {
	const path = rest.replace(/\/+$/, '') || '/';
	if (path !== '/device' && !path.startsWith('/device/')) return null;
	const method = req.method.toUpperCase();
	if (method === 'GET' && path === '/device') {
		return new Response(PAGE, {
			headers: {
				'content-type': 'text/html; charset=utf-8',
				'cache-control': 'no-store',
				'x-frame-options': 'DENY',
				'referrer-policy': 'no-referrer',
			},
		});
	}
	if (method === 'POST' && path === '/device/code') return request_code(req, url);
	if (method === 'POST' && path === '/device/token') return poll_token(store, req);
	if (method === 'GET' && path === '/device/verify') return verify_code(store, sql, req, url);
	if (method === 'POST' && path === '/device/approve') return approve_code(store, sql, req);
	return oauth_error(404, 'not_found', 'Ruta CLI no encontrada');
}
