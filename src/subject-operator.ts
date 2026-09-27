/**
 * HTTP sidecar: docker.sock + compose del host. El núcleo no monta el socket.
 */
import { print_console_log } from './imperium/debug-request-log.ts';
import { handle_operator_http } from './imperium/subject-runtime.ts';
import { master_secret } from './imperium/subject-secret.ts';

const PORT = Number(process.env.SUBJECT_OPERATOR_PORT ?? 3200);

process.env.SUBJECT_OPERATOR_URL = '';
process.env.SUBJECT_RUNTIME = process.env.SUBJECT_RUNTIME || 'docker';

if (!master_secret()) {
	print_console_log(
		'warning',
		'CORE_SUBJECT_GATEWAY_SECRET no está definido: el operador responde 403 a todo y el núcleo no puede instalar, actualizar ni desinstalar apps.',
	);
}

const server = Bun.serve({
	port: PORT,
	fetch: handle_operator_http,
});

console.log(`subject-operator listening on :${server.port}`);
