/**
 * Operador Docker de apps: pull/up al instalar; stop + rm contenedor +
 * rmi imagen al desinstalar. Nunca toca volúmenes ni DROP SCHEMA.
 *
 * El núcleo llama a SUBJECT_OPERATOR_URL si existe (sidecar con docker.sock).
 * Si no, intenta `docker compose` en el host (dev). Tests no setean
 * SUBJECT_COMPOSE_DIR → se omite Docker.
 */
export const BASE_SUBJECT_SLUGS = new Set([
	'configuracion',
	'configuraciones-de-vista',
	'planeacion',
]);

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const IMAGE_RE =
	/^ghcr\.io\/opus-perpetuus\/subject-[a-z0-9-]+:[A-Za-z0-9._-]+$/;
const SERVICE_RE = /^subject-[a-z0-9]+(-[a-z0-9]+)*$/;
const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export type SubjectRuntimeOp = 'install' | 'uninstall';

export type SubjectRuntimeResult = {
	ok: boolean;
	skipped: boolean;
	op: SubjectRuntimeOp;
	slug: string;
	service: string;
	image: string | null;
	steps: string[];
	error?: string;
};

export type SubjectRuntimeProgress = {
	phase: string;
	message: string;
	level: 'info' | 'success' | 'warning' | 'error';
};

function env(name: string, fallback = ''): string {
	return String(process.env[name] ?? fallback).trim();
}

export function is_base_subject_slug(slug: string): boolean {
	return BASE_SUBJECT_SLUGS.has(slug.replace(/^subject-/, ''));
}

export function normalize_subject_slug(value: string): string | null {
	const slug = String(value ?? '')
		.trim()
		.replace(/^subject-/, '');
	if (!slug || slug.length > 64 || !SLUG_RE.test(slug)) return null;
	return slug;
}

export function subject_service_name(slug: string): string {
	return `subject-${slug}`;
}

export function subject_image_ref(input: {
	slug: string;
	image?: string | null;
}): string {
	const slug = normalize_subject_slug(input.slug) ?? '';
	const tag = env('IMPERIUM_SUBJECT_TAG');
	const catalog = String(input.image ?? '').trim();
	if (catalog && IMAGE_RE.test(catalog)) {
		if (tag) return catalog.replace(/:[^:]+$/, `:${tag}`);
		return catalog;
	}
	const fallback_tag = tag || '0.1.0';
	return `ghcr.io/opus-perpetuus/subject-${slug}:${fallback_tag}`;
}

export function compose_profile_args(profiles: string[]): string[] {
	const out: string[] = [];
	for (const raw of profiles) {
		const profile = raw.trim();
		if (!profile || !/^[a-z0-9][a-z0-9_-]*$/i.test(profile)) continue;
		out.push('--profile', profile);
	}
	return out;
}

/** `-p` para que el sidecar no cree un proyecto llamado `compose`. */
export function compose_project_args(name: string): string[] {
	const project = name.trim();
	if (!project || !PROJECT_RE.test(project)) return [];
	return ['-p', project];
}

export function compose_install_args(
	service: string,
	profiles: string[],
): string[] {
	assert_service(service);
	return [
		...compose_profile_args(profiles),
		'up',
		'-d',
		'--no-deps',
		service,
	];
}

export function compose_stop_args(
	service: string,
	profiles: string[],
): string[] {
	assert_service(service);
	return [...compose_profile_args(profiles), 'stop', service];
}

export function compose_rm_args(service: string, profiles: string[]): string[] {
	assert_service(service);
	return [...compose_profile_args(profiles), 'rm', '-f', service];
}

function assert_service(service: string): void {
	if (!SERVICE_RE.test(service)) {
		throw new Error(`servicio docker inválido: ${service}`);
	}
}

function assert_image(image: string): void {
	if (!IMAGE_RE.test(image)) {
		throw new Error(`imagen docker inválida: ${image}`);
	}
}

function compose_files(): string[] {
	const raw =
		env('SUBJECT_COMPOSE_FILES') || env('COMPOSE_FILE') || 'compose.yml';
	return raw
		.split(':')
		.map((item) => item.trim())
		.filter((item) => /^[A-Za-z0-9._/-]+\.ya?ml$/.test(item));
}

function compose_dir(): string {
	return env('SUBJECT_COMPOSE_DIR');
}

function compose_profiles(): string[] {
	return env('SUBJECT_COMPOSE_PROFILES')
		.split(',')
		.map((item) => item.trim())
		.filter(Boolean);
}

