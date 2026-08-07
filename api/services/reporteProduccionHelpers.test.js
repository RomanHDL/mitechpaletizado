const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeDestino,
  extraerTipoPedido,
  clasificarRegistro,
  parseFechaMDY,
  formatFechaMDY,
  inicioDeSemana,
  prepararRegistro,
  buildReporteSemanal,
} = require('./reporteProduccionHelpers');

test('normalizeDestino tolera mayusculas, minusculas y acentos', () => {
  assert.equal(normalizeDestino('almacen'), 'Almacen');
  assert.equal(normalizeDestino('ALMACEN'), 'Almacen');
  assert.equal(normalizeDestino('Almacén'), 'Almacen');
  assert.equal(normalizeDestino('trg'), 'TRG');
  assert.equal(normalizeDestino('TRG'), 'TRG');
  assert.equal(normalizeDestino('fba'), 'FBA');
  assert.equal(normalizeDestino('FBA'), 'FBA');
  assert.equal(normalizeDestino('Sin clasificar'), 'Sin clasificar');
});

test('extraerTipoPedido detecta Bulky/Fierro en observaciones o pedido, sin distinguir mayusculas', () => {
  assert.equal(extraerTipoPedido({ observaciones: 'BULKY', pedido: '' }), 'BULKY');
  assert.equal(extraerTipoPedido({ observaciones: 'bulky | nota extra', pedido: '' }), 'BULKY');
  assert.equal(extraerTipoPedido({ observaciones: '', pedido: 'fierro' }), 'FIERRO');
  assert.equal(extraerTipoPedido({ observaciones: '', pedido: 'FIERRO' }), 'FIERRO');
  assert.equal(extraerTipoPedido({ observaciones: '', pedido: '' }), '');
  assert.equal(extraerTipoPedido({}), '');
});

// Caso real detectado en produccion (pedido 391931, 8/5/2026): el formulario de
// escaneo guarda 'LPN | BULKY' en observaciones cuando el usuario elige la
// clasificacion BULKY (index.html, guardarEscaneo) — nunca guarda 'BULKY' solo.
// getClasificacion() en el frontend ya revierte ese alias; este helper debe
// hacer lo mismo o estos pallets se pierden como Bulky=0 (bug real, ya corregido).
test('extraerTipoPedido reconoce el alias legado LPN -> BULKY', () => {
  assert.equal(extraerTipoPedido({ observaciones: 'LPN | BULKY', pedido: '391931' }), 'BULKY');
  assert.equal(extraerTipoPedido({ observaciones: 'lpn | bulky | nota', pedido: '' }), 'BULKY');
  assert.equal(extraerTipoPedido({ observaciones: '', pedido: 'LPN' }), 'BULKY');
});

test('extraerTipoPedido detecta Element en observaciones o pedido, sin distinguir mayusculas', () => {
  assert.equal(extraerTipoPedido({ observaciones: 'ELEMENT', pedido: '' }), 'ELEMENT');
  assert.equal(extraerTipoPedido({ observaciones: 'element | nota extra', pedido: '' }), 'ELEMENT');
  assert.equal(extraerTipoPedido({ observaciones: '', pedido: 'Element' }), 'ELEMENT');
});

test('clasificarRegistro: pallet real con clasificacion BULKY (alias LPN) y destino Almacen se clasifica como Bulky', () => {
  assert.equal(clasificarRegistro({ destino: 'Almacen', observaciones: 'LPN | BULKY', pedido: '391931' }), 'Bulky');
});

test('clasificarRegistro: TRG y FBA tienen prioridad sobre Bulky/Fierro/Element', () => {
  assert.equal(clasificarRegistro({ destino: 'TRG', pedido: 'BULKY' }), 'TRG');
  assert.equal(clasificarRegistro({ destino: 'FBA', pedido: 'FIERRO' }), 'FBA');
  assert.equal(clasificarRegistro({ destino: 'FBA', pedido: 'ELEMENT' }), 'FBA');
});

test('clasificarRegistro: Bulky/Fierro con destino Almacen NO cuentan como Almacen', () => {
  assert.equal(clasificarRegistro({ destino: 'Almacen', pedido: 'BULKY' }), 'Bulky');
  assert.equal(clasificarRegistro({ destino: 'Almacen', observaciones: 'FIERRO' }), 'Fierro');
});

