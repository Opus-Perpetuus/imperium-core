import { describe, expect, test } from 'bun:test';
import { builtin_status_seed_entries } from './state-fields.ts';
import { default_state_icon, state_icon_or_default } from './state-icons.ts';

// #323: todos los estatus llevan ícono, incluidos los de pedidos.
describe('#323 íconos de estatus', () => {
	test('los estatus de pedidos tienen ícono propio', () => {
		const pedidos = builtin_status_seed_entries().find((entry) => entry.module_name === 'pedidos');
		const icons = Object.fromEntries((pedidos?.options ?? []).map((o) => [o.value, o.icon]));
		expect(icons).toEqual({
			borrador: 'fas fa-file-pen',
			confirmado: 'fas fa-circle-check',
			por_surtir: 'fas fa-box-open',
			surtiendo: 'fas fa-dolly',
			surtido: 'fas fa-boxes-stacked',
			enviado: 'fas fa-truck',
			cancelado: 'fas fa-ban',
		});
	});

	test('ningún estatus sembrado del núcleo queda sin ícono', () => {
		const sin_icono = builtin_status_seed_entries().flatMap((entry) =>
			entry.options.filter((o) => !o.icon).map((o) => `${entry.module_name}:${o.value}`),
		);
		expect(sin_icono).toEqual([]);
	});

	test('sin ícono configurado: por valor, luego por tipo, nunca vacío', () => {
		expect(default_state_icon('Cancelada')).toBe('fas fa-ban');
		expect(default_state_icon('xyz', 'success')).toBe('fas fa-circle-check');
		expect(default_state_icon('', '')).toBe('fas fa-circle');
		expect(state_icon_or_default('fas fa-star', 'cancelado')).toBe('fas fa-star');
	});
});
