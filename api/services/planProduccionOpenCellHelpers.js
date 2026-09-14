// Helpers puros (sin DB, sin red) para el modulo "Plan de Produccion OpenCell":
// parseo generico del Excel semanal ("Plan de produccion semanal Open cell.xlsx",
// hoja Summary + hojas "Week NN"), calculo de totales/KPIs semanales y aritmetica
// de navegacion entre semanas. Se mantienen aqui, separados de api/index.js, para
// poder probarlos con node:test sin necesitar Mongo real ni un archivo .xlsx real
// (los tests construyen worksheets de ExcelJS en memoria).
//
// Principio que gobierna todo este archivo (pedido explicito de Roman): una
// celda VACIA nunca se convierte en 0. Todo valor numerico que no pudo leerse
// regresa `null`, nunca `0` ni NaN/Infinity.

const DAY_MS = 24 * 60 * 60 * 1000;

// ── Valor/tipo de celda ──

// Resuelve el valor "real" de una celda de ExcelJS: soporta formulas
// (`{formula, result}`), formulas compartidas (`{sharedFormula, result}`),
// texto enriquecido (`{richText:[...]}`) y valores planos. Si una formula no
// trae `result` calculado, regresa null (NUNCA 0) -- se trata como falta de
// dato, no como un cero real.
function cellValue(cell) {
  if (!cell) return null;
  const v = cell.value;
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join('');
    if (Object.prototype.hasOwnProperty.call(v, 'result')) return v.result === undefined ? null : v.result;
    if (Object.prototype.hasOwnProperty.call(v, 'text')) return v.text;
    return null;
  }
  return v;
}

function toNumberOrNull(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function toTrimmedString(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  return String(v).trim();
}

function toDateOrNull(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === 'string' && v.trim()) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

// ── Fechas / semanas ──

function addDays(date, n) {
  return new Date(date.getTime() + n * DAY_MS);
}

// Lunes 00:00 UTC de la semana (Lunes-Domingo) que contiene `date`. TODAS las
// fechas de este modulo se tratan como "dia calendario" en UTC, nunca en hora
// local: ExcelJS regresa las fechas del .xlsx como medianoche UTC, y este
// backend corre en servidores cuya zona local puede ser distinta de UTC (ej.
// America/Mexico_City, GMT-6) -- usar getFullYear()/getDay() (locales) sobre
// esas fechas las recorre un dia hacia atras (bug real detectado: Week 36
// "31/08/2026" se calculaba como si empezara el 24/08/2026). getUTCDay()/
// Date.UTC() evitan ese corrimiento sin importar en que zona corra el server.
function mondayOf(date) {
  const utcMidnight = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dow = utcMidnight.getUTCDay(); // 0=Domingo
  const diff = dow === 0 ? -6 : 1 - dow;
  return addDays(utcMidnight, diff);
}

function pad2(n) { return String(n).padStart(2, '0'); }
function weekKey(year, weekNumber) { return `${year}-W${pad2(weekNumber)}`; }

// Numero de semana ISO-8601 (Lunes-Domingo, semana 1 = la que contiene el
// primer Jueves del ano) de `date`. Verificado contra el Excel real de Roman:
// el numero de semana que usa el Excel ("Week 36" para el Lunes 31/08/2026)
// coincide exactamente con ISO-8601 -- se usa SOLO como ancla de arranque
// quando la base de datos todavia no tiene ninguna semana importada (ver
// /api/plan-produccion-opencell/week/:year/:weekNumber en api/index.js), NUNCA
// para sobreescribir el numero de semana que ya trae un archivo importado.
function isoWeekNumber(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d - yearStart) / DAY_MS + 1) / 7);
}

// weekStartDate de `targetWeekNumber` a partir de una semana ancla conocida,
// desplazando la fecha 7*n dias (n = diferencia de numero de semana). Pedido
// explicito de Roman: nunca reinventar una formula de semana ISO aparte --
// solo sumar/restar dias sobre una fecha real ya conocida. Funciona cruzando
// fin de ano porque opera sobre timestamps, no sobre el numero de semana.
function computeWeekStartDate(anchorWeekStartDate, anchorWeekNumber, targetWeekNumber) {
  const diffWeeks = targetWeekNumber - anchorWeekNumber;
  return addDays(anchorWeekStartDate, diffWeeks * 7);
}

