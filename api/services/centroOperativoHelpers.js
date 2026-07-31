// Helpers puros (sin DB, sin red) para el modulo "Centro Operativo API".
// Se mantienen aqui, separados de api/index.js, para poder probarlos con
// node:test sin necesitar Mongo ni SmartControl reales.

// Extrae pulgadas de una descripcion real de SmartControl (ej. '55" Class 4K UHD LED TV').
// Antes vivia duplicado en api/index.js como parseInches() — unificado aqui.
function parseInchesFromDescription(desc) {
  if (!desc) return null;
  const m = String(desc).match(/(\d{2,3})\s*("|”|Class|Clase|in\.)/i);
  return m ? parseInt(m[1], 10) : null;
}

// Normaliza el campo Brand de la Classification API de SmartControl. Nunca inventa una marca:
// si viene vacio, regresa la etiqueta explicita "Marca sin identificar" (no null/undefined,
// para que agrupar() pueda usarlo como llave consistente en tablas/graficas). No cambia
// mayusculas/minusculas aqui (forzar Title Case rompe siglas reales como "LG"/"TCL") — la
// unificacion de variantes de mayusculas del MISMO texto (ej. "VIZIO" vs "Vizio") se hace
// aparte, en groupByFoldingCase, donde se puede elegir la variante mas frecuente como
// etiqueta en vez de inventar un formato nuevo.
function normalizeBrand(brand) {
  const b = (brand || '').toString().trim().replace(/\s+/g, ' ');
  return b || 'Marca sin identificar';
}

function normalizeModelo(mfgSku) {
  const m = (mfgSku || '').toString().trim();
  return m || 'Modelo sin identificar';
}

// Detecta menciones de tecnologia de panel/resolucion EN LA DESCRIPCION real (nunca inventadas).
// Cada resultado se marca confidence:'parsed' porque es un parseo de texto libre, no un campo
// oficial de la API — ver seccion 13 del pedido de Roman ("no convertir coincidencias dudosas
// en informacion confirmada").
const TV_TYPE_PATTERNS = [
  { tag: 'Mini-LED', re: /mini[\s-]?led/i },
  { tag: 'QLED', re: /qled/i },
  { tag: 'OLED', re: /oled/i },
  { tag: 'LED', re: /\bled\b/i },
  { tag: 'LCD', re: /\blcd\b/i },
  { tag: '8K', re: /\b8k\b/i },
  { tag: '4K', re: /\b4k\b|uhd/i },
];
function parseTvTypeTags(desc) {
  if (!desc) return [];
  const found = [];
  for (const { tag, re } of TV_TYPE_PATTERNS) {
    if (re.test(desc)) found.push(tag);
  }
  // 'Mini-LED' ya implica LED (el guion antes de 'LED' hace que \bled\b tambien
  // dispare) — evitar el tag generico redundante cuando ya se detecto el especifico.
  if (found.includes('Mini-LED')) return found.filter((t) => t !== 'LED');
  return found;
}

// Set de LPN (NumeroSerie) unicos, normalizados (trim + uppercase) para no contar
// "abc123" y "ABC123 " como distintos. Ignora vacios/null.
function dedupeUniqueLpns(serials) {
  const set = new Set();
  for (const s of serials || []) {
    const v = (s || '').toString().trim().toUpperCase();
    if (v) set.add(v);
  }
  return set;
}

// Agrupador generico: suma weightFn(item) por keyFn(item), regresa arreglo ordenado
// descendente con total y porcentaje sobre el total general. Mismo patron que ya usaba
// /api/dashboard/tv-stats (funcion agrupar() local), generalizado para reutilizarse.
function groupBy(items, keyFn, weightFn = () => 1) {
  const grupos = new Map();
  let totalGeneral = 0;
  for (const item of items || []) {
    const key = keyFn(item);
    const weight = weightFn(item) || 0;
    totalGeneral += weight;
    const g = grupos.get(key) || { key, total: 0, items: [] };
    g.total += weight;
    g.items.push(item);
    grupos.set(key, g);
  }
  return [...grupos.values()]
    .sort((a, b) => b.total - a.total)
    .map((g) => ({ ...g, porcentaje: totalGeneral > 0 ? (g.total / totalGeneral) * 100 : 0 }));
}

// Como groupBy, pero agrupa ignorando mayusculas/espacios extra (para que "VIZIO" y
// "Vizio" caigan en el mismo grupo — son el mismo texto real, no dos marcas distintas)
// y usa como etiqueta la variante EXACTA mas frecuente dentro del grupo, en vez de
// inventar un formato nuevo (title case rompe siglas reales como "LG"/"TCL").
function groupByFoldingCase(items, valueFn, weightFn = () => 1) {
  const grupos = new Map(); // foldKey -> { variantes: Map<string,count>, total, items }
  let totalGeneral = 0;
  for (const item of items || []) {
    const raw = (valueFn(item) || '').toString();
    const foldKey = raw.trim().toLowerCase();
    const weight = weightFn(item) || 0;
    totalGeneral += weight;
    const g = grupos.get(foldKey) || { variantes: new Map(), total: 0, items: [] };
    g.variantes.set(raw, (g.variantes.get(raw) || 0) + 1);
    g.total += weight;
    g.items.push(item);
    grupos.set(foldKey, g);
  }
  return [...grupos.values()]
    .sort((a, b) => b.total - a.total)
    .map((g) => {
      const key = [...g.variantes.entries()].sort((a, b) => b[1] - a[1])[0][0];
      return { key, total: g.total, items: g.items, porcentaje: totalGeneral > 0 ? (g.total / totalGeneral) * 100 : 0 };
    });
}

// Un pallet es "mixto" cuando trae mas de una marca, modelo o SKU distintos. No debe
// presentarse como si tuviera un solo modelo (pedido explicito de Roman, seccion 14).
function detectMixedPallet(productos) {
  const brands = new Set(), modelos = new Set(), skus = new Set();
  for (const p of productos || []) {
    if (p.brand) brands.add(p.brand);
    if (p.modelo) modelos.add(p.modelo);
    if (p.sku) skus.add(p.sku);
  }
  return {
    isMixed: brands.size > 1 || modelos.size > 1 || skus.size > 1,
    brandCount: brands.size,
    modeloCount: modelos.size,
    skuCount: skus.size,
  };
}

function safeDivide(numerador, denominador) {
  if (!denominador) return 0;
  return numerador / denominador;
}

// Delta porcentual entre el periodo actual y el anterior. null cuando no se puede
// calcular correctamente (periodo anterior en cero o inexistente) — nunca inventa tendencia.
function computeDelta(actual, anterior) {
  if (anterior == null || actual == null) return null;
  if (anterior === 0) return actual === 0 ? 0 : null;
  return ((actual - anterior) / anterior) * 100;
}

module.exports = {
  parseInchesFromDescription,
  normalizeBrand,
  groupByFoldingCase,
  normalizeModelo,
  parseTvTypeTags,
  dedupeUniqueLpns,
  groupBy,
  detectMixedPallet,
  safeDivide,
  computeDelta,
};
