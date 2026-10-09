/** La serie es del dispositivo: dos equipos del mismo usuario no comparten folio. */
export function device_folio(device_id: string, local_n: number): string {
	const series = device_id.trim();
	if (!series) throw new Error("El folio offline exige el id del dispositivo");
	if (!Number.isInteger(local_n) || local_n < 1) {
		throw new Error("El consecutivo local del folio empieza en 1");
	}
	return `${series}-${local_n}`;
}
