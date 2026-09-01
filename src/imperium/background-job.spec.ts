import { describe, expect, test } from 'bun:test';
import {
	append_background_job_logs,
	background_job_persist_patch,
	background_job_progress,
	background_job_title,
	is_background_job_doc,
	merge_background_job_payload,
	should_refresh_shell_for_subject,
	should_toast_subject_event,
	type BackgroundJobPayload,
} from './background-job.ts';

function payload(
	partial: Partial<BackgroundJobPayload> = {},
): BackgroundJobPayload {
	return {
		kind: 'background_job',
		job_kind: 'subject_install',
		technical_id: 'subject-turnos',
		slug: 'turnos',
		name: 'Turnos',
		status: 'running',
		progress: 12,
		phase: 'sql',
		logs: [],
		...partial,
	};
}

describe('background_job helpers', () => {
	test('progress jumps to 100 only on terminal phases', () => {
		expect(background_job_progress('sql')).toBe(12);
		expect(background_job_progress('docker_up')).toBe(40);
		expect(background_job_progress('schema')).toBe(88);
		expect(background_job_progress('done')).toBe(100);
		expect(background_job_progress('error')).toBe(100);
	});

	test('toasts and shell refresh only fire at the end', () => {
		expect(should_toast_subject_event('sql')).toBe(false);
		expect(should_toast_subject_event('docker_up')).toBe(false);
		expect(should_toast_subject_event('done')).toBe(true);
		expect(should_toast_subject_event('error')).toBe(true);
		expect(should_refresh_shell_for_subject('sql')).toBe(false);
		expect(should_refresh_shell_for_subject('done')).toBe(true);
	});

	test('merge appends distinct logs and marks success on done', () => {
		const next = merge_background_job_payload(payload(), {
			phase: 'docker_up',
			level: 'info',
			message: 'Descargando la imagen…',
		});
		expect(next.status).toBe('running');
		expect(next.progress).toBe(40);
		expect(next.logs).toHaveLength(1);
		const done = merge_background_job_payload(next, {
			phase: 'done',
			status: 'installed',
			level: 'success',
			message: 'Turnos instalada',
		});
		expect(done.status).toBe('success');
		expect(done.progress).toBe(100);
		expect(done.logs).toHaveLength(2);
	});

	test('duplicate consecutive log lines are ignored', () => {
		const once = append_background_job_logs([], {
			at: '1',
			level: 'info',
			phase: 'docker',
			message: 'pull',
		});
		const twice = append_background_job_logs(once, {
			at: '2',
			level: 'info',
			phase: 'docker',
			message: 'pull',
		});
		expect(twice).toHaveLength(1);
	});

	test('persist patch keeps recipientId so the inbox can still list the job', () => {
		const patch = background_job_persist_patch(
			{
				_id: 'n1',
				recipientId: 'user-admin',
				type: 'background_job',
				isRead: false,
				source: { route: '/internal/module-management' },
			},
			payload({ phase: 'docker_up', progress: 40 }),
			'Descargando la imagen…',
		);
		expect(patch.recipientId).toBe('user-admin');
		expect(patch.user).toBe('user-admin');
		expect(patch.type).toBe('background_job');
		expect(patch.status).toBe('running');
		expect(patch.is_active).toBe(true);
		const done = background_job_persist_patch(
			{ _id: 'n1', recipientId: 'user-admin', status: 'running' },
			payload({ status: 'success', phase: 'done', progress: 100 }),
			'Turnos instalada',
		);
		expect(done.status).toBe('success');
		expect(done.phase).toBe('done');
	});

	test('titles stay user-facing and is_background_job_doc recognizes the type', () => {
		expect(
			background_job_title('subject_install', 'Turnos', 'running'),
		).toBe('Instalando Turnos');
		expect(is_background_job_doc({ type: 'background_job' })).toBe(true);
		expect(
			is_background_job_doc({ payload: { kind: 'background_job' } }),
		).toBe(true);
		expect(is_background_job_doc({ type: 'message' })).toBe(false);
	});
});
