import { describe, expect, test } from 'bun:test';
import { build_ics, fold_line, next_occurrence, rrule_of, type IcsInput } from './ics.ts';

const BASE: IcsInput = {
	method: 'REQUEST',
	uid: '0123456789abcdef01234567@empresa.test',
	sequence: 0,
	start_at: '2026-10-12T16:00:00.000Z',
	duration_min: 45,
	timezone: 'America/Mexico_City',
	title: 'Revisión semanal',
	description: '',
	url: 'https://empresa.test/reunion/abc-defg-hjk',
	code: 'abc-defg-hjk',
	now: Date.parse('2026-10-08T10:00:00.000Z'),
};

function unfold(text: string): string[] {
	return text.replace(/\r\n /g, '').split('\r\n');
}

describe('build_ics', () => {
	test('CRLF en cada línea, sin saltos sueltos y con el cierre del calendario', () => {
		const text = build_ics(BASE);
		expect(text.endsWith('END:VCALENDAR\r\n')).toBe(true);
		expect(text.replace(/\r\n/g, '')).not.toContain('\n');
		const lines = unfold(text);
		expect(lines.slice(0, 5)).toEqual([
			'BEGIN:VCALENDAR',
			'VERSION:2.0',
			'PRODID:-//Imperium//Reuniones//ES',
			'CALSCALE:GREGORIAN',
			'METHOD:REQUEST',
		]);
		expect(lines).toContain('UID:0123456789abcdef01234567@empresa.test');
		expect(lines).toContain('SEQUENCE:0');
		expect(lines).toContain('DTSTAMP:20261008T100000Z');
		expect(lines).toContain('DTSTART:20261012T160000Z');
		expect(lines).toContain('DTEND:20261012T164500Z');
		expect(lines).toContain('URL:https://empresa.test/reunion/abc-defg-hjk');
		expect(lines).toContain('STATUS:CONFIRMED');
	});

	test('cancelar lleva METHOD:CANCEL, STATUS:CANCELLED y la secuencia nueva con el mismo UID', () => {
		const lines = unfold(build_ics({ ...BASE, method: 'CANCEL', sequence: 3 }));
		expect(lines).toContain('METHOD:CANCEL');
		expect(lines).toContain('STATUS:CANCELLED');
		expect(lines).toContain('SEQUENCE:3');
		expect(lines).toContain(`UID:${BASE.uid}`);
	});

	test('el texto se escapa y la descripción lleva el enlace y el código', () => {
		const lines = unfold(
			build_ics({ ...BASE, title: 'Plan; 2026, fase\\1', description: 'Primera línea\nSegunda' }),
		);
		expect(lines).toContain('SUMMARY:Plan\\; 2026\\, fase\\\\1');
		const description = lines.find((line) => line.startsWith('DESCRIPTION:'));
		expect(description).toBe(
			'DESCRIPTION:Primera línea\\nSegunda\\n\\nEntra con el enlace: https://empresa.test/reunion/abc-defg-hjk\\n\\nCódigo: abc-defg-hjk',
		);
	});

	test('organizador y asistentes con mailto; el nombre con coma va entre comillas', () => {
		const lines = unfold(
			build_ics({
				...BASE,
				organizer: { name: 'Pérez, Ana', email: 'ana@empresa.test' },
				attendees: [{ name: 'Luis', email: 'luis@empresa.test' }],
			}),
		);
		expect(lines).toContain('ORGANIZER;CN="Pérez, Ana":mailto:ana@empresa.test');
		expect(lines).toContain('ATTENDEE;CN=Luis;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:luis@empresa.test');
	});

	test('las líneas largas se pliegan a 75 octetos sin partir un carácter', () => {
		const title = 'Reunión de planeación de la señalización y los años de operación '.repeat(3);
		const text = build_ics({ ...BASE, title });
		for (const line of text.split('\r\n')) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
		expect(unfold(text)).toContain(`SUMMARY:${title}`);
		expect(text).not.toContain('�');
	});

	test('fold_line deja intacta una línea corta y pliega con un espacio al inicio de cada continuación', () => {
		expect(fold_line('SUMMARY:corta')).toBe('SUMMARY:corta');
		const folded = fold_line(`DESCRIPTION:${'ñ'.repeat(80)}`).split('\r\n');
		expect(folded.length).toBeGreaterThan(1);
		for (const part of folded.slice(1)) expect(part.startsWith(' ')).toBe(true);
		expect(Buffer.byteLength(folded[0]!)).toBeLessThanOrEqual(75);
	});

	test('la recurrencia sale como RRULE', () => {
		const lines = unfold(
			build_ics({ ...BASE, recurrence: { freq: 'weekly', interval: 2, by_day: ['MO', 'WE'], count: 6 } }),
		);
		expect(lines).toContain('RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=6');
	});
});

