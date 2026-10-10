import { describe, expect, test } from "bun:test";
import { confirmed_seqs } from "./confirmed-seqs";

describe("confirmed_seqs", () => {
	test("conserva el seq cuando el resultado llegó a un estado terminal", () => {
		const mutations = [{ seq: 1 }, { seq: 2 }, { seq: 3 }, { seq: 4 }, { seq: 5 }];
		expect(
			confirmed_seqs(
				[
					{ status: "applied" },
					{ status: "adjusted" },
					{ status: "rejected" },
					{ status: "conflict" },
					{ status: "pending" },
				],
				mutations,
			),
		).toEqual([1, 2, 3, 4]);
	});

	test("no confirma nada si el servidor no mandó un arreglo", () => {
		expect(confirmed_seqs(undefined, [{ seq: 1 }])).toEqual([]);
		expect(confirmed_seqs(null, [{ seq: 1 }])).toEqual([]);
	});

	test("ignora un resultado sin status", () => {
		expect(confirmed_seqs([{}], [{ seq: 9 }])).toEqual([]);
	});
});