// Pedido explicito de Roman (2026-08-07): Element se contaba como Almacen
// (catch-all) — debe identificarse aparte, nunca sumado a Almacen ni a FBA.
test('clasificarRegistro: Element con destino Almacen se identifica aparte, NO cuenta como Almacen ni como FBA', () => {
  assert.equal(clasificarRegistro({ destino: 'Almacen', pedido: 'ELEMENT' }), 'Element');
  assert.equal(clasificarRegistro({ destino: 'Almacen', observaciones: 'ELEMENT | nota' }), 'Element');
  assert.notEqual(clasificarRegistro({ destino: 'Almacen', pedido: 'ELEMENT' }), 'FBA');
});

test('clasificarRegistro: Almacen normal (sin tipo especial) cae en Almacén', () => {
  assert.equal(clasificarRegistro({ destino: 'Almacen', pedido: '', observaciones: '' }), 'Almacén');
  assert.equal(clasificarRegistro({ destino: 'almacen' }), 'Almacén');
});

test('clasificarRegistro: mayusculas/minusculas/acentos no cambian el resultado', () => {
  assert.equal(clasificarRegistro({ destino: 'trg' }), 'TRG');
  assert.equal(clasificarRegistro({ destino: 'fba' }), 'FBA');
  assert.equal(clasificarRegistro({ destino: 'ALMACÉN', pedido: 'bulky' }), 'Bulky');
});

test('parseFechaMDY / formatFechaMDY son inversas para fechas validas', () => {
  const d = parseFechaMDY('8/5/2026');
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 7);
  assert.equal(d.getDate(), 5);
  assert.equal(formatFechaMDY(d), '8/5/2026');
  assert.equal(parseFechaMDY(''), null);
  assert.equal(parseFechaMDY('no es fecha'), null);
});

test('inicioDeSemana regresa el Lunes de la semana (2026-08-05 es miercoles -> lunes 2026-08-03)', () => {
  const miercoles = new Date(2026, 7, 5); // 5 ago 2026
  const lunes = inicioDeSemana(miercoles);
  assert.equal(formatFechaMDY(lunes), '8/3/2026');
});
test('inicioDeSemana: si `date` ya es domingo, retrocede al lunes anterior (no se queda en domingo)', () => {
  const domingo = new Date(2026, 7, 9); // 9 ago 2026 es domingo
  const lunes = inicioDeSemana(domingo);
  assert.equal(formatFechaMDY(lunes), '8/3/2026');
});

test('prepararRegistro da el shape correcto y calcula categoria/dia una sola vez', () => {
  const doc = { _id: 'abc123', fecha: '8/3/2026', turno: 'Día', destino: 'Almacen', pedido: 'BULKY', cantidad: 12, palletId: 'P1', createdAt: new Date('2026-08-03T10:00:00Z') };
  const r = prepararRegistro(doc);
  assert.equal(r.id, 'abc123');
  assert.equal(r.categoria, 'Bulky');
  assert.equal(r.tipoPedido, 'BULKY');
  assert.equal(r.diaSemana, 'Lunes');
  assert.equal(r.pallets, 1);
  assert.equal(r.piezas, 12);
});

// Ejemplo EXACTO del pedido del usuario: 20 pallets destino Almacen, de los
// cuales 3 son Bulky y 2 son Fierro. Resultado esperado: Almacen 15, Bulky+Fierro
// 5 (informativo), Bulky 3, Fierro 2 — nunca Almacen con 20.
test('buildReporteSemanal: ejemplo exacto del usuario, sin doble conteo', () => {
  const lunes = new Date(2026, 7, 3);
  const registrosCrudos = [
    ...Array.from({ length: 15 }, (_, i) => ({ _id: 'a' + i, fecha: '8/3/2026', destino: 'Almacen', pedido: '', observaciones: '', cantidad: 10 })),
    ...Array.from({ length: 3 }, (_, i) => ({ _id: 'b' + i, fecha: '8/3/2026', destino: 'Almacen', pedido: 'BULKY', observaciones: '', cantidad: 10 })),
    ...Array.from({ length: 2 }, (_, i) => ({ _id: 'c' + i, fecha: '8/3/2026', destino: 'Almacen', pedido: 'FIERRO', observaciones: '', cantidad: 10 })),
  ];
  const preparados = registrosCrudos.map(prepararRegistro);
  const reporte = buildReporteSemanal(preparados, lunes);
  const lunesRow = reporte.dias[0];
  assert.equal(lunesRow.dia, 'Lunes');
  assert.equal(lunesRow.filas.almacen.pallets, 15);
  assert.equal(lunesRow.filas.bulkyFierro.pallets, 5);
  assert.equal(lunesRow.filas.bulkyFierro.bulky, 3);
  assert.equal(lunesRow.filas.bulkyFierro.fierro, 2);
  assert.equal(lunesRow.filas.trg.pallets, 0);
  assert.equal(lunesRow.filas.fba.pallets, 0);
  assert.equal(lunesRow.totalPallets, 20); // 15 + 5, NUNCA 15+3+2+5=25
  assert.equal(reporte.resumen.totalPallets, 20);
  assert.equal(reporte.resumen.almacenPallets, 15);
  assert.equal(reporte.resumen.bulkyPallets, 3);
  assert.equal(reporte.resumen.fierroPallets, 2);
});

