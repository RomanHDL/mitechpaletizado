const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const {
  cellValue,
  toNumberOrNull,
  toDateOrNull,
  detectRowBlocks,
  computeWeekStartDate,
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
  isoWeekNumber,
} = require('./planProduccionOpenCellHelpers');

function setRow(ws, rowNumber, values) {
  // values: array indexada desde columna 1 (values[0] -> col A)
  const row = ws.getRow(rowNumber);
  values.forEach((v, i) => { if (v !== undefined) row.getCell(i + 1).value = v; });
}

test('cellValue/toNumberOrNull distinguen celda vacia (null) de cero real', () => {
  assert.equal(toNumberOrNull(null), null);
  assert.equal(toNumberOrNull(undefined), null);
  assert.equal(toNumberOrNull(''), null);
  assert.equal(toNumberOrNull(0), 0);
  assert.equal(toNumberOrNull('0'), 0);
  assert.equal(toNumberOrNull(32), 32);
});

test('cellValue resuelve formulas y formulas compartidas por su .result, nunca inventa 0', () => {
  assert.equal(cellValue({ value: { formula: 'I26', result: 152 } }), 152);
  assert.equal(cellValue({ value: { sharedFormula: 'J27', result: 141 } }), 141);
  assert.equal(cellValue({ value: { formula: 'I26', result: undefined } }), null);
  assert.equal(cellValue({ value: null }), null);
});

test('detectRowBlocks agrupa columnas contiguas con el mismo texto, ancho variable', () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('T');
  setRow(ws, 1, ['September', 'Week 36', 'Week 36', 'Week 37', 'Week 37', 'Week 37']);
  const blocks = detectRowBlocks(ws, 1);
  assert.equal(blocks.length, 3);
  assert.deepEqual(blocks[0], { text: 'September', startCol: 1, endCol: 1 });
  assert.deepEqual(blocks[1], { text: 'Week 36', startCol: 2, endCol: 3 });
  assert.deepEqual(blocks[2], { text: 'Week 37', startCol: 4, endCol: 6 });
});

// Regresion: ExcelJS regresa las fechas del .xlsx como medianoche UTC
// (Date.UTC), nunca hora local. Si mondayOf() usara getters locales
// (getFullYear/getDay) en un servidor con zona GMT-negativa (ej.
// America/Mexico_City), el "Lunes 31/08/2026" se recorreria al 24/08/2026 --
// bug real detectado al validar contra el Excel real de Roman.
test('mondayOf trata la fecha como UTC, sin corrimiento por zona horaria local', () => {
  const { mondayOf } = require('./planProduccionOpenCellHelpers');
  const utcMonday = new Date(Date.UTC(2026, 7, 31)); // 2026-08-31T00:00:00.000Z, tal cual lo regresa ExcelJS
  const result = mondayOf(utcMonday);
  assert.equal(result.toISOString(), '2026-08-31T00:00:00.000Z');
  const utcWednesday = new Date(Date.UTC(2026, 8, 2)); // 2026-09-02
  assert.equal(mondayOf(utcWednesday).toISOString(), '2026-08-31T00:00:00.000Z');
});

test('computeWeekStartDate desplaza 7 dias por semana, cruzando fin de ano', () => {
  const anchor = new Date(2026, 11, 28); // Lunes 28-dic-2026, semana 53 (ejemplo arbitrario)
  const next = computeWeekStartDate(anchor, 53, 54);
  assert.equal(next.getTime(), new Date(2027, 0, 4).getTime());
  const prev = computeWeekStartDate(anchor, 53, 51);
  assert.equal(prev.getTime(), new Date(2026, 11, 14).getTime());
});

