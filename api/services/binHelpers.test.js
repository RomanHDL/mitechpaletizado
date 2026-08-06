const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeBin, agruparPalletsPorBin, agruparBinesPorArea } = require('./binHelpers');

test('normalizeBin: pallets sin locationName aparecen como "Sin bin", nunca null/undefined', () => {
  assert.equal(normalizeBin(null).valor, 'Sin bin');
  assert.equal(normalizeBin('').valor, 'Sin bin');
  assert.equal(normalizeBin('  TRG-A12 ').valor, 'TRG-A12');
});

test('agruparPalletsPorBin: agrupa correctamente, pallets nunca se duplican ni se suman como piezas', () => {
  const pallets = [
    { palletId: '1', locationName: 'TRG-A12', binTypeName: 'PRODUCTO TERMINADO', area: 'Zona 1', cantidadTotal: 10 },
    { palletId: '2', locationName: 'TRG-A12', binTypeName: 'PRODUCTO TERMINADO', area: 'Zona 1', cantidadTotal: 5 },
    { palletId: '3', locationName: 'ALM-B05', binTypeName: 'Wholesale', area: 'Zona 2', cantidadTotal: 20 },
  ];
  const bines = agruparPalletsPorBin(pallets);
  const trgA12 = bines.find((b) => b.bin === 'TRG-A12');
  assert.equal(trgA12.pallets, 2);
  assert.equal(trgA12.piezas, 15);
  assert.equal(trgA12.area, 'Zona 1');
});

test('agruparPalletsPorBin: la categoria de inventario NUNCA se llama "destino" (bug corregido)', () => {
  const pallets = [{ palletId: '1', locationName: 'TRG-A12', binTypeName: 'PRODUCTO TERMINADO', area: 'Zona 1', cantidadTotal: 10 }];
  const bin = agruparPalletsPorBin(pallets)[0];
  assert.equal(bin.categoria, 'PRODUCTO TERMINADO');
  assert.equal(bin.destino, undefined);
});

test('agruparPalletsPorBin: pallets sin bin se agrupan bajo "Sin bin", nunca se pierden', () => {
  const pallets = [
    { palletId: '1', locationName: null, binTypeName: 'TRG', area: 'Sin área', cantidadTotal: 3 },
    { palletId: '2', locationName: '', binTypeName: 'TRG', area: 'Sin área', cantidadTotal: 4 },
  ];
  const bines = agruparPalletsPorBin(pallets);
  assert.equal(bines.length, 1);
  assert.equal(bines[0].bin, 'Sin bin');
  assert.equal(bines[0].pallets, 2);
  assert.equal(bines[0].piezas, 7);
});

test('agruparPalletsPorBin: porcentajes suman correctamente y lista vacia no truena', () => {
  assert.deepEqual(agruparPalletsPorBin([]), []);
  const pallets = [
    { palletId: '1', locationName: 'A', binTypeName: 'X', area: 'Z1', cantidadTotal: 10 },
    { palletId: '2', locationName: 'B', binTypeName: 'X', area: 'Z1', cantidadTotal: 10 },
  ];
  const bines = agruparPalletsPorBin(pallets);
  assert.equal(bines[0].pctPallets, 50);
  assert.equal(bines[1].pctPallets, 50);
});

test('agruparBinesPorArea: el total de una area es exactamente la suma de sus bines', () => {
  const pallets = [
    { palletId: '1', locationName: 'TRG-A12', binTypeName: 'X', area: 'Zona 1', cantidadTotal: 10 },
    { palletId: '2', locationName: 'TRG-A13', binTypeName: 'X', area: 'Zona 1', cantidadTotal: 5 },
    { palletId: '3', locationName: 'ALM-B05', binTypeName: 'X', area: 'Zona 2', cantidadTotal: 20 },
  ];
  const bines = agruparPalletsPorBin(pallets);
  const areas = agruparBinesPorArea(bines);
  const zona1 = areas.find((a) => a.area === 'Zona 1');
  assert.equal(zona1.cantidadBines, 2);
  assert.equal(zona1.pallets, 2); // 2 pallets (uno por bin), no piezas
  assert.equal(zona1.piezas, 15); // 10 + 5
  const zona2 = areas.find((a) => a.area === 'Zona 2');
  assert.equal(zona2.pallets, 1);
  assert.equal(zona2.piezas, 20);
});

test('agruparBinesPorArea: abrir un area solo debe traer sus propios bines, nunca de otra area', () => {
  const pallets = [
    { palletId: '1', locationName: 'BIN-1', binTypeName: 'X', area: 'Zona 1', cantidadTotal: 1 },
    { palletId: '2', locationName: 'BIN-2', binTypeName: 'X', area: 'Zona 2', cantidadTotal: 1 },
  ];
  const bines = agruparPalletsPorBin(pallets);
  const areas = agruparBinesPorArea(bines);
  const zona1 = areas.find((a) => a.area === 'Zona 1');
  assert.equal(zona1.bines.length, 1);
  assert.equal(zona1.bines[0].bin, 'BIN-1');
});
