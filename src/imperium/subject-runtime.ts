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

export type SubjectRuntimeOp = 'install' | 'uninstall' | 'update';

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

/**
 * Variable por app que el compose interpola en su `image:`
 * (`…/subject-pos:${IMPERIUM_SUBJECT_TAG_POS:-<pin>}`). Es el ÚNICO selector de
 * versión que tenemos: el directorio de compose se monta `:ro`, así que el tag
 * viaja por entorno hasta el `docker compose` que lanza el operador.
 */
export function subject_tag_env_name(slug: string): string {
	return `IMPERIUM_SUBJECT_TAG_${slug.replace(/-/g, '_').toUpperCase()}`;
}

/** `ghcr.io/…/subject-pos:0.1.2` → `0.1.2`. */
export function image_tag(image: string | null | undefined): string {
	const raw = String(image ?? '').trim();
	if (!raw || !IMAGE_RE.test(raw)) return '';
	return raw.split(':').pop() ?? '';
}

/**
 * Entorno extra para el `docker compose` de una app: fija su tag.
 *
 * `${VAR:-default}` cae al default tanto si la variable falta como si viene
 * vacía, así que un tag en blanco no se publica: se deja que mande el pin del
 * compose en vez de arrastrar la app a una imagen inexistente.
 */
export function subject_tag_env(
	slug: string,
	image: string | null | undefined,
): Record<string, string> {
	const tag = image_tag(image);
	if (!tag) return {};
	return { [subject_tag_env_name(slug)]: tag };
}

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

/**
 * Imagen efectiva de una app, por precedencia:
 *
 *   1. `IMPERIUM_SUBJECT_TAG_<SLUG>` — el selector por app.
 *   2. la imagen que se pasa (lo instalado en `subject_installs`, o el pin del
 *      catálogo).
 *   3. `IMPERIUM_SUBJECT_TAG` — palanca global, para pinar toda la flota.
 *   4. `0.1.0`.
 *
 * El global estaba por ENCIMA de la imagen recibida, así que reescribía a su
 * valor el tag de todas las apps. Como el compose lo trae puesto a `0.1.0` por
 * defecto, el `docker rmi` del desinstalar apuntaba a una imagen que no era la
 * que corría y se iba en silencio por el `no such image`. Debajo de la imagen
 * concreta sigue sirviendo para pinar la flota, que es para lo que está.
 */