// ── Deteccion generica de bloques de columnas por texto repetido ──

// Agrupa columnas CONTIGUAS de una fila que comparten el mismo texto (trim,
// no vacio) en bloques {text, startCol, endCol}. Sirve tanto para la fila de
// "Week NN" del Summary como para la fila de dias (MON/TUE/...) de las hojas
// "Week NN" -- ninguna de las 2 asume un ancho fijo de columnas por bloque.
function detectRowBlocks(worksheet, rowNumber, { fromCol = 1, toCol } = {}) {
  const row = worksheet.getRow(rowNumber);
  const lastCol = toCol || worksheet.columnCount || 1;
  const blocks = [];
  let current = null;
  for (let c = fromCol; c <= lastCol; c++) {
    const text = toTrimmedString(cellValue(row.getCell(c)));
    if (!text) { current = null; continue; }
    if (current && current.text === text) {
      current.endCol = c;
    } else {
      current = { text, startCol: c, endCol: c };
      blocks.push(current);
    }
  }
  return blocks;
}

// Primera fila que contiene, en CUALQUIER columna, un texto que matchea
// /^Week\s+\d+$/i -- es la fila de encabezados de semana del Summary. No
// asume que sea la fila 23, solo que el patron exista en alguna celda.
function findWeekHeaderRow(worksheet, { maxRow } = {}) {
  const lastRow = maxRow || worksheet.rowCount;
  const lastCol = worksheet.columnCount || 1;
  const re = /^week\s+\d+$/i;
  for (let r = 1; r <= lastRow; r++) {
    const row = worksheet.getRow(r);
    for (let c = 1; c <= lastCol; c++) {
      if (re.test(toTrimmedString(cellValue(row.getCell(c))))) return r;
    }
  }
  return null;
}

// Primera fila cuya columna A (recortada) coincide con `label` (comparacion
// case-insensitive; los labels reales del Excel a veces traen espacios
// extra, ya resueltos por toTrimmedString).
function findRowByLabel(worksheet, label, { maxRow } = {}) {
  const lastRow = maxRow || worksheet.rowCount;
  const target = label.trim().toLowerCase();
  for (let r = 1; r <= lastRow; r++) {
    const raw = toTrimmedString(cellValue(worksheet.getRow(r).getCell(1))).toLowerCase();
    if (raw === target) return r;
  }
  return null;
}

// ── Hoja "Summary" ──

const METRIC_LABELS = {
  plan: 'Plan (Materials Available)',
  processed: 'Processed',
  finishedGood: 'Finished Good',
  delta: 'Delta vs Processed',
  recoveryPlan: 'Recovery Plan',
  pctPlan: '% Plan',
};

function parseSummaryMetricRows(worksheet) {
  const metricRows = {};
  const warnings = [];
  for (const [key, label] of Object.entries(METRIC_LABELS)) {
    const row = findRowByLabel(worksheet, label);
    metricRows[key] = row;
    if (row == null) warnings.push(`No se encontro la fila "${label}" en la hoja Summary.`);
  }
  return { metricRows, warnings };
}

