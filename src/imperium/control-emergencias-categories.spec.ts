import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

const ROOT = join(import.meta.dir, '../../../..');

describe('control de emergencias category list routes', () => {
	test('the three category modules register list GET routers', () => {
		const paths = [
			'backend/src/components/control-emergencias/despensa-solidaria/categoria-despensa-solidaria/categoria-despensa-solidaria.routes.ts',
			'backend/src/components/control-emergencias/inventario-sanitario/categoria-inventario-sanitario/categoria-inventario-sanitario.routes.ts',
			'backend/src/components/control-emergencias/directorio-contactos/categoria-directorio-contactos/categoria-directorio-contactos.routes.ts',
		];
		for (const rel of paths) {
			expect(existsSync(join(ROOT, rel))).toBe(true);
		}
	});
});