// Pedido explicito de Roman (2026-08-07): 20 pallets Almacen, 3 con tipo
// Element -> Almacen debe quedar en 17 (no 20), Element identificado aparte
// con 3, y el total del dia sigue siendo 20 (nunca se pierde ni se duplica).
test('buildReporteSemanal: Element se separa de Almacen sin duplicarse ni sumarse a FBA', () => {
  const lunes = new Date(2026, 7, 3);
  const registrosCrudos = [
    ...Array.from({ length: 17 }, (_, i) => ({ _id: 'a' + i, fecha: '8/3/2026', destino: 'Almacen', pedido: '', observaciones: '', cantidad: 10 })),
    ...Array.from({ length: 3 }, (_, i) => ({ _id: 'e' + i, fecha: '8/3/2026', destino: 'Almacen', pedido: 'ELEMENT', observaciones: '', cantidad: 10 })),
  ];
  const preparados = registrosCrudos.map(prepararRegistro);
  const reporte = buildReporteSemanal(preparados, lunes);
  const lunesRow = reporte.dias[0];
  assert.equal(lunesRow.filas.almacen.pallets, 17); // NUNCA 20
  assert.equal(lunesRow.filas.element.pallets, 3);
  assert.equal(lunesRow.filas.element.categoria, 'Element');
  assert.equal(lunesRow.filas.fba.pallets, 0); // Element nunca se suma a FBA
  assert.equal(lunesRow.totalPallets, 20); // 17 + 3, sin perder ni duplicar
  assert.equal(reporte.resumen.almacenPallets, 17);
  assert.equal(reporte.resumen.elementPallets, 3);
  assert.equal(reporte.resumen.fbaPallets, 0);
});

test('buildReporteSemanal: dia sin registros muestra sinProduccion y detalle "Sin producción"', () => {
  const lunes = new Date(2026, 7, 3);
  const reporte = buildReporteSemanal([], lunes);
  assert.equal(reporte.dias.length, 7);
  reporte.dias.forEach((d) => {
    assert.equal(d.sinProduccion, true);
    assert.equal(d.totalPallets, 0);
    assert.equal(d.filas.bulkyFierro.detalle, 'Sin producción');
  });
  assert.equal(reporte.resumen.diaMayorProduccion, null);
});

test('buildReporteSemanal: TRG y FBA se suman por destino, no interfieren con Bulky/Fierro', () => {
  const lunes = new Date(2026, 7, 3);
  const crudos = [
    { _id: '1', fecha: '8/4/2026', destino: 'TRG', cantidad: 20 },
    { _id: '2', fecha: '8/4/2026', destino: 'FBA', cantidad: 30 },
    { _id: '3', fecha: '8/4/2026', destino: 'TRG', pedido: 'BULKY', cantidad: 5 }, // TRG gana sobre Bulky
  ];
  const preparados = crudos.map(prepararRegistro);
  const reporte = buildReporteSemanal(preparados, lunes);
  const martes = reporte.dias[1]; // martes = index 1
  assert.equal(martes.dia, 'Martes');
  assert.equal(martes.filas.trg.pallets, 2); // los 2 registros con destino TRG (incluyendo el "Bulky")
  assert.equal(martes.filas.fba.pallets, 1);
  assert.equal(martes.filas.bulkyFierro.pallets, 0); // el Bulky con destino TRG NO cuenta aqui
  assert.equal(martes.totalPallets, 3);
});

test('buildReporteSemanal: dia con solo Bulky muestra detalle correcto (sin "+ 0 Fierro")', () => {
  const lunes = new Date(2026, 7, 3);
  const crudos = [
    { _id: '1', fecha: '8/3/2026', destino: 'Almacen', pedido: 'BULKY', cantidad: 5 },
    { _id: '2', fecha: '8/3/2026', destino: 'Almacen', pedido: 'BULKY', cantidad: 5 },
  ];
  const preparados = crudos.map(prepararRegistro);
  const reporte = buildReporteSemanal(preparados, lunes);
  assert.equal(reporte.dias[0].filas.bulkyFierro.detalle, '2 Bulky');
});