// Parsea la hoja "Summary" completa: bloques de semana (ancho variable),
// fecha real por columna y las 6 metricas diarias -- SIN tocar el detalle
// Brand/Model/Size/QTY (eso viene de las hojas "Week NN", ver mergeWeekDetail).
function parseSummarySheet(worksheet) {
  const weekHeaderRow = findWeekHeaderRow(worksheet);
  if (weekHeaderRow == null) {
    return { weeks: [], actionItems: [], warnings: ['No se encontro la fila de encabezados de semana ("Week N") en la hoja Summary.'] };
  }
  const dateRow = weekHeaderRow + 1;
  const blocks = detectRowBlocks(worksheet, weekHeaderRow).filter((b) => /^week\s+\d+$/i.test(b.text));
  const { metricRows, warnings } = parseSummaryMetricRows(worksheet);

  const weeks = [];
  for (const block of blocks) {
    const weekNumber = parseInt(block.text.match(/\d+/)[0], 10);
    const days = [];
    for (let c = block.startCol; c <= block.endCol; c++) {
      const dateVal = toDateOrNull(cellValue(worksheet.getRow(dateRow).getCell(c)));
      if (!dateVal) continue; // columna del bloque sin fecha real -- se ignora, no se inventa
      days.push({
        date: dateVal,
        plan: metricRows.plan != null ? toNumberOrNull(cellValue(worksheet.getRow(metricRows.plan).getCell(c))) : null,
        processed: metricRows.processed != null ? toNumberOrNull(cellValue(worksheet.getRow(metricRows.processed).getCell(c))) : null,
        finishedGood: metricRows.finishedGood != null ? toNumberOrNull(cellValue(worksheet.getRow(metricRows.finishedGood).getCell(c))) : null,
        delta: metricRows.delta != null ? toNumberOrNull(cellValue(worksheet.getRow(metricRows.delta).getCell(c))) : null,
        recoveryPlan: metricRows.recoveryPlan != null ? toNumberOrNull(cellValue(worksheet.getRow(metricRows.recoveryPlan).getCell(c))) : null,
        pctPlan: metricRows.pctPlan != null ? toNumberOrNull(cellValue(worksheet.getRow(metricRows.pctPlan).getCell(c))) : null,
        detail: [],
      });
    }
    if (!days.length) continue;
    const weekStartDate = mondayOf(days[0].date);
    weeks.push({
      year: weekStartDate.getUTCFullYear(),
      weekNumber,
      weekStartDate,
      weekEndDate: addDays(weekStartDate, 6),
      days,
    });
  }

  return { weeks, actionItems: parseActionPlanBlock(worksheet), warnings };
}

// ── Bloque "Action Plan" (dentro de la hoja Summary) ──

const ACTION_FIELD_MATCHERS = [
  { key: 'week', test: (t) => t.toLowerCase() === 'week' },
  { key: 'accountable', test: (t) => t.toLowerCase() === 'accountable' },
  { key: 'descripcion', test: (t) => t.toLowerCase().startsWith('descripcion de las acciones') },
  // El Excel original trae el typo "Commited date" (sin la segunda 'm'). Se
  // acepta tambien la forma correcta "Committed date" por si se corrige.
  { key: 'committedDate', test: (t) => { const low = t.toLowerCase(); return low.startsWith('commited date') || low.startsWith('committed date'); } },
];

// Extrae los items del bloque "Action Plan " (nota: el label real trae un
// espacio final en el archivo de origen) de la hoja Summary. Descarta filas
// placeholder totalmente vacias (solo con la columna Week llena) -- un item
// solo es real si Accountable o Descripcion tienen contenido.
function parseActionPlanBlock(worksheet) {
  let headerAnchorRow = null;
  for (let r = 1; r <= worksheet.rowCount; r++) {
    const text = toTrimmedString(cellValue(worksheet.getRow(r).getCell(1))).toLowerCase();
    if (text === 'action plan') { headerAnchorRow = r; break; }
  }
  if (headerAnchorRow == null) return [];

  const fieldHeaderRow = headerAnchorRow + 1;
  const blocks = detectRowBlocks(worksheet, fieldHeaderRow);
  const fieldCols = {};
  for (const block of blocks) {
    const match = ACTION_FIELD_MATCHERS.find((m) => m.test(block.text));
    if (match && fieldCols[match.key] == null) fieldCols[match.key] = block.startCol;
  }
  if (fieldCols.week == null) return [];

  const items = [];
  for (let r = fieldHeaderRow + 1; r <= worksheet.rowCount; r++) {
    const row = worksheet.getRow(r);
    const weekText = toTrimmedString(cellValue(row.getCell(fieldCols.week)));
    const accountable = fieldCols.accountable != null ? toTrimmedString(cellValue(row.getCell(fieldCols.accountable))) : '';
    const descripcion = fieldCols.descripcion != null ? toTrimmedString(cellValue(row.getCell(fieldCols.descripcion))) : '';
    const committedDateRaw = fieldCols.committedDate != null ? cellValue(row.getCell(fieldCols.committedDate)) : null;
    if (!accountable && !descripcion) continue;
    const weekMatch = weekText.match(/\d+/);
    if (!weekMatch) continue;
    items.push({
      weekNumber: parseInt(weekMatch[0], 10),
      accountable,
      descripcion,
      committedDate: toDateOrNull(committedDateRaw),
    });
  }
  return items;
}

// ── Hojas de detalle "Week NN" ──

