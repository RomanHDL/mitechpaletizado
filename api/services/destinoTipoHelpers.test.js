const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizePalletId,
  normalizePieces,
  normalizeScanner,
  normalizeCondition,
  normalizeDestination,
  normalizeOrderType,
  prepararRegistroFft,
} = require('./destinoTipoHelpers');

test('normalizePalletId siempre trata el PalletID como texto, nunca como numero', () => {
  assert.equal(normalizePalletId(391931).valor, '391931');
  assert.equal(typeof normalizePalletId(391931).valor, 'string');
  assert.equal(normalizePalletId('  391931 ').valor, '391931');
  assert.equal(normalizePalletId(null).valor, '');
});

test('normalizePieces nunca suma el PalletID como piezas, solo usa el campo cantidad', () => {
  assert.equal(normalizePieces(12).valor, 12);
  assert.equal(normalizePieces('12').valor, 12);
  assert.equal(normalizePieces(null).valor, 0);
  assert.equal(normalizePieces(undefined).valor, 0);
  assert.equal(normalizePieces('no es numero').valor, 0);
});

test('normalizeScanner y normalizeCondition regresan un texto por defecto en vez de null/undefined', () => {
  assert.equal(normalizeScanner('').valor, 'Sin escaneadora');
  assert.equal(normalizeScanner(null).valor, 'Sin escaneadora');
  assert.equal(normalizeScanner('Nathalie Lopez').valor, 'Nathalie Lopez');
  assert.equal(normalizeCondition('').valor, 'Sin condición');
  assert.equal(normalizeCondition('GRB').valor, 'GRB');
});

test('normalizeDestination tolera mayusculas/minusculas/acentos para los 3 destinos oficiales', () => {
  assert.equal(normalizeDestination('trg').valor, 'TRG');
  assert.equal(normalizeDestination('TRG').valor, 'TRG');
  assert.equal(normalizeDestination('almacen').valor, 'Almacén');
  assert.equal(normalizeDestination('Almacén').valor, 'Almacén');
  assert.equal(normalizeDestination('ALMACÉN').valor, 'Almacén');
  assert.equal(normalizeDestination('fba').valor, 'FBA');
  assert.equal(normalizeDestination('').valor, 'Sin destino');
});

test('normalizeDestination NUNCA fuerza un destino real desconocido a uno de los 3 oficiales', () => {
  const r = normalizeDestination('Zona Especial');
  assert.equal(r.valor, 'Zona Especial');
  assert.equal(r.original, 'Zona Especial');
});

test('normalizeOrderType usa el catalogo REAL (no una lista fija) y nunca trata Bulky/Fierro como destino', () => {
  const catalogo = ['BOX', 'BULKY', 'FIERRO', 'HV'];
  assert.equal(normalizeOrderType({ observaciones: 'BULKY', pedido: '' }, catalogo).valor, 'BULKY');
  assert.equal(normalizeOrderType({ observaciones: 'fierro | nota', pedido: '' }, catalogo).valor, 'FIERRO');
  assert.equal(normalizeOrderType({ observaciones: '', pedido: '' }, catalogo).valor, 'Sin pedido');
  // Un tipo que no esta en el catalogo actual nunca se inventa como valido:
  assert.equal(normalizeOrderType({ observaciones: 'ELEMENT', pedido: '' }, catalogo).valor, 'Sin pedido');
});

test('normalizeOrderType reconoce el alias legado LPN -> BULKY (bug real detectado y corregido)', () => {
  const catalogo = ['BOX', 'BULKY', 'HV'];
  assert.equal(normalizeOrderType({ observaciones: 'LPN | BULKY', pedido: '391931' }, catalogo).valor, 'BULKY');
  assert.equal(normalizeOrderType({ observaciones: 'lpn | bulky', pedido: '' }, catalogo).valor, 'BULKY');
});

test('normalizeOrderType respeta el nombre EXACTO del catalogo (casing real), no lo reinventa', () => {
  const catalogo = ['HV Televisiones'];
  assert.equal(normalizeOrderType({ observaciones: 'hv televisiones', pedido: '' }, catalogo).valor, 'HV Televisiones');
});

test('prepararRegistroFft: PalletID es texto, piezas viene de cantidad, destino y tipo quedan separados', () => {
  const catalogo = ['BULKY'];
  const pallet = { palletId: 391931, cantidad: 12, destino: 'Almacen', observaciones: 'LPN | BULKY', pedido: '391931', condicion: 'GRB', escaneadora: 'Nathalie Lopez', fecha: '8/5/2026' };
  const r = prepararRegistroFft(pallet, catalogo);
  assert.equal(r.palletId, '391931');
  assert.equal(typeof r.palletId, 'string');
  assert.equal(r.piezas, 12);
  assert.equal(r.destino, 'Almacén');
  assert.equal(r.tipoPedido, 'BULKY');
  assert.equal(r.escaneadora, 'Nathalie Lopez');
  assert.equal(r.condicion, 'GRB');
});

test('prepararRegistroFft: registros sin destino/tipo muestran los textos por defecto, nunca null/undefined', () => {
  const pallet = { palletId: 'X1', cantidad: 5, destino: '', observaciones: '', pedido: '', condicion: '', escaneadora: '', fecha: '8/5/2026' };
  const r = prepararRegistroFft(pallet, []);
  assert.equal(r.destino, 'Sin destino');
  assert.equal(r.tipoPedido, 'Sin pedido');
  assert.equal(r.condicion, 'Sin condición');
  assert.equal(r.escaneadora, 'Sin escaneadora');
});
