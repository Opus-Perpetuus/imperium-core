/**
 * HTTP sidecar: docker.sock + compose del host. El núcleo no monta el socket.
 */
import { handle_operator_http } from './imperium/subject-runtime.ts';

const PORT = Number(process.env.SUBJECT_OPERATOR_PORT ?? 3200);

process.env.SUBJECT_OPERATOR_URL = '';
process.env.SUBJECT_RUNTIME = process.env.SUBJECT_RUNTIME || 'docker';

const server = Bun.serve({
	port: PORT,
	fetch: handle_operator_http,
});

console.log(`subject-operator listening on :${server.port}`);
