import { describe, expect, test } from 'bun:test';
import { fill_empty_presentation, insert_missing } from './option-seed.ts';

describe('fill_empty_presentation', () => {
	test('rellena color e icon solo cuando estaban vacíos', () => {
		const existing = [
			{ value: 'pendiente', field_name: 'state', color: '', icon: undefined },
			{ value: 'ok', field_name: 'state', color: '#198754', icon: 'fas fa-check' },
		];
		const incoming = [
			{ value: 'pendiente', field_name: 'state', color: '#ffc107', icon: 'fas fa-clock' },
			{ value: 'ok', field_name: 'state', color: '#00ff00', icon: 'fas fa-x' },
		];
		const { options, filled } = fill_empty_presentation(existing, incoming, true);
		expect(filled).toBe(1);
		expect(options[0]?.color).toBe('#ffc107');
		expect(options[0]?.icon).toBe('fas fa-clock');
		expect(options[1]?.color).toBe('#198754');
		expect(options[1]?.icon).toBe('fas fa-check');
	});

	test('no pisa presentación ya guardada y convive con insert_missing', () => {
		const existing = [{ value: 'a', color: '#111111' }];
		const incoming = [
			{ value: 'a', color: '#222222', icon: 'fas fa-a' },
			{ value: 'b', color: '#333333', icon: 'fas fa-b' },
		];
		const merged = insert_missing(existing, incoming, false);
		const filled = fill_empty_presentation(merged.options, incoming, false);
		expect(merged.inserted).toBe(1);
		expect(filled.filled).toBe(1);
		expect(filled.options.find((o) => o.value === 'a')?.color).toBe('#111111');
		expect(filled.options.find((o) => o.value === 'a')?.icon).toBe('fas fa-a');
		expect(filled.options.find((o) => o.value === 'b')?.color).toBe('#333333');
	});
});
