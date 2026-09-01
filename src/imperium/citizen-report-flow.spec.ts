import { describe, expect, test } from 'bun:test';
import {
	prepare_citizen_report_write,
	sanitize_citizen_report_evidence,
} from './citizen-report-flow.ts';

describe('citizen-report-flow', () => {
	test('sanitize_citizen_report_evidence drops empty slots', () => {
		expect(
			sanitize_citizen_report_evidence([
				'',
				{ _id: '' },
				null,
				'507f1f77bcf86cd799439011',
			]),
		).toEqual(['507f1f77bcf86cd799439011']);
	});

	test('prepare_citizen_report_write persists department id and folio', async () => {
		const store = {
			next_auto_increment: async () => 81,
			has: () => false,
		};
		const incoming = {
			citizen_name: 'QA Persistencia Uno',
			citizen_email: 'qa.persist.uno@example.com',
			department: { _id: '69af40c25059cf0bfda2ca90', name: 'Obras' },
			evidence_before_images: ['', { _id: '' }],
			images: [],
			name: '',
		};
		const out = await prepare_citizen_report_write(
			store as never,
			incoming,
			true,
		);
		expect(out.department).toBe(incoming.department._id);
		expect(out.citizen_name).toBe(incoming.citizen_name);
		expect(out.sequence).toBe(81);
		expect(String(out.name ?? '')).toBeTruthy();
		expect(out.evidence_before_images).toEqual([]);
		expect(out.images).toBeUndefined();
	});
});