async function resolve_compose_project(): Promise<string> {
	const from_env = env('COMPOSE_PROJECT_NAME');
	if (from_env && PROJECT_RE.test(from_env)) return from_env;
	const candidates = [env('HOSTNAME')];
	try {
		candidates.push((await Bun.file('/etc/hostname').text()).trim());
	} catch {
		/* ignore */
	}
	for (const hostname of candidates) {
		if (!hostname || !PROJECT_RE.test(hostname)) continue;
		const result = await run_cmd([
			'docker',
			'inspect',
			'-f',
			'{{ index .Config.Labels "com.docker.compose.project" }}',
			hostname,
		]);
		const name = (result.output.trim().split('\n').pop() ?? '').trim();
		if (PROJECT_RE.test(name)) return name;
	}
	return '';
}

function operator_url(): string {
	return env('SUBJECT_OPERATOR_URL').replace(/\/+$/, '');
}

function runtime_mode(): 'off' | 'docker' | 'auto' {
	const mode = env('SUBJECT_RUNTIME', 'auto').toLowerCase();
	if (mode === 'off' || mode === 'docker' || mode === 'auto') return mode;
	return 'auto';
}

export function docker_runtime_wanted(): boolean {
	const mode = runtime_mode();
	if (mode === 'off') return false;
	if (operator_url()) return true;
	if (mode === 'docker') return true;
	return Boolean(compose_dir());
}

function compose_bin(): string[] {
	const custom = env('SUBJECT_COMPOSE_BIN');
	if (custom) return [custom];
	return ['docker', 'compose'];
}

async function run_cmd(
	argv: string[],
	cwd?: string,
): Promise<{ ok: boolean; output: string }> {
	const proc = Bun.spawn(argv, {
		cwd: cwd || undefined,
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	const output = `${stdout}\n${stderr}`.trim();
	return { ok: code === 0, output };
}

function file_args(): string[] {
	const out: string[] = [];
	for (const file of compose_files()) {
		out.push('-f', file);
	}
	return out;
}

export async function run_subject_docker(
	op: SubjectRuntimeOp,
	input: { slug: string; image?: string | null },
	on_progress?: (event: SubjectRuntimeProgress) => void,
): Promise<SubjectRuntimeResult> {
	const slug = normalize_subject_slug(input.slug);
	if (!slug) {
		return {
			ok: false,
			skipped: false,
			op,
			slug: String(input.slug ?? ''),
			service: '',
			image: null,
			steps: [],
			error: 'slug inválido',
		};
	}
	if (op === 'uninstall' && is_base_subject_slug(slug)) {
		return {
			ok: false,
			skipped: false,
			op,
			slug,
			service: subject_service_name(slug),
			image: null,
			steps: [],
			error: 'las apps base no se desinstalan',
		};
	}
	const service = subject_service_name(slug);
	const image = subject_image_ref({ slug, image: input.image });
	if (!docker_runtime_wanted()) {
		return {
			ok: true,
			skipped: true,
			op,
			slug,
			service,
			image,
			steps: ['skipped'],
		};
	}
	const remote = operator_url();
	if (remote) {
		return call_operator(remote, op, { slug, image }, on_progress);
	}
	return run_subject_docker_local(op, { slug, service, image }, on_progress);
}

async function call_operator(
	base: string,
	op: SubjectRuntimeOp,
	input: { slug: string; image: string },
	on_progress?: (event: SubjectRuntimeProgress) => void,
): Promise<SubjectRuntimeResult> {
	on_progress?.({
		phase: 'docker',
		message:
			op === 'install'
				? 'Descargando y arrancando el contenedor…'
				: 'Deteniendo y borrando la imagen Docker…',
		level: 'info',
	});
	const secret = env('CORE_SUBJECT_GATEWAY_SECRET');
	try {
		const res = await fetch(`${base}/runtime/${input.slug}/${op}`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-core-subject-gateway-secret': secret,
			},
			body: JSON.stringify({ image: input.image }),
			signal: AbortSignal.timeout(10 * 60 * 1000),
		});
		const json = (await res.json().catch(() => ({}))) as SubjectRuntimeResult;
		if (!res.ok) {
			return {
				ok: false,
				skipped: false,
				op,
				slug: input.slug,
				service: subject_service_name(input.slug),
				image: input.image,
				steps: json.steps ?? [],
				error: json.error || `operator http ${res.status}`,
			};
		}
		return json;
	} catch (err) {
		return {
			ok: false,
			skipped: false,
			op,
			slug: input.slug,
			service: subject_service_name(input.slug),
			image: input.image,
			steps: [],
			error: String(err),
		};
	}
}

