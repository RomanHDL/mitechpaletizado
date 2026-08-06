// Cruce PalletID entre el inventario real (BinManagerRO via Cubicaje) y los
// registros propios de escaneo FFT (EscReg/Mongo). UNICA fuente de verdad para
// "que cuenta como el mismo pallet" en ambos lados. El PalletID NUNCA se trata
// como numero ni se suma — solo se usa como texto para emparejar.

const { normalizeBin } = require('./binHelpers');
const {
  normalizeInventoryCategory,
  normalizeDestination,
  normalizeOrderType,
  normalizeCondition,
  normalizeScanner,
  normalizeDate,
  normalizePieces,
} = require('./destinoTipoHelpers');

// Clave de CRUCE (no de presentacion): mayusculas + trim, sin quitar guiones
// internos, nunca convertida a numero. El valor que se MUESTRA al usuario
// sigue siendo el original tal cual vino de cada fuente.
function palletIdMatchKey(raw) {
  return (raw === null || raw === undefined ? '' : String(raw)).trim().toUpperCase();
}

// Arma UN UnifiedPalletRecord a partir de lo que exista de cada fuente (puede
// faltar cualquiera de las dos, nunca ambas si esta funcion se invoco para un
// PalletID real). `inv` = fila ya mapeada de fetchCubicajeLivePalletsPage
// (incluye area/areaFuente ya resueltas); `fftDoc` = documento crudo de EscReg
// (.lean() o Mongoose doc); `catalogoNombres` = nombres reales de Clasificacion.
function buildUnifiedRecord(inv, fftDoc, catalogoNombres) {
  const palletIdOriginal = (inv && inv.palletId) || (fftDoc && fftDoc.palletId) || '';

  const inventory = inv ? {
    area: inv.area,
    areaFuente: inv.areaFuente,
    bin: normalizeBin(inv.locationName).valor,
    category: normalizeInventoryCategory(inv.binTypeName).valor,
    pieces: Number(inv.cantidadTotal) || 0,
    skuCount: inv.skuCount ?? null,
    status: 'Con inventario',
    raw: inv.raw || null,
  } : null;

  const fft = fftDoc ? {
    destination: normalizeDestination(fftDoc.destino).valor,
    orderType: normalizeOrderType(fftDoc, catalogoNombres).valor,
    orderNumber: String(fftDoc.pedido || '').trim(),
    pieces: normalizePieces(fftDoc.cantidad).valor,
    scanner: normalizeScanner(fftDoc.escaneadora).valor,
    condition: normalizeCondition(fftDoc.condicion).valor,
    date: normalizeDate(fftDoc.fecha).valor,
    turno: fftDoc.turno || '',
    observaciones: fftDoc.observaciones || '',
    createdAt: fftDoc.createdAt ? new Date(fftDoc.createdAt).toISOString() : null,
    id: fftDoc._id ? String(fftDoc._id) : null,
    raw: fftDoc.raw || null,
  } : null;

  let matchStatus;
  if (inv && fft) {
    matchStatus = inventory.pieces === fft.pieces ? 'matched' : 'conflict';
  } else if (inv && !fft) {
    matchStatus = 'inventory-only';
  } else if (!inv && fft) {
    matchStatus = 'fft-only';
  } else {
    matchStatus = 'incomplete';
  }

  return {
    palletId: palletIdOriginal,
    inventory,
    fft,
    products: [],
    movements: [],
    matchStatus,
  };
}

module.exports = { palletIdMatchKey, buildUnifiedRecord };
