/** Segmentos del lanzador estático. Otro slug no puede tomarlos. */
export const GRANDFATHER_SEGMENTS: Readonly<Record<string, readonly string[]>> = {
	'control-escolar': ['tipos-incidencia', 'periodos-examen'],
	'database-manager': ['dbm-policies', 'dbm-destinations', 'dbm-runs', 'dbm-saved-queries'],
	'herramientas': ['herr-inicio', 'herr-tabla', 'herr-registro', 'herr-tablas', 'herr-registros', 'herr-cierres', 'herr-jornada', 'herr-liquidacion', 'herr-jornadas', 'herr-pedidos', 'herr-gastos', 'herr-caja', 'herr-domicilios', 'herr-etiquetas', 'herr-vehiculos', 'herr-recargas', 'herr-rutas', 'herr-menu-categorias', 'herr-menu-tamanos', 'herr-menu-productos', 'herr-menu-extras', 'herr-menu-complementos', 'herr-menu-promos', 'herr-telefono', 'herr-telefono-contactos', 'herr-telefono-llamadas', 'herr-asistente', 'herr-voz', 'herr-voz-bitacora', 'herr-agenda-dia', 'herr-agenda', 'herr-utilidades'],
	'ingresos': ['contribuyente', 'concepto', 'licencia', 'adeudo'],
	'pos': ['pos-order'],
	'tienda': ['providers', 'connectors', 'catalog', 'pricing', 'store-info', 'payment-gateways', 'sync', 'orders', 'store-home', 'store-catalog', 'store-product', 'store-cart', 'store-lists', 'store-favorites', 'store-checkout', 'store-checkout-result', 'store-order-detail', 'store-orders', 'store-account', 'store-addresses', 'store-payment-methods', 'store-about'],
	'vehiculos': ['padron-vehiculos', 'plantilla-revision', 'bitacora', 'envio-revision', 'falla', 'mantenimiento-correctivo', 'mantenimiento-preventivo', 'servicio-programado', 'lectura-uso', 'documento-vehiculo', 'recordatorios', 'costos-flota', 'carga-combustible'],
};
