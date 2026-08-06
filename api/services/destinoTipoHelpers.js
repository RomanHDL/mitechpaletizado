// Helpers puros (sin DB, sin red) para "Dashboard Destinos FFT". Mantiene DESTINO
// (TRG/Almacen/FBA/otros reales) y TIPO DE PEDIDO (Bulky/Fierro/BOX/etc., segun el
// catalogo REAL y dinamico de Clasificacion) como dos dimensiones separadas — nunca
// se trata un tipo de pedido como destino, ni el nombre de un bin como cantidad.
//
// normalizeOrderType() replica EXACTAMENTE getClasificacion() del frontend
// (index.html): primer token de `observaciones` (antes de '|'), si no coincide se
// revisa `pedido` completo, comparados sin distinguir mayusculas/minusculas contra
// el catalogo real (nunca una lista fija de nombres), con el alias legado
// LPN -> BULKY (el formulario de escaneo guarda literalmente 'LPN | BULKY' en
// observaciones cuando el usuario elige la clasificacion BULKY — ver el bug real
// corregido en reporteProduccionHelpers.js, [[project_reporte_semanal_bulky_lpn]]).

const ALIAS_TIPO = { LPN: 'BULKY' };

function normalizePalletId(raw) {
  const original = raw === null || raw === undefined ? '' : String(raw);
  return { valor: original.trim(), original };
}

function normalizePieces(raw) {
  const original = raw === null || raw === undefined ? null : raw;
  const n = Number(raw);
  return { valor: Number.isFinite(n) ? n : 0, original };
}

function normalizeDate(raw) {
  const original = raw === null || raw === undefined ? '' : String(raw);
  return { valor: original.trim(), original };
}

function normalizeScanner(raw) {
  const original = raw === null || raw === undefined ? '' : String(raw);
  const t = original.trim();
  return { valor: t || 'Sin escaneadora', original };
}

function normalizeCondition(raw) {
  const original = raw === null || raw === undefined ? '' : String(raw);
  const t = original.trim();
  return { valor: t || 'Sin condición', original };
}

// AREA (zona/almacen/agrupacion superior al bin) es un concepto DISTINTO del
// bin y de la categoria de inventario — nunca se mezclan. Quien llama a esta
// funcion decide de donde sale el valor real (ver resolverAreaDesdeInventario
// en api/index.js); aqui solo se normaliza el texto ya resuelto.
function normalizeArea(raw) {
  const original = raw === null || raw === undefined ? '' : String(raw);
  const t = original.trim();
  return { valor: t || 'Sin área', original };
}

// CATEGORIA DE INVENTARIO (BinManagerRO, ej. "PRODUCTO TERMINADO", "Wholesale")
// es un concepto DISTINTO de destino FFT (TRG/Almacen/FBA) — nunca se muestra
// una categoria de inventario en una columna llamada "destino".
function normalizeInventoryCategory(raw) {
  const original = raw === null || raw === undefined ? '' : String(raw);
  const t = original.trim();
  return { valor: t || 'Sin categoría', original };
}

// Destinos oficiales conocidos se normalizan a su forma canonica (tolerando
// mayusculas/minusculas/acentos); cualquier otro destino real encontrado en los
// datos se conserva TAL CUAL (nunca se inventa ni se fuerza a uno de los 3
// oficiales) — "Otros destinos reales" del pedido se cumple asi, sin lista fija.
function normalizeDestination(raw) {
  const original = raw === null || raw === undefined ? '' : String(raw);
  const trimmed = original.trim();
  if (!trimmed) return { valor: 'Sin destino', original };
  const up = trimmed.toUpperCase();
  if (up === 'TRG') return { valor: 'TRG', original };
  if (up === 'ALMACEN' || up === 'ALMACÉN') return { valor: 'Almacén', original };
  if (up === 'FBA') return { valor: 'FBA', original };
  return { valor: trimmed, original };
}

// `catalogoNombres`: lista de nombres REALES tal como existen hoy en la coleccion
// Clasificacion (nunca hardcodeados aqui) — quien llama a esta funcion es
// responsable de pasar el catalogo vigente. Regresa el nombre EXACTO tal como
// esta en el catalogo (respetando su casing original), o 'Sin pedido' si nada
// coincide (nunca inventa un tipo que no este en el catalogo ni en el texto).
function normalizeOrderType(registro, catalogoNombres) {
  const lista = Array.isArray(catalogoNombres) ? catalogoNombres : [];

  function match(token) {
    if (!token) return null;
    const t = String(token).trim();
    if (!t) return null;
    const exact = lista.find((n) => n.toLowerCase() === t.toLowerCase());
    if (exact) return exact;
    const aliasTarget = ALIAS_TIPO[t.toUpperCase()];
    if (aliasTarget) {
      const aliased = lista.find((n) => n.toUpperCase() === aliasTarget.toUpperCase());
      if (aliased) return aliased;
    }
    return null;
  }

  const obsToken = String((registro && registro.observaciones) || '').split('|')[0].trim();
  const pedidoTxt = String((registro && registro.pedido) || '').trim();
  let matched = match(obsToken);
  if (!matched) matched = match(pedidoTxt);
  const original = obsToken || pedidoTxt;
  return { valor: matched || 'Sin pedido', original };
}

// Da forma a UN pallet ya agrupado (ver getFilteredPalletsMeta en api/index.js,
// que agrupa por palletId sumando cantidad — un pallet nunca se cuenta 2 veces
// ni se suma su ID) al shape final que usa el Dashboard Destinos FFT.
function prepararRegistroFft(pallet, catalogoNombres) {
  const palletId = normalizePalletId(pallet.palletId);
  const piezas = normalizePieces(pallet.cantidad);
  const destino = normalizeDestination(pallet.destino);
  const tipo = normalizeOrderType(pallet, catalogoNombres);
  const condicion = normalizeCondition(pallet.condicion);
  const escaneadora = normalizeScanner(pallet.escaneadora);
  const fecha = normalizeDate(pallet.fecha);
  return {
    palletId: palletId.valor,
    piezas: piezas.valor,
    destino: destino.valor,
    destinoOriginal: destino.original,
    tipoPedido: tipo.valor,
    tipoPedidoOriginal: tipo.original,
    condicion: condicion.valor,
    escaneadora: escaneadora.valor,
    pedido: String(pallet.pedido || '').trim(),
    fecha: fecha.valor,
    ultimoRegistro: pallet.createdAt ? new Date(pallet.createdAt).toISOString() : null,
  };
}

module.exports = {
  normalizePalletId,
  normalizePieces,
  normalizeDate,
  normalizeScanner,
  normalizeCondition,
  normalizeDestination,
  normalizeOrderType,
  normalizeArea,
  normalizeInventoryCategory,
  prepararRegistroFft,
};
