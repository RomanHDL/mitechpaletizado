// Helpers puros (sin DB, sin red) para "Reporte Semanal de Produccion" y para
// /api/reportes/produccion-excel — UNA SOLA fuente de verdad para normalizar,
// clasificar (Almacen/TRG/FBA/Bulky/Fierro/Element sin doble conteo), agrupar por dia
// y calcular el resumen semanal. Se mantienen aqui, separados de api/index.js,
// para poder probarlos con node:test sin necesitar Mongo real.

const DIAS_ES = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const CATEGORIAS_OFICIALES = ['Almacén', 'TRG', 'FBA', 'Bulky', 'Fierro', 'Element'];

// Normaliza el campo `destino` tolerando mayusculas/minusculas/acentos. Regresa
// exactamente 'TRG' | 'Almacen' | 'FBA' cuando coincide; si no coincide con
// ninguno (ej. "Sin clasificar", datos historicos raros) regresa el texto
// original recortado — nunca fuerza un valor desconocido a un destino oficial
// aqui (el catch-all a "Almacén" ocurre mas adelante, en clasificarRegistro,
// como decision documentada, no aqui de forma implicita).
function normalizeDestino(d) {
  const u = (d || '').toString().trim();
  const up = u.toUpperCase();
  if (up === 'ALMACEN' || up === 'ALMACÉN') return 'Almacen';
  if (up === 'TRG') return 'TRG';
  if (up === 'FBA') return 'FBA';
  return u;
}

// Token de tipo de pedido/clasificacion de UN registro: primero el primer
// segmento de `observaciones` (antes de '|'), si no coincide se revisa el
// campo `pedido` completo — mismo criterio que getClasificacion() del
// frontend (index.html), comparado sin distinguir mayusculas/minusculas.
// 'LPN' es un alias legado de 'BULKY': el formulario de escaneo (index.html,
// guardarEscaneo) guarda literalmente el tag 'LPN | BULKY' en observaciones
// cuando el usuario elige la clasificacion BULKY (nunca guarda 'BULKY' solo),
// y getClasificacion() ya revierte ese alias en el resto de la app — este
// helper debe reconocer el mismo alias o los pallets BULKY reales caen en
// Almacen por error (bug real detectado: Bulky salia siempre en 0).
// Regresa 'BULKY' | 'FIERRO' | 'ELEMENT' | '' (nunca inventa un tipo que no
// esta en el texto). ELEMENT agregado 2026-08-07 a peticion de Roman: se
// contaba como Almacen (catch-all) y queria poder identificarlo aparte, sin
// sumarlo a Almacen ni a FBA — mismo mecanismo que ya existia para Bulky/Fierro.
function extraerTipoPedido(registro) {
  const obsToken = String((registro && registro.observaciones) || '').split('|')[0].trim().toUpperCase();
  if (obsToken === 'BULKY' || obsToken === 'LPN') return 'BULKY';
  if (obsToken === 'FIERRO') return 'FIERRO';
  if (obsToken === 'ELEMENT') return 'ELEMENT';
  const pedToken = String((registro && registro.pedido) || '').trim().toUpperCase();
  if (pedToken === 'BULKY' || pedToken === 'LPN') return 'BULKY';
  if (pedToken === 'FIERRO') return 'FIERRO';
  if (pedToken === 'ELEMENT') return 'ELEMENT';
  return '';
}

