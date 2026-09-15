// Genera el .xlsx de exportacion del modulo "Plan de Produccion OpenCell" para
// UNA semana (Resumen de produccion + Action Plan de esa semana). Usa el
// MISMO shape de datos que produce la API (semana ya armada con
// planProduccionOpenCellHelpers.js) -- no recalcula nada aqui, solo pinta en
// celdas.
//
// Diseno alineado a la identidad visual VIOS/HYUNDAI del dashboard (pedido
// explicito de Roman, 2026-09-15): logo real embebido (branding/vios-hyundai-
// light.png, version clara porque la hoja tiene fondo blanco), titulo
// "PRODUCCION SEMANAL" (nunca "Plan de Produccion OpenCell" como encabezado
// visible), paleta de colores identica a la del dashboard (ver
// COLOR_BY_METRIC/pctFontColor, tomados de las mismas variables --accent/
// --success/--warning/--danger del tema claro y de los colores ya usados en
// las graficas del modulo).

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

// ── Paleta (identica a la del dashboard, tema claro -- la hoja SIEMPRE es de
// fondo blanco, sin importar el tema que el usuario tenga activo en pantalla) ──
const AZUL_PRINCIPAL = 'FF1E40AF'; // --accent (tema claro, index.html)
const AZUL_OSCURO = 'FF153B82';
const AZUL_CLARO = 'FFEAF2FF';
const GRIS_MUY_CLARO = 'FFF6F8FC';
const GRIS_TEXTO = 'FF64748B'; // --text-muted (tema claro)
const TEXTO_OSCURO = 'FF0F172A'; // --text-main (tema claro)
const VERDE = 'FF059669'; // --success (tema claro) -- Processed
const TURQUESA = 'FF14B8A6'; // mismo color que .opc-row-finishedgood en index.html
const ROJO = 'FFDC2626'; // --danger (tema claro) -- Delta vs Processed
const MORADO = 'FF7C3AED'; // mismo tono que la linea de Recovery Plan en las graficas
const NARANJA = 'FFD97706'; // --warning (tema claro) -- % Plan
const LIMA = 'FF84CC16'; // mismo tono que .opc-pct-ok en index.html
const BLANCO = 'FFFFFFFF';
const BORDE_SUAVE = { style: 'thin', color: { argb: 'FFCBD5E1' } };
const ALL_BORDERS = { top: BORDE_SUAVE, left: BORDE_SUAVE, bottom: BORDE_SUAVE, right: BORDE_SUAVE };

const BANNER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: AZUL_PRINCIPAL } };
const BANNER_FONT = { color: { argb: BLANCO }, bold: true, size: 12 };
const WEEKDAY_HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: AZUL_PRINCIPAL } };
const WEEKEND_HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: AZUL_CLARO } };
const WEEKEND_CELL_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: GRIS_MUY_CLARO } };

// Logo real del proyecto (branding/vios-hyundai-light.png) -- se lee UNA vez
// al cargar el modulo, nunca se genera/inventa un logo distinto. Si el
// archivo no existe (entorno sin el asset) se omite silenciosamente y el
// resto del diseno sigue funcionando sin logo.
const LOGO_PATH = path.join(__dirname, '..', '..', 'branding', 'vios-hyundai-light.png');
let LOGO_BUFFER = null;
try { LOGO_BUFFER = fs.readFileSync(LOGO_PATH); } catch { LOGO_BUFFER = null; }

const ROW_LABELS = [
  { key: 'plan', label: 'Plan (Materials Available)', color: AZUL_PRINCIPAL },
  { key: 'processed', label: 'Processed', color: VERDE },
  { key: 'finishedGood', label: 'Finished Good', color: TURQUESA },
  { key: 'delta', label: 'Delta vs Processed', color: ROJO },
  { key: 'recoveryPlan', label: 'Recovery Plan', color: MORADO },
  { key: 'pctPlanPct', label: '% Plan', color: NARANJA },
];