export function subject_image_ref(input: {
	slug: string;
	image?: string | null;
}): string {
	const slug = normalize_subject_slug(input.slug) ?? '';
	const per_app = env(subject_tag_env_name(slug));
	const global_tag = env('IMPERIUM_SUBJECT_TAG');
	const given = String(input.image ?? '').trim();
	if (per_app) {
		return `ghcr.io/opus-perpetuus/subject-${slug}:${per_app}`;
	}
	if (given && IMAGE_RE.test(given)) {
		return given;
	}
	const fallback_tag = global_tag || '0.1.0';
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

/**
 * Recrear con la imagen nueva. `--force-recreate` porque cuando se republica
 * el MISMO tag el `image:` interpolado no cambia y compose dejaría el
 * contenedor viejo en pie; `--pull always` porque el pin puede haberse movido
 * bajo el mismo tag.
 */
export function compose_update_args(
	service: string,
	profiles: string[],
): string[] {
	assert_service(service);
	return [
		...compose_profile_args(profiles),
		'up',
		'-d',
		'--no-deps',
		'--force-recreate',
		'--pull',
		'always',
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
	extra_env?: Record<string, string>,
): Promise<{ ok: boolean; output: string }> {
	const proc = Bun.spawn(argv, {
		cwd: cwd || undefined,
		// `env` sustituye el entorno entero, así que se parte de `process.env`:
		// sin él el hijo perdería PATH, DOCKER_HOST y el resto.
		env:
			extra_env && Object.keys(extra_env).length
				? { ...process.env, ...extra_env }
				: undefined,
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
				: op === 'update'
					? `Descargando la versión ${image_tag(input.image) || 'nueva'} y recreando el contenedor…`
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
	// El tag pedido viaja hasta el `image:` del compose por esta variable. El
	// directorio se monta `:ro`, así que es la única forma de elegir versión.
	const tag_env = subject_tag_env(input.slug, input.image);
	const run_compose = async (args: string[], label: string) => {
		const argv = [...bin, ...project, ...files, ...args];
		const result = await run_cmd(argv, dir, tag_env);
		steps.push(label);
		if (!result.ok) {
			throw new Error(result.output || `falló ${label}`);
		}
	};
	try {
		if (op === 'update') {
			on_progress?.({
				phase: 'docker_pull',
				message: `Descargando la versión ${image_tag(input.image) || 'nueva'}…`,
				level: 'info',
			});
			await run_compose(
				compose_update_args(input.service, profiles),
				'compose up --force-recreate',
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

/**
 * Imagen con la que corre AHORA MISMO el contenedor de una app.
 *
 * Es observación, no deducción: `docker inspect` del contenedor que compose
 * tiene levantado para ese servicio. Sirve para rellenar `installed_image` en
 * instalaciones anteriores a esa columna, donde el sistema no sabía qué
 * versión estaba sirviendo.
 *
 * Cadena vacía = no hay contenedor (app parada o no instalada). No se
 * confunde con "no se sabe": el llamador decide qué hacer con cada caso.
 */
export async function inspect_subject_image(slug: string): Promise<string> {
	const clean = normalize_subject_slug(slug);
	if (!clean) return '';
	const dir = compose_dir();
	if (!dir) return '';
	const service = subject_service_name(clean);
	assert_service(service);
	const bin = compose_bin();
	const project = compose_project_args(await resolve_compose_project());
	const files = file_args();
	const ps = await run_cmd(
		[...bin, ...project, ...files, 'ps', '-aq', service],
		dir,
	);
	const id = ps.output.trim().split('\n').filter(Boolean).pop() ?? '';
	if (!ps.ok || !/^[0-9a-f]{12,64}$/i.test(id)) return '';
	const inspect = await run_cmd(
		['docker', 'inspect', '-f', '{{ .Config.Image }}', id],
		dir,
	);
	const image = inspect.output.trim().split('\n').filter(Boolean).pop() ?? '';
	return inspect.ok && IMAGE_RE.test(image) ? image : '';
}

/** Pregunta la imagen al operador remoto; local si no hay sidecar. */
export async function resolve_running_subject_image(
	slug: string,
): Promise<string> {
	const clean = normalize_subject_slug(slug);
	if (!clean || !docker_runtime_wanted()) return '';
	const remote = operator_url();
	if (!remote) return inspect_subject_image(clean);
	try {
		const res = await fetch(`${remote}/runtime/${clean}/image`, {
			headers: {
				'x-core-subject-gateway-secret': env(
					'CORE_SUBJECT_GATEWAY_SECRET',
				),
			},
			signal: AbortSignal.timeout(30 * 1000),
		});
		if (!res.ok) return '';
		const json = (await res.json().catch(() => ({}))) as { image?: string };
		const image = String(json.image ?? '');
		return IMAGE_RE.test(image) ? image : '';
	} catch {
		return '';
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
	const peek = url.pathname.match(/^\/runtime\/([a-z0-9-]+)\/image\/?$/);
	if (peek && req.method === 'GET') {
		const slug = normalize_subject_slug(peek[1]!);
		if (!slug) {
			return Response.json({ error: 'invalid slug' }, { status: 400 });
		}
		return Response.json({ image: await inspect_subject_image(slug) });
	}
	const hit = url.pathname.match(
		/^\/runtime\/([a-z0-9-]+)\/(install|uninstall|update)\/?$/,
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
