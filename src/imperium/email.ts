/**
 * SMTP — mismo contrato que EmailSettingsService + EmailService.
 */
import type { ImperiumStore } from './store.ts';

export type EmailSettings = {
	host: string;
	port: number;
	secure: boolean;
	user: string;
	pass: string;
	from: string;
	app_name: string;
	recovery_domain: string;
};

function cfg_text(value: unknown) {
	return String(value ?? '').replace(/^"+|"+$/g, '').trim();
}

function cfg_bool(value: unknown, fallback = false) {
	if (value === true || value === 1) return true;
	if (value === false || value === 0) return false;
	const raw = cfg_text(value).toLowerCase();
	if (!raw) return fallback;
	return !['0', 'false', 'off', 'no'].includes(raw);
}

async function cfg_ref(store: ImperiumStore, ref: string) {
	if (!store.has('configuration')) return '';
	return cfg_text((await store.find_where('configuration', { ref }))?.value);
}

function env_text(...names: string[]) {
	for (const name of names) {
		const value = cfg_text(process.env[name]);
		if (value) return value;
	}
	return '';
}

function managed_mail() {
	const raw = String(process.env.IMPERIUM_MANAGED_MAIL ?? '').trim().toLowerCase();
	if (!['1', 'true', 'yes'].includes(raw)) return false;
	return Boolean(
		env_text('CORREO_TRANSPORT_HOST') &&
			env_text('CORREO_TRANSPORT_AUTH_USER') &&
			env_text('CORREO_TRANSPORT_AUTH_PASS'),
	);
}

function settings_from_env(): EmailSettings {
	const port = Number(env_text('CORREO_TRANSPORT_PORT') || 587);
	return {
		host: env_text('CORREO_TRANSPORT_HOST'),
		port: Number.isFinite(port) ? port : 587,
		secure: cfg_bool(env_text('CORREO_TRANSPORT_SECURE'), port === 465),
		user: env_text('CORREO_TRANSPORT_AUTH_USER'),
		pass: env_text('CORREO_TRANSPORT_AUTH_PASS'),
		from: env_text('CORREO_MAILOPTIONS_FROM', 'CORREO_TRANSPORT_AUTH_USER'),
		app_name: env_text('CORREO_NOMBRE_APLICACION') || 'la plataforma',
		recovery_domain: env_text('CORREO_DOMINIO_RECUPERACION', 'CORREO_DOMINIO', 'ORIGIN'),
	};
}

export async function resolve_email_settings(store: ImperiumStore): Promise<EmailSettings> {
	if (managed_mail()) return settings_from_env();
	const mode = (await cfg_ref(store, 'configuration-email-mode')).toLowerCase();
	if (mode === 'custom') {
		const port = Number((await cfg_ref(store, 'configuration-email-smtp-port')) || 587);
		return {
			host: await cfg_ref(store, 'configuration-email-smtp-host'),
			port: Number.isFinite(port) ? port : 587,
			secure: cfg_bool(await cfg_ref(store, 'configuration-email-smtp-secure'), port === 465),
			user: await cfg_ref(store, 'configuration-email-smtp-user'),
			pass: await cfg_ref(store, 'configuration-email-smtp-pass'),
			from:
				(await cfg_ref(store, 'configuration-email-from')) ||
				env_text('CORREO_MAILOPTIONS_FROM'),
			app_name:
				(await cfg_ref(store, 'configuration-email-app-name')) ||
				env_text('CORREO_NOMBRE_APLICACION') ||
				'la plataforma',
			recovery_domain:
				(await cfg_ref(store, 'configuration-email-app-domain')) ||
				env_text('CORREO_DOMINIO_RECUPERACION', 'CORREO_DOMINIO', 'ORIGIN'),
		};
	}
	return settings_from_env();
}

export function email_is_configured(settings: EmailSettings) {
	return Boolean(settings.host && settings.user && settings.pass);
}

export function build_recovery_link(settings: EmailSettings, raw_token: string, origin = '') {
	const candidate = (settings.recovery_domain || origin).split(',')[0]!.trim().replace(/\/+$/, '');
	const path = '/usuario/recuperar-contrasena';
	const root = candidate.endsWith(path) ? candidate.slice(0, -path.length) : candidate;
	return `${root}${path}?codigo=${raw_token}`;
}

export async function send_password_reset_email(input: {
	settings: EmailSettings;
	to: string;
	link: string;
	kind: 'recovery' | 'invitation';
	user_name?: string;
}) {
	if (!email_is_configured(input.settings)) {
		throw new Error(
			'El servicio de correo no está configurado (revisa Configuración → Correo o las variables CORREO_*).',
		);
	}
	const app_name = input.settings.app_name || 'la plataforma';
	const is_invitation = input.kind === 'invitation';
	const greeting = input.user_name ? `Hola ${input.user_name},` : 'Hola,';
	const subject = is_invitation
		? `Invitación para acceder a ${app_name}`
		: `Tu código de acceso a ${app_name}`;
	const heading = is_invitation ? 'Te damos la bienvenida' : 'Accede a tu cuenta';
	const intro = is_invitation
		? `Se creó una cuenta para ti en ${app_name}. Usa el botón para entrar directamente; ya dentro podrás definir una contraseña desde tu perfil si lo deseas.`
		: `Recibimos una solicitud para acceder a tu cuenta en ${app_name}. Usa el botón para entrar directamente; el enlace es de un solo uso. Podrás cambiar tu contraseña desde tu perfil.`;
	const button_label = 'Entrar a mi cuenta';
	const ignore_note = is_invitation
		? 'Si no esperabas esta invitación, puedes ignorar este correo.'
		: 'Si tú no solicitaste este acceso, puedes ignorar este correo; tu cuenta seguirá protegida.';
	const html = `<!doctype html><html><body style="font-family:sans-serif">
<p>${greeting}</p><h2>${heading}</h2><p>${intro}</p>
<p><a href="${input.link}">${button_label}</a></p><p>${ignore_note}</p>
</body></html>`;
	const text = `${greeting}\n\n${intro}\n\n${button_label}: ${input.link}\n\n${ignore_note}`;
	const nodemailer = await import('nodemailer');
	const transporter = nodemailer.createTransport({
		host: input.settings.host,
		port: input.settings.port,
		secure: input.settings.secure,
		auth: { user: input.settings.user, pass: input.settings.pass },
	});
	await transporter.sendMail({
		from: input.settings.from || input.settings.user,
		to: input.to,
		subject,
		html,
		text,
	});
}