function buildSummaryWorksheet() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Summary');
  // Semana 36: cols B-H (2-8), Semana 37: cols I-O (9-15) -- ancho variable (7 y 7 aqui, pero el parser no debe asumirlo)
  setRow(ws, 23, ['September', 'Week 36', 'Week 36', 'Week 36', 'Week 36', 'Week 36', 'Week 36', 'Week 36', 'Week 37', 'Week 37', 'Week 37']);
  setRow(ws, 24, [null,
    new Date(2026, 7, 31), new Date(2026, 8, 1), new Date(2026, 8, 2), new Date(2026, 8, 3), new Date(2026, 8, 4), new Date(2026, 8, 5), new Date(2026, 8, 6),
    new Date(2026, 8, 7), new Date(2026, 8, 8), new Date(2026, 8, 9),
  ]);
  setRow(ws, 25, ['Plan (Materials Available)', 180, 180, 180, 180, 180, null, null, 180, 180, 180]);
  setRow(ws, 26, ['Processed', 100, 152, 141, 160, 32, null, null, 0, 0, 0]);
  // Nota: ExcelJS descarta result:0 al asignar .value con setter en memoria (JS),
  // aunque un archivo .xlsx real si trae ese resultado cacheado -- se usan
  // valores no-cero aqui para probar la resolucion de formula/sharedFormula
  // sin toparse con esa limitacion del setter (ver test de cellValue() puro
  // arriba, que ya cubre result:152 y result:undefined directamente).
  setRow(ws, 27, ['Finished Good', 100, 152, 141, 160, 32, null, null, { formula: 'I26', result: 45 }, { formula: 'J26', result: 60 }, { sharedFormula: 'J27', result: 60 }]);
  setRow(ws, 28, ['Delta vs Processed', 80, 28, 39, 20, 148, null, null, 180, 180, 180]);
  setRow(ws, 29, ['Recovery Plan', null, 260, 208, 219, 200, null, null, null, 360, 360]);
  setRow(ws, 30, ['% Plan ', 0.5555555555555556, 0.8444444444444444, 0.7833333333333333, 0.8888888888888888, 0.17777777777777778, null, null, 0, 0, 0]);
  setRow(ws, 32, ['Action Plan ']);
  setRow(ws, 33, ['Week', 'Accountable', 'Accountable', 'Accountable', 'DESCRIPCION DE LAS ACCIONES', 'DESCRIPCION DE LAS ACCIONES', 'DESCRIPCION DE LAS ACCIONES', 'DESCRIPCION DE LAS ACCIONES', 'Commited date', 'Commited date', 'Commited date']);
  setRow(ws, 34, ['Week 36', 'Alvaro Lugo', 'Alvaro Lugo', 'Alvaro Lugo', 'Production Line set up', 'Production Line set up', 'Production Line set up', 'Production Line set up', new Date(2026, 8, 5), new Date(2026, 8, 5), new Date(2026, 8, 5)]);
  // Filas placeholder vacias (solo columna Week llena) -- deben ignorarse
  setRow(ws, 35, ['Week 36']);
  setRow(ws, 36, ['Week 36']);
  return ws;
}

test('parseSummarySheet detecta bloques de semana de ancho variable y no confunde vacio con cero', () => {
  const ws = buildSummaryWorksheet();
  const { weeks, warnings } = parseSummarySheet(ws);
  assert.equal(warnings.length, 0);
  assert.equal(weeks.length, 2);

  const w36 = weeks.find((w) => w.weekNumber === 36);
  assert.equal(w36.days.length, 7);
  assert.equal(w36.days[0].plan, 180);
  assert.equal(w36.days[0].processed, 100);
  // Sabado (indice 5) y Domingo (indice 6) vienen vacios en el Excel -> null, NO 0
  assert.equal(w36.days[5].plan, null);
  assert.equal(w36.days[5].processed, null);
  assert.equal(w36.days[6].recoveryPlan, null);
  // weekStartDate siempre se normaliza a medianoche UTC (ver mondayOf) --
  // se compara contra Date.UTC(...), no contra una fecha local.
  assert.equal(w36.weekStartDate.getTime(), Date.UTC(2026, 7, 31));

  const w37 = weeks.find((w) => w.weekNumber === 37);
  assert.equal(w37.days.length, 3);
  // Finished Good con formula compartida -> se resuelve por .result, no se ignora
  assert.equal(w37.days[0].finishedGood, 45);
  assert.equal(w37.days[2].finishedGood, 60);
});

