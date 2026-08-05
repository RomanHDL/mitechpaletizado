const test = require('node:test');
const assert = require('node:assert/strict');
const { construirWorkbookReporteSemanal } = require('./reporteProduccionExcel');
const { buildReporteSemanal, prepararRegistro } = require('./reporteProduccionHelpers');

test('construirWorkbookReporteSemanal genera hojas Producción y Resumen con datos reales del reporte', async () => {
  const lunes = new Date(2026, 7, 3);
  const crudos = [
    { _id: 'a1', fecha: '8/3/2026', destino: 'Almacen', pedido: '', observaciones: '', cantidad: 10 },
    { _id: 'a2', fecha: '8/3/2026', destino: 'Almacen', pedido: 'BULKY', observaciones: '', cantidad: 8 },
    { _id: 'a3', fecha: '8/4/2026', destino: 'TRG', cantidad: 20 },
  ];
  const preparados = crudos.map(prepararRegistro);
  const reporte = buildReporteSemanal(preparados, lunes);
  const semana = { isoInicio: '2026-08-03', isoFin: '2026-08-09', fechaInicio: '8/3/2026', fechaFin: '8/9/2026' };

  const wb = construirWorkbookReporteSemanal(reporte, semana);
  const wsProd = wb.getWorksheet('Producción');
  const wsResumen = wb.getWorksheet('Resumen');
  assert.ok(wsProd, 'debe existir la hoja Producción');
  assert.ok(wsResumen, 'debe existir la hoja Resumen');

  const buffer = await wb.xlsx.writeBuffer();
  assert.ok(buffer.length > 0, 'el buffer del xlsx generado no debe estar vacío');

  const textoCompleto = JSON.stringify(wsProd.getSheetValues());
  assert.match(textoCompleto, /Lunes/);
  assert.match(textoCompleto, /Sin producción|Almacén/);

  const resumenValues = JSON.stringify(wsResumen.getSheetValues());
  assert.match(resumenValues, /Total de pallets/);
});
