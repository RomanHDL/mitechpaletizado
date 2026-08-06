// Helpers puros (sin DB, sin red) para el modulo "Bines" de Dashboard Destinos
// FFT. BinManagerRO (via Cubicaje) solo expone una FOTO del inventario actual
// (locationName por pallet, sin historial permanente) — estas funciones agrupan
// esa muestra por bin, nunca inventan un historial que no existe.

function normalizeBin(raw) {
  const original = raw === null || raw === undefined ? '' : String(raw);
  const t = original.trim();
  return { valor: t || 'Sin bin', original };
}

// Agrupa una lista de pallets (shape de fetchCubicajeLivePalletsSample: palletId,
// BinTypeID, binTypeName, cantidadTotal, skuCount, locationName) por bin
// (locationName normalizado). `destino` de cada bin = la categoria (binTypeName)
// mas frecuente entre sus pallets — informativo, nunca fuerza un unico destino
// oficial si el bin en la practica tiene mezcla.
function agruparPalletsPorBin(pallets) {
  const lista = Array.isArray(pallets) ? pallets : [];
  const grupos = new Map();
  for (const p of lista) {
    const bin = normalizeBin(p.locationName).valor;
    if (!grupos.has(bin)) grupos.set(bin, { bin, pallets: 0, piezas: 0, tiposCount: new Map() });
    const g = grupos.get(bin);
    g.pallets += 1;
    g.piezas += Number(p.cantidadTotal) || 0;
    const tipo = p.binTypeName || 'Sin categoría';
    g.tiposCount.set(tipo, (g.tiposCount.get(tipo) || 0) + 1);
  }
  const totalPallets = lista.length;
  const totalPiezas = lista.reduce((s, p) => s + (Number(p.cantidadTotal) || 0), 0);
  return [...grupos.values()]
    .map((g) => {
      let destinoPrincipal = 'Sin categoría';
      let max = 0;
      for (const [tipo, count] of g.tiposCount) { if (count > max) { max = count; destinoPrincipal = tipo; } }
      return {
        bin: g.bin,
        destino: destinoPrincipal,
        pallets: g.pallets,
        piezas: g.piezas,
        pctPallets: totalPallets > 0 ? Number(((g.pallets / totalPallets) * 100).toFixed(1)) : 0,
        pctPiezas: totalPiezas > 0 ? Number(((g.piezas / totalPiezas) * 100).toFixed(1)) : 0,
      };
    })
    .sort((a, b) => b.pallets - a.pallets);
}

module.exports = { normalizeBin, agruparPalletsPorBin };
