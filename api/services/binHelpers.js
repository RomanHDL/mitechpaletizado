// Helpers puros (sin DB, sin red) para el modulo "Areas y Bines" de Dashboard
// Destinos FFT. BinManagerRO (via Cubicaje) solo expone una FOTO del inventario
// actual (locationName/area por pallet, sin historial permanente) — estas
// funciones agrupan esa foto por bin y por area, sin inventar historial.
//
// IMPORTANTE: `categoria` (BinTypeName, ej. "PRODUCTO TERMINADO") es la
// categoria de INVENTARIO de BinManagerRO — nunca se llama "destino" aqui.
// El destino FFT real (TRG/Almacen/FBA) sale de EscReg, se calcula aparte
// (ver api/index.js, resumenDestinosFft) y se cruza con estos bines por
// PalletID, no se deriva de esta agrupacion.

function normalizeBin(raw) {
  const original = raw === null || raw === undefined ? '' : String(raw);
  const t = original.trim();
  return { valor: t || 'Sin bin', original };
}

function categoriaPrincipal(tiposCount) {
  let principal = 'Sin categoría';
  let max = 0;
  for (const [tipo, count] of tiposCount) { if (count > max) { max = count; principal = tipo; } }
  return principal;
}

// Agrupa una lista de pallets (shape de fetchCubicajeLivePalletsAll: palletId,
// binTypeName, cantidadTotal, skuCount, locationName, area, areaFuente) por
// bin (locationName normalizado). Cada bin conserva su `area` (ya resuelta por
// el caller — ver resolverAreaDesdeInventario en api/index.js).
function agruparPalletsPorBin(pallets) {
  const lista = Array.isArray(pallets) ? pallets : [];
  const grupos = new Map();
  for (const p of lista) {
    const bin = normalizeBin(p.locationName).valor;
    if (!grupos.has(bin)) grupos.set(bin, { bin, area: p.area || 'Sin área', pallets: 0, piezas: 0, tiposCount: new Map() });
    const g = grupos.get(bin);
    g.pallets += 1;
    g.piezas += Number(p.cantidadTotal) || 0;
    const tipo = p.binTypeName || 'Sin categoría';
    g.tiposCount.set(tipo, (g.tiposCount.get(tipo) || 0) + 1);
  }
  const totalPallets = lista.length;
  const totalPiezas = lista.reduce((s, p) => s + (Number(p.cantidadTotal) || 0), 0);
  return [...grupos.values()]
    .map((g) => ({
      bin: g.bin,
      area: g.area,
      categoria: categoriaPrincipal(g.tiposCount),
      pallets: g.pallets,
      piezas: g.piezas,
      pctPallets: totalPallets > 0 ? Number(((g.pallets / totalPallets) * 100).toFixed(1)) : 0,
      pctPiezas: totalPiezas > 0 ? Number(((g.piezas / totalPiezas) * 100).toFixed(1)) : 0,
    }))
    .sort((a, b) => b.pallets - a.pallets);
}

// Agrupa los BINES YA AGREGADOS (salida de agruparPalletsPorBin) por area —
// el total de una area es, por construccion, la suma de sus bines (nunca se
// recalcula desde cero, para que area.pallets === suma(bin.pallets) siempre).
function agruparBinesPorArea(bines) {
  const lista = Array.isArray(bines) ? bines : [];
  const grupos = new Map();
  for (const b of lista) {
    const area = b.area || 'Sin área';
    if (!grupos.has(area)) grupos.set(area, { area, bines: [], pallets: 0, piezas: 0 });
    const g = grupos.get(area);
    g.bines.push(b);
    g.pallets += b.pallets;
    g.piezas += b.piezas;
  }
  const totalPallets = lista.reduce((s, b) => s + b.pallets, 0);
  const totalPiezas = lista.reduce((s, b) => s + b.piezas, 0);
  return [...grupos.values()]
    .map((g) => ({
      area: g.area,
      bines: g.bines.sort((a, b) => b.pallets - a.pallets),
      cantidadBines: g.bines.length,
      pallets: g.pallets,
      piezas: g.piezas,
      pctPallets: totalPallets > 0 ? Number(((g.pallets / totalPallets) * 100).toFixed(1)) : 0,
      pctPiezas: totalPiezas > 0 ? Number(((g.piezas / totalPiezas) * 100).toFixed(1)) : 0,
    }))
    .sort((a, b) => b.pallets - a.pallets);
}

module.exports = { normalizeBin, agruparPalletsPorBin, agruparBinesPorArea };