describe('rrule_of', () => {
	test('BYDAY se pasa al día UTC en que cae la hora local de inicio', () => {
		// Domingo 19:00 en Ciudad de México es lunes 01:00 UTC.
		expect(rrule_of({ freq: 'weekly', by_day: ['SU', 'TU'] }, '2026-10-12T01:00:00.000Z', 'America/Mexico_City')).toBe(
			'FREQ=WEEKLY;BYDAY=MO,WE',
		);
	});

	test('UNTIL en UTC básico; INTERVAL solo si es mayor que 1; COUNT gana a UNTIL', () => {
		expect(rrule_of({ freq: 'daily', until: '2026-11-01T05:59:59.000Z' }, BASE.start_at, BASE.timezone)).toBe(
			'FREQ=DAILY;UNTIL=20261101T055959Z',
		);
		expect(rrule_of({ freq: 'monthly', interval: 1, count: 3 }, BASE.start_at, BASE.timezone)).toBe(
			'FREQ=MONTHLY;COUNT=3',
		);
	});
});

describe('next_occurrence', () => {
	const at = (iso: string) => Date.parse(iso);

	test('sin recurrencia: el inicio, o nada si ya pasó', () => {
		expect(next_occurrence(BASE.start_at, undefined, at('2026-10-01T00:00:00Z'), BASE.timezone)).toBe(BASE.start_at);
		expect(next_occurrence(BASE.start_at, undefined, at('2026-10-13T00:00:00Z'), BASE.timezone)).toBeNull();
	});

	test('cada dos días', () => {
		expect(
			next_occurrence(BASE.start_at, { freq: 'daily', interval: 2 }, at('2026-10-15T00:00:00Z'), BASE.timezone),
		).toBe('2026-10-16T16:00:00.000Z');
	});

	test('semanal por días con COUNT: el inicio cuenta y la serie termina', () => {
		// Lunes 12 y miércoles 14, 19 y 21: cuatro ocurrencias.
		const rule = { freq: 'weekly' as const, by_day: ['MO', 'WE'], count: 4 };
		expect(next_occurrence(BASE.start_at, rule, at('2026-10-13T00:00:00Z'), BASE.timezone)).toBe(
			'2026-10-14T16:00:00.000Z',
		);
		expect(next_occurrence(BASE.start_at, rule, at('2026-10-20T00:00:00Z'), BASE.timezone)).toBe(
			'2026-10-21T16:00:00.000Z',
		);
		expect(next_occurrence(BASE.start_at, rule, at('2026-10-22T00:00:00Z'), BASE.timezone)).toBeNull();
	});

	test('semanal sin COUNT salta hasta la fecha pedida sin recorrer la serie', () => {
		expect(
			next_occurrence(BASE.start_at, { freq: 'weekly', by_day: ['FR', 'MO'] }, at('2030-01-01T00:00:00Z'), BASE.timezone),
		).toBe('2030-01-04T16:00:00.000Z');
	});

	test('UNTIL corta la serie', () => {
		const rule = { freq: 'weekly' as const, until: '2026-10-25T00:00:00.000Z' };
		expect(next_occurrence(BASE.start_at, rule, at('2026-10-13T00:00:00Z'), BASE.timezone)).toBe('2026-10-19T16:00:00.000Z');
		expect(next_occurrence(BASE.start_at, rule, at('2026-10-20T00:00:00Z'), BASE.timezone)).toBeNull();
	});

	test('mensual el día 31 se salta los meses que no lo tienen', () => {
		expect(
			next_occurrence('2026-01-31T16:00:00.000Z', { freq: 'monthly' }, at('2026-02-01T00:00:00Z'), BASE.timezone),
		).toBe('2026-03-31T16:00:00.000Z');
	});
});