const DIAS_CORTOS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb']; // indexado por getUTCDay()
const ACTION_PLAN_HEADERS = ['Week', 'Accountable', 'Descripción de las acciones', 'Committed date', 'Estatus'];
// Cada columna de Action Plan puede ocupar VARIAS columnas fisicas de la hoja
// (las mismas 8 columnas que usa la tabla de produccion arriba: Concepto +
// 7 dias) -- se fusionan para lograr "Descripcion" mucho mas ancha sin tener
// que romper el ancho uniforme de los dias en la tabla de arriba, que
// comparte esas mismas columnas fisicas.
const ACTION_PLAN_SPANS = [1, 2, 3, 1, 1]; // Week=A, Accountable=B:C, Descripcion=D:F, Committed date=G, Estatus=H

const ESTATUS_STYLE = {
  'Pendiente': { font: NARANJA, fill: 'FFFEF3E2' },
  'En proceso': { font: AZUL_PRINCIPAL, fill: AZUL_CLARO },
  'Completado': { font: VERDE, fill: 'FFECFDF5' },
};

function fmtDate(d) {
  if (!d) return '';
  const dt = d instanceof Date ? d : new Date(d);
  return `${String(dt.getUTCDate()).padStart(2, '0')}/${String(dt.getUTCMonth() + 1).padStart(2, '0')}/${dt.getUTCFullYear()}`;
}