// Clasifica UN registro en EXACTAMENTE una de las 6 categorias oficiales.
// Prioridad: TRG/FBA (por destino) > Bulky/Fierro/Element (por tipo de pedido)
// > Almacén (todo lo demas, incluyendo Almacen sin tipo especial y cualquier
// destino no reconocido). Cada rama hace `return` inmediato — un registro
// nunca puede caer en mas de una categoria por construccion, no por casualidad.
// Element (2026-08-07): mismo nivel de prioridad que Bulky/Fierro — si el
// registro es destino TRG/FBA, ESE gana (igual que ya pasaba con Bulky/Fierro,
// ver test "TRG y FBA tienen prioridad"); Element solo aparece separado de
// Almacén cuando el destino no es TRG/FBA. Nunca se suma a FBA ni a Almacén.
function clasificarRegistro(registro) {
  const destNorm = normalizeDestino(registro && registro.destino);
  if (destNorm === 'TRG') return 'TRG';
  if (destNorm === 'FBA') return 'FBA';
  const tipo = extraerTipoPedido(registro);
  if (tipo === 'BULKY') return 'Bulky';
  if (tipo === 'FIERRO') return 'Fierro';
  if (tipo === 'ELEMENT') return 'Element';
  return 'Almacén';
}

// "fecha" en EscReg es texto M/D/YYYY (fecha de NEGOCIO, ya resuelta contra el
// turno nocturno al capturar el registro — no es lo mismo que createdAt).
function parseFechaMDY(f) {
  if (!f || typeof f !== 'string') return null;
  const p = f.split('/');
  if (p.length !== 3) return null;
  const mo = parseInt(p[0], 10), da = parseInt(p[1], 10), yr = parseInt(p[2], 10);
  if (Number.isNaN(mo) || Number.isNaN(da) || Number.isNaN(yr)) return null;
  if (mo < 1 || mo > 12 || da < 1 || da > 31) return null;
  return new Date(yr, mo - 1, da);
}
function formatFechaMDY(date) {
  return `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()}`;
}

// Lunes de la semana (Lunes-Domingo) que contiene `date`. getDay(): 0=Domingo.
function inicioDeSemana(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const dow = d.getDay();
  const diff = dow === 0 ? -6 : 1 - dow;
  d.setDate(d.getDate() + diff);
  return d;
}

// Da forma a UN documento crudo de EscReg (ya .lean()) al shape final que usan
// tanto el modulo web como el export a Excel — un solo lugar para este mapeo.
function prepararRegistro(doc) {
  const categoria = clasificarRegistro(doc);
  const tipo = extraerTipoPedido(doc);
  const fecha = doc.fecha || '';
  const fd = parseFechaMDY(fecha);
  return {
    id: String(doc._id),
    fecha,
    diaSemana: fd ? DIAS_ES[fd.getDay()] : '',
    turno: doc.turno || '',
    categoria,
    destinoOriginal: doc.destino || '',
    palletId: doc.palletId || '',
    pallets: 1,
    piezas: doc.cantidad || 0,
    pedido: doc.pedido || '',
    tipoPedido: tipo,
    condicion: doc.condicion || '',
    escaneadora: doc.escaneadora || '',
    observaciones: doc.observaciones || '',
    fechaCreacion: doc.createdAt ? new Date(doc.createdAt).toISOString() : null,
  };
}

