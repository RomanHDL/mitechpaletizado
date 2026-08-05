// Genera el archivo .xlsx del "Reporte Semanal de Produccion" desde cero con
// ExcelJS (formato estandar, sin depender de manipular el archivo original a
// mano). Usa el MISMO shape de datos que produce reporteProduccionHelpers.js
// (buildReporteSemanal) — no recalcula ni reclasifica nada aqui, solo pinta
// en celdas lo que el servicio central ya clasifico. Estructura y colores
// imitan Reporte_Produccion_Bulky_Fierro_Separados.xlsx: hoja "Produccion"
// (una seccion por dia, con encabezado de dia coloreado) + hoja "Resumen"
// (tarjetas/resumen semanal).

const ExcelJS = require('exceljs');

const DIA_COLORS = {
  Lunes: 'FFDCEBFF',
  Martes: 'FFE0F5E9',
  Miércoles: 'FFFFF3D6',
  Jueves: 'FFF3E0FF',
  Viernes: 'FFFFE0E6',
  Sábado: 'FFE0F7FA',
  Domingo: 'FFF0F0F0',
};

const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A8A' } };
const HEADER_FONT = { color: { argb: 'FFFFFFFF' }, bold: true };
const THIN_BORDER = { style: 'thin', color: { argb: 'FFCBD5E1' } };
const ALL_BORDERS = { top: THIN_BORDER, left: THIN_BORDER, bottom: THIN_BORDER, right: THIN_BORDER };

function estiloEncabezadoDia(cell, colorArgb) {
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: colorArgb } };
  cell.font = { bold: true, size: 13 };
  cell.alignment = { vertical: 'middle', horizontal: 'left' };
}

function escribirFilaColumnas(ws, rowIdx) {
  const row = ws.getRow(rowIdx);
  row.values = ['Categoría / Destino', 'Pallets', 'Piezas', 'Bulky', 'Fierro', 'Detalle'];
  row.eachCell((cell) => {
    cell.fill = HEADER_FILL;
    cell.font = HEADER_FONT;
    cell.border = ALL_BORDERS;
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
  });
}

function escribirFilaDatos(ws, rowIdx, fila, opts) {
  const row = ws.getRow(rowIdx);
  row.values = [fila.categoria, fila.pallets, fila.piezas, opts.mostrarBulkyFierro ? fila.bulky : '', opts.mostrarBulkyFierro ? fila.fierro : '', fila.detalle];
  row.eachCell((cell, colNumber) => {
    cell.border = ALL_BORDERS;
    cell.alignment = { vertical: 'middle', horizontal: colNumber === 1 || colNumber === 6 ? 'left' : 'center' };
  });
  if (opts.negrita) row.font = { bold: true };
}

/**
 * Construye el workbook completo a partir del resultado de buildReporteSemanal().
 * @param {{dias: Array, resumen: object}} reporte
 * @param {{isoInicio: string, isoFin: string, fechaInicio: string, fechaFin: string}} semana
 * @returns {ExcelJS.Workbook}
 */