function fmtMesAnio(d) {
  return new Intl.DateTimeFormat('es-MX', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(d);
}

// Color del texto de % Plan, mismos umbrales que opcPctClass() en index.html
// (fraccion 0..1, NUNCA se compara contra *100).
function pctFontColor(fraction) {
  if (fraction >= 1) return VERDE;
  if (fraction >= 0.8) return LIMA;
  if (fraction >= 0.5) return NARANJA;
  return ROJO;
}

// Celda generica con bordes + alineacion consistentes. `value === null`
// (dato que NUNCA se capturo) se pinta como "-" -- nunca en blanco y nunca
// como 0, para que el Excel exportado distinga lo mismo que ya distingue la
// pantalla (celda vacia != cero real, ver planProduccionOpenCellHelpers.js).
function writeCell(ws, r, c, value, opts = {}) {
  const cell = ws.getRow(r).getCell(c);
  if (value === null || value === undefined) {
    cell.value = '-';
    cell.font = { color: { argb: GRIS_TEXTO } };
  } else {
    cell.value = value;
    if (opts.font) cell.font = opts.font;
    if (opts.numFmt) cell.numFmt = opts.numFmt;
  }
  cell.border = ALL_BORDERS;
  cell.alignment = { vertical: 'middle', horizontal: opts.align || 'center', wrapText: !!opts.wrap };
  if (opts.fill) cell.fill = opts.fill;
  return cell;
}

// ── Encabezado: logo + mes/año a la derecha + titulo "PRODUCCION SEMANAL" ──
function buildHeaderSection(ws, week, colCount) {
  ws.getRow(1).height = 30;
  ws.getRow(2).height = 20;

  if (LOGO_BUFFER) {
    const imageId = ws.workbook.addImage({ buffer: LOGO_BUFFER, extension: 'png' });
    ws.addImage(imageId, { tl: { col: 0.15, row: 0.15 }, ext: { width: 150, height: 50 } });
  } else {
    const fallback = ws.getCell('A1');
    fallback.value = 'VIOS / HYUNDAI';
    fallback.font = { bold: true, size: 16, color: { argb: AZUL_OSCURO } };
  }

  const mesAnio = ws.getCell(1, colCount - 1);
  mesAnio.value = fmtMesAnio(week.weekStartDate);
  mesAnio.font = { bold: true, size: 11, color: { argb: AZUL_OSCURO } };
  mesAnio.alignment = { horizontal: 'right', vertical: 'middle' };
  ws.mergeCells(1, colCount - 1, 1, colCount);

  const linea2 = ws.getCell(2, colCount - 1);
  linea2.value = 'Plan de Producción | OpenCell';
  linea2.font = { size: 9, color: { argb: GRIS_TEXTO } };
  linea2.alignment = { horizontal: 'right', vertical: 'middle' };
  ws.mergeCells(2, colCount - 1, 2, colCount);

  let r = 4;
  const titulo = ws.getCell(r, 1);
  titulo.value = 'PRODUCCIÓN SEMANAL';
  titulo.font = { bold: true, size: 20, color: { argb: AZUL_OSCURO } };
  ws.mergeCells(r, 1, r, colCount);
  ws.getRow(r).height = 28;
  r++;

  const subtitulo = ws.getCell(r, 1);
  subtitulo.value = `Semana ${week.weekNumber} — ${fmtDate(week.weekStartDate)} al ${fmtDate(week.weekEndDate)}`;
  subtitulo.font = { size: 11, color: { argb: GRIS_TEXTO } };
  ws.mergeCells(r, 1, r, colCount);
  r += 2; // fila en blanco de respiro

  return r;
}

function buildSectionBanner(ws, r, text, colCount) {
  const cell = ws.getCell(r, 1);
  cell.value = text;
  cell.font = BANNER_FONT;
  cell.fill = BANNER_FILL;
  cell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  ws.mergeCells(r, 1, r, colCount);
  ws.getRow(r).height = 22;
  return r + 1;
}

// ── Tabla "Producción Semanal": Concepto + 7 dias, 6 metricas con bullet de color ──
function buildProductionTable(ws, week, startRow) {
  let r = startRow;
  const headerRow = r;
  const concepto = writeCell(ws, headerRow, 1, 'Concepto', { fill: WEEKDAY_HEADER_FILL, align: 'left' });
  concepto.font = { ...BANNER_FONT, size: 11 };
  week.days.forEach((d, i) => {
    const dow = d.date.getUTCDay();
    const isWeekend = dow === 0 || dow === 6;
    const cell = ws.getRow(headerRow).getCell(i + 2);
    cell.value = `${fmtDate(d.date)}\n${DIAS_CORTOS[dow]}`;
    cell.border = ALL_BORDERS;
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.fill = isWeekend ? WEEKEND_HEADER_FILL : WEEKDAY_HEADER_FILL;
    cell.font = isWeekend ? { bold: true, color: { argb: AZUL_OSCURO } } : { bold: true, color: { argb: BLANCO } };
  });
  ws.getRow(headerRow).height = 32;
  r++;

  for (const { key, label, color } of ROW_LABELS) {
    const isPct = key === 'pctPlanPct';
    const labelCell = ws.getRow(r).getCell(1);
    labelCell.value = { richText: [
      { font: { color: { argb: color }, size: 12 }, text: '●  ' },
      { font: { bold: true, color: { argb: TEXTO_OSCURO } }, text: label },
    ] };
    labelCell.border = ALL_BORDERS;
    labelCell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };

    week.days.forEach((d, i) => {
      const raw = isPct ? d.pctPlan : d[key];
      const dow = d.date.getUTCDay();
      const isWeekend = dow === 0 || dow === 6;
      const cell = writeCell(ws, r, i + 2, raw, {
        fill: isWeekend ? WEEKEND_CELL_FILL : undefined,
        numFmt: isPct && raw !== null && raw !== undefined ? '0%' : undefined,
        font: isPct && raw !== null && raw !== undefined ? { bold: true, color: { argb: pctFontColor(raw) } } : undefined,
      });
      if (raw === null || raw === undefined) cell.alignment = { ...cell.alignment, horizontal: 'center' };
    });
    r++;
  }
  return r + 1; // fila en blanco de respiro
}

