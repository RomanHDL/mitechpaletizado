const test = require('node:test');
const assert = require('node:assert/strict');
const { palletIdMatchKey, buildUnifiedRecord } = require('./unifiedPalletHelpers');

test('palletIdMatchKey normaliza mayusculas/espacios pero NUNCA quita guiones internos ni convierte a numero', () => {
  assert.equal(palletIdMatchKey(' ab-123 '), 'AB-123');
  assert.equal(palletIdMatchKey('AB-123'), 'AB-123');
  assert.equal(palletIdMatchKey(391931), '391931');
  assert.equal(typeof palletIdMatchKey(391931), 'string');
});

test('palletIdMatchKey hace que IDs con distinto casing/espacios crucen como el mismo pallet', () => {
  assert.equal(palletIdMatchKey(' Ab-123'), palletIdMatchKey('AB-123 '));
});

const INV = { palletId: '391931', locationName: 'TRG-A12', area: 'Zona Norte', areaFuente: 'campo real: warehouseName', binTypeName: 'PRODUCTO TERMINADO', cantidadTotal: 12, skuCount: 3 };
const FFT = { palletId: '391931', destino: 'Almacen', pedido: '391931', observaciones: 'LPN | BULKY', cantidad: 12, escaneadora: 'Nathalie Lopez', condicion: 'GRB', fecha: '8/5/2026', turno: 'Día', createdAt: new Date('2026-08-05T10:00:00Z') };
const CATALOGO = ['BULKY'];

test('buildUnifiedRecord: con ambas fuentes y piezas iguales -> matched, con info de ambas', () => {
  const r = buildUnifiedRecord(INV, FFT, CATALOGO);
  assert.equal(r.matchStatus, 'matched');
  assert.equal(r.inventory.category, 'PRODUCTO TERMINADO');
  assert.equal(r.inventory.bin, 'TRG-A12');
  assert.equal(r.inventory.area, 'Zona Norte');
  assert.equal(r.fft.destination, 'Almacén');
  assert.equal(r.fft.orderType, 'BULKY');
  // La categoria de inventario nunca se filtra al campo destino:
  assert.notEqual(r.fft.destination, r.inventory.category);
});

test('buildUnifiedRecord: piezas distintas entre inventario y FFT -> conflict, sin sobrescribir ninguna', () => {
  const fftDistinto = { ...FFT, cantidad: 8 };
  const r = buildUnifiedRecord(INV, fftDistinto, CATALOGO);
  assert.equal(r.matchStatus, 'conflict');
  assert.equal(r.inventory.pieces, 12);
  assert.equal(r.fft.pieces, 8);
});

test('buildUnifiedRecord: solo inventario (sin registro FFT) conserva TODA su info de inventario -> inventory-only', () => {
  const r = buildUnifiedRecord(INV, null, CATALOGO);
  assert.equal(r.matchStatus, 'inventory-only');
  assert.equal(r.inventory.bin, 'TRG-A12');
  assert.equal(r.inventory.pieces, 12);
  assert.equal(r.fft, null);
});

test('buildUnifiedRecord: solo registro FFT (sin inventario actual) -> fft-only', () => {
  const r = buildUnifiedRecord(null, FFT, CATALOGO);
  assert.equal(r.matchStatus, 'fft-only');
  assert.equal(r.inventory, null);
  assert.equal(r.fft.destination, 'Almacén');
});

test('buildUnifiedRecord: PalletID nunca se suma ni se convierte a numero', () => {
  const r = buildUnifiedRecord(INV, FFT, CATALOGO);
  assert.equal(typeof r.palletId, 'string');
  assert.equal(r.palletId, '391931');
});