// Construye el reporte semanal completo (Lunes..Domingo) a partir de una lista
// PLANA de registros YA preparados (ver prepararRegistro). Nunca cuenta un
// registro en 2 dias (se agrupa por su propio campo `fecha`) ni en 2 categorias
// (cada registro ya trae una sola `categoria`, calculada una unica vez).
function buildReporteSemanal(registrosPreparados, semanaInicio) {
  const regs = registrosPreparados || [];
  const dias = [];
  for (let i = 0; i < 7; i++) {
    const fechaDia = new Date(semanaInicio.getFullYear(), semanaInicio.getMonth(), semanaInicio.getDate() + i);
    const fechaStr = formatFechaMDY(fechaDia);
    const nombreDia = DIAS_ES[fechaDia.getDay()];
    const regsDia = regs.filter((r) => r.fecha === fechaStr);

    const nuevoBucket = () => ({ pallets: 0, piezas: 0 });
    const almacen = nuevoBucket(), trg = nuevoBucket(), fba = nuevoBucket(), bulky = nuevoBucket(), fierro = nuevoBucket(), element = nuevoBucket();
    for (const r of regsDia) {
      const b = r.categoria === 'Almacén' ? almacen
        : r.categoria === 'TRG' ? trg
        : r.categoria === 'FBA' ? fba
        : r.categoria === 'Bulky' ? bulky
        : r.categoria === 'Fierro' ? fierro
        : element;
      b.pallets += 1;
      b.piezas += r.piezas || 0;
    }
    const bulkyFierroPallets = bulky.pallets + fierro.pallets;
    const bulkyFierroPiezas = bulky.piezas + fierro.piezas;
    const totalPallets = almacen.pallets + trg.pallets + fba.pallets + bulky.pallets + fierro.pallets + element.pallets;
    const totalPiezas = almacen.piezas + trg.piezas + fba.piezas + bulky.piezas + fierro.piezas + element.piezas;

    let detalleBulkyFierro = 'Sin producción';
    const partes = [];
    if (bulky.pallets > 0) partes.push(`${bulky.pallets} Bulky`);
    if (fierro.pallets > 0) partes.push(`${fierro.pallets} Fierro`);
    if (partes.length) detalleBulkyFierro = partes.join(' + ');

    dias.push({
      fecha: fechaStr,
      dia: nombreDia,
      sinProduccion: totalPallets === 0,
      filas: {
        almacen: { categoria: 'Almacén', pallets: almacen.pallets, piezas: almacen.piezas, bulky: 0, fierro: 0, detalle: 'Excluye Bulky, Fierro y Element' },
        bulkyFierro: { categoria: 'Bulky + Fierro', pallets: bulkyFierroPallets, piezas: bulkyFierroPiezas, bulky: bulky.pallets, fierro: fierro.pallets, detalle: detalleBulkyFierro },
        trg: { categoria: 'TRG', pallets: trg.pallets, piezas: trg.piezas, bulky: 0, fierro: 0, detalle: '' },
        fba: { categoria: 'FBA', pallets: fba.pallets, piezas: fba.piezas, bulky: 0, fierro: 0, detalle: '' },
        // Element (2026-08-07): identificado aparte, colocado junto a FBA en
        // la UI/Excel — nunca sumado a FBA ni a Almacén (ver clasificarRegistro).
        element: { categoria: 'Element', pallets: element.pallets, piezas: element.piezas, bulky: 0, fierro: 0, detalle: '' },
      },
      totalPallets,
      totalPiezas,
    });
  }

  const totalSemanaPallets = dias.reduce((s, d) => s + d.totalPallets, 0);
  const totalSemanaPiezas = dias.reduce((s, d) => s + d.totalPiezas, 0);
  const sumFila = (key, campo) => dias.reduce((s, d) => s + d.filas[key][campo], 0);
  const diaTop = dias.reduce((max, d) => (max === null || d.totalPallets > max.totalPallets ? d : max), null);

  return {
    dias,
    resumen: {
      totalPallets: totalSemanaPallets,
      totalPiezas: totalSemanaPiezas,
      almacenPallets: sumFila('almacen', 'pallets'),
      trgPallets: sumFila('trg', 'pallets'),
      fbaPallets: sumFila('fba', 'pallets'),
      bulkyPallets: sumFila('bulkyFierro', 'bulky'),
      fierroPallets: sumFila('bulkyFierro', 'fierro'),
      elementPallets: sumFila('element', 'pallets'),
      promedioDiarioPallets: totalSemanaPallets / 7,
      diaMayorProduccion: diaTop && diaTop.totalPallets > 0 ? diaTop.dia : null,
    },
  };
}

module.exports = {
  DIAS_ES,
  CATEGORIAS_OFICIALES,
  normalizeDestino,
  extraerTipoPedido,
  clasificarRegistro,
  parseFechaMDY,
  formatFechaMDY,
  inicioDeSemana,
  prepararRegistro,
  buildReporteSemanal,
};