// ── Action Plan: banner + encabezados (columnas fusionadas) + filas reales o empty state ──
function buildActionPlanSection(ws, week, actionItems, startRow, colCount) {
  let r = buildSectionBanner(ws, startRow, `📋  ACTION PLAN - SEMANA ${week.weekNumber}`, colCount);

  const headerRow = r;
  let col = 1;
  ACTION_PLAN_HEADERS.forEach((label, i) => {
    const span = ACTION_PLAN_SPANS[i];
    const cell = ws.getRow(headerRow).getCell(col);
    cell.value = label;
    cell.font = { ...BANNER_FONT, size: 10 };
    cell.fill = WEEKDAY_HEADER_FILL;
    cell.border = ALL_BORDERS;
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    if (span > 1) ws.mergeCells(headerRow, col, headerRow, col + span - 1);
    for (let extra = 1; extra < span; extra++) ws.getRow(headerRow).getCell(col + extra).border = ALL_BORDERS;
    col += span;
  });
  r++;

  if (!actionItems || !actionItems.length) {
    const emptyRowStart = r;
    const emptyRowEnd = r + 2;
    ws.mergeCells(emptyRowStart, 1, emptyRowEnd, colCount);
    const cell = ws.getCell(emptyRowStart, 1);
    cell.value = { richText: [
      { font: { bold: true, size: 12, color: { argb: TEXTO_OSCURO } }, text: '🗒️  Sin acciones registradas para esta semana\n' },
      { font: { size: 10, color: { argb: GRIS_TEXTO } }, text: 'Agrega acciones para dar seguimiento al plan de producción' },
    ] };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = ALL_BORDERS;
    for (let rr = emptyRowStart; rr <= emptyRowEnd; rr++) ws.getRow(rr).height = 20;
    r = emptyRowEnd + 1;
  } else {
    for (const item of actionItems) {
      const estatus = item.estatus || 'Pendiente';
      const estiloEstatus = ESTATUS_STYLE[estatus] || ESTATUS_STYLE.Pendiente;
      let c = 1;
      writeCell(ws, r, c, `Week ${item.weekNumber}`); c += ACTION_PLAN_SPANS[0];
      writeCell(ws, r, c, item.accountable || '-', { align: 'left', wrap: true });
      ws.mergeCells(r, c, r, c + ACTION_PLAN_SPANS[1] - 1); c += ACTION_PLAN_SPANS[1];
      writeCell(ws, r, c, item.descripcion || '-', { align: 'left', wrap: true });
      ws.mergeCells(r, c, r, c + ACTION_PLAN_SPANS[2] - 1); c += ACTION_PLAN_SPANS[2];
      writeCell(ws, r, c, item.committedDate ? fmtDate(item.committedDate) : null); c += ACTION_PLAN_SPANS[3];
      writeCell(ws, r, c, estatus, { font: { bold: true, color: { argb: estiloEstatus.font } }, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: estiloEstatus.fill } } });
      // Altura estimada por lineas envueltas (Descripcion es la columna mas
      // ancha, la que mas domina) -- una altura fija (ej. 20) cortaba
      // descripciones largas porque desactiva el autofit de Excel para esa
      // fila (bug real detectado con una descripcion de 2 lineas en la
      // verificacion visual de este cambio, via PDF exportado con Excel COM).
      const CHARS_POR_LINEA_DESC = 42; // ancho real de la columna fusionada D:F (39 unidades)
      const lineas = Math.max(1, Math.ceil((item.descripcion || '-').length / CHARS_POR_LINEA_DESC));
      ws.getRow(r).height = Math.max(20, lineas * 15);
      r++;
    }
  }
  return r;
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

  const wsProd = wb.addWorksheet(`Semana ${week.weekNumber}`, {
    views: [{ showGridLines: false }], // sin freeze panes: bug conocido de ExcelJS duplica visualmente el encabezado si no se pasa topLeftCell (ver memoria del proyecto) -- no vale la pena el riesgo para una hoja de este tamaño
  });
  const colCount = week.days.length + 1; // Concepto + 7 dias = 8
  wsProd.columns = [{ width: 28 }, ...week.days.map(() => ({ width: 13 }))];

  let r = buildHeaderSection(wsProd, week, colCount);
  r = buildSectionBanner(wsProd, r, '📊  PRODUCCIÓN SEMANAL', colCount);
  r = buildProductionTable(wsProd, week, r);
  r = buildActionPlanSection(wsProd, week, actionItems, r, colCount);

  wsProd.pageSetup = {
    orientation: 'landscape',
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0, // 0 = tantas paginas de alto como haga falta, siempre 1 de ancho
    horizontalCentered: true,
    margins: { left: 0.35, right: 0.35, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 },
    printArea: `A1:${wsProd.getColumn(colCount).letter}${r - 1}`,
  };

  return wb;
}

module.exports = { construirWorkbookPlanProduccionOpenCell };
