/**
 * Invitación iCalendar de una reunión (RFC 5545) y la expansión de su recurrencia simple. Pura:
 * las fechas van en UTC y sin VTIMEZONE (contrato §13), así que los días de `BYDAY` se pasan al
 * día UTC en que cae la hora local de inicio.
 */

export type Recurrence = {
	freq: 'daily' | 'weekly' | 'monthly';
	interval?: number;
	by_day?: string[];
	count?: number;
	until?: string;
};

export type IcsPerson = { name: string; email: string };

export type IcsInput = {
	method: 'REQUEST' | 'CANCEL';
	uid: string;
	sequence: number;
	start_at: string;
	duration_min: number;
	timezone: string;
	title: string;
	description: string;
	url: string;
	code: string;
	recurrence?: Recurrence;
	organizer?: IcsPerson;
	attendees?: IcsPerson[];
	now: number;
};

export const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;

const DAY_MS = 86_400_000;
const FOLD_OCTETS = 75;

function stamp(ms: number): string {
	return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** TEXT de RFC 5545 §3.3.11. */
function escape_text(value: string): string {
	return value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** Un parámetro no admite comillas dobles; con `:`, `;` o `,` va entre comillas. */
function param_value(value: string): string {
	const clean = value.replace(/["\r\n]/g, '');
	return /[:;,]/.test(clean) ? `"${clean}"` : clean;
}

/** Corta en 75 octetos sin partir un carácter UTF-8; la continuación empieza con un espacio. */
export function fold_line(line: string): string {
	if (Buffer.byteLength(line) <= FOLD_OCTETS) return line;
	const parts: string[] = [];
	let current = '';
	let size = 0;
	for (const char of line) {
		const bytes = Buffer.byteLength(char);
		const limit = parts.length ? FOLD_OCTETS - 1 : FOLD_OCTETS;
		if (size + bytes > limit) {
			parts.push(current);
			current = '';
			size = 0;
		}
		current += char;
		size += bytes;
	}
	parts.push(current);
	return parts.join('\r\n ');
}

/** Día de la semana (0 = domingo) de un instante en esa zona. */
function local_weekday(ms: number, timezone: string): number {
	const name = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: timezone }).format(new Date(ms));
	return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(name);
}

/** Lunes = 0: la semana de `RRULE` empieza en lunes (`WKST=MO`). */
function from_monday(day: number): number {
	return (day + 6) % 7;
}

/** `BYDAY` local → días UTC (0 = domingo) en que cae la hora de inicio, de lunes a domingo. */
function utc_days(start: number, by_day: string[], timezone: string): number[] {
	const shift = (new Date(start).getUTCDay() - local_weekday(start, timezone) + 7) % 7;
	const days = by_day.map((day) => (WEEKDAYS.indexOf(day as (typeof WEEKDAYS)[number]) + shift) % 7);
	return [...new Set(days)].sort((a, b) => from_monday(a) - from_monday(b));
}

export function rrule_of(recurrence: Recurrence, start_at: string, timezone: string): string {
	const parts = [`FREQ=${recurrence.freq.toUpperCase()}`];
	if ((recurrence.interval ?? 1) > 1) parts.push(`INTERVAL=${recurrence.interval}`);
	if (recurrence.freq === 'weekly' && recurrence.by_day?.length) {
		const days = utc_days(Date.parse(start_at), recurrence.by_day, timezone);
		parts.push(`BYDAY=${days.map((day) => WEEKDAYS[day]).join(',')}`);
	}
	if (recurrence.count) parts.push(`COUNT=${recurrence.count}`);
	else if (recurrence.until) parts.push(`UNTIL=${stamp(Date.parse(recurrence.until))}`);
	return parts.join(';');
}

/**
 * Inicios de la serie en orden: el primero siempre es `start` (RFC 5545 §3.8.5.3, aunque no
 * caiga en `BYDAY`). `from` salta las ocurrencias anteriores sin contar: solo vale sin `COUNT`.
 */
function* occurrences(start: number, rule: Recurrence, timezone: string, from = start): Generator<number> {
	const interval = Math.max(1, rule.interval ?? 1);
	yield start;
	if (rule.freq === 'daily' || (rule.freq === 'weekly' && !rule.by_day?.length)) {
		const period = interval * (rule.freq === 'daily' ? 1 : 7) * DAY_MS;
		for (let k = Math.max(1, Math.floor((from - start) / period)); ; k++) yield start + k * period;
	}
	if (rule.freq === 'weekly') {
		const days = utc_days(start, rule.by_day ?? [], timezone);
		const week = interval * 7 * DAY_MS;
		const anchor = start - from_monday(new Date(start).getUTCDay()) * DAY_MS;
		for (let w = Math.max(0, Math.floor((from - anchor) / week) - 1); ; w++) {
			for (const day of days) {
				const at = anchor + w * week + from_monday(day) * DAY_MS;
				if (at > start) yield at;
			}
		}
	}
	const first = new Date(start);
	const day = first.getUTCDate();
	const months_from = (new Date(from).getUTCFullYear() - first.getUTCFullYear()) * 12 + new Date(from).getUTCMonth() - first.getUTCMonth();
	for (let m = Math.max(1, Math.floor(months_from / interval) - 1); ; m++) {
		const at = Date.UTC(
			first.getUTCFullYear(),
			first.getUTCMonth() + m * interval,
			day,
			first.getUTCHours(),
			first.getUTCMinutes(),
			first.getUTCSeconds(),
		);
		// Un mes sin ese día no tiene ocurrencia (RFC 5545 §3.3.10).
		if (new Date(at).getUTCDate() === day) yield at;
	}
}

/** El primer inicio de la serie en `after` o después; `null` si la serie ya terminó. */
export function next_occurrence(
	start_at: string,
	recurrence: Recurrence | undefined,
	after: number,
	timezone: string,
): string | null {
	const start = Date.parse(start_at);
	if (!recurrence) return start >= after ? start_at : null;
	const until = recurrence.until ? Date.parse(recurrence.until) : Number.POSITIVE_INFINITY;
	const count = recurrence.count ?? Number.POSITIVE_INFINITY;
	const from = Number.isFinite(count) ? start : after;
	let seen = 0;
	for (const at of occurrences(start, recurrence, timezone, from)) {
		if (at > until || ++seen > count) return null;
		if (at >= after) return new Date(at).toISOString();
	}
	return null;
}

export function build_ics(input: IcsInput): string {
	const start = Date.parse(input.start_at);
	const end = start + input.duration_min * 60_000;
	const details = [input.description.trim(), `Entra con el enlace: ${input.url}`, `Código: ${input.code}`]
		.filter(Boolean)
		.join('\n\n');
	const lines = [
		'BEGIN:VCALENDAR',
		'VERSION:2.0',
		'PRODID:-//Imperium//Reuniones//ES',
		'CALSCALE:GREGORIAN',
		`METHOD:${input.method}`,
		'BEGIN:VEVENT',
		`UID:${input.uid}`,
		`SEQUENCE:${input.sequence}`,
		`DTSTAMP:${stamp(input.now)}`,
		`DTSTART:${stamp(start)}`,
		`DTEND:${stamp(end)}`,
		...(input.recurrence ? [`RRULE:${rrule_of(input.recurrence, input.start_at, input.timezone)}`] : []),
		`SUMMARY:${escape_text(input.title)}`,
		`DESCRIPTION:${escape_text(details)}`,
		`LOCATION:${escape_text(input.url)}`,
		`URL:${input.url}`,
		...(input.organizer
			? [`ORGANIZER;CN=${param_value(input.organizer.name)}:mailto:${input.organizer.email}`]
			: []),
		...(input.attendees ?? []).map(
			(person) =>
				`ATTENDEE;CN=${param_value(person.name)};ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${person.email}`,
		),
		`STATUS:${input.method === 'CANCEL' ? 'CANCELLED' : 'CONFIRMED'}`,
		'END:VEVENT',
		'END:VCALENDAR',
	];
	return `${lines.map(fold_line).join('\r\n')}\r\n`;
}
