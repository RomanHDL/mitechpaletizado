// ══════════════════════════════════════════════════════════════════════════
// CATALOGO CENTRAL DE MODULOS + RESOLUCION DE PERMISOS (auditoria 2026-08-28)
//
// Unica fuente de verdad para "que modulo existe" y "quien lo ve por default".
// Antes de esto, cada modulo 3647-only tenia su propio check inline
// (`if (req.user.usuario !== '3647') return 403`) o compartia un guard generico
// (`centroOperativoGuard`) que mezclaba 4 modulos distintos bajo un solo
// permiso. Esta version separa cada modulo en un permiso independiente,
// reutilizando EXACTAMENTE el mecanismo de compatibilidad que ya existia en
// el schema de usuario (`modulosCustom`): undefined = usa el default de su
// rol/reglas de abajo; array (incluso []) = override explicito por usuario.
//
// defaultAccess(user) reproduce el guard EXACTO que cada modulo tenia hoy
// (antes de este cambio) para que un usuario sin `modulosCustom` no pierda ni
// gane acceso el dia del deploy. Ver notas por modulo abajo.
// ══════════════════════════════════════════════════════════════════════════

// Mapa historico admin/lider/escaneadora/viewer -> modulos, ya existente en
// api/index.js antes de este cambio (ROLE_MODULES). Se conserva aqui, tal
// cual, unicamente como la formula que reproduce el comportamiento actual de
// 'dashboard' y 'escaneadoras' -- NO como un sistema paralelo. El resto de
// modulos NUNCA estuvo en este mapa (solo cubria estos 2).
const LEGACY_ROLE_MODULES = {
  admin: ['dashboard', 'escaneadoras'],
  lider: ['dashboard', 'escaneadoras'],
  escaneadora: ['escaneadoras'],
  viewer: ['dashboard'],
};

const MODULES = [
  {
    id: 'escaneadoras',
    name: 'Escaneadoras',
    viewTarget: 'openEscaneadorasModule',
    category: 'Operación',
    icon: 'fa-barcode',
    // Hoy: gobernado por ROLE_MODULES (admin/lider/escaneadora lo tienen, viewer no).
    defaultAccess: (user) => (LEGACY_ROLE_MODULES[user.role] || []).includes('escaneadoras'),
  },
  {
    id: 'resumen',
    name: 'Resumen Turno',
    viewTarget: 'resumen',
    category: 'Operación',
    icon: 'fa-clipboard-list',
    // Hoy NO tiene guard propio: switchView('resumen') y /api/resumen dependen
    // de hasModule('escaneadoras')/moduleGuard('escaneadoras') -- se reproduce
    // esa misma regla aqui como default, y el backend (ver requireEscaneadorasOrResumen
    // en api/index.js) acepta cualquiera de los 2 permisos para no romper el
    // acceso de nadie mientras se habilita la separacion granular nueva.
    defaultAccess: (user) => (LEGACY_ROLE_MODULES[user.role] || []).includes('escaneadoras'),
  },
  {
    id: 'dashboard',
    name: 'Dashboard',
    viewTarget: 'dashboard',
    category: 'Operación',
    icon: 'fa-gauge',
    // Hoy: gobernado por ROLE_MODULES (admin/lider/viewer lo tienen, escaneadora no).
    defaultAccess: (user) => (LEGACY_ROLE_MODULES[user.role] || []).includes('dashboard'),
  },
  {
    id: 'config',
    name: 'Configuración',
    viewTarget: 'config',
    category: 'Administración',
    icon: 'fa-gear',
    // Siempre visible para cualquier usuario logueado. Aparece en el catalogo
    // solo como referencia (perfil/preferencias/seguridad propios) -- NO se
    // renderiza como switch editable en el panel de permisos.
    toggleable: false,
    defaultAccess: () => true,
  },
  {
    id: 'lpn-duplicados',
    name: 'LPN Duplicados',
    viewTarget: 'lpn',
    category: 'FFT/Almacén',
    icon: 'fa-copy',
    defaultAccess: (user) => String(user.usuario) === '3647',
  },
  {
    id: 'operaciones',
    name: 'Operaciones y Pedidos',
    viewTarget: 'operaciones',
    category: 'Pedidos/Producción',
    icon: 'fa-boxes-stacked',
    // Hoy: roleGuard('admin') -- por ROL, no por username. Se deja asi
    // (decision explicita, ver auditoria en el reporte final).
    defaultAccess: (user) => user.role === 'admin',
  },
  {
    id: 'centro-operativo',
    name: 'Centro Operativo API',
    viewTarget: 'centro-operativo',
    category: 'FFT/Almacén',
    icon: 'fa-server',
    defaultAccess: (user) => String(user.usuario) === '3647',
  },
  {
    id: 'reporte-semanal',
    name: 'Reporte Semanal de Producción',
    viewTarget: 'reporte-semanal',
    category: 'Pedidos/Producción',
    icon: 'fa-file-excel',
    defaultAccess: (user) => String(user.usuario) === '3647',
  },
  {
    id: 'dashboard-destinos-fft',
    name: 'Centro de Control de Pallets — MAXX',
    viewTarget: 'dashboard-destinos-fft',
    category: 'FFT/Almacén',
    icon: 'fa-warehouse',
    defaultAccess: (user) => String(user.usuario) === '3647',
  },
  {
    id: 'comparador-pallets',
    name: 'Comparador de Pallets',
    viewTarget: 'comparador-pallets',
    category: 'FFT/Almacén',
    icon: 'fa-code-compare',
    defaultAccess: (user) => String(user.usuario) === '3647',
  },
  {
    id: 'trazabilidad-tag',
    name: 'Centro de Trazabilidad TAG — MAXX',
    viewTarget: 'trazabilidad-tag',
    category: 'FFT/Almacén',
    icon: 'fa-tags',
    defaultAccess: (user) => String(user.usuario) === '3647',
  },
];

const ALL_MODULE_IDS = MODULES.map((m) => m.id);

function isKnownModuleId(id) {
  return ALL_MODULE_IDS.includes(id);
}

function getModule(id) {
  return MODULES.find((m) => m.id === id) || null;
}

// Resolucion de acceso real para UN modulo. Reglas, en orden estricto:
//  1) usuario 3647 -> SIEMPRE true, sin excepcion (superadmin protegido, ver
//     tambien la validacion dura en PUT /api/admin/users/:id/permissions).
//  2) modulosCustom es un array (incluso []) -> override explicito: solo lo
//     que este en ese arreglo.
//  3) modulosCustom es undefined -> cae al default del modulo (defaultAccess),
//     que reproduce el guard que ese modulo ya tenia antes de este cambio.
function userHasModuleAccess(user, moduleId) {
  if (!user) return false;
  if (String(user.usuario) === '3647') return true;
  if (Array.isArray(user.modulosCustom)) return user.modulosCustom.includes(moduleId);
  const mod = getModule(moduleId);
  if (!mod) return false;
  return !!mod.defaultAccess(user);
}

// Lista de ids de modulo que el usuario puede ver, calculada sobre el
// catalogo completo (reemplaza al getUserModules viejo, que solo conocia
// 'dashboard'/'escaneadoras' -- moduleGuard(x) solo hace .includes(x), asi
// que devolver mas ids de los que ese guard usa nunca rompe nada).
function getUserModules(user) {
  return MODULES.filter((m) => userHasModuleAccess(user, m.id)).map((m) => m.id);
}

module.exports = {
  MODULES,
  ALL_MODULE_IDS,
  LEGACY_ROLE_MODULES,
  isKnownModuleId,
  getModule,
  userHasModuleAccess,
  getUserModules,
};
