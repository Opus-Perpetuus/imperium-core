/**
 * Hoja de estilos de impresión de las plantillas de reporte.
 *
 * Es la única fuente: el núcleo la mete en cada PDF y el diseñador la pide por
 * `GET /api/reports/print-css` para pintar el lienzo igual que el PDF. Cubre el
 * subconjunto de clases que usan los bloques del diseñador (card, alert, table,
 * row/col, utilidades de espaciado y texto) sin depender de Bootstrap.
 */
export const REPORT_PRINT_CSS = `
*, *::before, *::after { box-sizing: border-box; }
body { font-family: "Open Sans", "DejaVu Sans", Arial, Helvetica, sans-serif; font-size: 10.5pt; line-height: 1.4; color: #1f2933; background: #ffffff; margin: 0; }
h1, h2, h3, h4, h5, h6 { margin: 0 0 0.45em; line-height: 1.2; font-weight: 700; color: #102a43; break-after: avoid; page-break-after: avoid; }
h1 { font-size: 20pt; } h2 { font-size: 15pt; } h3 { font-size: 12.5pt; } h4 { font-size: 11pt; } h5 { font-size: 10.5pt; } h6 { font-size: 9.5pt; }
p { margin: 0 0 0.6em; orphans: 3; widows: 3; }
ul, ol { margin: 0 0 0.6em; padding-left: 1.4em; }
hr { border: 0; border-top: 1px solid #cbd2d9; margin: 0.8em 0; }
img { max-width: 100%; height: auto; break-inside: avoid; page-break-inside: avoid; }
table { width: 100%; border-collapse: collapse; margin: 0 0 0.8em; }
thead { display: table-header-group; }
tfoot { display: table-footer-group; }
tr, img, figure, .card, .alert, .report-keep { break-inside: avoid; page-break-inside: avoid; }
th, td { padding: 4px 6px; vertical-align: top; text-align: left; overflow-wrap: break-word; }
th { font-weight: 700; }
.table { width: 100%; }
.table > thead > tr > th { background: #f0f4f8; border-bottom: 1.5px solid #9fb3c8; }
.table > tbody > tr > td, .table > tbody > tr > th { border-bottom: 1px solid #e4e7eb; }
.report-key-values th { width: 35%; color: #52606d; font-weight: 600; }
.table-sm th, .table-sm td { padding: 2px 4px; }
.table-bordered th, .table-bordered td { border: 1px solid #bcccdc; }
.table-striped > tbody > tr:nth-of-type(odd) > td { background: #f7f9fb; }
.card { border: 1px solid #d9e2ec; border-radius: 6px; margin-bottom: 0.8em; background: #ffffff; }
.card-body { padding: 10px 12px; }
.card-title { font-size: 11.5pt; margin-bottom: 0.35em; }
.card-text:last-child { margin-bottom: 0; }
.alert { border: 1px solid transparent; border-radius: 6px; padding: 8px 12px; margin-bottom: 0.8em; }
.alert-info { background: #e6f4ff; border-color: #9ccbf5; color: #0b4a75; }
.alert-success { background: #e7f6ec; border-color: #9fd8b0; color: #1c5b33; }
.alert-warning { background: #fff7e0; border-color: #f3d27a; color: #6b4a00; }
.alert-danger { background: #fdecec; border-color: #f0a9a9; color: #7a1c1c; }
.row { display: flex; flex-wrap: wrap; margin: 0 -6px; }
.row > * { padding: 0 6px; }
.g-2 { row-gap: 8px; }
.col { flex: 1 0 0%; }
.col-12 { flex: 0 0 100%; max-width: 100%; }
.col-8 { flex: 0 0 66.6667%; max-width: 66.6667%; }
.col-6 { flex: 0 0 50%; max-width: 50%; }
.col-4 { flex: 0 0 33.3333%; max-width: 33.3333%; }
.col-3 { flex: 0 0 25%; max-width: 25%; }
.form-label { display: block; font-size: 8.5pt; font-weight: 600; color: #52606d; margin-bottom: 2px; }
.form-control { display: block; width: 100%; min-height: 1.9em; padding: 3px 6px; border: 1px solid #bcccdc; border-radius: 4px; }
.badge { display: inline-block; padding: 1px 6px; border-radius: 999px; font-size: 8pt; font-weight: 700; background: #d9e2ec; color: #243b53; }
.text-start { text-align: left; } .text-center { text-align: center; } .text-end { text-align: right; }
.text-muted { color: #7b8794; } .text-uppercase { text-transform: uppercase; }
.fw-bold { font-weight: 700; } .fw-normal { font-weight: 400; } .fst-italic { font-style: italic; }
.small, small { font-size: 85%; }
.m-0 { margin: 0; } .mb-0 { margin-bottom: 0; } .mb-1 { margin-bottom: 0.25em; } .mb-2 { margin-bottom: 0.5em; } .mb-3 { margin-bottom: 1em; } .mb-4 { margin-bottom: 1.5em; }
.mt-0 { margin-top: 0; } .mt-1 { margin-top: 0.25em; } .mt-2 { margin-top: 0.5em; } .mt-3 { margin-top: 1em; } .mt-4 { margin-top: 1.5em; }
.my-2 { margin-top: 0.5em; margin-bottom: 0.5em; } .my-3 { margin-top: 1em; margin-bottom: 1em; }
.p-0 { padding: 0; } .p-2 { padding: 0.5em; } .p-3 { padding: 1em; }
.w-100 { width: 100%; }
.report-page-break, .designer-export-page-break { break-after: page; page-break-after: always; height: 0; border: 0; margin: 0; }
.report-watermark { position: fixed; top: 42%; left: 0; right: 0; text-align: center; font-size: 64pt; font-weight: 800; letter-spacing: 0.08em; color: rgba(16, 42, 67, 0.08); transform: rotate(-28deg); pointer-events: none; z-index: 0; }
.report-field-missing { display: inline-block; min-width: 18mm; min-height: 12mm; border: 1px dashed #bcccdc; color: #9aa5b1; font-size: 7pt; text-align: center; padding: 2mm; }
`;
