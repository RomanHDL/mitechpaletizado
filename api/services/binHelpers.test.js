const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeBin, agruparPalletsPorBin } = require('./binHelpers');

test('normalizeBin: pallets sin locationName aparecen como "Sin bin", nunca null/undefined', () => {
  assert.equal(normalizeBin(null).valor, 'Sin bin');
  assert.equal(normalizeBin('').valor, 'Sin bin');
  assert.equal(normalizeBin('  TRG-A12 ').valor, 'TRG-A12');
});

test('agruparPalletsPorBin: agrupa correctamente, pallets nunca se duplican ni se suman como piezas', () => {
  const pallets = [
    { palletId: '1', locationName: 'TRG-A12', binTypeName: 'TRG', cantidadTotal: 10 },
    { palletId: '2', locationName: 'TRG-A12', binTypeName: 'TRG', cantidadTotal: 5 },
    { palletId: '3', locationName: 'ALM-B05', binTypeName: 'Almacen', cantidadTotal: 20 },
  ];
  const bines = agruparPalletsPorBin(pallets);
  const trgA12 = bines.find((b) => b.bin === 'TRG-A12');
  assert.equal(trgA12.pallets, 2);
  assert.equal(trgA12.piezas, 15);
  assert.equal(trgA12.destino, 'TRG');
  const almB05 = bines.find((b) => b.bin === 'ALM-B05');
  assert.equal(almB05.pallets, 1);
  assert.equal(almB05.piezas, 20);
});

test('agruparPalletsPorBin: pallets sin bin se agrupan bajo "Sin bin", nunca se pierden', () => {
  const pallets = [
    { palletId: '1', locationName: null, binTypeName: 'TRG', cantidadTotal: 3 },
    { palletId: '2', locationName: '', binTypeName: 'TRG', cantidadTotal: 4 },
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
    { palletId: '1', locationName: 'A', binTypeName: 'X', cantidadTotal: 10 },
    { palletId: '2', locationName: 'B', binTypeName: 'X', cantidadTotal: 10 },
  ];
  const bines = agruparPalletsPorBin(pallets);
  assert.equal(bines[0].pctPallets, 50);
  assert.equal(bines[1].pctPallets, 50);
});

test('agruparPalletsPorBin: destino de un bin es la categoria MAS FRECUENTE entre sus pallets, no inventada', () => {
  const pallets = [
    { palletId: '1', locationName: 'MIX-1', binTypeName: 'TRG', cantidadTotal: 1 },
    { palletId: '2', locationName: 'MIX-1', binTypeName: 'TRG', cantidadTotal: 1 },
    { palletId: '3', locationName: 'MIX-1', binTypeName: 'Almacen', cantidadTotal: 1 },
  ];
  const bines = agruparPalletsPorBin(pallets);
  assert.equal(bines[0].destino, 'TRG');
});
