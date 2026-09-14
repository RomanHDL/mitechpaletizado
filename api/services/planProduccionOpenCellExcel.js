// Genera el .xlsx de exportacion del modulo "Plan de Produccion OpenCell" para
// UNA semana (Resumen de produccion + Action Plan de esa semana). Usa el
// MISMO shape de datos que produce la API (semana ya armada con
// planProduccionOpenCellHelpers.js) -- no recalcula nada aqui, solo pinta en
// celdas. Estilo/paleta copiados de reporteProduccionExcel.js para mantener
// consistencia visual entre los Excels que exporta este proyecto.

const ExcelJS = require('exceljs');

const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A8A' } };
const HEADER_FONT = { color: { argb: 'FFFFFFFF' }, bold: true };
const WEEKEND_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };
const THIN_BORDER = { style: 'thin', color: { argb: 'FFCBD5E1' } };
const ALL_BORDERS = { top: THIN_BORDER, left: THIN_BORDER, bottom: THIN_BORDER, right: THIN_BORDER };

const ROW_LABELS = [
  { key: 'plan', label: 'Plan (Materials Available)' },
  { key: 'processed', label: 'Processed' },
  { key: 'finishedGood', label: 'Finished Good' },
  { key: 'delta', label: 'Delta vs Processed' },
  { key: 'recoveryPlan', label: 'Recovery Plan' },
  { key: 'pctPlanPct', label: '% Plan' },
];

function fmtDate(d) {
  if (!d) return '';
  const dt = d instanceof Date ? d : new Date(d);
  return `${String(dt.getUTCDate()).padStart(2, '0')}/${String(dt.getUTCMonth() + 1).padStart(2, '0')}/${dt.getUTCFullYear()}`;
}

// value === null -> celda vacia real (no "-", no 0) para que el .xlsx
// exportado sea consistente con la pantalla (una celda vacia sigue siendo
// una celda vacia, nunca un cero inventado).
function writeCell(ws, r, c, value, opts = {}) {
  const cell = ws.getRow(r).getCell(c);
  if (value !== null && value !== undefined) cell.value = value;
  cell.border = ALL_BORDERS;
  cell.alignment = { vertical: 'middle', horizontal: opts.align || 'center' };
  if (opts.bold) cell.font = { bold: true };
  if (opts.fill) cell.fill = opts.fill;
  if (opts.numFmt) cell.numFmt = opts.numFmt;
  return cell;
}

/**
 * @param {{year:number, weekNumber:number, weekStartDate:Date, weekEndDate:Date, days:Array}} week
 * @param {Array} actionItems - items de Action Plan de esa semana (ya con estatus)
 * @returns {ExcelJS.Workbook}
 */
function construirWorkbookPlanProduccionOpenCell(week, actionItems) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'mitechpaletizado';
  wb.created = new Date();

  const wsProd = wb.addWorksheet(`Semana ${week.weekNumber}`);
  const colCount = week.days.length + 1;
  wsProd.columns = [{ width: 28 }, ...week.days.map(() => ({ width: 13 }))];

  let r = 1;
  const titulo = wsProd.getCell(`A${r}`);
  titulo.value = 'PLAN DE PRODUCCION OPENCELL';
  titulo.font = { bold: true, size: 16, color: { argb: 'FF1E3A8A' } };
  wsProd.mergeCells(r, 1, r, colCount);
  r++;
  const subtitulo = wsProd.getCell(`A${r}`);
  subtitulo.value = `Semana ${week.weekNumber} — ${fmtDate(week.weekStartDate)} al ${fmtDate(week.weekEndDate)}`;
  subtitulo.font = { italic: true, size: 11, color: { argb: 'FF475569' } };
  wsProd.mergeCells(r, 1, r, colCount);
  r += 2;

  const headerRow = r;
  writeCell(wsProd, headerRow, 1, 'Concepto', { fill: HEADER_FILL, align: 'left' }).font = HEADER_FONT;
  week.days.forEach((d, i) => {
    const dow = d.date.getUTCDay();
    const isWeekend = dow === 0 || dow === 6;
    const cell = writeCell(wsProd, headerRow, i + 2, fmtDate(d.date), { fill: isWeekend ? WEEKEND_FILL : HEADER_FILL });
    cell.font = isWeekend ? { bold: true, color: { argb: 'FF475569' } } : HEADER_FONT;
  });
  r++;

  for (const { key, label } of ROW_LABELS) {
    writeCell(wsProd, r, 1, label, { align: 'left', bold: true });
    week.days.forEach((d, i) => {
      let value;
      if (key === 'pctPlanPct') {
        value = d.pctPlan === null || d.pctPlan === undefined ? null : d.pctPlan; // fraccion; numFmt la muestra como %
      } else {
        value = d[key];
      }
      const dow = d.date.getUTCDay();
      const isWeekend = dow === 0 || dow === 6;
      const cell = writeCell(wsProd, r, i + 2, value, { fill: isWeekend ? WEEKEND_FILL : undefined, numFmt: key === 'pctPlanPct' ? '0%' : undefined });
      if (value === null || value === undefined) cell.value = '';
    });
    r++;
  }
  r++;

  // ── Action Plan de la semana ──
  const apHeaderRow = r;
  const apTitle = wsProd.getCell(`A${apHeaderRow}`);
  apTitle.value = `ACTION PLAN — SEMANA ${week.weekNumber}`;
  apTitle.font = { bold: true, size: 13, color: { argb: 'FF1E3A8A' } };
  wsProd.mergeCells(apHeaderRow, 1, apHeaderRow, colCount);
  r++;

  const apCols = ['Week', 'Accountable', 'Descripción de las acciones', 'Committed date', 'Estatus'];
  const apColRow = r;
  apCols.forEach((label, i) => {
    const cell = writeCell(wsProd, apColRow, i + 1, label, { fill: HEADER_FILL });
    cell.font = HEADER_FONT;
  });
  r++;

  if (!actionItems || !actionItems.length) {
    writeCell(wsProd, r, 1, 'Sin acciones registradas para esta semana', { align: 'left' });
    wsProd.mergeCells(r, 1, r, 5);
    r++;
  } else {
    for (const item of actionItems) {
      writeCell(wsProd, r, 1, `Week ${item.weekNumber}`);
      writeCell(wsProd, r, 2, item.accountable || '', { align: 'left' });
      writeCell(wsProd, r, 3, item.descripcion || '', { align: 'left' });
      writeCell(wsProd, r, 4, item.committedDate ? fmtDate(item.committedDate) : '');
      writeCell(wsProd, r, 5, item.estatus || 'Pendiente');
      r++;
    }
  }

  return wb;
}

module.exports = { construirWorkbookPlanProduccionOpenCell };
