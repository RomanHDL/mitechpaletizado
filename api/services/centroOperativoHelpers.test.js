const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseInchesFromDescription,
  normalizeBrand,
  normalizeModelo,
  parseTvTypeTags,
  dedupeUniqueLpns,
  groupBy,
  groupByFoldingCase,
  detectMixedPallet,
  safeDivide,
  computeDelta,
} = require('./centroOperativoHelpers');

test('parseInchesFromDescription extrae pulgadas de descripciones reales', () => {
  assert.equal(parseInchesFromDescription('55" Class 4K UHD LED TV'), 55);
  assert.equal(parseInchesFromDescription('65 Class QLED'), 65);
  assert.equal(parseInchesFromDescription('32in. HD Ready'), 32);
  assert.equal(parseInchesFromDescription(''), null);
  assert.equal(parseInchesFromDescription(null), null);
  assert.equal(parseInchesFromDescription('Soundbar sin pulgadas'), null);
});

test('normalizeBrand nunca inventa una marca', () => {
  assert.equal(normalizeBrand('Samsung'), 'Samsung');
  assert.equal(normalizeBrand('  Vizio  '), 'Vizio');
  assert.equal(normalizeBrand(''), 'Marca sin identificar');
  assert.equal(normalizeBrand(null), 'Marca sin identificar');
  assert.equal(normalizeBrand(undefined), 'Marca sin identificar');
});

test('normalizeModelo nunca inventa un modelo', () => {
  assert.equal(normalizeModelo('UN55CU7000'), 'UN55CU7000');
  assert.equal(normalizeModelo(''), 'Modelo sin identificar');
});

test('parseTvTypeTags solo detecta lo que realmente esta en el texto', () => {
  assert.deepEqual(parseTvTypeTags('55" Class 4K UHD LED TV'), ['LED', '4K']);
  assert.deepEqual(parseTvTypeTags('OLED evo 65"'), ['OLED']);
  assert.deepEqual(parseTvTypeTags('QLED 8K Mini-LED'), ['Mini-LED', 'QLED', '8K']);
  assert.deepEqual(parseTvTypeTags(''), []);
  assert.deepEqual(parseTvTypeTags('Soundbar'), []);
});

test('dedupeUniqueLpns normaliza y quita duplicados', () => {
  const set = dedupeUniqueLpns(['abc123', 'ABC123 ', ' xyz789', '', null, undefined, 'xyz789']);
  assert.equal(set.size, 2);
  assert.ok(set.has('ABC123'));
  assert.ok(set.has('XYZ789'));
});

test('groupBy agrupa, suma pesos y calcula porcentaje correctamente', () => {
  const items = [
    { marca: 'Samsung', cantidad: 10 },
    { marca: 'Samsung', cantidad: 5 },
    { marca: 'Vizio', cantidad: 5 },
  ];
  const result = groupBy(items, (i) => i.marca, (i) => i.cantidad);
  assert.equal(result.length, 2);
  assert.equal(result[0].key, 'Samsung');
  assert.equal(result[0].total, 15);
  assert.equal(result[0].porcentaje, 75);
  assert.equal(result[1].key, 'Vizio');
  assert.equal(result[1].total, 5);
  assert.equal(result[1].porcentaje, 25);
});

test('groupBy con lista vacia no truena y no divide entre cero', () => {
  assert.deepEqual(groupBy([], (i) => i.marca), []);
});

test('groupByFoldingCase une variantes de mayusculas del mismo texto', () => {
  const items = [
    { marca: 'VIZIO', cantidad: 10 },
    { marca: 'Vizio', cantidad: 5 },
    { marca: 'vizio', cantidad: 3 },
    { marca: 'Onn / VIZIO', cantidad: 4 },
  ];
  const result = groupByFoldingCase(items, (i) => i.marca, (i) => i.cantidad);
  assert.equal(result.length, 2); // Vizio (3 variantes fusionadas) + Onn / VIZIO (distinta, no fusionada)
  const vizio = result.find((r) => r.total === 18);
  assert.equal(vizio.key, 'VIZIO'); // la variante mas frecuente (peso por ocurrencias, no por cantidad)
  const onn = result.find((r) => r.total === 4);
  assert.equal(onn.key, 'Onn / VIZIO');
});

test('groupByFoldingCase no rompe siglas cuando solo hay una variante', () => {
  const result = groupByFoldingCase([{ marca: 'LG', cantidad: 1 }, { marca: 'TCL', cantidad: 1 }], (i) => i.marca, (i) => i.cantidad);
  const keys = result.map((r) => r.key).sort();
  assert.deepEqual(keys, ['LG', 'TCL']);
});

test('detectMixedPallet identifica pallets con mas de una marca/modelo/SKU', () => {
  const mixto = detectMixedPallet([
    { brand: 'Samsung', modelo: 'A', sku: 'SKU1' },
    { brand: 'LG', modelo: 'B', sku: 'SKU2' },
  ]);
  assert.equal(mixto.isMixed, true);
  assert.equal(mixto.brandCount, 2);

  const homogeneo = detectMixedPallet([
    { brand: 'Samsung', modelo: 'A', sku: 'SKU1' },
    { brand: 'Samsung', modelo: 'A', sku: 'SKU1' },
  ]);
  assert.equal(homogeneo.isMixed, false);
  assert.equal(homogeneo.brandCount, 1);
});

test('detectMixedPallet con productos vacios/nulos no truena', () => {
  assert.equal(detectMixedPallet([]).isMixed, false);
  assert.equal(detectMixedPallet(undefined).isMixed, false);
});

test('safeDivide evita division entre cero', () => {
  assert.equal(safeDivide(10, 2), 5);
  assert.equal(safeDivide(10, 0), 0);
  assert.equal(safeDivide(0, 0), 0);
});

test('computeDelta regresa null cuando no se puede calcular correctamente', () => {
  assert.equal(computeDelta(120, 100), 20);
  assert.equal(computeDelta(80, 100), -20);
  assert.equal(computeDelta(100, null), null);
  assert.equal(computeDelta(null, 100), null);
  assert.equal(computeDelta(0, 0), 0);
  assert.equal(computeDelta(50, 0), null); // no hay base real para comparar
});
