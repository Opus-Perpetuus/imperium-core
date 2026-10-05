import { format_score, format_summary, load_corpus, score_transcript, validate_corpus } from './ai-query-corpus.ts';
import type { TranscriptLine } from './ai-query-corpus.ts';

const summary = validate_corpus();
if (process.argv[2] === 'score') {
	const file = process.argv[3];
	let text: string;
	if (file) {
		const handle = Bun.file(file);
		if (!(await handle.exists())) {
			process.stderr.write(`No está el archivo ${file}\n`);
			process.exit(1);
		}
		text = await handle.text();
	} else {
		text = await new Response(Bun.stdin.stream()).text();
	}
	const lines = text
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => JSON.parse(line) as TranscriptLine);
	process.stdout.write(format_score(score_transcript(lines, load_corpus().questions), lines));
	process.exit(0);
}

process.stdout.write(`${format_summary(summary)}\n`);
if (!summary.ok) process.exit(1);