// getDay(): 0=Domingo..6=Sabado. Alinea el label de dia en ingles (fila 2 de
// las hojas "Week NN") con el dia-de-semana REAL de cada fecha del Summary --
// nunca se asume por posicion/indice de columna.
const DAY_LABEL_TO_DOW = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };

// Parsea UNA hoja "Week NN": bloques de dia (ancho variable, detectado por
// texto repetido en la fila 2) y, dentro de cada bloque, columnas
// Brand/Model/Size/QTY localizadas por su propio sub-encabezado (fila 3) --
// nunca por posicion fija. Se detiene en la fila "TOTAL" de cada bloque
// (guarda su valor) e ignora cualquier "Grand total" posterior.
function parseWeekDetailSheet(worksheet) {
  const dayHeaderRow = 2;
  const subHeaderRow = 3;
  const dayBlocks = detectRowBlocks(worksheet, dayHeaderRow).filter((b) => /^[a-z]{3}$/i.test(b.text));

  const result = [];
  for (const block of dayBlocks) {
    const subLabels = [];
    for (let c = block.startCol; c <= block.endCol; c++) {
      subLabels.push(toTrimmedString(cellValue(worksheet.getRow(subHeaderRow).getCell(c))).toLowerCase());
    }
    const colFor = (name) => {
      const idx = subLabels.findIndex((t) => t.startsWith(name));
      return idx === -1 ? null : block.startCol + idx;
    };
    const brandCol = colFor('brand');
    const modelCol = colFor('model');
    const sizeCol = colFor('size');
    const qtyCol = colFor('qty');

    const items = [];
    let total = null;
    for (let r = subHeaderRow + 1; r <= worksheet.rowCount; r++) {
      const row = worksheet.getRow(r);
      const firstCellText = toTrimmedString(cellValue(row.getCell(block.startCol)));
      if (/^total$/i.test(firstCellText)) {
        total = qtyCol != null ? toNumberOrNull(cellValue(row.getCell(qtyCol))) : null;
        break;
      }
      if (/^grand total$/i.test(firstCellText)) break;
      const brand = brandCol != null ? toTrimmedString(cellValue(row.getCell(brandCol))) : '';
      const model = modelCol != null ? toTrimmedString(cellValue(row.getCell(modelCol))) : '';
      const size = sizeCol != null ? toNumberOrNull(cellValue(row.getCell(sizeCol))) : null;
      const qty = qtyCol != null ? toNumberOrNull(cellValue(row.getCell(qtyCol))) : null;
      if (!brand && !model && size == null && qty == null) continue;
      items.push({ brand, model, size, qty });
    }
    result.push({ dayLabel: block.text.toUpperCase(), items, total });
  }
  return result;
}

// Adjunta el detalle Brand/Model/Size/QTY de una hoja "Week NN" ya parseada
// (parseWeekDetailSheet) a los dias correspondientes de una semana ya
// parseada del Summary, alineando por dia-de-semana real (nunca por indice).
function mergeWeekDetail(week, dayBlocks) {
  const days = week.days.map((d) => ({ ...d, detail: Array.isArray(d.detail) ? d.detail : [] }));
  for (const block of dayBlocks) {
    const dow = DAY_LABEL_TO_DOW[block.dayLabel];
    if (dow === undefined) continue;
    const day = days.find((d) => d.date.getUTCDay() === dow);
    if (day) day.detail = block.items;
  }
  return { ...week, days };
}

// ── Orquestador: workbook completo -> semanas + action plan ──

// `workbook` ya debe estar cargado (ExcelJS.Workbook con .xlsx.load/readFile
// ya resuelto). Nunca lanza por hojas "Week NN" sin semana correspondiente en
// Summary -- las reporta en `warnings` y sigue con el resto del archivo.
function parseOpenCellWorkbook(workbook) {
  const summarySheet = workbook.getWorksheet('Summary');
  if (!summarySheet) {
    return { weeks: [], actionItems: [], warnings: ['El archivo no tiene una hoja "Summary".'] };
  }
  const parsedSummary = parseSummarySheet(summarySheet);
  const warnings = [...parsedSummary.warnings];
  const weeksByNumber = new Map(parsedSummary.weeks.map((w) => [w.weekNumber, w]));

  for (const ws of workbook.worksheets) {
    const m = /^week\s+(\d+)$/i.exec((ws.name || '').trim());
    if (!m) continue;
    const weekNumber = parseInt(m[1], 10);
    const week = weeksByNumber.get(weekNumber);
    if (!week) {
      warnings.push(`La hoja "${ws.name}" no tiene semana correspondiente en Summary (semana ${weekNumber} no encontrada) -- se ignoro su detalle.`);
      continue;
    }
    weeksByNumber.set(weekNumber, mergeWeekDetail(week, parseWeekDetailSheet(ws)));
  }

  return {
    weeks: [...weeksByNumber.values()].sort((a, b) => a.weekStartDate - b.weekStartDate),
    actionItems: parsedSummary.actionItems,
    warnings,
  };
}