test('parseActionPlanBlock lee el bloque merge-como-repetido y descarta filas placeholder vacias', () => {
  const ws = buildSummaryWorksheet();
  const items = parseActionPlanBlock(ws);
  assert.equal(items.length, 1);
  assert.equal(items[0].weekNumber, 36);
  assert.equal(items[0].accountable, 'Alvaro Lugo');
  assert.equal(items[0].descripcion, 'Production Line set up');
  assert.equal(items[0].committedDate.getTime(), new Date(2026, 8, 5).getTime());
});

function buildWeek36DetailWorksheet() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Week 36');
  setRow(ws, 1, Array(8).fill('WEEK 36'));
  setRow(ws, 2, ['MON', 'MON', 'MON', 'MON', 'TUE', 'TUE', 'TUE', 'TUE']);
  setRow(ws, 3, ['Brand ', 'Model', 'Size', 'QTY', 'Brand ', 'Model', 'Size', 'QTY']);
  setRow(ws, 4, ['Hisense', '55H5BR', 55, 44, 'Hisense', '50R6E5', 50, 97]);
  setRow(ws, 5, ['Hisense', '43A6H', 43, 4, 'Hisense', '40H4030F4', 40, 27]);
  setRow(ws, 6, [null, null, null, null, 'Hisense', '43R6E4', 43, 14]);
  setRow(ws, 7, ['TOTAL', 'TOTAL', 'TOTAL', 48, 'TOTAL', 'TOTAL', 'TOTAL', 138]);
  setRow(ws, 8, [null, null, null, null, null, null, 'Grand total', 999]);
  return ws;
}

test('parseWeekDetailSheet detecta bloques de dia de ancho variable, localiza columnas por sub-encabezado y para en TOTAL', () => {
  const ws = buildWeek36DetailWorksheet();
  const dayBlocks = parseWeekDetailSheet(ws);
  assert.equal(dayBlocks.length, 2);
  const mon = dayBlocks.find((b) => b.dayLabel === 'MON');
  assert.equal(mon.items.length, 2);
  assert.deepEqual(mon.items[0], { brand: 'Hisense', model: '55H5BR', size: 55, qty: 44 });
  assert.equal(mon.total, 48);
  const tue = dayBlocks.find((b) => b.dayLabel === 'TUE');
  assert.equal(tue.items.length, 3);
  assert.equal(tue.total, 138); // nunca lee el "Grand total" de la fila 8
});

test('mergeWeekDetail alinea el detalle por dia-de-semana real, no por indice', () => {
  const summaryWs = buildSummaryWorksheet();
  const { weeks } = parseSummarySheet(summaryWs);
  const w36 = weeks.find((w) => w.weekNumber === 36);
  const dayBlocks = parseWeekDetailSheet(buildWeek36DetailWorksheet());
  const merged = mergeWeekDetail(w36, dayBlocks);
  const monday = merged.days.find((d) => d.date.getDay() === 1);
  const tuesday = merged.days.find((d) => d.date.getDay() === 2);
  assert.equal(monday.detail.length, 2);
  assert.equal(tuesday.detail.length, 3);
  const wednesday = merged.days.find((d) => d.date.getDay() === 3);
  assert.equal(wednesday.detail.length, 0);
});

