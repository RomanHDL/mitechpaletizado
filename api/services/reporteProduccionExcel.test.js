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
  assert.match(resumenValues, /Pallets Element/);
});

test('construirWorkbookReporteSemanal: Element aparece junto a FBA, nunca sumado a su total', async () => {
  const lunes = new Date(2026, 7, 3);
  const crudos = [
    { _id: 'a1', fecha: '8/3/2026', destino: 'Almacen', pedido: '', observaciones: '', cantidad: 10 },
    { _id: 'e1', fecha: '8/3/2026', destino: 'Almacen', pedido: 'ELEMENT', observaciones: '', cantidad: 7 },
    { _id: 'f1', fecha: '8/3/2026', destino: 'FBA', cantidad: 3 },
  ];
  const preparados = crudos.map(prepararRegistro);
  const reporte = buildReporteSemanal(preparados, lunes);
  const semana = { isoInicio: '2026-08-03', isoFin: '2026-08-09', fechaInicio: '8/3/2026', fechaFin: '8/9/2026' };

  const wb = construirWorkbookReporteSemanal(reporte, semana);
  const wsProd = wb.getWorksheet('Producción');
  const valores = wsProd.getSheetValues();
  const filaElement = valores.find((row) => row && row[1] === 'Element');
  assert.ok(filaElement, 'debe existir una fila con categoria "Element" en la hoja Producción');
  assert.equal(filaElement[2], 1, 'la fila Element debe mostrar su propio conteo de pallets (1), no los de FBA');
  assert.equal(filaElement[3], 7, 'la fila Element debe mostrar sus propias piezas (7)');
});

// Pedido explicito de Roman (2026-08-07): el resumen semanal (mismas filas
// que los dias) debe aparecer AL FINAL de la hoja "Producción", no solo en
// la hoja "Resumen" aparte.
test('construirWorkbookReporteSemanal: agrega RESUMEN SEMANAL al final de la hoja Producción', async () => {
  const lunes = new Date(2026, 7, 3);
  const crudos = [
    { _id: 'a1', fecha: '8/3/2026', destino: 'Almacen', pedido: '', observaciones: '', cantidad: 10 },
    { _id: 'a2', fecha: '8/4/2026', destino: 'Almacen', pedido: '', observaciones: '', cantidad: 5 },
    { _id: 'e1', fecha: '8/5/2026', destino: 'Almacen', pedido: 'ELEMENT', cantidad: 6 },
    { _id: 'f1', fecha: '8/6/2026', destino: 'FBA', cantidad: 8 },
  ];
  const preparados = crudos.map(prepararRegistro);
  const reporte = buildReporteSemanal(preparados, lunes);
  const semana = { isoInicio: '2026-08-03', isoFin: '2026-08-09', fechaInicio: '8/3/2026', fechaFin: '8/9/2026' };

  const wb = construirWorkbookReporteSemanal(reporte, semana);
  const valores = wb.getWorksheet('Producción').getSheetValues();
  const textoCompleto = JSON.stringify(valores);
  assert.match(textoCompleto, /RESUMEN SEMANAL/);

  const idxTitulo = valores.findIndex((row) => row && row[1] === 'RESUMEN SEMANAL');
  assert.ok(idxTitulo > 0, 'RESUMEN SEMANAL debe existir en la hoja');
  // Debe ser lo ULTIMO en la hoja (después de los 7 días) — filas posteriores
  // a esta sección son solo las de la propia tabla de resumen.
  const filaAlmacenResumen = valores.slice(idxTitulo).find((row) => row && row[1] === 'Almacén');
  assert.ok(filaAlmacenResumen, 'debe existir una fila Almacén dentro de la seccion de resumen');
  assert.equal(filaAlmacenResumen[2], 2, 'Almacén del resumen semanal debe sumar los 2 dias (10) + (5), nunca incluir Element');
  const filaElementResumen = valores.slice(idxTitulo).find((row) => row && row[1] === 'Element');
  assert.equal(filaElementResumen[2], 1);
  const filaTotalSemana = valores.slice(idxTitulo).find((row) => row && row[1] === 'Total de la semana');
  assert.ok(filaTotalSemana, 'debe existir la fila Total de la semana');
  assert.equal(filaTotalSemana[2], 4); // 2 Almacen + 1 Element + 1 FBA
});
