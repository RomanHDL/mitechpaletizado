const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MODULES,
  ALL_MODULE_IDS,
  isKnownModuleId,
  userHasModuleAccess,
  getUserModules,
} = require('./permissions');

test('el catalogo tiene los 11 modulos reales, sin duplicados', () => {
  assert.equal(MODULES.length, 11);
  assert.equal(new Set(ALL_MODULE_IDS).size, 11);
  [
    'escaneadoras', 'resumen', 'dashboard', 'config', 'lpn-duplicados',
    'operaciones', 'centro-operativo', 'reporte-semanal',
    'dashboard-destinos-fft', 'comparador-pallets', 'trazabilidad-tag',
  ].forEach((id) => assert.ok(isKnownModuleId(id), `falta el modulo ${id}`));
});

test('userHasModuleAccess: el usuario 3647 SIEMPRE tiene acceso, sin excepcion', () => {
  const admin3647 = { usuario: '3647', role: 'admin', modulosCustom: [] };
  ALL_MODULE_IDS.forEach((id) => assert.equal(userHasModuleAccess(admin3647, id), true, id));

  // Incluso si alguien lograra setear modulosCustom vacio o restrictivo en su
  // propio registro, 3647 nunca depende de eso.
  const admin3647Restringido = { usuario: '3647', role: 'viewer', modulosCustom: undefined };
  ALL_MODULE_IDS.forEach((id) => assert.equal(userHasModuleAccess(admin3647Restringido, id), true, id));
});

test('userHasModuleAccess: modulosCustom explicito (incluso array vacio) manda sobre el default del rol', () => {
  const user = { usuario: 'ana', role: 'admin', modulosCustom: ['dashboard'] };
  assert.equal(userHasModuleAccess(user, 'dashboard'), true);
  assert.equal(userHasModuleAccess(user, 'escaneadoras'), false);
  assert.equal(userHasModuleAccess(user, 'centro-operativo'), false);

  const sinNada = { usuario: 'beto', role: 'admin', modulosCustom: [] };
  ALL_MODULE_IDS.forEach((id) => assert.equal(userHasModuleAccess(sinNada, id), false, id));
});

test('userHasModuleAccess: sin modulosCustom (undefined) cae al defaultAccess del modulo', () => {
  const admin = { usuario: 'carla', role: 'admin' };
  const lider = { usuario: 'dani', role: 'lider' };
  const escaneadora = { usuario: 'edu', role: 'escaneadora' };
  const viewer = { usuario: 'fer', role: 'viewer' };

  // dashboard/escaneadoras reproducen ROLE_MODULES tal cual existia antes del cambio
  assert.equal(userHasModuleAccess(admin, 'dashboard'), true);
  assert.equal(userHasModuleAccess(admin, 'escaneadoras'), true);
  assert.equal(userHasModuleAccess(lider, 'dashboard'), true);
  assert.equal(userHasModuleAccess(lider, 'escaneadoras'), true);
  assert.equal(userHasModuleAccess(escaneadora, 'dashboard'), false);
  assert.equal(userHasModuleAccess(escaneadora, 'escaneadoras'), true);
  assert.equal(userHasModuleAccess(viewer, 'dashboard'), true);
  assert.equal(userHasModuleAccess(viewer, 'escaneadoras'), false);

  // resumen sigue exactamente la misma regla que escaneadoras (no tenia guard propio)
  assert.equal(userHasModuleAccess(viewer, 'resumen'), false);
  assert.equal(userHasModuleAccess(escaneadora, 'resumen'), true);

  // config: siempre true para cualquier rol
  [admin, lider, escaneadora, viewer].forEach((u) => assert.equal(userHasModuleAccess(u, 'config'), true));

  // operaciones: por ROL admin, no por username
  assert.equal(userHasModuleAccess(admin, 'operaciones'), true);
  assert.equal(userHasModuleAccess(lider, 'operaciones'), false);

  // Los 6 modulos exclusivos de 3647 hoy: nadie mas los ve por default
  ['lpn-duplicados', 'centro-operativo', 'reporte-semanal', 'dashboard-destinos-fft', 'comparador-pallets', 'trazabilidad-tag']
    .forEach((id) => {
      assert.equal(userHasModuleAccess(admin, id), false, id);
      assert.equal(userHasModuleAccess(lider, id), false, id);
    });
});

test('getUserModules regresa la lista de ids visibles para el usuario', () => {
  const viewer = { usuario: 'fer', role: 'viewer' };
  assert.deepEqual(getUserModules(viewer).sort(), ['config', 'dashboard'].sort());

  const admin3647 = { usuario: '3647', role: 'admin' };
  assert.deepEqual(getUserModules(admin3647).sort(), [...ALL_MODULE_IDS].sort());
});

test('un usuario no-3647 puede recibir acceso granular a un modulo antes exclusivo de 3647 via modulosCustom', () => {
  const lider = { usuario: 'dani', role: 'lider', modulosCustom: ['dashboard', 'escaneadoras', 'trazabilidad-tag'] };
  assert.equal(userHasModuleAccess(lider, 'trazabilidad-tag'), true);
  assert.equal(userHasModuleAccess(lider, 'comparador-pallets'), false);
});