// ── Calculos de KPI / semana vacia ──

// Suma ignorando null/undefined (una celda vacia NO suma como 0, pero
// tampoco "contamina" la suma de los dias que si tienen dato). Si NINGUN
// dia tiene dato, regresa null (no 0) -- semana totalmente sin informacion.
function sumOrNull(values) {
  const nums = values.filter((v) => v !== null && v !== undefined);
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0);
}

// Porcentaje numerator/denominator*100 con guardia division-por-cero/null ->
// null (nunca NaN/Infinity).
function calcPct(numerator, denominator) {
  if (denominator === null || denominator === undefined || denominator === 0) return null;
  if (numerator === null || numerator === undefined) return null;
  return (numerator / denominator) * 100;
}

function calcWeeklyTotals(days) {
  const plan = sumOrNull(days.map((d) => d.plan));
  const processed = sumOrNull(days.map((d) => d.processed));
  const finishedGood = sumOrNull(days.map((d) => d.finishedGood));
  const delta = sumOrNull(days.map((d) => d.delta));
  return { plan, processed, finishedGood, delta, cumplimientoPct: calcPct(processed, plan) };
}

// Semana "vacia" (aun no importada) con fechas correctas y todas las
// metricas en null -- para que la navegacion nunca truene en una semana sin
// datos todavia.
function buildEmptyWeekSkeleton(year, weekNumber, weekStartDate) {
  const days = [];
  for (let i = 0; i < 7; i++) {
    days.push({
      date: addDays(weekStartDate, i),
      plan: null, processed: null, finishedGood: null, delta: null, recoveryPlan: null, pctPlan: null,
      detail: [],
    });
  }
  return { year, weekNumber, weekStartDate, weekEndDate: addDays(weekStartDate, 6), days };
}

// ── Action Plan: dedupe / estatus default al importar ──

// Clave estable para NO duplicar un item de Action Plan al reimportar el
// mismo Excel (o una version corregida) -- un item que ya existe en la app
// conserva su estatus/ediciones; solo se agregan items realmente nuevos.
function actionItemSourceKey(item) {
  const dateStr = item.committedDate ? item.committedDate.toISOString().slice(0, 10) : '';
  return [item.weekNumber, item.accountable.trim().toLowerCase(), item.descripcion.trim().toLowerCase(), dateStr].join('|');
}

// El Excel origen no trae columna de Estatus (es un campo nuevo de la app).
// Al importar por primera vez, se asigna un default razonable: si la fecha
// comprometida ya paso, 'Completado'; si no, 'Pendiente'. Reimportar NUNCA
// pisa el estatus real ya editado en la app (eso lo decide el caller via
// actionItemSourceKey, no esta funcion).
function defaultEstatusFor(committedDate, today = new Date()) {
  if (!committedDate) return 'Pendiente';
  return committedDate.getTime() < today.getTime() ? 'Completado' : 'Pendiente';
}

module.exports = {
  cellValue,
  toNumberOrNull,
  toTrimmedString,
  toDateOrNull,
  addDays,
  mondayOf,
  pad2,
  weekKey,
  isoWeekNumber,
  computeWeekStartDate,
  detectRowBlocks,
  findWeekHeaderRow,
  findRowByLabel,
  parseSummarySheet,
  parseActionPlanBlock,
  parseWeekDetailSheet,
  mergeWeekDetail,
  parseOpenCellWorkbook,
  sumOrNull,
  calcPct,
  calcWeeklyTotals,
  buildEmptyWeekSkeleton,
  actionItemSourceKey,
  defaultEstatusFor,
  METRIC_LABELS,
  DAY_LABEL_TO_DOW,
};
