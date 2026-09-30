/**
 * HTTP sidecar: docker.sock + compose del host. El núcleo no monta el socket.
 */
import { print_console_log } from './imperium/debug-request-log.ts';
import { handle_operator_http } from './imperium/subject-runtime.ts';
import { is_master_request, master_secret } from './imperium/subject-secret.ts';

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
	fetch(req, srv) {
		// Un pull de una versión nueva tarda más que los 10 s por defecto de
		// Bun, que cortaba la conexión con el núcleo a media descarga. Solo las
		// peticiones del núcleo (maestro) esperan lo que dure; el tope lo pone
		// él (10 min). Las demás conservan el corte: sin secreto, nadie puede
		// dejar conexiones abiertas para siempre.
		if (is_master_request(req)) srv.timeout(req, 0);
		return handle_operator_http(req);
	},
});

console.log(`subject-operator listening on :${server.port}`);