function construirWorkbookReporteSemanal(reporte, semana) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'mitechpaletizado';
  wb.created = new Date();

  const wsProd = wb.addWorksheet('Producción', { views: [{ state: 'frozen', ySplit: 0 }] });
  wsProd.columns = [
    { width: 26 }, { width: 12 }, { width: 12 }, { width: 10 }, { width: 10 }, { width: 34 },
  ];

  let r = 1;
  const titulo = wsProd.getCell(`A${r}`);
  titulo.value = 'REPORTE SEMANAL DE PRODUCCIÓN';
  titulo.font = { bold: true, size: 16, color: { argb: 'FF1E3A8A' } };
  wsProd.mergeCells(`A${r}:F${r}`);
  r++;
  const subtitulo = wsProd.getCell(`A${r}`);
  subtitulo.value = `Semana del ${semana.fechaInicio} al ${semana.fechaFin}`;
  subtitulo.font = { italic: true, size: 11, color: { argb: 'FF475569' } };
  wsProd.mergeCells(`A${r}:F${r}`);
  r += 2;

  for (const dia of reporte.dias) {
    const colorDia = DIA_COLORS[dia.dia] || 'FFF0F0F0';
    const encHeader = wsProd.getCell(`A${r}`);
    encHeader.value = `${dia.dia} — ${dia.fecha}`;
    estiloEncabezadoDia(encHeader, colorDia);
    wsProd.mergeCells(`A${r}:F${r}`);
    for (let c = 1; c <= 6; c++) wsProd.getRow(r).getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: colorDia } };
    r++;

    if (dia.sinProduccion) {
      const sin = wsProd.getCell(`A${r}`);
      sin.value = 'Sin producción';
      sin.font = { italic: true, color: { argb: 'FF64748B' } };
      wsProd.mergeCells(`A${r}:F${r}`);
      r += 2;
      continue;
    }

    escribirFilaColumnas(wsProd, r);
    r++;
    escribirFilaDatos(wsProd, r, dia.filas.almacen, { mostrarBulkyFierro: false });
    r++;
    escribirFilaDatos(wsProd, r, dia.filas.bulkyFierro, { mostrarBulkyFierro: true });
    r++;
    escribirFilaDatos(wsProd, r, dia.filas.trg, { mostrarBulkyFierro: false });
    r++;
    escribirFilaDatos(wsProd, r, dia.filas.fba, { mostrarBulkyFierro: false });
    r++;
    escribirFilaDatos(wsProd, r, { categoria: 'Total del día', pallets: dia.totalPallets, piezas: dia.totalPiezas, detalle: '' }, { mostrarBulkyFierro: false, negrita: true });
    r += 2;
  }

  const wsResumen = wb.addWorksheet('Resumen');
  wsResumen.columns = [{ width: 32 }, { width: 18 }];
  let rr = 1;
  const tituloResumen = wsResumen.getCell(`A${rr}`);
  tituloResumen.value = 'RESUMEN SEMANAL';
  tituloResumen.font = { bold: true, size: 16, color: { argb: 'FF1E3A8A' } };
  wsResumen.mergeCells(`A${rr}:B${rr}`);
  rr++;
  const subResumen = wsResumen.getCell(`A${rr}`);
  subResumen.value = `Semana del ${semana.fechaInicio} al ${semana.fechaFin}`;
  subResumen.font = { italic: true, size: 11, color: { argb: 'FF475569' } };
  wsResumen.mergeCells(`A${rr}:B${rr}`);
  rr += 2;

  const filasResumen = [
    ['Total de pallets', reporte.resumen.totalPallets],
    ['Total de piezas', reporte.resumen.totalPiezas],
    ['Pallets Almacén', reporte.resumen.almacenPallets],
    ['Pallets TRG', reporte.resumen.trgPallets],
    ['Pallets FBA', reporte.resumen.fbaPallets],
    ['Pallets Bulky', reporte.resumen.bulkyPallets],
    ['Pallets Fierro', reporte.resumen.fierroPallets],
    ['Promedio diario de pallets', Number(reporte.resumen.promedioDiarioPallets.toFixed(2))],
    ['Día con mayor producción', reporte.resumen.diaMayorProduccion || 'N/A'],
  ];
  for (const [label, valor] of filasResumen) {
    const cLabel = wsResumen.getCell(`A${rr}`);
    const cValor = wsResumen.getCell(`B${rr}`);
    cLabel.value = label;
    cValor.value = valor;
    cLabel.border = ALL_BORDERS;
    cValor.border = ALL_BORDERS;
    cLabel.font = { bold: true };
    cValor.alignment = { horizontal: 'center' };
    rr++;
  }

  return wb;
}

module.exports = { construirWorkbookReporteSemanal };