export async function run_subject_docker_local(
	op: SubjectRuntimeOp,
	input: { slug: string; service: string; image: string },
	on_progress?: (event: SubjectRuntimeProgress) => void,
): Promise<SubjectRuntimeResult> {
	assert_service(input.service);
	assert_image(input.image);
	const dir = compose_dir();
	const steps: string[] = [];
	if (!dir) {
		return {
			ok: false,
			skipped: false,
			op,
			slug: input.slug,
			service: input.service,
			image: input.image,
			steps,
			error: 'SUBJECT_COMPOSE_DIR no está definido',
		};
	}
	const bin = compose_bin();
	const files = file_args();
	const profiles = compose_profiles();
	const project = compose_project_args(await resolve_compose_project());
	const run_compose = async (args: string[], label: string) => {
		const argv = [...bin, ...project, ...files, ...args];
		const result = await run_cmd(argv, dir);
		steps.push(label);
		if (!result.ok) {
			throw new Error(result.output || `falló ${label}`);
		}
	};
	try {
		if (op === 'install') {
			on_progress?.({
				phase: 'docker_up',
				message: 'Descargando la imagen y arrancando la app…',
				level: 'info',
			});
			await run_compose(
				compose_install_args(input.service, profiles),
				'compose up',
			);
			return {
				ok: true,
				skipped: false,
				op,
				slug: input.slug,
				service: input.service,
				image: input.image,
				steps,
			};
		}
		on_progress?.({
			phase: 'docker_stop',
			message: 'Deteniendo el contenedor…',
			level: 'info',
		});
		await run_compose(
			compose_stop_args(input.service, profiles),
			'compose stop',
		);
		on_progress?.({
			phase: 'docker_rm',
			message: 'Eliminando el contenedor…',
			level: 'info',
		});
		await run_compose(compose_rm_args(input.service, profiles), 'compose rm');
		on_progress?.({
			phase: 'docker_rmi',
			message: 'Borrando la imagen Docker…',
			level: 'info',
		});
		const rmi = await run_cmd(['docker', 'rmi', '-f', input.image], dir);
		steps.push('docker rmi');
		if (!rmi.ok && !/no such image/i.test(rmi.output)) {
			throw new Error(rmi.output || 'falló docker rmi');
		}
		return {
			ok: true,
			skipped: false,
			op,
			slug: input.slug,
			service: input.service,
			image: input.image,
			steps,
		};
	} catch (err) {
		return {
			ok: false,
			skipped: false,
			op,
			slug: input.slug,
			service: input.service,
			image: input.image,
			steps,
			error: String(err),
		};
	}
}

function operator_secret_ok(req: Request): boolean {
	const expected = env('CORE_SUBJECT_GATEWAY_SECRET');
	if (!expected) return false;
	const got =
		req.headers.get('x-core-subject-gateway-secret') ??
		req.headers.get('x-nox-kirlet-gateway-secret') ??
		'';
	return got === expected;
}

export async function handle_operator_http(req: Request): Promise<Response> {
	const url = new URL(req.url);
	if (url.pathname === '/health') {
		return Response.json({ ok: true, unit: 'subject-operator' });
	}
	if (!operator_secret_ok(req)) {
		return Response.json({ error: 'forbidden' }, { status: 403 });
	}
	const hit = url.pathname.match(
		/^\/runtime\/([a-z0-9-]+)\/(install|uninstall)\/?$/,
	);
	if (!hit || req.method !== 'POST') {
		return Response.json({ error: 'not found' }, { status: 404 });
	}
	const slug = normalize_subject_slug(hit[1]!);
	if (!slug) {
		return Response.json({ error: 'invalid slug' }, { status: 400 });
	}
	let image = '';
	try {
		const body = (await req.json()) as { image?: string };
		image = String(body.image ?? '');
	} catch {
		image = '';
	}
	if (!image) image = subject_image_ref({ slug });
	const result = await run_subject_docker_local(
		hit[2] as SubjectRuntimeOp,
		{
			slug,
			service: subject_service_name(slug),
			image: subject_image_ref({ slug, image }),
		},
	);
	return Response.json(result, { status: result.ok ? 200 : 500 });
}