test('parseOpenCellWorkbook combina Summary + hojas Week NN dinamicamente (sin hardcodear 36/37)', () => {
  const wb = new ExcelJS.Workbook();
  const summaryWs = wb.addWorksheet('Summary');
  const src = buildSummaryWorksheet();
  src.eachRow((row, r) => row.eachCell({ includeEmpty: false }, (cell, c) => { summaryWs.getRow(r).getCell(c).value = cell.value; }));
  const detailWs = wb.addWorksheet('Week 36');
  const srcDetail = buildWeek36DetailWorksheet();
  srcDetail.eachRow((row, r) => row.eachCell({ includeEmpty: false }, (cell, c) => { detailWs.getRow(r).getCell(c).value = cell.value; }));

  const { weeks, actionItems, warnings } = parseOpenCellWorkbook(wb);
  assert.equal(weeks.length, 2);
  assert.equal(actionItems.length, 1);
  const w36 = weeks.find((w) => w.weekNumber === 36);
  const monday = w36.days.find((d) => d.date.getDay() === 1);
  assert.equal(monday.detail.length, 2);
  // Semana 37 no tiene hoja de detalle en este workbook -> sin warning fatal, solo sin detalle
  const w37 = weeks.find((w) => w.weekNumber === 37);
  assert.equal(w37.days.every((d) => d.detail.length === 0), true);
  assert.equal(warnings.length, 0);
});

test('sumOrNull / calcPct: division por cero y semana sin ningun dato regresan null, nunca NaN/Infinity', () => {
  assert.equal(sumOrNull([null, undefined, null]), null);
  assert.equal(sumOrNull([null, 5, 10]), 15);
  assert.equal(calcPct(100, 0), null);
  assert.equal(calcPct(100, null), null);
  assert.equal(calcPct(null, 100), null);
  assert.equal(calcPct(50, 100), 50);
});

test('calcWeeklyTotals suma solo dias con dato y calcula cumplimiento semanal', () => {
  const days = [
    { plan: 180, processed: 100, finishedGood: 100, delta: 80 },
    { plan: 180, processed: 152, finishedGood: 152, delta: 28 },
    { plan: null, processed: null, finishedGood: null, delta: null },
  ];
  const totals = calcWeeklyTotals(days);
  assert.equal(totals.plan, 360);
  assert.equal(totals.processed, 252);
  assert.equal(totals.cumplimientoPct, (252 / 360) * 100);
});

test('buildEmptyWeekSkeleton produce 7 dias con fechas correctas y todas las metricas en null', () => {
  const monday = new Date(2026, 8, 7);
  const skeleton = buildEmptyWeekSkeleton(2026, 37, monday);
  assert.equal(skeleton.days.length, 7);
  assert.equal(skeleton.days[0].date.getTime(), monday.getTime());
  assert.equal(skeleton.days[6].date.getTime(), new Date(2026, 8, 13).getTime());
  assert.ok(skeleton.days.every((d) => d.plan === null && d.processed === null));
});

test('actionItemSourceKey es estable para el mismo item (dedupe en reimportacion)', () => {
  const item = { weekNumber: 36, accountable: 'Alvaro Lugo ', descripcion: 'Production Line set up', committedDate: new Date(2026, 8, 5) };
  const key1 = actionItemSourceKey(item);
  const key2 = actionItemSourceKey({ ...item, accountable: 'ALVARO LUGO ' });
  assert.equal(key1, key2);
});

test('defaultEstatusFor: fecha pasada -> Completado, fecha futura o sin fecha -> Pendiente', () => {
  const today = new Date(2026, 8, 14);
  assert.equal(defaultEstatusFor(new Date(2026, 8, 5), today), 'Completado');
  assert.equal(defaultEstatusFor(new Date(2026, 8, 20), today), 'Pendiente');
  assert.equal(defaultEstatusFor(null, today), 'Pendiente');
});

test('isoWeekNumber coincide con la numeracion real del Excel de Roman (Lunes 31/08/2026 = Week 36)', () => {
  assert.equal(isoWeekNumber(new Date(Date.UTC(2026, 7, 31))), 36);
  assert.equal(isoWeekNumber(new Date(Date.UTC(2026, 8, 7))), 37);
  assert.equal(isoWeekNumber(new Date(Date.UTC(2026, 8, 13))), 37); // Domingo, misma semana ISO que su Lunes
});

test('toDateOrNull nunca convierte texto invalido en una fecha falsa', () => {
  assert.equal(toDateOrNull(''), null);
  assert.equal(toDateOrNull('no es fecha'), null);
  assert.equal(toDateOrNull(null), null);
  assert.ok(toDateOrNull(new Date(2026, 0, 1)) instanceof Date);
});
