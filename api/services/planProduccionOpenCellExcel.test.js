const test = require('node:test');
const assert = require('node:assert/strict');
const { construirWorkbookPlanProduccionOpenCell } = require('./planProduccionOpenCellExcel');

function buildWeek({ weekNumber = 38, plans, processed, finishedGood, delta, recoveryPlan, pctPlan } = {}) {
  const monday = new Date(Date.UTC(2026, 8, 14));
  const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
  const days = [];
  for (let i = 0; i < 7; i++) {
    days.push({
      date: addDays(monday, i),
      plan: plans ? plans[i] : null,
      processed: processed ? processed[i] : null,
      finishedGood: finishedGood ? finishedGood[i] : null,
      delta: delta ? delta[i] : null,
      recoveryPlan: recoveryPlan ? recoveryPlan[i] : null,
      pctPlan: pctPlan ? pctPlan[i] : null,
      detail: [],
    });
  }
  return { year: 2026, weekNumber, weekStartDate: monday, weekEndDate: addDays(monday, 6), days };
}

test('construirWorkbookPlanProduccionOpenCell: titulo es "PRODUCCION SEMANAL", nunca "PLAN DE PRODUCCION OPENCELL"', () => {
  const week = buildWeek();
  const wb = construirWorkbookPlanProduccionOpenCell(week, []);
  const ws = wb.getWorksheet(`Semana ${week.weekNumber}`);
  assert.ok(ws, 'debe existir una hoja nombrada "Semana <N>" (no hardcodeada)');
  const texto = JSON.stringify(ws.getSheetValues());
  assert.match(texto, /PRODUCCIÓN SEMANAL/);
  assert.doesNotMatch(texto, /PLAN DE PRODUCCION OPENCELL/i);
});

test('construirWorkbookPlanProduccionOpenCell: celda vacia se exporta como "-", un 0 real se conserva como 0', () => {
  const week = buildWeek({
    plans: [400, 400, 0, null, null, null, null], // Miercoles: Plan real = 0 (no null)
    processed: [100, null, null, null, null, null, null],
  });
  const wb = construirWorkbookPlanProduccionOpenCell(week, []);
  const ws = wb.getWorksheet('Semana 38');
  const filas = ws.getSheetValues();
  const filaPlan = filas.find((f) => f && JSON.stringify(f).includes('Plan (Materials Available)'));
  // fila: [vacio, label, Lunes, Martes, Miercoles, Jueves, ...]
  assert.equal(filaPlan[4], 0, 'Miercoles con Plan=0 real debe exportarse como 0, no como "-"');
  assert.equal(filaPlan[5], '-', 'Jueves sin dato debe exportarse como "-"');
  const filaProcessed = filas.find((f) => f && JSON.stringify(f).includes('Processed'));
  assert.equal(filaProcessed[3], '-', 'Martes sin Processed capturado debe ser "-"');
});

test('construirWorkbookPlanProduccionOpenCell: % Plan se formatea como porcentaje (numFmt 0%), fraccion se guarda tal cual', () => {
  const week = buildWeek({ plans: [400], processed: [100], pctPlan: [0.25] });
  const wb = construirWorkbookPlanProduccionOpenCell(week, []);
  const ws = wb.getWorksheet('Semana 38');
  // Fila 6 de metricas (Plan/Processed/FinishedGood/Delta/RecoveryPlan/%Plan) es la ultima -- se busca por numFmt.
  let pctCell = null;
  ws.eachRow((row) => {
    row.eachCell((cell) => { if (cell.numFmt === '0%') pctCell = cell; });
  });
  assert.ok(pctCell, 'debe existir al menos una celda con formato de porcentaje');
  assert.equal(pctCell.value, 0.25, 'el valor crudo se guarda como fraccion (0.25), Excel lo pinta como 25% via numFmt');
});

test('construirWorkbookPlanProduccionOpenCell: Action Plan vacio muestra un empty state, no una fila "Sin acciones registradas" simple', () => {
  const week = buildWeek();
  const wb = construirWorkbookPlanProduccionOpenCell(week, []);
  const ws = wb.getWorksheet('Semana 38');
  const texto = JSON.stringify(ws.getSheetValues());
  assert.match(texto, /Sin acciones registradas para esta semana/);
  assert.match(texto, /Agrega acciones para dar seguimiento al plan de producción/);
});

test('construirWorkbookPlanProduccionOpenCell: Action Plan con items reales conserva accountable/descripcion/estatus/fecha', () => {
  const week = buildWeek();
  const items = [
    { weekNumber: 38, accountable: 'Alvaro Lugo', descripcion: 'Production Line set up', committedDate: new Date(Date.UTC(2026, 8, 16)), estatus: 'En proceso' },
  ];
  const wb = construirWorkbookPlanProduccionOpenCell(week, items);
  const ws = wb.getWorksheet('Semana 38');
  const texto = JSON.stringify(ws.getSheetValues());
  assert.match(texto, /Alvaro Lugo/);
  assert.match(texto, /Production Line set up/);
  assert.match(texto, /En proceso/);
  assert.match(texto, /16\/09\/2026/);
  assert.match(texto, /ACTION PLAN - SEMANA 38/);
});

test('construirWorkbookPlanProduccionOpenCell: configuracion de impresion horizontal, ajustada a 1 pagina de ancho', () => {
  const week = buildWeek();
  const wb = construirWorkbookPlanProduccionOpenCell(week, []);
  const ws = wb.getWorksheet('Semana 38');
  assert.equal(ws.pageSetup.orientation, 'landscape');
  assert.equal(ws.pageSetup.fitToWidth, 1);
  assert.equal(ws.pageSetup.horizontalCentered, true);
});

test('construirWorkbookPlanProduccionOpenCell: nombre de hoja usa el numero de semana real, nunca hardcodeado a 38', () => {
  const week = buildWeek({ weekNumber: 41 });
  const wb = construirWorkbookPlanProduccionOpenCell(week, []);
  assert.ok(wb.getWorksheet('Semana 41'), 'la hoja debe llamarse "Semana 41" para esta semana');
  assert.equal(wb.getWorksheet('Semana 38'), undefined);
});

test('construirWorkbookPlanProduccionOpenCell: genera un buffer .xlsx valido y no vacio', async () => {
  const week = buildWeek({ plans: [400, 400, 400, 400, 400, null, null], processed: [100, 600, null, null, null, null, null] });
  const wb = construirWorkbookPlanProduccionOpenCell(week, []);
  const buffer = await wb.xlsx.writeBuffer();
  assert.ok(buffer.length > 0);
});
