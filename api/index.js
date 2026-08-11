const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const Pusher = require('pusher');
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
} = require('./services/centroOperativoHelpers');
const {
  formatFechaMDY,
  inicioDeSemana,
  prepararRegistro,
  buildReporteSemanal,
} = require('./services/reporteProduccionHelpers');
const { construirWorkbookReporteSemanal } = require('./services/reporteProduccionExcel');
const {
  prepararRegistroFft,
  normalizeDestination: fftNormalizeDestino,
} = require('./services/destinoTipoHelpers');
const { normalizeBin: fftNormalizeBin } = require('./services/binHelpers');
const { palletIdMatchKey, buildUnifiedRecord } = require('./services/unifiedPalletHelpers');

const app = express();
app.use(cors());
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || 'mitech-jwt-secret-2026';
// Key required to call the one-time seed/diagnostic endpoints (they create users / expose data).
// Set SEED_KEY in the environment to override the default. Call e.g. /api/seed?key=<SEED_KEY>
const SEED_KEY = process.env.SEED_KEY || 'mitech-seed-3647';
function seedGuard(req, res) {
  if ((req.query.key || '') !== SEED_KEY) {
    res.status(403).json({ success: false, error: 'No autorizado. Falta la clave de seed.' });
    return false;
  }
  return true;
}

// ── Pusher (real-time events) ──
let pusher = null;
if (process.env.PUSHER_APP_ID && process.env.PUSHER_KEY && process.env.PUSHER_SECRET) {
  pusher = new Pusher({
    appId: process.env.PUSHER_APP_ID,
    key: process.env.PUSHER_KEY,
    secret: process.env.PUSHER_SECRET,
    cluster: process.env.PUSHER_CLUSTER || 'us2',
    useTLS: true
  });
}
function emitEvent(channel, event, data) {
  if (pusher) { try { pusher.trigger(channel, event, data); } catch(e) { console.error('[PUSHER]', e.message); } }
}

// ── Audit helper (SAP-style: one doc per event with changes array) ──
async function audit(action, data) {
  try {
    const doc = {
      action,
      entityType: 'pallet',
      palletId: data.palletId || '',
      escaneadora: data.escaneadora || '',
      changedBy: data.changedBy || '',
      source: data.source || 'APP',
      reason: data.reason || '',
      timestamp: new Date(),
      changes: data.changes || [],        // [{field, before, after}]
      snapshot: data.snapshot || null,     // full object for DELETE
    };
    await mongoose.connection.db.collection('audit_logs').insertOne(doc);
    emitEvent('paletizado', 'audit:new', { action, palletId: doc.palletId });
  } catch(e) { console.error('[AUDIT]', e.message); }
}

// ── Validation helpers ──
// Catalogo central de destinos oficiales (documental — el schema de EscReg NO usa
// enum a proposito, para no romper valores historicos como "Sin clasificar" que
// vienen de SmartControl; el catalogo editable en vivo es /api/settings 'destinos',
// ver SETTING_DEFAULTS mas abajo). normalizeDestino() es el unico lugar que aplica
// este catalogo para normalizar mayusculas/acentos de forma consistente.
const VALID_DESTINOS = ['TRG', 'Almacen', 'FBA'];
const VALID_CLASIFICACIONES = ['', 'BOX', 'BULKY', 'HV', 'HV TELEVISIONES', '9X7251Z'];
function normalizeDestino(d) { const u = (d||'').trim(); const up = u.toUpperCase(); if (up === 'ALMACEN' || up === 'ALMACÉN') return 'Almacen'; if (up === 'TRG') return 'TRG'; if (up === 'FBA') return 'FBA'; return u; }
function normalizePalletId(id) { return (id||'').trim().toUpperCase(); }

// ── Search / date helpers ──
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h
// Escape regex metacharacters so user input can't break/inject the $regex query
function escapeRegex(str) { return String(str == null ? '' : str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
// Case-insensitive "contains" filter built from a safe (escaped) user string
function rx(str) { return { $regex: escapeRegex(str), $options: 'i' }; }
// Parse stored M/D/YYYY (unpadded) date string → Date at local midnight, or null if invalid.
// NOTE: dates are stored unpadded (e.g. "6/6/2026") by both the web form and mobile; do NOT pad.
function parseFechaMDY(f) {
  if (!f || typeof f !== 'string') return null;
  const p = f.split('/');
  if (p.length !== 3) return null;
  const mo = parseInt(p[0], 10), da = parseInt(p[1], 10), yr = parseInt(p[2], 10);
  if (Number.isNaN(mo) || Number.isNaN(da) || Number.isNaN(yr)) return null;
  return new Date(yr, mo - 1, da);
}
// Keep a record if its date is within [start, end]; unparseable dates are kept (not dropped)
function inDateRange(fechaStr, start, end) {
  const d = parseFechaMDY(fechaStr);
  if (!d) return true;
  return d >= start && d <= end;
}

// Aggregation stages that derive a real BSON Date (`_fechaDate`) from the stored unpadded
// M/D/YYYY `fecha` string, without ever throwing on malformed values (yields null instead).
// Needed because Mongo can't sort/range-filter/group-by-week correctly on a plain string like
// "6/6/2026" vs "12/1/2026" (lexical order != chronological order).
function fechaDateStages() {
  return [
    { $addFields: { _fParts: { $split: ['$fecha', '/'] } } },
    { $addFields: {
        _fY: { $convert: { input: { $arrayElemAt: ['$_fParts', 2] }, to: 'int', onError: null, onNull: null } },
        _fM: { $convert: { input: { $arrayElemAt: ['$_fParts', 0] }, to: 'int', onError: null, onNull: null } },
        _fD: { $convert: { input: { $arrayElemAt: ['$_fParts', 1] }, to: 'int', onError: null, onNull: null } },
    } },
    { $addFields: {
        _fechaDate: {
          $cond: [
            { $and: [
                { $eq: [{ $size: '$_fParts' }, 3] },
                { $ne: ['$_fY', null] }, { $ne: ['$_fM', null] }, { $ne: ['$_fD', null] },
                { $gte: ['$_fM', 1] }, { $lte: ['$_fM', 12] },
                { $gte: ['$_fD', 1] }, { $lte: ['$_fD', 31] },
            ] },
            { $dateFromParts: { year: '$_fY', month: '$_fM', day: '$_fD' } },
            null,
          ],
        },
    } },
    { $project: { _fParts: 0, _fY: 0, _fM: 0, _fD: 0 } },
  ];
}
// Date-range match that keeps unparseable-fecha docs visible (mirrors inDateRange's "keep if unknown" rule)
function fechaDateRangeMatch(fechaInicio, fechaFin) {
  const range = {};
  if (fechaInicio) range.$gte = new Date(fechaInicio + 'T00:00:00');
  if (fechaFin) { const end = new Date(fechaFin + 'T00:00:00'); end.setHours(23, 59, 59, 999); range.$lte = end; }
  return { $or: [{ _fechaDate: null }, { _fechaDate: range }] };
}
const MESES_ES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
const DIAS_ES = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

// ── DB Connection (reuse across invocations) ──
let isConnected = false;
async function connectDB() {
  if (isConnected) return;
  let uri = process.env.MONGODB_URI || '';
  // Ensure we connect to paletizadodb, not the default 'test' database
  if (uri && !uri.includes('/paletizadodb')) {
    uri = uri.replace(/\/(\?|$)/, '/paletizadodb$1');
    if (!uri.includes('/paletizadodb')) uri = uri + '/paletizadodb';
  }
  await mongoose.connect(uri);
  isConnected = true;
}

// ── Models ──
const userSchema = new mongoose.Schema({
  nombre: { type: String, required: true },
  usuario: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  role: { type: String, enum: ['admin', 'lider', 'escaneadora', 'viewer'], required: true },
  isActive: { type: Boolean, default: true },
  // undefined = usa el default de su rol (ROLE_MODULES); array (incluso []) = override explicito por usuario
  modulosCustom: { type: [String], default: undefined },
}, { timestamps: true });

userSchema.methods.comparePassword = async function(p) { return bcrypt.compare(p, this.passwordHash); };
userSchema.statics.hashPassword = function(p) { return bcrypt.hash(p, 10); };
userSchema.set('toJSON', { transform: (d, r) => { delete r.passwordHash; return r; } });

const escRegSchema = new mongoose.Schema({
  palletId: { type: String, required: true, index: true },
  cantidad: { type: Number, default: 0 },
  condicion: { type: String, default: '' },
  destino: { type: String, required: true },
  turno: { type: String, required: true },
  escaneadora: { type: String, required: true, index: true },
  fecha: { type: String, required: true, index: true },
  pedido: { type: String, default: '' },
  fechaSalida: { type: String, default: '' },
  incidencias: { type: String, default: '' },
  observaciones: { type: String, default: '' },
  capturadoPor: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  origen: { type: String, default: 'manual' }, // 'manual' | 'smartcontrol-sync'
}, { timestamps: true });

escRegSchema.index({ fecha: 1, turno: 1 });
escRegSchema.index({ escaneadora: 1, fecha: 1 });
escRegSchema.index({ createdAt: -1 });

const User = mongoose.models.User || mongoose.model('User', userSchema);
const EscReg = mongoose.models.EscaneadoraRegistro || mongoose.model('EscaneadoraRegistro', escRegSchema);

// ── Centro Operativo API: enriquecimiento PERSISTENTE por pallet (reemplaza el muestreo
// temporal de 5 min por un cache real que nunca se descarta) — ver seccion de rutas
// /api/centro-operativo/* para el flujo completo de por que existe esto. ──
const palletEnrichmentProductSchema = new mongoose.Schema({
  lpn: String, sku: String, marca: String, modelo: String, pulgadas: Number,
  tvTypeTags: [String], condicion: String,
}, { _id: false });
const palletEnrichmentSchema = new mongoose.Schema({
  palletId: { type: String, required: true, unique: true, index: true },
  foundInSmartControl: { type: Boolean, default: false },
  workcenter: String,
  cantidadTotalSc: Number,
  condicionesSc: String,
  ubicacionSc: String,
  lpns: [String],
  productos: [palletEnrichmentProductSchema],
  marcas: [String],
  modelos: [String],
  pulgadas: [Number],
  tvTypeTags: [String],
  lastSyncedAt: { type: Date, default: Date.now, index: true },
  syncError: { type: String, default: '' },
}, { timestamps: true });
const PalletEnrichment = mongoose.models.PalletEnrichment || mongoose.model('PalletEnrichment', palletEnrichmentSchema);

// ── Cache local del inventario real de BinManagerRO (via Cubicaje) ──
// Consultar Cubicaje EN VIVO por los 30,000+ pallets del inventario completo
// en cada carga de pagina resulto ser demasiado lento (una sola pagina de 200
// ya tardaba mas de 12s) — Dashboard Destinos FFT (Areas/Bines/Pallets) ahora
// LEE de este cache local (rapido, un solo query a Mongo) en vez de llamar a
// Cubicaje en cada request. El cache se refresca via cron (ver
// /api/cron/sync-cubicaje-inventory, vercel.json) y bajo demanda (admin 3647,
// boton "Actualizar inventario" del modulo) — nunca de forma sincrona dentro
// de un request normal de usuario.
const cubicajeInventarioSchema = new mongoose.Schema({
  palletId: { type: String, required: true, unique: true, index: true },
  binTypeId: Number,
  binTypeName: String,
  cantidadTotal: Number,
  skuCount: Number,
  locationName: String,
  area: String,
  areaFuente: String,
  raw: mongoose.Schema.Types.Mixed,
}, { timestamps: true });
const CubicajeInventario = mongoose.models.CubicajeInventario || mongoose.model('CubicajeInventario', cubicajeInventarioSchema);
const cubicajeSyncMetaSchema = new mongoose.Schema({
  _id: { type: String, default: 'singleton' },
  ultimaSincronizacion: Date,
  totalReal: Number,
  totalGuardado: Number,
  agotado: Boolean,
  error: String,
}, { timestamps: true });
const CubicajeSyncMeta = mongoose.models.CubicajeSyncMeta || mongoose.model('CubicajeSyncMeta', cubicajeSyncMetaSchema);

// ── Middleware ──
async function auth(req, res, next) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return res.status(401).json({ success: false, error: 'Token requerido' });
  try {
    const decoded = jwt.verify(h.split(' ')[1], JWT_SECRET);
    const user = await User.findById(decoded.id).select('-passwordHash');
    if (!user || !user.isActive) return res.status(401).json({ success: false, error: 'Usuario invalido' });
    req.user = user;
    next();
  } catch (err) { console.error('[AUTH]', err.message); return res.status(401).json({ success: false, error: 'Token invalido' }); }
}

function roleGuard(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ success: false, error: 'No autenticado' });
    if (!roles.includes(req.user.role)) return res.status(403).json({ success: false, error: 'Sin permisos' });
    next();
  };
}

// Permisos por modulo (independiente del Centro de Control, que sigue exclusivo de usuario 3647).
// Solo hay 2 modulos reales en esta app: dashboard y escaneadoras (incluye resumen de turno).
const ROLE_MODULES = {
  admin: ['dashboard', 'escaneadoras'],
  lider: ['dashboard', 'escaneadoras'],
  escaneadora: ['escaneadoras'],
  viewer: ['dashboard'],
};
function getUserModules(user) {
  // El admin 3647 es superusuario en TODO el resto del codigo (decenas de
  // checks explicitos `usuario !== '3647'`) — moduleGuard era la unica
  // excepcion, y un modulosCustom desactualizado/incompleto en su propio
  // registro (ej. sin 'escaneadoras') lo dejaba fuera de sus propios
  // endpoints con 403. Nunca debe depender de modulosCustom.
  if (String(user.usuario) === '3647') return ['dashboard', 'escaneadoras'];
  return Array.isArray(user.modulosCustom) ? user.modulosCustom : (ROLE_MODULES[user.role] || []);
}
function moduleGuard(moduleName) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ success: false, error: 'No autenticado' });
    if (!getUserModules(req.user).includes(moduleName)) {
      return res.status(403).json({ success: false, error: 'Acceso denegado: no tienes permiso para ver este modulo.' });
    }
    next();
  };
}

// Connect DB on every request
app.use(async (req, res, next) => {
  try { await connectDB(); next(); }
  catch (err) { res.status(500).json({ success: false, error: 'DB error: ' + err.message }); }
});

// ═══════════ AUTH + SESSION CONTROL ═══════════
function sessionsCol() { return mongoose.connection.db.collection('active_sessions'); }

async function checkAndSetSession(user, deviceId) {
  if (user.role !== 'escaneadora') return { allowed: true };
  const did = deviceId || ('srv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10));
  const col = sessionsCol();
  await col.deleteMany({ expiresAt: { $lt: new Date() } });
  const existing = await col.findOne({ userId: user._id.toString(), deviceId: { $ne: did } });
  if (existing) return { allowed: false, error: 'Este usuario ya tiene una sesion activa en otro dispositivo. Cierra sesion en el otro dispositivo o pide apoyo al administrador.', sessionConflict: true };
  await col.updateOne({ userId: user._id.toString() }, { $set: { userId: user._id.toString(), deviceId: did, createdAt: new Date(), expiresAt: new Date(Date.now()+SESSION_TTL_MS) } }, { upsert: true });
  return { allowed: true, deviceId: did };
}

app.post('/api/auth/login', async (req, res) => {
  try {
    const { usuario, password, deviceId } = req.body;
    if (!usuario || !password) return res.status(400).json({ success: false, error: 'Usuario y contrasena requeridos' });
    const user = await User.findOne({ usuario: usuario.toLowerCase().trim() });
    if (!user || !user.isActive) return res.status(401).json({ success: false, error: 'Credenciales incorrectas' });
    const valid = await user.comparePassword(password);
    if (!valid) return res.status(401).json({ success: false, error: 'Credenciales incorrectas' });
    const sc = await checkAndSetSession(user, deviceId);
    if (!sc.allowed) return res.status(403).json({ success: false, error: sc.error, sessionConflict: true });
    const token = jwt.sign({ id: user._id, role: user.role }, JWT_SECRET, { expiresIn: '12h' });
    res.json({ success: true, token, deviceId: sc.deviceId, user: { id: user._id, nombre: user.nombre, usuario: user.usuario, role: user.role, modulosCustom: user.modulosCustom ?? null } });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.post('/api/auth/nfc', async (req, res) => {
  try {
    const { serialNumber, deviceId } = req.body;
    if (!serialNumber) return res.status(400).json({ success: false, error: 'Numero de serie NFC requerido' });
    const db = mongoose.connection.db;
    const card = await db.collection('nfc_cards').findOne({ serialNumber: serialNumber.toUpperCase().trim(), isActive: true });
    if (!card) return res.status(401).json({ success: false, error: 'Tarjeta NFC no autorizada' });
    let user = card.userId ? await User.findById(card.userId) : null;
    if (!user) user = await User.findOne({ role: card.role, isActive: true });
    if (!user) return res.status(401).json({ success: false, error: 'No hay usuario asociado a esta tarjeta' });
    const sc = await checkAndSetSession(user, deviceId);
    if (!sc.allowed) return res.status(403).json({ success: false, error: sc.error, sessionConflict: true });
    const token = jwt.sign({ id: user._id, role: user.role }, JWT_SECRET, { expiresIn: '12h' });
    await db.collection('nfc_cards').updateOne({ _id: card._id }, { $set: { lastUsed: new Date() }, $inc: { useCount: 1 } });
    res.json({ success: true, token, deviceId: sc.deviceId, user: { id: user._id, nombre: user.nombre, usuario: user.usuario, role: user.role, modulosCustom: user.modulosCustom ?? null }, nfc: { serial: card.serialNumber, role: card.role } });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.post('/api/auth/logout', auth, async (req, res) => {
  try {
    await sessionsCol().deleteMany({ userId: req.user._id.toString() });
    res.json({ success: true, message: 'Sesion cerrada' });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.get('/api/auth/me', auth, async (req, res) => {
  const deviceId = req.headers['x-device-id'];
  if (req.user.role === 'escaneadora' && deviceId) {
    const session = await sessionsCol().findOne({ userId: req.user._id.toString() });
    if (session && session.deviceId !== deviceId) return res.status(401).json({ success: false, error: 'Sesion invalida para este dispositivo' });
  }
  res.json({ success: true, user: { id: req.user._id, nombre: req.user.nombre, usuario: req.user.usuario, role: req.user.role, modulosCustom: req.user.modulosCustom ?? null } });
});

// ═══════════ IMPERSONATION (admin only) ═══════════
app.post('/api/auth/impersonate', auth, roleGuard('admin'), async (req, res) => {
  try {
    const { targetUsuario } = req.body;
    if (!targetUsuario) return res.status(400).json({ success: false, error: 'targetUsuario requerido' });

    // Only admin 3647 can impersonate
    if (req.user.usuario !== '3647') return res.status(403).json({ success: false, error: 'Solo el administrador 3647 puede usar esta funcion' });

    const target = await User.findOne({ usuario: targetUsuario.toLowerCase().trim() });
    if (!target || !target.isActive) return res.status(404).json({ success: false, error: 'Usuario no encontrado' });

    // Generate token for target user — NO session check, no logout of target
    const token = jwt.sign({ id: target._id, role: target.role, impersonatedBy: req.user._id }, JWT_SECRET, { expiresIn: '12h' });

    // Log impersonation for audit
    try {
      await mongoose.connection.db.collection('audit_log').insertOne({
        action: 'impersonate',
        adminId: req.user._id.toString(),
        adminUsuario: req.user.usuario,
        targetId: target._id.toString(),
        targetUsuario: target.usuario,
        targetNombre: target.nombre,
        timestamp: new Date()
      });
    } catch(e) { /* audit log failure should not block impersonation */ }

    res.json({
      success: true,
      token,
      user: { id: target._id, nombre: target.nombre, usuario: target.usuario, role: target.role, modulosCustom: target.modulosCustom ?? null },
      impersonation: true,
      admin: req.user.usuario
    });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// ═══════════ USER MANAGEMENT (admin 3647 only) ═══════════
app.get('/api/users', auth, roleGuard('admin'), async (req, res) => {
  try {
    if (req.user.usuario !== '3647') return res.status(403).json({ success: false, error: 'Sin permiso' });
    const users = await User.find({}).select('-passwordHash').sort({ role: 1, nombre: 1 });
    // Include NFC card info to know which users have NFC
    const nfcCards = await mongoose.connection.db.collection('nfc_cards').find({ isActive: true, role: 'escaneadora' }).toArray();
    const nfcUserIds = nfcCards.map(c => c.userId ? c.userId.toString() : null).filter(Boolean);
    const data = users.map(u => ({ ...u.toJSON(), hasNfc: nfcUserIds.includes(u._id.toString()), effectiveModules: getUserModules(u) }));
    res.json({ success: true, data });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.post('/api/users', auth, roleGuard('admin'), async (req, res) => {
  try {
    if (req.user.usuario !== '3647') return res.status(403).json({ success: false, error: 'Sin permiso' });
    const { nombre, usuario, password } = req.body;
    if (!nombre || !usuario || !password) return res.status(400).json({ success: false, error: 'nombre, usuario y password son requeridos' });
    if (password.length !== 6 || !/^\d{6}$/.test(password)) return res.status(400).json({ success: false, error: 'Password debe ser exactamente 6 digitos' });
    const exists = await User.findOne({ usuario: usuario.toLowerCase().trim() });
    if (exists) return res.status(409).json({ success: false, error: 'Ese usuario ya existe' });
    const passwordHash = await User.hashPassword(password);
    const user = await User.create({ nombre, usuario: usuario.toLowerCase().trim(), passwordHash, role: 'escaneadora' });
    res.json({ success: true, data: { id: user._id, nombre: user.nombre, usuario: user.usuario, role: user.role } });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.delete('/api/users/:id', auth, roleGuard('admin'), async (req, res) => {
  try {
    if (req.user.usuario !== '3647') return res.status(403).json({ success: false, error: 'Sin permiso' });
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ success: false, error: 'Usuario no encontrado' });
    if (user.role === 'admin') return res.status(403).json({ success: false, error: 'No se puede eliminar un administrador' });
    // Solo desactivar, no borrar — los registros del usuario se mantienen
    await User.findByIdAndUpdate(req.params.id, { isActive: false });
    // Limpiar sesiones activas
    await mongoose.connection.db.collection('active_sessions').deleteMany({ userId: req.params.id.toString() });
    res.json({ success: true, message: `Usuario ${user.nombre} desactivado. Sus registros se mantienen.` });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// Editar usuario (nombre, role, isActive) — admin 3647
app.put('/api/users/:id', auth, roleGuard('admin'), async (req, res) => {
  try {
    if (req.user.usuario !== '3647') return res.status(403).json({ success: false, error: 'Sin permiso' });
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ success: false, error: 'Usuario no encontrado' });
    const isSelf3647 = user.usuario === '3647';
    const { nombre, role, isActive, modulosCustom } = req.body;
    if (nombre !== undefined) {
      const n = String(nombre).trim();
      if (!n) return res.status(400).json({ success: false, error: 'Nombre no puede estar vacio' });
      user.nombre = n;
    }
    if (role !== undefined) {
      if (!['admin', 'lider', 'escaneadora', 'viewer'].includes(role)) return res.status(400).json({ success: false, error: 'Rol invalido' });
      if (isSelf3647 && role !== 'admin') return res.status(403).json({ success: false, error: 'No puedes cambiar el rol del administrador 3647' });
      user.role = role;
    }
    if (typeof isActive === 'boolean') {
      if (isSelf3647 && !isActive) return res.status(403).json({ success: false, error: 'No puedes desactivar al administrador 3647' });
      user.isActive = isActive;
      if (!isActive) await mongoose.connection.db.collection('active_sessions').deleteMany({ userId: user._id.toString() });
    }
    if (modulosCustom !== undefined) {
      if (modulosCustom === null) {
        user.modulosCustom = undefined;
      } else {
        const ALL_MODULES = ['dashboard', 'escaneadoras'];
        if (!Array.isArray(modulosCustom) || !modulosCustom.every(m => ALL_MODULES.includes(m))) {
          return res.status(400).json({ success: false, error: 'modulosCustom invalido: debe ser null o un subconjunto de ' + ALL_MODULES.join(', ') });
        }
        if (isSelf3647 && !ALL_MODULES.every(m => modulosCustom.includes(m))) {
          return res.status(403).json({ success: false, error: 'No puedes restringir tus propios modulos como administrador 3647' });
        }
        user.modulosCustom = modulosCustom;
      }
    }
    await user.save();
    res.json({ success: true, data: { id: user._id, nombre: user.nombre, usuario: user.usuario, role: user.role, isActive: user.isActive, modulosCustom: user.modulosCustom ?? null, effectiveModules: getUserModules(user) } });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// Resetear password (6 digitos) — admin 3647
app.post('/api/users/:id/password', auth, roleGuard('admin'), async (req, res) => {
  try {
    if (req.user.usuario !== '3647') return res.status(403).json({ success: false, error: 'Sin permiso' });
    const { password } = req.body;
    if (!password || password.length !== 6 || !/^\d{6}$/.test(password)) return res.status(400).json({ success: false, error: 'Password debe ser exactamente 6 digitos' });
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ success: false, error: 'Usuario no encontrado' });
    user.passwordHash = await User.hashPassword(password);
    await user.save();
    // Forzar re-login: limpiar sesiones del usuario
    await mongoose.connection.db.collection('active_sessions').deleteMany({ userId: user._id.toString() });
    res.json({ success: true, message: `Password de ${user.nombre} actualizado` });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// ═══════════ SESIONES ACTIVAS (admin 3647 only) ═══════════
app.get('/api/sessions', auth, roleGuard('admin'), async (req, res) => {
  try {
    if (req.user.usuario !== '3647') return res.status(403).json({ success: false, error: 'Sin permiso' });
    const col = mongoose.connection.db.collection('active_sessions');
    await col.deleteMany({ expiresAt: { $lt: new Date() } });
    const sessions = await col.find({}).sort({ createdAt: -1 }).toArray();
    const userIds = sessions.map(s => { try { return new mongoose.Types.ObjectId(s.userId); } catch { return null; } }).filter(Boolean);
    const users = await User.find({ _id: { $in: userIds } }).select('nombre usuario role');
    const byId = {}; users.forEach(u => { byId[u._id.toString()] = u; });
    const data = sessions.map(s => {
      const u = byId[s.userId];
      return { userId: s.userId, deviceId: s.deviceId, createdAt: s.createdAt, expiresAt: s.expiresAt,
        nombre: u ? u.nombre : '(desconocido)', usuario: u ? u.usuario : '', role: u ? u.role : '' };
    });
    res.json({ success: true, data, total: data.length });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.delete('/api/sessions/:userId', auth, roleGuard('admin'), async (req, res) => {
  try {
    if (req.user.usuario !== '3647') return res.status(403).json({ success: false, error: 'Sin permiso' });
    const r = await mongoose.connection.db.collection('active_sessions').deleteMany({ userId: req.params.userId });
    res.json({ success: true, message: `Sesion cerrada (${r.deletedCount})`, deletedCount: r.deletedCount });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// ═══════════ TARJETAS NFC (admin 3647 only) ═══════════
function nfcCol() { return mongoose.connection.db.collection('nfc_cards'); }

app.get('/api/nfc', auth, roleGuard('admin'), async (req, res) => {
  try {
    if (req.user.usuario !== '3647') return res.status(403).json({ success: false, error: 'Sin permiso' });
    const cards = await nfcCol().find({}).sort({ createdAt: -1 }).toArray();
    const userIds = cards.map(c => c.userId).filter(Boolean);
    const users = await User.find({ _id: { $in: userIds } }).select('nombre usuario');
    const byId = {}; users.forEach(u => { byId[u._id.toString()] = u; });
    const data = cards.map(c => ({ ...c, usuarioVinculado: c.userId && byId[c.userId.toString()] ? byId[c.userId.toString()].usuario : null }));
    res.json({ success: true, data, total: data.length });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.post('/api/nfc', auth, roleGuard('admin'), async (req, res) => {
  try {
    if (req.user.usuario !== '3647') return res.status(403).json({ success: false, error: 'Sin permiso' });
    const serialNumber = (req.body.serialNumber || '').toUpperCase().trim();
    const role = req.body.role === 'admin' ? 'admin' : 'escaneadora';
    const nombre = (req.body.nombre || '').trim();
    let userId = null;
    if (!serialNumber) return res.status(400).json({ success: false, error: 'Numero de serie requerido' });
    if (req.body.usuario) {
      const u = await User.findOne({ usuario: String(req.body.usuario).toLowerCase().trim() });
      if (!u) return res.status(404).json({ success: false, error: 'Usuario a vincular no encontrado' });
      userId = u._id;
    }
    const exists = await nfcCol().findOne({ serialNumber });
    if (exists) return res.status(409).json({ success: false, error: 'Ya existe una tarjeta con ese numero de serie' });
    const doc = { serialNumber, role, nombre, userId, isActive: true, useCount: 0, createdAt: new Date() };
    await nfcCol().insertOne(doc);
    res.json({ success: true, data: doc });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.put('/api/nfc/:id', auth, roleGuard('admin'), async (req, res) => {
  try {
    if (req.user.usuario !== '3647') return res.status(403).json({ success: false, error: 'Sin permiso' });
    let _id; try { _id = new mongoose.Types.ObjectId(req.params.id); } catch { return res.status(400).json({ success: false, error: 'ID invalido' }); }
    const set = {};
    if (typeof req.body.isActive === 'boolean') set.isActive = req.body.isActive;
    if (req.body.nombre !== undefined) set.nombre = String(req.body.nombre).trim();
    if (req.body.role !== undefined) set.role = req.body.role === 'admin' ? 'admin' : 'escaneadora';
    if (req.body.usuario !== undefined) {
      if (req.body.usuario) {
        const u = await User.findOne({ usuario: String(req.body.usuario).toLowerCase().trim() });
        if (!u) return res.status(404).json({ success: false, error: 'Usuario a vincular no encontrado' });
        set.userId = u._id;
      } else { set.userId = null; }
    }
    if (Object.keys(set).length === 0) return res.status(400).json({ success: false, error: 'Nada que actualizar' });
    const r = await nfcCol().findOneAndUpdate({ _id }, { $set: set }, { returnDocument: 'after' });
    const updated = r && (r.value || r);
    if (!updated) return res.status(404).json({ success: false, error: 'Tarjeta no encontrada' });
    res.json({ success: true, data: updated });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.delete('/api/nfc/:id', auth, roleGuard('admin'), async (req, res) => {
  try {
    if (req.user.usuario !== '3647') return res.status(403).json({ success: false, error: 'Sin permiso' });
    let _id; try { _id = new mongoose.Types.ObjectId(req.params.id); } catch { return res.status(400).json({ success: false, error: 'ID invalido' }); }
    await nfcCol().updateOne({ _id }, { $set: { isActive: false } });
    res.json({ success: true, message: 'Tarjeta desactivada' });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// ═══════════ ESCANEADORAS ═══════════
app.post('/api/escaneadoras', auth, moduleGuard('escaneadoras'), async (req, res) => {
  try {
    const { palletId, cantidad, condicion, destino, turno, escaneadora, fecha, pedido, incidencias, observaciones } = req.body;
    if (!palletId || !destino || !turno || !escaneadora || !fecha) return res.status(400).json({ success: false, error: 'Campos requeridos: palletId, destino, turno, escaneadora, fecha' });
    const hasPedido = pedido && pedido.trim();
    // Condicion obligatoria solo cuando NO es pedido
    if (!hasPedido && (!condicion || !condicion.trim())) return res.status(400).json({ success: false, error: 'El campo condicion es obligatorio' });
    const pid = normalizePalletId(palletId);
    const dest = normalizeDestino(destino);
    const qty = parseInt(cantidad, 10) || 0;
    // Cantidad 0 solo para admin 3647 o dispositivo autorizado
    if (qty < 0) return res.status(400).json({ success: false, error: 'Cantidad no puede ser negativa' });
    if (qty === 0 && req.user.usuario !== '3647') {
      const deviceId = req.headers['x-device-id'];
      const auth3647Doc = await mongoose.connection.db.collection('auth3647_devices').findOne({ deviceId, expiresAt: { $gt: new Date() } });
      if (!auth3647Doc) return res.status(403).json({ success: false, error: 'No tienes permiso para registrar cantidad 0.' });
    }
    const exists = await EscReg.findOne({ palletId: pid });
    if (exists) {
      emitEvent('paletizado', 'registro:duplicado', { palletId: pid, escaneadora, fecha });
      return res.status(409).json({ success: false, error: `Pallet ID duplicado. El pallet ${pid} ya fue registrado.`, duplicate: true });
    }
    const doc = await EscReg.create({ palletId: pid, cantidad: qty, condicion: (condicion||'').trim(), destino: dest, turno, escaneadora, fecha, pedido: pedido || '', fechaSalida: hasPedido ? fecha : '', incidencias: incidencias || '', observaciones: observaciones || '', capturadoPor: req.user._id });
    emitEvent('paletizado', 'registro:nuevo', { id: doc._id, palletId: pid, cantidad: qty, destino: dest, turno, escaneadora, fecha, condicion: condicion.trim(), source: 'web' });
    res.json({ success: true, id: doc._id, message: 'Registro guardado' });
  } catch (error) {
    emitEvent('paletizado', 'registro:error', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

// Retrabajo: copiar pallet a fecha de hoy (solo admin 3647)
app.post('/api/escaneadoras/retrabajo', auth, roleGuard('admin'), async (req, res) => {
  try {
    if (req.user.usuario !== '3647') return res.status(403).json({ success: false, error: 'Solo admin 3647 puede crear retrabajos' });
    const { originalId } = req.body;
    if (!originalId) return res.status(400).json({ success: false, error: 'originalId requerido' });
    const original = await EscReg.findById(originalId);
    if (!original) return res.status(404).json({ success: false, error: 'Registro original no encontrado' });
    const hoy = mexicoDateStr();
    // Crear copia con fecha de hoy y marcado como retrabajo
    // Observaciones se mantienen intactas para que la clasificacion de pedidos funcione
    const doc = await EscReg.create({
      palletId: original.palletId,
      cantidad: original.cantidad,
      condicion: original.condicion,
      destino: original.destino,
      turno: original.turno,
      escaneadora: original.escaneadora,
      fecha: hoy,
      pedido: original.pedido || '',
      fechaSalida: original.fechaSalida || '',
      incidencias: original.incidencias || '',
      observaciones: original.observaciones || '',
      capturadoPor: req.user._id,
      retrabajo: true,
      originalId: original._id,
    });
    emitEvent('paletizado', 'registro:nuevo', { id: doc._id, palletId: original.palletId, retrabajo: true });
    res.json({ success: true, id: doc._id, fecha: hoy, message: `Retrabajo de ${original.palletId} creado para ${hoy}` });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.get('/api/escaneadoras', auth, moduleGuard('escaneadoras'), async (req, res) => {
  try {
    const { fecha, escaneadora, turno, limit } = req.query;
    const filter = {};
    if (fecha) filter.fecha = fecha;
    if (escaneadora) filter.escaneadora = rx(escaneadora);
    if (turno) filter.turno = rx(turno);
    const registros = await EscReg.find(filter).sort({ createdAt: -1 }).limit(parseInt(limit) || 200);
    res.json({ success: true, data: registros, total: registros.length });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.get('/api/escaneadoras/:id', auth, moduleGuard('escaneadoras'), async (req, res) => {
  try {
    const doc = await EscReg.findById(req.params.id);
    if (!doc) return res.status(404).json({ success: false, error: 'No encontrado' });
    res.json({ success: true, data: doc });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// ── SmartControl (empresa): detalle real de un pallet en vivo (solo lectura, no se guarda nada) ──
function scTryParse(v) {
  if (typeof v !== 'string' || !v) return v;
  try { return JSON.parse(v); } catch { return v; }
}
// Extraido a helper (usado por la ruta de abajo y por /api/lpn-duplicates/:id/mapa
// para verificar en vivo si un LPN sigue presente en un pallet especifico).
async function fetchScPalletLive(palletId) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 9000);
  try {
    const url = `https://appsc.mitechnologiesinc.com/Home/BinPalletID_GET_ApiAR?PalletID=${encodeURIComponent(palletId)}`;
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) throw new Error(`SmartControl respondio ${resp.status}`);
    const raw = await resp.json();
    const productos = scTryParse(raw.Productos) || [];
    const fotos = scTryParse(raw.Fotos) || [];
    const palletsContent = scTryParse(raw.PalletsContent);
    let movimientos = scTryParse(raw.Movimientos) || [];
    if (Array.isArray(movimientos)) {
      movimientos = movimientos.map(m => ({ ...m, ProductosMovidos: scTryParse(m.ProductosMovidos) || [] }));
    }
    return {
      nombrePallet: raw.NombrePallet || palletId,
      cantidadTotal: raw.CantidadTotal,
      condiciones: raw.Condiciones,
      foto: raw.Foto,
      workcenter: raw.WorkcenterMovimiento,
      ubicacion: raw.Ubicacion,
      fotos: Array.isArray(fotos) ? fotos : [],
      productos: Array.isArray(productos) ? productos : [],
      movimientos: Array.isArray(movimientos) ? movimientos : [],
      palletsContent,
    };
  } finally {
    clearTimeout(timeout);
  }
}

app.get('/api/sc-pallet/:palletId', auth, async (req, res) => {
  const palletId = String(req.params.palletId || '').trim();
  if (!palletId) return res.status(400).json({ success: false, error: 'PalletID requerido' });
  try {
    const data = await fetchScPalletLive(palletId);
    res.json({ success: true, data });
  } catch (error) {
    const msg = error.name === 'AbortError' ? 'SmartControl no respondio a tiempo' : error.message;
    res.status(502).json({ success: false, error: msg });
  }
});

// ── SmartControl: detalle real de un LPN (pieza individual) en vivo, solo lectura ──
app.get('/api/sc-lpn/:lpn', auth, async (req, res) => {
  const lpn = String(req.params.lpn || '').trim();
  if (!lpn) return res.status(400).json({ success: false, error: 'LPN requerido' });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 9000);
  try {
    const url = `https://appsc.mitechnologiesinc.com/Classification/GetDataLicensePlateNumber_ApiAR?LPN=${encodeURIComponent(lpn)}`;
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) return res.status(502).json({ success: false, error: `SmartControl respondio ${resp.status}` });
    const raw = await resp.json();
    const workPlanArr = scTryParse(raw.WorkPlanLicensePlateNumber) || [];
    const info = Array.isArray(workPlanArr) ? workPlanArr[0] : null;
    const palletInfo = scTryParse(raw.PalletInfo) || [];
    const categoryBrandModels = scTryParse(raw.CategoryBrandModels) || [];
    res.json({
      success: true,
      data: {
        lpn,
        wasScanned: raw.wasScanned,
        isValid: raw.isValid,
        isReclassification: raw.Is_Reclassification,
        needTRGID: raw.NeedTRGID,
        totalPalletQuantity: raw.TotalPalletQuantity,
        totalQuantityReceived: raw.TotalQuantityReceived,
        totalQuantityInspection: raw.TotalQuantityInspection,
        info: info ? {
          sku: info.SKU,
          brand: info.Brand,
          modelo: info.MFGSKU,
          descripcion: info.ItemDescription,
          categoria: info.CategoryName,
          estado: info.StatusDescription,
          serie: info.SerialNumber,
          trgId: info.TRGID,
          needTRGID: info.NeedTRGID,
          supplierName: info.SupplierName,
          imagen: info.SKUImage,
          qtyOrdered: info.QtyOrdered,
          qtyPacked: info.QtyPacked,
          qtyPrinted: info.QtyPrinted,
          sourceOrderId: info.SourceOrderID,
          dueDate: info.DueDate,
          classification: info.Step2 && info.Step2[0] ? info.Step2[0].data : null,
          packing: info.Step3 && info.Step3[0] ? info.Step3[0] : null,
          accessories: info.Step4 && info.Step4[0] ? info.Step4[0] : null,
          steps: {
            upc: info.Step1 && info.Step1[0] ? info.Step1[0].isComplete : null,
            clasificacion: info.Step2 && info.Step2[0] ? info.Step2[0].isComplete : null,
            empaque: info.Step3 && info.Step3[0] ? info.Step3[0].isComplete : null,
            accesorios: info.Step4 && info.Step4[0] ? info.Step4[0].isComplete : null,
            comentario: info.Step5 && info.Step5[0] ? info.Step5[0].isComplete : null,
            foto: info.Step6 && info.Step6[0] ? info.Step6[0].isComplete : null,
          },
        } : null,
        palletInfo: Array.isArray(palletInfo) ? palletInfo : [],
        categoryBrandModels: Array.isArray(categoryBrandModels) ? categoryBrandModels : [],
      }
    });
  } catch (error) {
    const msg = error.name === 'AbortError' ? 'SmartControl no respondio a tiempo' : error.message;
    res.status(502).json({ success: false, error: msg });
  } finally {
    clearTimeout(timeout);
  }
});

// ── Sync SmartControl → Mongo (solo admin 3647, aditivo, nunca sobreescribe) ──
// 1) Diff: dado un listado de PalletIDs que SmartControl dice que existen, regresa cuales faltan en Mongo.
app.post('/api/sc-pallet/diff', auth, roleGuard('admin'), async (req, res) => {
  try {
    if (req.user.usuario !== '3647') return res.status(403).json({ success: false, error: 'Solo admin 3647' });
    const { palletIds } = req.body;
    if (!Array.isArray(palletIds) || !palletIds.length) return res.status(400).json({ success: false, error: 'palletIds (array) requerido' });
    const normalized = [...new Set(palletIds.map(normalizePalletId).filter(Boolean))];
    const existing = await EscReg.find({ palletId: { $in: normalized } }).distinct('palletId');
    const existingSet = new Set(existing.map(normalizePalletId));
    const missing = normalized.filter(id => !existingSet.has(id));
    res.json({ success: true, total: normalized.length, existentes: normalized.length - missing.length, faltantes: missing });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// Helper: GET con timeout a un endpoint publico de SmartControl (appsc.mitechnologiesinc.com).
async function scFetchJson(url, timeoutMs = 9000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) throw new Error(`SmartControl respondio ${resp.status}`);
    return await resp.json();
  } finally { clearTimeout(timeout); }
}

// Deduce destino (TRG/Almacen) tomando un LPN del pallet y revisando NeedTRGID en Classification API.
// Confirmado con datos reales: NeedTRGID=true -> TRG, NeedTRGID=false -> Almacen.
async function scDeduceDestino(productos) {
  const lpn = (productos || []).map(p => p.NumeroSerie).find(s => s && s.trim());
  if (!lpn) return 'Sin clasificar';
  try {
    const raw = await scFetchJson(`https://appsc.mitechnologiesinc.com/Classification/GetDataLicensePlateNumber_ApiAR?LPN=${encodeURIComponent(lpn)}`, 7000);
    if (typeof raw.NeedTRGID === 'boolean') return raw.NeedTRGID ? 'TRG' : 'Almacen';
    return 'Sin clasificar';
  } catch { return 'Sin clasificar'; }
}

// 2) Import: dado un listado de PalletIDs, jala cada uno de SmartControl (pallet + LPN para destino),
//    e inserta SOLO los que no existan ya en Mongo. Nunca sobreescribe ni borra nada existente.
app.post('/api/sc-pallet/sync-import', auth, roleGuard('admin'), async (req, res) => {
  try {
    if (req.user.usuario !== '3647') return res.status(403).json({ success: false, error: 'Solo admin 3647' });
    const { palletIds } = req.body;
    if (!Array.isArray(palletIds) || !palletIds.length) return res.status(400).json({ success: false, error: 'palletIds (array) requerido' });

    const inserted = [];
    const skipped = [];
    for (const rawId of palletIds) {
      const pid = normalizePalletId(rawId);
      if (!pid) { skipped.push({ palletId: rawId, reason: 'palletId vacio' }); continue; }
      const already = await EscReg.findOne({ palletId: pid });
      if (already) { skipped.push({ palletId: pid, reason: 'ya existe' }); continue; }

      let raw;
      try {
        raw = await scFetchJson(`https://appsc.mitechnologiesinc.com/Home/BinPalletID_GET_ApiAR?PalletID=${encodeURIComponent(pid)}`);
      } catch (e) { skipped.push({ palletId: pid, reason: 'SmartControl no respondio: ' + e.message }); continue; }

      const productos = scTryParse(raw.Productos) || [];
      const movimientos = scTryParse(raw.Movimientos) || [];
      const primerMov = Array.isArray(movimientos) && movimientos.length ? movimientos[movimientos.length - 1] : null; // el mas antiguo = creacion
      const fechaMov = primerMov && primerMov.FechaMovimiento ? new Date(primerMov.FechaMovimiento) : new Date();
      const destino = await scDeduceDestino(Array.isArray(productos) ? productos : []);

      const doc = await EscReg.create({
        palletId: pid,
        cantidad: parseInt(raw.CantidadTotal, 10) || 0,
        condicion: (raw.Condiciones || '').trim(),
        destino,
        turno: calcTurnoFromHour(fechaMov),
        escaneadora: (primerMov && primerMov.MovidoPor) || 'SmartControl',
        fecha: mexicoDateStr(fechaMov),
        observaciones: destino === 'Sin clasificar' ? 'Importado automaticamente desde SmartControl - revisar destino' : 'Importado automaticamente desde SmartControl',
        origen: 'smartcontrol-sync',
      });
      inserted.push({ id: doc._id, palletId: pid, destino });
    }
    res.json({ success: true, insertados: inserted.length, omitidos: skipped.length, inserted, skipped });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// ══════════════════════════════════════════════
// TODOS los pallets reales de la empresa, no solo los que se escanearon en
// esta app. Ni la API HTTP de SmartControl (appsc.mitechnologiesinc.com) ni
// /api/sc-pallet/diff-import (arriba) pueden listar "todos" — ambas
// necesitan que ya sepas el PalletID de antemano.
//
// Por decision explicita de Roman, esta app NUNCA guarda credenciales de la
// DB de la empresa (BinManagerRO) en su propio Vercel. En vez de conectarse
// directo a SQL Server (como Cubicaje si hace), este endpoint es un PROXY
// server-a-server hacia Cubicaje (mi2-apps/cubicaje), que ya tiene esa
// conexion y expone GET /api/integrations/live-pallets protegido con una
// llave compartida (header X-Integration-Key) — no con sesion de usuario,
// porque quien llama es este backend, no un navegador logueado.
//
// Requiere CUBICAJE_API_BASE_URL + CUBICAJE_INTEGRATION_KEY en las env vars
// de Vercel de ESTE proyecto (la llave, coordinada con Roman/IT, NO la
// contrasena real de la DB). Sin esas variables responde 503 claro.
// ══════════════════════════════════════════════
// Una sola pagina de "todos los pallets reales" contra Cubicaje — extraida para
// que tanto /api/sc-pallets/live COMO el agregado por bin de Dashboard Destinos
// FFT (mas abajo) llamen a la MISMA logica, en vez de reimplementar 2 veces el
// fetch/timeout/mapeo de campos hacia Cubicaje.
async function fetchCubicajeLivePalletsPage(limit, offset, search, timeoutMs = 20000) {
  const base = process.env.CUBICAJE_API_BASE_URL;
  const key = process.env.CUBICAJE_INTEGRATION_KEY;
  if (!base || !key) { const e = new Error('CUBICAJE_API_BASE_URL/CUBICAJE_INTEGRATION_KEY no configuradas para este proyecto'); e.status = 503; throw e; }
  const params = new URLSearchParams({ limit, offset });
  if (search) params.set('search', search);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let resp;
  try {
    resp = await fetch(`${base.replace(/\/$/, '')}/api/integrations/live-pallets?${params.toString()}`, {
      headers: { 'X-Integration-Key': key },
      signal: controller.signal,
    });
  } catch (e) {
    const msg = e.name === 'AbortError' ? 'Cubicaje no respondio a tiempo' : e.message;
    const err = new Error('No se pudo consultar Cubicaje: ' + msg);
    err.status = 502;
    throw err;
  } finally { clearTimeout(timeout); }
  const data = await resp.json();
  if (!resp.ok || !data.success) {
    const err = new Error(data.error || `Cubicaje respondio ${resp.status}`);
    err.status = resp.status === 401 ? 502 : resp.status;
    throw err;
  }
  return {
    data: (data.data || []).map((r) => ({ palletId: r.palletId, BinTypeID: r.binTypeId, binTypeName: r.binTypeName, cantidadTotal: r.cantidadTotal, skuCount: r.skuCount, locationName: r.locationName ?? null, ...resolverAreaDesdeInventario(r), raw: r })),
    total: data.total || 0,
  };
}

// Contenido REAL (SKUs+cantidad+condicion) de UN pallet directo de
// BinManagerRO por su BinCode — mismo proxy/llave que fetchCubicajeLivePalletsPage
// pero contra /api/integrations/paletizado/pallets/:code (auditoria 2026-08-07,
// Dashboard Destinos FFT: el modal de pallet solo tenia SKU/LPN via
// SmartControl, opcional y a veces vacio). Complementa data.productos, no lo
// reemplaza. Devuelve null en cualquier falla/config faltante — SIEMPRE
// opcional, el resto del detalle del pallet debe seguir mostrandose igual.
async function fetchCubicajePalletDetail(code, timeoutMs = 15000) {
  const base = process.env.CUBICAJE_API_BASE_URL;
  const key = process.env.CUBICAJE_INTEGRATION_KEY;
  if (!base || !key || !code) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`${base.replace(/\/$/, '')}/api/integrations/paletizado/pallets/${encodeURIComponent(code)}`, {
      headers: { 'X-Integration-Key': key },
      signal: controller.signal,
    });
    if (resp.status === 404) return null;
    const data = await resp.json();
    if (!resp.ok || !data.success) return null;
    return data.data; // { bin, content, movements }
  } catch (e) {
    return null;
  } finally { clearTimeout(timeout); }
}

// Catalogo de tipos de envio/destino (FBA, TRG, HV, FULL, BULK, BOX, UPT,
// CALVERY, NACIONAL, INTERNACIONAL) con su politica real (apilable, mezcla,
// inspeccion, documentos) — de la Postgres PROPIA de Cubicaje, no de
// BinManagerRO. Mismo proxy/llave que fetchCubicajePalletDetail. Auditoria
// 2026-08-07: pedido explicito de Roman de mostrar este catalogo en el
// Dashboard Destinos FFT, no solo el conteo operativo de EscReg.
async function fetchCubicajeShipmentTypes(timeoutMs = 15000) {
  const base = process.env.CUBICAJE_API_BASE_URL;
  const key = process.env.CUBICAJE_INTEGRATION_KEY;
  if (!base || !key) { const e = new Error('CUBICAJE_API_BASE_URL/CUBICAJE_INTEGRATION_KEY no configuradas para este proyecto'); e.status = 503; throw e; }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let resp;
  try {
    resp = await fetch(`${base.replace(/\/$/, '')}/api/integrations/paletizado/shipment-types`, {
      headers: { 'X-Integration-Key': key },
      signal: controller.signal,
    });
  } catch (e) {
    const msg = e.name === 'AbortError' ? 'Cubicaje no respondio a tiempo' : e.message;
    const err = new Error('No se pudo consultar Cubicaje: ' + msg);
    err.status = 502;
    throw err;
  } finally { clearTimeout(timeout); }
  const data = await resp.json();
  if (!resp.ok || !data.success) {
    const err = new Error(data.error || `Cubicaje respondio ${resp.status}`);
    err.status = resp.status === 401 ? 502 : resp.status;
    throw err;
  }
  return data.data;
}

app.get('/api/dashboard-destinos-fft/shipment-types', auth, roleGuard('admin'), centroOperativoGuard, async (req, res) => {
  try {
    const data = await fetchCubicajeShipmentTypes();
    res.json({ success: true, data });
  } catch (error) { res.status(error.status || 500).json({ success: false, error: error.message }); }
});

// Filas reales (BinCode/SKU/Qty de BinManagerRO) para UN codigo del catalogo
// — "Ver pallets" en las tarjetas de destino necesita el PalletID/BinCode
// REAL, nunca el PalletID que el escaneo (EscReg) le puso. Auditoria
// 2026-08-10, pedido explicito de Roman.
async function fetchCubicajeShipmentTypePallets(code, timeoutMs = 15000) {
  const base = process.env.CUBICAJE_API_BASE_URL;
  const key = process.env.CUBICAJE_INTEGRATION_KEY;
  if (!base || !key) { const e = new Error('CUBICAJE_API_BASE_URL/CUBICAJE_INTEGRATION_KEY no configuradas para este proyecto'); e.status = 503; throw e; }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let resp;
  try {
    resp = await fetch(`${base.replace(/\/$/, '')}/api/integrations/paletizado/shipment-types/${encodeURIComponent(code)}/pallets`, {
      headers: { 'X-Integration-Key': key },
      signal: controller.signal,
    });
  } catch (e) {
    const msg = e.name === 'AbortError' ? 'Cubicaje no respondio a tiempo' : e.message;
    const err = new Error('No se pudo consultar Cubicaje: ' + msg);
    err.status = 502;
    throw err;
  } finally { clearTimeout(timeout); }
  const data = await resp.json();
  if (!resp.ok || !data.success) {
    const err = new Error(data.error || `Cubicaje respondio ${resp.status}`);
    err.status = resp.status === 401 ? 502 : resp.status;
    throw err;
  }
  return data.pallets;
}

app.get('/api/dashboard-destinos-fft/shipment-types/:code/pallets', auth, roleGuard('admin'), centroOperativoGuard, async (req, res) => {
  try {
    const pallets = await fetchCubicajeShipmentTypePallets(req.params.code);
    res.json({ success: true, code: req.params.code, pallets });
  } catch (error) { res.status(error.status || 500).json({ success: false, error: error.message }); }
});

// Total real de inventario de TELEVISIONES (nunca insumos/consumibles) —
// pedido explicito de Roman de que "Pallets/Piezas totales" del Resumen
// solo cuenten TVs. Auditoria 2026-08-10.
async function fetchCubicajeTvInventoryTotal(timeoutMs = 15000) {
  const base = process.env.CUBICAJE_API_BASE_URL;
  const key = process.env.CUBICAJE_INTEGRATION_KEY;
  if (!base || !key) { const e = new Error('CUBICAJE_API_BASE_URL/CUBICAJE_INTEGRATION_KEY no configuradas para este proyecto'); e.status = 503; throw e; }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let resp;
  try {
    resp = await fetch(`${base.replace(/\/$/, '')}/api/integrations/paletizado/tv-inventory-total`, {
      headers: { 'X-Integration-Key': key },
      signal: controller.signal,
    });
  } catch (e) {
    const msg = e.name === 'AbortError' ? 'Cubicaje no respondio a tiempo' : e.message;
    const err = new Error('No se pudo consultar Cubicaje: ' + msg);
    err.status = 502;
    throw err;
  } finally { clearTimeout(timeout); }
  const data = await resp.json();
  if (!resp.ok || !data.success) {
    const err = new Error(data.error || `Cubicaje respondio ${resp.status}`);
    err.status = resp.status === 401 ? 502 : resp.status;
    throw err;
  }
  return data.total;
}

app.get('/api/dashboard-destinos-fft/tv-inventory-total', auth, roleGuard('admin'), centroOperativoGuard, async (req, res) => {
  try {
    const total = await fetchCubicajeTvInventoryTotal();
    res.json({ success: true, total });
  } catch (error) { res.status(error.status || 500).json({ success: false, error: error.message }); }
});

// "Operadores con movimientos" en Monterrey MAXX (COUNT DISTINCT MovementBy,
// BM.BinMovements) — KPI real para Centro de Control de Pallets, en vez de
// "usuarios activos por sesion" (no calculable, no hay tabla de sesiones).
async function fetchCubicajeMaxxOperatorActivity(windowHours = 48, timeoutMs = 15000) {
  const base = process.env.CUBICAJE_API_BASE_URL;
  const key = process.env.CUBICAJE_INTEGRATION_KEY;
  if (!base || !key) { const e = new Error('CUBICAJE_API_BASE_URL/CUBICAJE_INTEGRATION_KEY no configuradas para este proyecto'); e.status = 503; throw e; }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let resp;
  try {
    resp = await fetch(`${base.replace(/\/$/, '')}/api/integrations/paletizado/maxx/operator-activity?windowHours=${windowHours}`, {
      headers: { 'X-Integration-Key': key },
      signal: controller.signal,
    });
  } catch (e) {
    const msg = e.name === 'AbortError' ? 'Cubicaje no respondio a tiempo' : e.message;
    const err = new Error('No se pudo consultar Cubicaje: ' + msg);
    err.status = 502;
    throw err;
  } finally { clearTimeout(timeout); }
  const data = await resp.json();
  if (!resp.ok || !data.success) {
    const err = new Error(data.error || `Cubicaje respondio ${resp.status}`);
    err.status = resp.status === 401 ? 502 : resp.status;
    throw err;
  }
  return data.data;
}

app.get('/api/dashboard-destinos-fft/maxx/operator-activity', auth, roleGuard('admin'), centroOperativoGuard, async (req, res) => {
  try {
    const windowHours = Math.min(168, Math.max(1, parseInt(req.query.windowHours, 10) || 48));
    const data = await fetchCubicajeMaxxOperatorActivity(windowHours);
    res.json({ success: true, data });
  } catch (error) { res.status(error.status || 500).json({ success: false, error: error.message }); }
});

// Auditoria FISICA de Monterrey MAXX (BM.Audit) — deliberadamente separada
// de movimientos/pallets (pedido explicito de Roman: nunca mezclarlas en
// la misma seccion de la UI).
async function fetchCubicajeMaxxAudit(limit = 50, timeoutMs = 15000) {
  const base = process.env.CUBICAJE_API_BASE_URL;
  const key = process.env.CUBICAJE_INTEGRATION_KEY;
  if (!base || !key) { const e = new Error('CUBICAJE_API_BASE_URL/CUBICAJE_INTEGRATION_KEY no configuradas para este proyecto'); e.status = 503; throw e; }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let resp;
  try {
    resp = await fetch(`${base.replace(/\/$/, '')}/api/integrations/paletizado/maxx/audit?limit=${limit}`, {
      headers: { 'X-Integration-Key': key },
      signal: controller.signal,
    });
  } catch (e) {
    const msg = e.name === 'AbortError' ? 'Cubicaje no respondio a tiempo' : e.message;
    const err = new Error('No se pudo consultar Cubicaje: ' + msg);
    err.status = 502;
    throw err;
  } finally { clearTimeout(timeout); }
  const data = await resp.json();
  if (!resp.ok || !data.success) {
    const err = new Error(data.error || `Cubicaje respondio ${resp.status}`);
    err.status = resp.status === 401 ? 502 : resp.status;
    throw err;
  }
  return data.data;
}

app.get('/api/dashboard-destinos-fft/maxx/audit', auth, roleGuard('admin'), centroOperativoGuard, async (req, res) => {
  try {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const data = await fetchCubicajeMaxxAudit(limit);
    res.json({ success: true, data });
  } catch (error) { res.status(error.status || 500).json({ success: false, error: error.message }); }
});

// Pallets reales (un renglon por PalletID/pedido) de UN destino -- para el
// listado "click en un destino" del rediseño de Resumen (2026-08-11).
async function fetchCubicajeDestinoPallets(code, timeoutMs = 15000) {
  const base = process.env.CUBICAJE_API_BASE_URL;
  const key = process.env.CUBICAJE_INTEGRATION_KEY;
  if (!base || !key) { const e = new Error('CUBICAJE_API_BASE_URL/CUBICAJE_INTEGRATION_KEY no configuradas para este proyecto'); e.status = 503; throw e; }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let resp;
  try {
    resp = await fetch(`${base.replace(/\/$/, '')}/api/integrations/paletizado/destinos/${encodeURIComponent(code)}/pallets`, {
      headers: { 'X-Integration-Key': key },
      signal: controller.signal,
    });
  } catch (e) {
    const msg = e.name === 'AbortError' ? 'Cubicaje no respondio a tiempo' : e.message;
    const err = new Error('No se pudo consultar Cubicaje: ' + msg);
    err.status = 502;
    throw err;
  } finally { clearTimeout(timeout); }
  const data = await resp.json();
  if (!resp.ok || !data.success) {
    const err = new Error(data.error || `Cubicaje respondio ${resp.status}`);
    err.status = resp.status === 401 ? 502 : resp.status;
    throw err;
  }
  return { unidad: data.unidad, data: data.data };
}

app.get('/api/dashboard-destinos-fft/destinos/:code/pallets', auth, roleGuard('admin'), centroOperativoGuard, async (req, res) => {
  try {
    const code = String(req.params.code || '').trim();
    if (!code) return res.status(400).json({ success: false, error: 'code invalido' });
    const { unidad, data } = await fetchCubicajeDestinoPallets(code);
    res.json({ success: true, unidad, data, total: data.length });
  } catch (error) { res.status(error.status || 500).json({ success: false, error: error.message }); }
});

// Pallets sin movimiento confirmado hacia su bin actual, >= minHours.
async function fetchCubicajeMaxxPalletsSinMovimiento(minHours, timeoutMs = 15000) {
  const base = process.env.CUBICAJE_API_BASE_URL;
  const key = process.env.CUBICAJE_INTEGRATION_KEY;
  if (!base || !key) { const e = new Error('CUBICAJE_API_BASE_URL/CUBICAJE_INTEGRATION_KEY no configuradas para este proyecto'); e.status = 503; throw e; }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let resp;
  try {
    resp = await fetch(`${base.replace(/\/$/, '')}/api/integrations/paletizado/maxx/pallets-sin-movimiento?minHours=${minHours}`, {
      headers: { 'X-Integration-Key': key },
      signal: controller.signal,
    });
  } catch (e) {
    const msg = e.name === 'AbortError' ? 'Cubicaje no respondio a tiempo' : e.message;
    const err = new Error('No se pudo consultar Cubicaje: ' + msg);
    err.status = 502;
    throw err;
  } finally { clearTimeout(timeout); }
  const data = await resp.json();
  if (!resp.ok || !data.success) {
    const err = new Error(data.error || `Cubicaje respondio ${resp.status}`);
    err.status = resp.status === 401 ? 502 : resp.status;
    throw err;
  }
  return data.data;
}

app.get('/api/dashboard-destinos-fft/maxx/pallets-sin-movimiento', auth, roleGuard('admin'), centroOperativoGuard, async (req, res) => {
  try {
    const minHours = Math.min(720, Math.max(0, parseInt(req.query.minHours, 10) || 2));
    const data = await fetchCubicajeMaxxPalletsSinMovimiento(minHours);
    res.json({ success: true, data, total: data.length });
  } catch (error) { res.status(error.status || 500).json({ success: false, error: error.message }); }
});

// Actividad reciente real (BM.BinMovements, MAXX) -- NUNCA BM.Audit.
async function fetchCubicajeMaxxActividadReciente(limit = 50, timeoutMs = 15000) {
  const base = process.env.CUBICAJE_API_BASE_URL;
  const key = process.env.CUBICAJE_INTEGRATION_KEY;
  if (!base || !key) { const e = new Error('CUBICAJE_API_BASE_URL/CUBICAJE_INTEGRATION_KEY no configuradas para este proyecto'); e.status = 503; throw e; }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let resp;
  try {
    resp = await fetch(`${base.replace(/\/$/, '')}/api/integrations/paletizado/maxx/actividad-reciente?limit=${limit}`, {
      headers: { 'X-Integration-Key': key },
      signal: controller.signal,
    });
  } catch (e) {
    const msg = e.name === 'AbortError' ? 'Cubicaje no respondio a tiempo' : e.message;
    const err = new Error('No se pudo consultar Cubicaje: ' + msg);
    err.status = 502;
    throw err;
  } finally { clearTimeout(timeout); }
  const data = await resp.json();
  if (!resp.ok || !data.success) {
    const err = new Error(data.error || `Cubicaje respondio ${resp.status}`);
    err.status = resp.status === 401 ? 502 : resp.status;
    throw err;
  }
  return data.data;
}

app.get('/api/dashboard-destinos-fft/maxx/actividad-reciente', auth, roleGuard('admin'), centroOperativoGuard, async (req, res) => {
  try {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const data = await fetchCubicajeMaxxActividadReciente(limit);
    res.json({ success: true, data, total: data.length });
  } catch (error) { res.status(error.status || 500).json({ success: false, error: error.message }); }
});

// Resumen real de UNA area fisica confirmada (TRG/FBA/FULL/UPT) -- las
// cards grandes del Centro de Control de Pallets. Mismo proxy/llave que
// fetchCubicajeMaxxAudit.
async function fetchCubicajeMaxxAreaSummary(area, timeoutMs = 15000) {
  const base = process.env.CUBICAJE_API_BASE_URL;
  const key = process.env.CUBICAJE_INTEGRATION_KEY;
  if (!base || !key) { const e = new Error('CUBICAJE_API_BASE_URL/CUBICAJE_INTEGRATION_KEY no configuradas para este proyecto'); e.status = 503; throw e; }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let resp;
  try {
    resp = await fetch(`${base.replace(/\/$/, '')}/api/integrations/paletizado/maxx/areas/${encodeURIComponent(area)}`, {
      headers: { 'X-Integration-Key': key },
      signal: controller.signal,
    });
  } catch (e) {
    const msg = e.name === 'AbortError' ? 'Cubicaje no respondio a tiempo' : e.message;
    const err = new Error('No se pudo consultar Cubicaje: ' + msg);
    err.status = 502;
    throw err;
  } finally { clearTimeout(timeout); }
  const data = await resp.json();
  if (!resp.ok || !data.success) {
    const err = new Error(data.error || `Cubicaje respondio ${resp.status}`);
    err.status = resp.status === 401 ? 502 : resp.status;
    throw err;
  }
  return data.data;
}

app.get('/api/dashboard-destinos-fft/maxx/areas/:area', auth, roleGuard('admin'), centroOperativoGuard, async (req, res) => {
  try {
    const area = String(req.params.area || '').trim();
    if (!area) return res.status(400).json({ success: false, error: 'area invalida' });
    const data = await fetchCubicajeMaxxAreaSummary(area);
    res.json({ success: true, data });
  } catch (error) { res.status(error.status || 500).json({ success: false, error: error.message }); }
});

// Grid real de bins de UNA area fisica confirmada. includeEmpty=1 es el
// modo "Ver bins vacios" -- NO es el default (ver nota en getMaxxAreaBins
// del lado de Cubicaje sobre por que es mucho mas caro).
async function fetchCubicajeMaxxAreaBins(area, includeEmpty, timeoutMs = 15000) {
  const base = process.env.CUBICAJE_API_BASE_URL;
  const key = process.env.CUBICAJE_INTEGRATION_KEY;
  if (!base || !key) { const e = new Error('CUBICAJE_API_BASE_URL/CUBICAJE_INTEGRATION_KEY no configuradas para este proyecto'); e.status = 503; throw e; }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let resp;
  try {
    resp = await fetch(`${base.replace(/\/$/, '')}/api/integrations/paletizado/maxx/areas/${encodeURIComponent(area)}/bins${includeEmpty ? '?includeEmpty=1' : ''}`, {
      headers: { 'X-Integration-Key': key },
      signal: controller.signal,
    });
  } catch (e) {
    const msg = e.name === 'AbortError' ? 'Cubicaje no respondio a tiempo' : e.message;
    const err = new Error('No se pudo consultar Cubicaje: ' + msg);
    err.status = 502;
    throw err;
  } finally { clearTimeout(timeout); }
  const data = await resp.json();
  if (!resp.ok || !data.success) {
    const err = new Error(data.error || `Cubicaje respondio ${resp.status}`);
    err.status = resp.status === 401 ? 502 : resp.status;
    throw err;
  }
  return data.data;
}

app.get('/api/dashboard-destinos-fft/maxx/areas/:area/bins', auth, roleGuard('admin'), centroOperativoGuard, async (req, res) => {
  try {
    const area = String(req.params.area || '').trim();
    if (!area) return res.status(400).json({ success: false, error: 'area invalida' });
    const includeEmpty = req.query.includeEmpty === '1' || req.query.includeEmpty === 'true';
    const data = await fetchCubicajeMaxxAreaBins(area, includeEmpty);
    res.json({ success: true, data, total: data.length });
  } catch (error) { res.status(error.status || 500).json({ success: false, error: error.message }); }
});

// "UBICACIONES / BINES" (fondo del Resumen, 2026-08-11): combina las 4
// areas fisicas confirmadas (TRG/FBA_FULL/UPT/FFT) en una sola tabla. Por
// default (sinVacios=true, el default de la UI) cada area ya viene sin
// bins vacios -- mas barato y es lo que pide el nuevo diseño. FFT agregada
// 2026-08-11 (WorkStationID=49 + texto "FFT", ~3,079 pallets reales -- la
// mas grande de las 4; el frontend pagina esta tabla justo por esto).
const MAXX_AREAS_CONFIRMADAS = ['TRG', 'FBA_FULL', 'UPT', 'FFT'];
app.get('/api/dashboard-destinos-fft/maxx/ubicaciones', auth, roleGuard('admin'), centroOperativoGuard, async (req, res) => {
  try {
    const includeEmpty = req.query.includeEmpty === '1' || req.query.includeEmpty === 'true';
    const porArea = await Promise.all(MAXX_AREAS_CONFIRMADAS.map((a) => fetchCubicajeMaxxAreaBins(a, includeEmpty).then((data) => data.map((b) => ({ ...b, areaFisica: a }))).catch(() => [])));
    const data = porArea.flat();
    res.json({ success: true, data, total: data.length });
  } catch (error) { res.status(error.status || 500).json({ success: false, error: error.message }); }
});

app.get('/api/sc-pallets/live', auth, roleGuard('admin'), async (req, res) => {
  if (req.user.usuario !== '3647') return res.status(403).json({ success: false, error: 'Solo admin 3647' });
  try {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 100));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const search = (req.query.search || '').trim();
    const { data, total } = await fetchCubicajeLivePalletsPage(limit, offset, search);
    res.json({ success: true, data: data.map(({ raw, ...rest }) => rest), total, limit, offset });
  } catch (error) {
    res.status(error.status || 502).json({ success: false, error: error.message });
  }
});

// ── AREA: BinManagerRO/Cubicaje (ver /api/integrations/live-pallets) no expone
// hoy un campo explicito de warehouse/zona/sitio superior al bin — solo
// binTypeId/binTypeName (categoria de inventario) y locationName (el bin). Se
// busca primero cualquier campo real candidato (por si Cubicaje algun dia
// empieza a mandarlo); si NINGUNO existe, se documenta la decision explicita
// permitida por Roman: el bin se muestra como su propia area (fallback, nunca
// una area inventada). `areaFuente` siempre indica cual de los 2 casos aplico.
const FFT_AREA_CAMPOS_CANDIDATOS = ['warehouseName', 'siteName', 'zoneName', 'area', 'areaName', 'locationGroupName', 'parentLocationName', 'department', 'facility', 'warehouse', 'site', 'zone'];
function resolverAreaDesdeInventario(r) {
  for (const campo of FFT_AREA_CAMPOS_CANDIDATOS) {
    const v = r[campo];
    if (v !== undefined && v !== null && String(v).trim()) {
      return { area: String(v).trim(), areaFuente: `campo real: ${campo}` };
    }
  }
  return {
    area: r.locationName ? String(r.locationName).trim() : 'Sin área',
    areaFuente: 'fallback documentado: BinManagerRO/Cubicaje no expone warehouse/zona/sitio en este endpoint — se usa el bin como su propia área',
  };
}

// Cache corta en memoria (por instancia serverless tibia) del inventario
// COMPLETO — varios endpoints de Dashboard Destinos FFT (resumen/areas/bines/
// pallets/detalle) leen el mismo inventario dentro de la misma ventana de
// pocos segundos; sin esta cache cada uno repetiria 100+ llamadas a Cubicaje.
let fftInventarioCache = { data: null, total: 0, agotado: false, timestamp: 0 };
const FFT_INVENTARIO_CACHE_TTL_MS = 60000;

// Trae el inventario REAL COMPLETO desde Cubicaje (no una muestra) paginando
// EN PARALELO (pageSize=200, el maximo que acepta Cubicaje) para que 30,000+
// pallets no tarden minutos. `maxPallets` es un tope de SEGURIDAD muy por
// encima del inventario real conocido (evita un runaway si crece muchisimo),
// no un limite de muestreo — en el caso normal se trae TODO. Si el tiempo
// total excede el presupuesto (proteccion contra timeout serverless), se
// regresa lo ya obtenido con `agotado:true` en vez de fallar sin datos.
// `presupuestoMs`: Cubicaje resulto ser lento (una sola pagina de 200 puede
// tardar >12s), asi que este presupuesto es CONFIGURABLE — corto (8s) para el
// path interactivo (por si algun caller todavia lo usa en vivo), largo (40s)
// para el sync de cron/manual, que si tiene margen de ejecucion.
async function fetchCubicajeLivePalletsAll(maxPallets = 60000, forzar = false, presupuestoMs = 8000) {
  const ahora = Date.now();
  if (!forzar && fftInventarioCache.data && (ahora - fftInventarioCache.timestamp) < FFT_INVENTARIO_CACHE_TTL_MS) {
    return fftInventarioCache;
  }
  const pageSize = 200;
  const CONCURRENCIA = 10;
  const inicio = Date.now();

  const { data: primera, total } = await fetchCubicajeLivePalletsPage(pageSize, 0);
  const acumulado = [...primera];
  const totalAFetch = Math.min(total, maxPallets);
  const offsets = [];
  for (let off = pageSize; off < totalAFetch; off += pageSize) offsets.push(off);

  let agotadoPorTiempo = false;
  let idx = 0;
  async function worker() {
    while (idx < offsets.length) {
      if (Date.now() - inicio > presupuestoMs) { agotadoPorTiempo = true; return; }
      const miOffset = offsets[idx++];
      try {
        const { data } = await fetchCubicajeLivePalletsPage(pageSize, miOffset);
        acumulado.push(...data);
      } catch (e) { agotadoPorTiempo = true; return; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCIA, offsets.length) }, worker));

  const resultado = {
    data: acumulado,
    total,
    agotado: agotadoPorTiempo || acumulado.length < totalAFetch || total > maxPallets,
    timestamp: Date.now(),
  };
  fftInventarioCache = resultado;
  return resultado;
}

// Trae el inventario COMPLETO en vivo de Cubicaje (presupuesto largo, pensado
// para cron/accion manual, NO para un request interactivo de usuario) y lo
// vuelca al cache local en Mongo (CubicajeInventario) — upsert por palletId +
// borra los que ya no aparecen en el inventario actual (salieron del almacen).
// UNICO lugar donde se escribe ese cache.
async function sincronizarInventarioCubicaje() {
  const { data, total, agotado } = await fetchCubicajeLivePalletsAll(60000, true, 40000);
  if (data.length) {
    const ops = data.map((p) => ({
      updateOne: {
        filter: { palletId: p.palletId },
        update: { $set: { binTypeId: p.BinTypeID, binTypeName: p.binTypeName, cantidadTotal: p.cantidadTotal, skuCount: p.skuCount, locationName: p.locationName, area: p.area, areaFuente: p.areaFuente, raw: p.raw } },
        upsert: true,
      },
    }));
    await CubicajeInventario.bulkWrite(ops, { ordered: false });
  }
  const idsActuales = data.map((p) => p.palletId).filter(Boolean);
  await CubicajeInventario.deleteMany({ palletId: { $nin: idsActuales } });
  await CubicajeSyncMeta.findByIdAndUpdate(
    'singleton',
    { ultimaSincronizacion: new Date(), totalReal: total, totalGuardado: data.length, agotado, error: '' },
    { upsert: true },
  );
  return { totalReal: total, totalGuardado: data.length, agotado };
}

// Lee el inventario YA CACHEADO en Mongo (rapido) en el shape que espera el
// resto del modulo Dashboard Destinos FFT (mismo shape que fetchCubicajeLivePalletsAll).
// EXCLUYE `raw` a proposito (projection -raw): las vistas agregadas
// (Areas/Bines/Destinos/Actividad) no lo necesitan, y traer el objeto crudo
// completo de Cubicaje para los ~30,000 pallets en cada carga era el cuello
// de botella real (mucho trafico innecesario Mongo -> funcion serverless).
// El detalle de UN pallet especifico pide su `raw` aparte, con
// leerRawInventarioDePallet() (una sola fila, barato).
async function leerInventarioCubicajeCacheado() {
  const [docs, meta] = await Promise.all([
    CubicajeInventario.find({}).select('-raw').lean(),
    CubicajeSyncMeta.findById('singleton').lean(),
  ]);
  const pallets = docs.map((d) => ({ palletId: d.palletId, BinTypeID: d.binTypeId, binTypeName: d.binTypeName, cantidadTotal: d.cantidadTotal, skuCount: d.skuCount, locationName: d.locationName, area: d.area, areaFuente: d.areaFuente }));
  return {
    pallets,
    totalReal: meta ? meta.totalReal : pallets.length,
    agotado: meta ? meta.agotado : false,
    ultimaSincronizacion: meta ? meta.ultimaSincronizacion : null,
    nuncaSincronizado: !meta,
  };
}

// Trae el `raw` (respuesta original de Cubicaje) de UN SOLO pallet — usado
// unicamente por el detalle de pallet (pestaña "Datos originales").
async function leerRawInventarioDePallet(palletIdOriginal) {
  if (!palletIdOriginal) return null;
  const doc = await CubicajeInventario.findOne({ palletId: palletIdOriginal }).select('raw').lean();
  return doc ? doc.raw : null;
}

// ══════════════════════════════════════════════
// KPIs de "Todos los pallets reales": conteo por categoria (BinTypeID) sobre
// el TOTAL real en BinManagerRO (no solo la pagina actual). Mismo patron de
// proxy que /api/sc-pallets/live — llama a Cubicaje via GET
// /api/integrations/live-pallets-stats con la misma llave compartida.
// ══════════════════════════════════════════════
app.get('/api/sc-pallets/live-stats', auth, roleGuard('admin'), async (req, res) => {
  if (req.user.usuario !== '3647') return res.status(403).json({ success: false, error: 'Solo admin 3647' });
  const base = process.env.CUBICAJE_API_BASE_URL;
  const key = process.env.CUBICAJE_INTEGRATION_KEY;
  if (!base || !key) return res.status(503).json({ success: false, error: 'CUBICAJE_API_BASE_URL/CUBICAJE_INTEGRATION_KEY no configuradas para este proyecto' });
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    let resp;
    try {
      resp = await fetch(`${base.replace(/\/$/, '')}/api/integrations/live-pallets-stats`, {
        headers: { 'X-Integration-Key': key },
        signal: controller.signal,
      });
    } finally { clearTimeout(timeout); }
    const data = await resp.json();
    if (!resp.ok || !data.success) return res.status(resp.status === 401 ? 502 : resp.status).json({ success: false, error: data.error || `Cubicaje respondio ${resp.status}` });
    res.json({ success: true, data: data.data || [] });
  } catch (error) {
    const msg = error.name === 'AbortError' ? 'Cubicaje no respondio a tiempo' : error.message;
    res.status(502).json({ success: false, error: 'No se pudo consultar Cubicaje: ' + msg });
  }
});

// ══════════════════════════════════════════════
// LPN DUPLICADOS: mismo LPN (numero de serie) registrado como presente en
// mas de un area/bin a la vez en BinManagerRO (bug de integridad de
// inventario, o algo peor). Pedido explicito de Roman (2026-07-28): seguir
// el LPN por todas partes y avisarle a el (admin 3647) en que area estaba,
// donde se duplico, y quien fue la persona, con tiempo para reaccionar.
//
// Este proyecto es una funcion serverless de Vercel (sin proceso en
// segundo plano posible) — por eso el "check" no corre en un cron propio
// de este repo, sino que lo dispara CUALQUIER cliente logueado con la app
// abierta (index.html llama a este endpoint cada pocos minutos via
// timer). Barato: solo golpea a Cubicaje (que ya tiene la conexion real a
// BinManagerRO) y hace un puñado de upserts en Mongo. La notificacion en
// vivo (Pusher) y la lista solo son visibles para 3647.
//
// Gotcha de lag (confirmado 2026-07-28 con un caso real de Roman):
// BinManagerRO (de donde viene Cubicaje) sincroniza ~1x/dia — un LPN
// candidato puede llevar horas resuelto sin que la vista de Cubicaje se
// entere. Por eso ANTES de avisar a 3647 se hace una verificacion en vivo
// contra la API de SmartControl (appsc.mitechnologiesinc.com, sin ese
// retraso) via liveVerifyDuplicate() — solo se notifica si el LPN sigue
// realmente presente en mas de un pallet AHORITA MISMO.
// ══════════════════════════════════════════════

// Dado un doc de LpnDuplicate (candidato de BinManagerRO, posiblemente con
// horas de retraso), confirma en vivo contra SmartControl si el LPN sigue
// presente en mas de uno de los pallets candidatos. Cap defensivo de 6
// pallets (fisico normalmente trae 2; transferencia trae origen+destino
// de cada evento, tipicamente 2 tambien) para no encadenar demasiadas
// llamadas HTTP externas por candidato.
async function liveVerifyDuplicate(doc) {
  const candidatos = doc.tipo === 'transferencia'
    ? [...new Set((doc.events || []).flatMap(e => [e.fromBinCode, e.toBinCode]).filter(Boolean))]
    : [...new Set((doc.locations || []).map(l => l.binCode).filter(Boolean))];
  // En paralelo (antes era secuencial) — necesario para poder re-verificar
  // en vivo lotes de LPN ya pendientes (no solo los nuevos) dentro del
  // tiempo limite de una funcion serverless de Vercel; con 6 candidatos
  // secuenciales y 9s de timeout cada uno, un solo LPN podia tardar
  // hasta 54s antes de este cambio.
  const checks = await Promise.all(candidatos.slice(0, 6).map(async (palletId) => {
    try {
      const live = await fetchScPalletLive(palletId);
      const presente = (live.productos || []).some(p => p.NumeroSerie === doc.serialNumber);
      return { palletId, presente, cantidadTotal: live.cantidadTotal, ubicacion: live.ubicacion, workcenter: live.workcenter, condiciones: live.condiciones };
    } catch (e) {
      return { palletId, error: e.message || 'Error al consultar SmartControl' };
    }
  }));
  const duplicadoEnVivo = checks.filter(c => c.presente).length > 1;
  return { checks, duplicadoEnVivo };
}

// Aplica el resultado de liveVerifyDuplicate a un doc: si SmartControl (en
// vivo, sin el retraso de BinManagerRO) confirma que el LPN YA NO esta en
// mas de un lugar, se marca resuelto de una vez en lugar de esperar a que
// BinManagerRO se ponga al dia (~1 dia, ver [[project_cubicaje_binmanagerro_lag]]).
// Devuelve true si el doc quedo resuelto en esta pasada.
// Nunca debe lanzar — se corre en lote dentro de Promise.all en /check, y un
// solo doc con problemas (SmartControl lento, conflicto de guardado en Mongo)
// no debe tumbar todo el ciclo con un 502 enganoso ("no se pudo consultar
// Cubicaje" cuando el problema real era otra cosa).
async function applyLiveVerification(doc, now) {
  let liveDuplicado = null;
  try {
    const { duplicadoEnVivo } = await liveVerifyDuplicate(doc);
    liveDuplicado = duplicadoEnVivo;
    doc.liveDuplicado = liveDuplicado;
    doc.liveCheckedAt = now;
    if (liveDuplicado === false && !doc.resuelto) {
      doc.resuelto = true;
      doc.resueltoPor = 'sistema (verificado en vivo contra SmartControl)';
      doc.resueltoFecha = now;
    }
    await doc.save();
  } catch (e) {
    console.error('applyLiveVerification fallo para', doc?.serialNumber, e?.message);
  }
  return liveDuplicado;
}

app.post('/api/lpn-duplicates/check', auth, async (req, res) => {
  const base = process.env.CUBICAJE_API_BASE_URL;
  const key = process.env.CUBICAJE_INTEGRATION_KEY;
  if (!base || !key) return res.status(503).json({ success: false, error: 'CUBICAJE_API_BASE_URL/CUBICAJE_INTEGRATION_KEY no configuradas para este proyecto' });
  const t0 = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    let resp;
    try {
      resp = await fetch(`${base.replace(/\/$/, '')}/api/integrations/lpn-duplicates`, {
        headers: { 'X-Integration-Key': key },
        signal: controller.signal,
      });
    } finally { clearTimeout(timeout); }
    const data = await resp.json();
    if (!resp.ok || !data.success) return res.status(resp.status === 401 ? 502 : resp.status).json({ success: false, error: data.error || `Cubicaje respondio ${resp.status}` });

    const fresh = data.data || [];
    // Clave compuesta: un mismo LPN puede tener a la vez un duplicado 'fisico'
    // Y uno de 'transferencia' — son fallas distintas, se rastrean por separado.
    const freshKeys = new Set(fresh.map(g => `${g.serialNumber}|${g.tipo || 'fisico'}`));
    const nuevos = [];
    const now = new Date();

    // En paralelo (antes era secuencial: un findOne + un findOneAndUpdate por
    // item, uno tras otro) — con `fresh` teniendo decenas de items (~59+
    // confirmados en produccion), esa secuencia de ~2x round-trips a Mongo
    // por item era lenta de sobra para acercarse al limite de tiempo de la
    // funcion serverless, incluso antes de llegar a la verificacion en vivo.
    // Cada item es independiente (clave unica serialNumber+tipo), asi que
    // correrlos concurrentes no cambia el resultado, solo el tiempo total.
    const procesados = await Promise.all(fresh.map(async (g) => {
      const tipo = g.tipo === 'transferencia' ? 'transferencia' : 'fisico';
      const existing = await LpnDuplicate.findOne({ serialNumber: g.serialNumber, tipo });
      const esNuevoOReaparecio = !existing || existing.resuelto;
      const locations = (g.locations || []).map(l => ({
        binId: l.binId, binCode: l.binCode, locationId: l.locationId,
        locationName: l.locationName, warehouseName: l.warehouseName,
        lastMovedBy: l.lastMovedBy, lastMovedDate: l.lastMovedDate ? new Date(l.lastMovedDate) : null,
      }));
      const events = (g.events || []).map(e => ({
        containerMovementId: e.containerMovementId, movementDate: e.movementDate ? new Date(e.movementDate) : null,
        fromBinCode: e.fromBinCode, toBinCode: e.toBinCode,
        fromLocationName: e.fromLocationName, toLocationName: e.toLocationName, movementBy: e.movementBy,
      }));
      const doc = await LpnDuplicate.findOneAndUpdate(
        { serialNumber: g.serialNumber, tipo },
        {
          $set: {
            productSku: g.productSku || '',
            locations,
            events,
            lastSeenAt: now,
            resuelto: false,
            ...(esNuevoOReaparecio ? { firstSeenAt: now } : {}),
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
      return { doc, esNuevoOReaparecio };
    }));
    for (const p of procesados) { if (p.esNuevoOReaparecio) nuevos.push(p.doc); }

    // Auto-resolver los que Cubicaje ya no reporta como duplicados (se corrigieron)
    const pendientes = await LpnDuplicate.find({ resuelto: false }).select('serialNumber tipo');
    const aResolver = pendientes.filter(p => !freshKeys.has(`${p.serialNumber}|${p.tipo}`)).map(p => p._id);
    if (aResolver.length > 0) {
      await LpnDuplicate.updateMany(
        { _id: { $in: aResolver } },
        { $set: { resuelto: true, resueltoPor: 'sistema (ya no duplicado)', resueltoFecha: now } },
      );
    }

    // Re-verificacion en vivo de un lote acotado de LPN YA pendientes (no
    // nuevos en este ciclo). Sin esto, un LPN que ya se corrigio en la
    // realidad se quedaba "pendiente" para siempre: `fresh` viene de
    // BinManagerRO via Cubicaje, que tarda ~1 dia en reflejar la correccion
    // (ver [[project_cubicaje_binmanagerro_lag]]), y antes de este cambio
    // solo se re-verificaba en vivo a los recien detectados, nunca a los
    // que ya llevaban rato en la lista. Se prioriza a los que tienen la
    // verificacion en vivo mas vieja (o nula) y se acota a 4 por ciclo para
    // no exceder el tiempo limite de una funcion serverless de Vercel — con
    // 59 pendientes, cubre todo el rezago en varios ciclos de 5 min.
    const nuevosIds = nuevos.map(d => d._id);
    const rezagados = await LpnDuplicate.find({ resuelto: false, _id: { $nin: nuevosIds } })
      .sort({ liveCheckedAt: 1 })
      .limit(4);

    // Verificacion en vivo (SmartControl, sin el retraso de BinManagerRO)
    // antes de notificar — BinManagerRO puede tardar horas en reflejar que
    // algo ya se corrigio, y no queremos avisarle a 3647 de un problema
    // que ya no existe. applyLiveVerification ademas auto-resuelve el doc
    // si SmartControl confirma que ya no esta duplicado. Nuevos y rezagados
    // se verifican EN UNA SOLA TANDA CONCURRENTE (no una tras otra) para no
    // duplicar el tiempo de espera total dentro del limite de la funcion.
    const [nuevosLive] = await Promise.all([
      Promise.all(nuevos.map(doc => applyLiveVerification(doc, now))),
      Promise.all(rezagados.map(doc => applyLiveVerification(doc, now))),
    ]);
    const confirmadosEnVivo = nuevos.filter((_doc, i) => nuevosLive[i] !== false);

    if (confirmadosEnVivo.length > 0) {
      emitEvent('paletizado', 'lpn:duplicado', {
        count: confirmadosEnVivo.length,
        items: confirmadosEnVivo.slice(0, 10).map(d => ({ serialNumber: d.serialNumber, productSku: d.productSku, tipo: d.tipo })),
      });
    }
    const totalPendientes = await LpnDuplicate.countDocuments({ resuelto: false });
    console.log(`lpn-duplicates/check OK en ${Date.now() - t0}ms — fresh:${fresh.length} nuevos:${nuevos.length} rezagados:${rezagados.length} pendientes:${totalPendientes}`);
    res.json({ success: true, nuevos: nuevos.length, confirmadosEnVivo: confirmadosEnVivo.length, reverificados: rezagados.length, totalPendientes });
  } catch (error) {
    const msg = error.name === 'AbortError' ? 'Cubicaje no respondio a tiempo' : error.message;
    console.error(`lpn-duplicates/check FALLO en ${Date.now() - t0}ms:`, error);
    res.status(502).json({ success: false, error: 'No se pudo consultar Cubicaje: ' + msg });
  }
});

app.get('/api/lpn-duplicates', auth, roleGuard('admin'), async (req, res) => {
  if (req.user.usuario !== '3647') return res.status(403).json({ success: false, error: 'Solo admin 3647' });
  try {
    const filter = {};
    if (req.query.resuelto === 'false') filter.resuelto = false;
    if (req.query.resuelto === 'true') filter.resuelto = true;
    const docs = await LpnDuplicate.find(filter).sort({ resuelto: 1, liveDuplicado: -1, firstSeenAt: -1 }).limit(300);
    const totalPendientes = await LpnDuplicate.countDocuments({ resuelto: false });
    res.json({ success: true, data: docs, total: docs.length, totalPendientes });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.post('/api/lpn-duplicates/:id/resolver', auth, roleGuard('admin'), async (req, res) => {
  if (req.user.usuario !== '3647') return res.status(403).json({ success: false, error: 'Solo admin 3647' });
  try {
    const doc = await LpnDuplicate.findByIdAndUpdate(
      req.params.id,
      { $set: { resuelto: true, resueltoPor: req.user.nombre || req.user.usuario, resueltoFecha: new Date() } },
      { new: true },
    );
    if (!doc) return res.status(404).json({ success: false, error: 'No encontrado' });
    const totalPendientes = await LpnDuplicate.countDocuments({ resuelto: false });
    emitEvent('paletizado', 'lpn:resuelto', { serialNumber: doc.serialNumber, totalPendientes });
    res.json({ success: true, data: doc, totalPendientes });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// "Mapa completo" de un LPN (2026-07-28, pedido explicito de Roman): linea
// de tiempo area por area (via Cubicaje, historico BinManagerRO) + estado
// actual y confirmacion en vivo (via SmartControl, sin el retraso) + a que
// pedido de venta va de salida.
app.get('/api/lpn-duplicates/:id/mapa', auth, roleGuard('admin'), async (req, res) => {
  if (req.user.usuario !== '3647') return res.status(403).json({ success: false, error: 'Solo admin 3647' });
  try {
    const doc = await LpnDuplicate.findById(req.params.id);
    if (!doc) return res.status(404).json({ success: false, error: 'No encontrado' });

    const base = process.env.CUBICAJE_API_BASE_URL;
    const key = process.env.CUBICAJE_INTEGRATION_KEY;
    let timeline = [], salesOrder = null, currentLocation = null, timelineError = null;
    if (!base || !key) {
      timelineError = 'CUBICAJE_API_BASE_URL/CUBICAJE_INTEGRATION_KEY no configuradas';
    } else {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        let resp;
        try {
          resp = await fetch(`${base.replace(/\/$/, '')}/api/integrations/lpn-timeline/${encodeURIComponent(doc.serialNumber)}`, {
            headers: { 'X-Integration-Key': key },
            signal: controller.signal,
          });
        } finally { clearTimeout(timeout); }
        const data = await resp.json();
        if (resp.ok && data.success) {
          timeline = data.data.timeline || [];
          salesOrder = data.data.salesOrder;
          currentLocation = data.data.currentLocation;
        } else {
          timelineError = data.error || `Cubicaje respondio ${resp.status}`;
        }
      } catch (e) {
        timelineError = e.name === 'AbortError' ? 'Cubicaje no respondio a tiempo' : e.message;
      }
    }

    const { checks, duplicadoEnVivo } = await liveVerifyDuplicate(doc);
    const now = new Date();
    doc.liveDuplicado = duplicadoEnVivo;
    doc.liveCheckedAt = now;
    if (duplicadoEnVivo === false && !doc.resuelto) {
      doc.resuelto = true;
      doc.resueltoPor = 'sistema (verificado en vivo contra SmartControl)';
      doc.resueltoFecha = now;
    }
    await doc.save();

    res.json({
      success: true,
      data: {
        serialNumber: doc.serialNumber,
        tipo: doc.tipo,
        productSku: doc.productSku,
        timeline,
        timelineError,
        salesOrder,
        currentLocation,
        liveChecks: checks,
        duplicadoEnVivo,
        resuelto: doc.resuelto,
        resueltoPor: doc.resueltoPor,
      },
    });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// ── UPDATE pallet (admin only, with audit) ──
app.put('/api/escaneadoras/:id', auth, roleGuard('admin'), async (req, res) => {
  try {
    const doc = await EscReg.findById(req.params.id);
    if (!doc) return res.status(404).json({ success: false, error: 'No encontrado' });
    const oldData = doc.toObject();
    const allowed = ['palletId','cantidad','condicion','destino','turno','escaneadora','fecha','pedido','fechaSalida','incidencias','observaciones'];
    const changes = [];
    allowed.forEach(f => {
      if (req.body[f] !== undefined && String(req.body[f]) !== String(oldData[f])) {
        changes.push({ field: f, oldValue: String(oldData[f]), newValue: String(req.body[f]) });
        doc[f] = f === 'cantidad' ? parseInt(req.body[f], 10) || 0 : (f === 'palletId' ? normalizePalletId(req.body[f]) : (f === 'destino' ? normalizeDestino(req.body[f]) : req.body[f]));
      }
    });
    // Auto-set fechaSalida when pedido is assigned for the first time
    if (req.body.pedido && req.body.pedido.trim() && !oldData.fechaSalida) {
      const todayStr = mexicoDateStr();
      doc.fechaSalida = todayStr;
      changes.push({ field: 'fechaSalida', oldValue: '', newValue: todayStr });
    }
    if (changes.length === 0) return res.json({ success: true, message: 'Sin cambios', data: doc });
    await doc.save();
    await audit('UPDATE', {
      palletId: doc.palletId, escaneadora: doc.escaneadora,
      changedBy: req.user.nombre || req.user.usuario,
      source: 'APP', reason: req.body.reason || '',
      changes: changes.map(ch => ({ field: ch.field, before: ch.oldValue, after: ch.newValue }))
    });
    emitEvent('paletizado', 'registro:updated', { id: doc._id, palletId: doc.palletId, changes, updatedBy: req.user.nombre || req.user.usuario });
    res.json({ success: true, message: `${changes.length} campo(s) actualizado(s)`, data: doc, changes });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// ── DELETE pallet (admin only, with audit) ──
app.delete('/api/escaneadoras/:id', auth, roleGuard('admin'), async (req, res) => {
  try {
    const doc = await EscReg.findById(req.params.id);
    if (!doc) return res.status(404).json({ success: false, error: 'No encontrado' });
    const snapshot = doc.toObject();
    await EscReg.deleteOne({ _id: doc._id });
    await audit('DELETE', {
      palletId: snapshot.palletId, escaneadora: snapshot.escaneadora,
      changedBy: req.user.nombre || req.user.usuario,
      source: 'APP', reason: req.body?.reason || 'Eliminado por admin',
      snapshot: { palletId: snapshot.palletId, cantidad: snapshot.cantidad, condicion: snapshot.condicion, destino: snapshot.destino, turno: snapshot.turno, escaneadora: snapshot.escaneadora, fecha: snapshot.fecha, fechaSalida: snapshot.fechaSalida || '', pedido: snapshot.pedido || '', incidencias: snapshot.incidencias || '', observaciones: snapshot.observaciones || '' },
      changes: [{ field: 'registro', before: 'ACTIVO', after: 'ELIMINADO' }]
    });
    emitEvent('paletizado', 'registro:deleted', { palletId: snapshot.palletId, deletedBy: req.user.nombre || req.user.usuario });
    res.json({ success: true, message: `Pallet ${snapshot.palletId} eliminado`, deletedPallet: snapshot });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// ═══════════ DASHBOARD (admin only) ═══════════
// "Hoy" y las franjas de turno se calculan en hora de Mexico, sin importar
// en que timezone corra el proceso (Vercel = UTC), para que registros de la
// tarde/noche no se cuenten como del dia siguiente.
function mexicoDateStr(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Mexico_City', month: 'numeric', day: 'numeric', year: 'numeric'
  }).formatToParts(date).reduce((o, p) => (o[p.type] = p.value, o), {});
  return `${parts.month}/${parts.day}/${parts.year}`;
}
function mexicoMinutesOfDay(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Mexico_City', hour: 'numeric', minute: 'numeric', hourCycle: 'h23'
  }).formatToParts(date).reduce((o, p) => (o[p.type] = p.value, o), {});
  return parseInt(parts.hour, 10) * 60 + parseInt(parts.minute, 10);
}
function normalizeTurno(t) {
  if (!t) return 'Otro';
  const l = t.toLowerCase();
  if (l.includes('extra')) return 'Tiempo Extra';
  if (l.includes('noche') || l.includes('night')) return 'Noche';
  if (l.includes('día') || l.includes('dia') || l.includes('day')) return 'Día';
  return t;
}

app.get('/api/dashboard/resumen', auth, moduleGuard('dashboard'), async (req, res) => {
  try {
    const { fecha, fecha_inicio, fecha_fin, escaneadora, turno } = req.query;
    const filter = {};
    if (fecha) filter.fecha = fecha;
    if (escaneadora) filter.escaneadora = rx(escaneadora);
    if (turno) filter.turno = rx(turno);

    // .lean() + select: esta ruta solo agrega en JS (no necesita instancias de Mongoose),
    // y no usa observaciones/incidencias/pedido/palletId - traerlos completos era peso muerto.
    let registros = await EscReg.find(filter).select('escaneadora destino condicion createdAt cantidad turno fecha').sort({ createdAt: -1 }).lean();

    // Solo se usa el conteo (salidaCount) - countDocuments evita traer los documentos completos
    let salidaCount = 0;
    if (fecha) {
      salidaCount = await EscReg.countDocuments({ fechaSalida: fecha, fecha: { $ne: fecha } });
    }

    if (!fecha && fecha_inicio && fecha_fin) {
      const start = new Date(fecha_inicio), end = new Date(fecha_fin);
      end.setHours(23, 59, 59, 999);
      registros = registros.filter(r => {
        return inDateRange(r.fecha, start, end);
      });
    }

    const hoyStr = mexicoDateStr();
    // "Registros Hoy" is ALWAYS today's real count, independent of filters
    const registrosHoyCount = await EscReg.countDocuments({ fecha: hoyStr });

    const porEscaneadora = {}, porTurno = {}, porDestino = {}, porCondicion = {};
    let totalUnidades = 0;

    registros.forEach(r => {
      const e = r.escaneadora, d = r.destino || 'Otro', c = r.condicion || 'Sin condicion';
      // La franja de turno se calcula por la hora real de escaneo (createdAt, hora Mexico),
      // no por el string guardado — en mobile el turno es fijo por operador (Day/Night)
      // y no refleja si en realidad escaneo en tiempo extra o turno nocturno.
      let t = r.createdAt ? calcTurnoFromHour(new Date(r.createdAt)) : normalizeTurno(r.turno);
      if (!porEscaneadora[e]) porEscaneadora[e] = { registros: 0, unidades: 0 };
      porEscaneadora[e].registros++; porEscaneadora[e].unidades += (r.cantidad || 0);
      if (!porTurno[t]) porTurno[t] = { registros: 0, unidades: 0 };
      porTurno[t].registros++; porTurno[t].unidades += (r.cantidad || 0);
      if (!porDestino[d]) porDestino[d] = { registros: 0, unidades: 0 };
      porDestino[d].registros++; porDestino[d].unidades += (r.cantidad || 0);
      if (!porCondicion[c]) porCondicion[c] = 0;
      porCondicion[c]++;
      totalUnidades += (r.cantidad || 0);
    });

    let metas = [];
    try { metas = await ProductionTarget.find({ isActive: true }).lean(); } catch(e) { /* targets opcionales */ }

    res.json({
      success: true,
      totalRegistros: registros.length,
      registrosHoy: registrosHoyCount,
      totalUnidades,
      fechaHoy: hoyStr,
      salidaCount,
      metas,
      porEscaneadora: Object.entries(porEscaneadora).map(([nombre, d]) => ({ nombre, ...d })),
      porTurno: Object.entries(porTurno).map(([turno, d]) => ({ turno, ...d })),
      porDestino: Object.entries(porDestino).map(([destino, d]) => ({ destino, ...d })),
      porCondicion: Object.entries(porCondicion).map(([condicion, total]) => ({ condicion, total })),
      escaneadoras: [...new Set(registros.map(r => r.escaneadora))].sort(),
      fechas: [...new Set(registros.map(r => r.fecha))].sort(),
    });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.get('/api/dashboard/registros', auth, moduleGuard('dashboard'), async (req, res) => {
  try {
    const { fecha, fecha_inicio, fecha_fin, escaneadora, turno, busqueda, limit, skip } = req.query;
    const filter = {};
    if (fecha) filter.fecha = fecha;
    if (escaneadora) filter.escaneadora = rx(escaneadora);
    if (turno) filter.turno = rx(turno);
    if (busqueda) {
      filter.$or = [
        { palletId: rx(busqueda) },
        { escaneadora: rx(busqueda) },
        { destino: rx(busqueda) },
        { pedido: rx(busqueda) },
        { observaciones: rx(busqueda) },
      ];
    }
    let query = EscReg.find(filter).sort({ createdAt: -1 });
    if (skip) query = query.skip(parseInt(skip));
    // Safety ceiling only (not a "results per page" default) — comfortably above real data volume
    // so dashboard metrics/charts never silently drop older records like the old 2000 default did.
    query = query.limit(Math.min(20000, parseInt(limit) || 20000));
    // .lean() evita el overhead de hidratar cada resultado como documento de Mongoose completo
    // (con getters/casting) - el frontend solo lee los campos como JSON de todos modos.
    let registros = await query.populate('capturadoPor', 'nombre').lean();

    if (!fecha && fecha_inicio && fecha_fin) {
      const start = new Date(fecha_inicio), end = new Date(fecha_fin);
      end.setHours(23, 59, 59, 999);
      registros = registros.filter(r => {
        return inDateRange(r.fecha, start, end);
      });
    }

    // Also fetch records shipped on this date (for pedido/BULKY charts)
    let salidaRecords = [];
    if (fecha) {
      salidaRecords = await EscReg.find({ fechaSalida: fecha, fecha: { $ne: fecha } }).sort({ createdAt: -1 }).populate('capturadoPor', 'nombre').lean();
    }

    const total = registros.length;
    res.json({ success: true, data: registros, salidaData: salidaRecords, total, filteredCount: registros.length });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// ── TV Stats: marca y pulgadas cruzando los pallets del filtro actual contra SmartControl ──
// Tu Mongo no guarda marca/modelo/pulgadas (solo palletId/cantidad/condicion) - ese dato solo
// vive en SmartControl. Se cachea por 5 min y se muestrea (max N pallets) para no saturar el
// endpoint externo ni hacer lenta la pagina. Se dispara manual, no en el poll de 8s.
const tvStatsCache = new Map();
const TV_STATS_CACHE_MS = 5 * 60 * 1000;
const TV_STATS_MAX_PALLETS = 80;

// parseInches vive ahora en services/centroOperativoHelpers.js (parseInchesFromDescription) —
// unificado para que /api/centro-operativo/* lo comparta sin duplicar la logica.
const parseInches = parseInchesFromDescription;

app.get('/api/dashboard/tv-stats', auth, moduleGuard('dashboard'), async (req, res) => {
  try {
    const { fecha, fecha_inicio, fecha_fin, escaneadora, turno } = req.query;
    const filter = {};
    if (fecha) filter.fecha = fecha;
    if (escaneadora) filter.escaneadora = rx(escaneadora);
    if (turno) filter.turno = rx(turno);
    // Ordenado por mas reciente: sin esto Mongo regresa en orden arbitrario y la muestra de 80
    // podia caer en pallets viejos (peor probabilidad de responder bien en SmartControl).
    let registros = await EscReg.find(filter).select('palletId fecha cantidad').sort({ createdAt: -1 });
    if (!fecha && fecha_inicio && fecha_fin) {
      const start = new Date(fecha_inicio), end = new Date(fecha_fin);
      end.setHours(23, 59, 59, 999);
      registros = registros.filter(r => inDateRange(r.fecha, start, end));
    }

    // cantidad real (de tu propia DB) por pallet, para poder pesar la muestra por piezas
    // en vez de contar "1" por pallet -> los totales se sienten cercanos a tus piezas reales.
    const cantidadPorPallet = {};
    const ordenPallets = [];
    registros.forEach(r => {
      const pid = normalizePalletId(r.palletId);
      if (!pid) return;
      if (!(pid in cantidadPorPallet)) ordenPallets.push(pid);
      cantidadPorPallet[pid] = (cantidadPorPallet[pid] || 0) + (r.cantidad || 0);
    });

    const totalPalletsFiltro = ordenPallets.length;
    const muestreado = totalPalletsFiltro > TV_STATS_MAX_PALLETS;
    const palletIds = muestreado ? ordenPallets.slice(0, TV_STATS_MAX_PALLETS) : ordenPallets;

    const cacheKey = JSON.stringify({ fecha, fecha_inicio, fecha_fin, escaneadora, turno, n: palletIds.length, palletIds: palletIds[0] });
    const cached = tvStatsCache.get(cacheKey);
    if (cached && (Date.now() - cached.ts) < TV_STATS_CACHE_MS) {
      return res.json({ success: true, ...cached.data, fromCache: true });
    }

    const muestras = []; // detalle por pallet, para poder listar al hacer click en una rebanada
    let procesados = 0, errores = 0;
    const BATCH = 8;
    for (let i = 0; i < palletIds.length; i += BATCH) {
      const batch = palletIds.slice(i, i + BATCH);
      await Promise.all(batch.map(async (pid) => {
        try {
          const rawPallet = await scFetchJson(`https://appsc.mitechnologiesinc.com/Home/BinPalletID_GET_ApiAR?PalletID=${encodeURIComponent(pid)}`);
          const productos = scTryParse(rawPallet.Productos) || [];
          const lista = Array.isArray(productos) ? productos : [];
          // Un pallet puede traer mezcladas TVs con accesorios/soundbars/etc bajo otras SKUs.
          // Preferimos candidatos cuya SKU empiece con "SNTV" (patron de TV visto en datos reales)
          // y probamos varios hasta encontrar uno que la Classification API confirme como Televisions,
          // en vez de asumir que el primer producto de la lista representa todo el pallet.
          const candidatos = [
            ...lista.filter(p => p.NumeroSerie && p.NumeroSerie.trim() && /^SNTV/i.test(p.SKU || '')),
            ...lista.filter(p => p.NumeroSerie && p.NumeroSerie.trim() && !/^SNTV/i.test(p.SKU || '')),
          ].map(p => p.NumeroSerie);

          let info = null;
          for (const lpn of candidatos.slice(0, 4)) {
            const rawLpn = await scFetchJson(`https://appsc.mitechnologiesinc.com/Classification/GetDataLicensePlateNumber_ApiAR?LPN=${encodeURIComponent(lpn)}`, 7000);
            const workPlanArr = scTryParse(rawLpn.WorkPlanLicensePlateNumber) || [];
            const candidateInfo = Array.isArray(workPlanArr) ? workPlanArr[0] : null;
            if (candidateInfo && candidateInfo.CategoryName === 'Televisions') { info = candidateInfo; break; }
          }
          if (!info) return; // este pallet no trae TVs identificables (o no responde)

          // Pesamos por la cantidad REAL de piezas de tu DB para ese pallet (no "+1" por pallet),
          // asi los totales reflejan piezas estimadas en vez de numero de pallets muestreados.
          const peso = cantidadPorPallet[pid] || 1;
          const brand = (info.Brand || '').trim() || 'Desconocida';
          const inches = parseInches(info.ItemDescription);
          muestras.push({
            palletId: pid,
            peso,
            marca: brand,
            pulgadas: inches ? `${inches}"` : 'Sin dato',
            modelo: info.MFGSKU || '',
            descripcion: info.ItemDescription || '',
          });
          procesados++;
        } catch (e) { errores++; }
      }));
    }

    function agrupar(keyName) {
      const grupos = {};
      muestras.forEach(m => {
        const key = m[keyName];
        if (!grupos[key]) grupos[key] = { total: 0, pallets: [] };
        grupos[key].total += m.peso;
        grupos[key].pallets.push({ palletId: m.palletId, cantidad: m.peso, modelo: m.modelo, descripcion: m.descripcion, marca: m.marca, pulgadas: m.pulgadas });
      });
      return Object.entries(grupos)
        .sort((a, b) => b[1].total - a[1].total)
        .map(([key, v]) => ({ [keyName]: key, total: v.total, pallets: v.pallets.sort((a, b) => b.cantidad - a.cantidad) }));
    }

    const data = {
      totalPalletsFiltro,
      palletsMuestreados: palletIds.length,
      muestreado,
      procesados,
      errores,
      porMarca: agrupar('marca'),
      porPulgadas: agrupar('pulgadas'),
    };
    tvStatsCache.set(cacheKey, { ts: Date.now(), data });
    res.json({ success: true, ...data, fromCache: false });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// Helper: calculate the real 3-way turno from createdAt hour, in Mexico local time
// Matutino/Dia: 7:00am-5:10pm · Tiempo Extra: 5:10pm-10:00pm · Nocturno: 10:00pm-7:00am
function calcTurnoFromHour(date) {
  if (!date) return 'Otro';
  const mins = mexicoMinutesOfDay(date);
  if (mins >= 420 && mins < 1030) return 'Día';
  if (mins >= 1030 && mins < 1320) return 'Tiempo Extra';
  return 'Noche';
}

app.get('/api/dashboard/tendencias', auth, moduleGuard('dashboard'), async (req, res) => {
  try {
    const limit = parseInt(req.query.dias) || 7;
    const { fecha, fecha_inicio, fecha_fin, escaneadora, turno } = req.query;

    // Build match filter for aggregation
    const matchFilter = {};
    if (fecha) matchFilter.fecha = fecha;
    if (escaneadora) matchFilter.escaneadora = rx(escaneadora);
    if (turno) matchFilter.turno = rx(turno);

    const pipeline = [];
    if (Object.keys(matchFilter).length > 0) pipeline.push({ $match: matchFilter });

    // Bucket by real scan hour (createdAt, Mexico time), not the stored turno string —
    // mobile assigns turno fijo por operador, no por hora real de escaneo.
    pipeline.push(
      { $addFields: { turnoMins: {
          $add: [
            { $multiply: [{ $hour: { date: '$createdAt', timezone: 'America/Mexico_City' } }, 60] },
            { $minute: { date: '$createdAt', timezone: 'America/Mexico_City' } }
          ]
      } } },
      { $group: { _id: '$fecha',
          dia:   { $sum: { $cond: [{ $and: [{ $gte: ['$turnoMins', 420] }, { $lt: ['$turnoMins', 1030] }] }, 1, 0] } },
          extra: { $sum: { $cond: [{ $and: [{ $gte: ['$turnoMins', 1030] }, { $lt: ['$turnoMins', 1320] }] }, 1, 0] } },
          noche: { $sum: { $cond: [{ $or: [{ $gte: ['$turnoMins', 1320] }, { $lt: ['$turnoMins', 420] }] }, 1, 0] } },
          total: { $sum: 1 } } },
      { $match: { total: { $gt: 0 } } },
      { $sort: { _id: -1 } },
      { $limit: limit },
      { $sort: { _id: 1 } },
      { $project: { _id: 0, date: '$_id', dia: 1, extra: 1, noche: 1, total: 1 } }
    );

    let tendencia = await EscReg.aggregate(pipeline);

    // Date range filter (string dates M/D/YYYY)
    if (!fecha && fecha_inicio && fecha_fin) {
      const start = new Date(fecha_inicio), end = new Date(fecha_fin);
      end.setHours(23, 59, 59, 999);
      tendencia = tendencia.filter(t => {
        return inDateRange(t.date, start, end);
      });
    }

    // Promedios - use same filters
    const proFilter = {};
    if (fecha) proFilter.fecha = fecha;
    if (escaneadora) proFilter.escaneadora = rx(escaneadora);
    if (turno) proFilter.turno = rx(turno);

    let registros = await EscReg.find(proFilter).select('createdAt turno fecha').lean();
    if (!fecha && fecha_inicio && fecha_fin) {
      const start = new Date(fecha_inicio), end = new Date(fecha_fin);
      end.setHours(23, 59, 59, 999);
      registros = registros.filter(r => {
        return inDateRange(r.fecha, start, end);
      });
    }

    const turnoStats = {}, turnoDates = {};
    registros.forEach(r => {
      // Misma clasificacion por hora real usada en /api/dashboard/resumen
      let t = r.createdAt ? calcTurnoFromHour(new Date(r.createdAt)) : normalizeTurno(r.turno);
      if (!turnoStats[t]) { turnoStats[t]=0; turnoDates[t]=new Set(); }
      turnoStats[t]++; turnoDates[t].add(r.fecha);
    });
    const promedios = Object.entries(turnoStats).map(([turno, total]) => ({ turno, totalRegistros: total, totalDias: turnoDates[turno].size, promedio: turnoDates[turno].size > 0 ? (total / turnoDates[turno].size).toFixed(1) : 0 }));
    res.json({ success: true, tendencia, promedios });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// ═══════════ PIEZAS PALETIZADAS POR SEMANA (agregacion real en Mongo, sin cargar registros al frontend) ═══════════
app.get('/api/dashboard/piezas-semana', auth, moduleGuard('dashboard'), async (req, res) => {
  try {
    const { fecha_inicio, fecha_fin, escaneadora, turno } = req.query;
    const matchFilter = {};
    if (escaneadora) matchFilter.escaneadora = rx(escaneadora);
    if (turno) matchFilter.turno = rx(turno);

    const pipeline = [];
    if (Object.keys(matchFilter).length) pipeline.push({ $match: matchFilter });
    pipeline.push(...fechaDateStages());

    if (fecha_inicio || fecha_fin) {
      pipeline.push({ $match: fechaDateRangeMatch(fecha_inicio, fecha_fin) });
    }
    // Un registro sin fecha valida no puede ubicarse en ninguna semana — se excluye solo de este agrupado
    pipeline.push({ $match: { _fechaDate: { $ne: null } } });

    pipeline.push(
      { $addFields: { _weekStart: { $dateTrunc: { date: '$_fechaDate', unit: 'week', startOfWeek: 'monday' } } } },
      { $group: {
          _id: '$_weekStart',
          totalPiezas: { $sum: { $ifNull: ['$cantidad', 0] } },
          totalPallets: { $sum: 1 },
          dias: { $addToSet: '$fecha' },
        } },
      { $sort: { _id: 1 } },
      { $project: { _id: 0, weekStart: '$_id', totalPiezas: 1, totalPallets: 1, diasConDatos: { $size: '$dias' } } },
    );

    const rows = await EscReg.aggregate(pipeline);

    let metaGlobalDiaria = 0;
    try {
      const metaGlobal = await ProductionTarget.findOne({ turno: 'Global', isActive: true });
      metaGlobalDiaria = metaGlobal?.targetPiezas || 0;
    } catch (e) { /* metas opcionales */ }
    const metaSemanal = metaGlobalDiaria > 0 ? metaGlobalDiaria * 7 : 0;

    const serie = rows.map(r => {
      const start = new Date(r.weekStart);
      const end = new Date(start); end.setDate(end.getDate() + 6);
      const label = `${start.getDate()} ${MESES_ES[start.getMonth()]} - ${end.getDate()} ${MESES_ES[end.getMonth()]}`;
      const promedioDiario = r.diasConDatos > 0 ? +(r.totalPiezas / r.diasConDatos).toFixed(1) : 0;
      return {
        weekStart: start.toISOString().slice(0, 10),
        weekEnd: end.toISOString().slice(0, 10),
        label,
        totalPiezas: r.totalPiezas,
        totalPallets: r.totalPallets,
        diasConDatos: r.diasConDatos,
        promedioDiario,
        metaSemanal,
        cumpleMeta: metaSemanal > 0 ? r.totalPiezas >= metaSemanal : null,
      };
    });

    res.json({ success: true, serie, metaSemanal, metaGlobalDiaria });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.get('/api/dashboard/catalogos', auth, moduleGuard('dashboard'), async (req, res) => {
  try {
    // Antes corrian uno tras otro (4 round-trips seguidos); en paralelo tardan lo del mas lento, no la suma.
    const [escaneadoras, destinos, turnos, fechas] = await Promise.all([
      EscReg.distinct('escaneadora'),
      EscReg.distinct('destino'),
      EscReg.distinct('turno'),
      EscReg.distinct('fecha'),
    ]);
    res.json({ success: true, escaneadoras: escaneadoras.sort(), destinos: destinos.sort(), turnos: turnos.sort(), fechas: fechas.sort() });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// ═══════════ RESUMEN PALETIZADO ═══════════
const resumenSchema = new mongoose.Schema({
  turno: { type: String, required: true },
  palletsTotales: { type: Number, required: true, min: 0 },
  palletsTRG: { type: Number, required: true, min: 0 },
  palletsAlmacen: { type: Number, required: true, min: 0 },
  // Agregado junto con el destino FBA — required:true solo aplica a documentos
  // NUEVOS; los resumenes historicos ya guardados no tienen este campo y se leen
  // igual (el frontend usa `r.palletsFBA || 0` al mostrarlos/exportarlos).
  palletsFBA: { type: Number, required: true, min: 0 },
  palletsEnProceso: { type: Number, required: true, min: 0 },
  asistencia: { type: Number, required: true, min: 0 },
  absentismo: { type: Number, required: true, min: 0 },
  tareasPendientes: { type: String, required: true },
  fecha: { type: String, required: true },
  capturadoPor: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  nombreCaptura: { type: String, default: '' },
}, { timestamps: true });
resumenSchema.index({ fecha: 1, turno: 1 });
resumenSchema.index({ createdAt: -1 });
const Resumen = mongoose.models.ResumenPaletizado || mongoose.model('ResumenPaletizado', resumenSchema);

app.post('/api/resumen', auth, moduleGuard('escaneadoras'), async (req, res) => {
  try {
    const { turno, palletsTotales, palletsTRG, palletsAlmacen, palletsFBA, palletsEnProceso, asistencia, absentismo, tareasPendientes, fecha } = req.body;
    if (!turno || !fecha || palletsTotales===undefined || palletsTotales==='' || palletsTRG===undefined || palletsTRG==='' || palletsAlmacen===undefined || palletsAlmacen==='' || palletsFBA===undefined || palletsFBA==='' || palletsEnProceso===undefined || palletsEnProceso==='' || asistencia===undefined || asistencia==='' || absentismo===undefined || absentismo==='' || !tareasPendientes) {
      return res.status(400).json({ success: false, error: 'Todos los campos son obligatorios' });
    }
    const nums = {
      palletsTotales: parseInt(palletsTotales, 10), palletsTRG: parseInt(palletsTRG, 10),
      palletsAlmacen: parseInt(palletsAlmacen, 10), palletsFBA: parseInt(palletsFBA, 10),
      palletsEnProceso: parseInt(palletsEnProceso, 10),
      asistencia: parseInt(asistencia, 10), absentismo: parseInt(absentismo, 10),
    };
    const bad = Object.entries(nums).find(([, v]) => Number.isNaN(v) || v < 0);
    if (bad) return res.status(400).json({ success: false, error: `El campo ${bad[0]} debe ser un numero valido (>= 0)` });
    const doc = await Resumen.create({
      turno, ...nums, tareasPendientes,
      fecha, capturadoPor: req.user._id, nombreCaptura: req.user.nombre,
    });
    res.json({ success: true, id: doc._id, message: 'Resumen guardado' });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.get('/api/resumen', auth, moduleGuard('escaneadoras'), async (req, res) => {
  try {
    const { fecha, turno, limit } = req.query;
    const filter = {};
    if (fecha) filter.fecha = fecha;
    if (turno) filter.turno = rx(turno);
    const docs = await Resumen.find(filter).sort({ createdAt: -1 }).limit(parseInt(limit)||100);
    res.json({ success: true, data: docs, total: docs.length });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// ═══════════ CLASIFICACIONES / PEDIDOS (admin 3647 manage; todos pueden leer) ═══════════
const clasifSchema = new mongoose.Schema({
  nombre: { type: String, required: true, trim: true },
  color: { type: String, required: true, lowercase: true, trim: true },
  isActive: { type: Boolean, default: true },
  isLocked: { type: Boolean, default: false },
  orden: { type: Number, default: 0 },
}, { timestamps: true });
clasifSchema.index({ nombre: 1 }, { unique: true, collation: { locale: 'es', strength: 2 } });
const Clasif = mongoose.models.Clasificacion || mongoose.model('Clasificacion', clasifSchema);

const CLASIF_DEFAULTS = [
  { nombre: 'Alejandro',       color: '#ef4444', orden: 1 },
  { nombre: 'BOX',             color: '#4f7cff', orden: 2,  isLocked: true },
  { nombre: 'BULKY',           color: '#f59e0b', orden: 3,  isLocked: true },
  { nombre: 'HV',              color: '#22c55e', orden: 4,  isLocked: true },
  { nombre: 'HV Televisiones', color: '#8b5cf6', orden: 5,  isLocked: true },
  { nombre: 'JESSY',           color: '#ec4899', orden: 6 },
  { nombre: 'Jesus',           color: '#f97316', orden: 7 },
  { nombre: 'Juan Manuel',     color: '#06b6d4', orden: 8 },
  { nombre: 'Lorena',          color: '#14b8a6', orden: 9 },
  { nombre: 'Perez Rangel',    color: '#a855f7', orden: 10 },
  { nombre: '9X7251Z',         color: '#6366f1', orden: 11, isLocked: true },
  { nombre: 'STOCK 50',        color: '#84cc16', orden: 12 },
];

async function seedClasifIfEmpty() {
  const count = await Clasif.countDocuments();
  if (count > 0) return;
  try { await Clasif.insertMany(CLASIF_DEFAULTS, { ordered: false }); } catch(e) { /* ignore dup */ }
}

function isHexColor(c) { return typeof c === 'string' && /^#[0-9A-Fa-f]{6}$/.test(c); }

app.get('/api/clasificaciones', auth, async (req, res) => {
  try {
    await seedClasifIfEmpty();
    const includeInactive = req.query.all === '1' && req.user.usuario === '3647';
    const filter = includeInactive ? {} : { isActive: true };
    const data = await Clasif.find(filter).sort({ orden: 1, nombre: 1 });
    res.json({ success: true, data });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.post('/api/clasificaciones', auth, roleGuard('admin'), async (req, res) => {
  try {
    if (req.user.usuario !== '3647') return res.status(403).json({ success: false, error: 'Solo admin 3647' });
    const nombre = (req.body.nombre || '').trim();
    const color = (req.body.color || '').toLowerCase().trim();
    if (!nombre) return res.status(400).json({ success: false, error: 'Nombre requerido' });
    if (!isHexColor(color)) return res.status(400).json({ success: false, error: 'Color invalido. Usa formato #RRGGBB.' });
    const exists = await Clasif.findOne({ nombre: { $regex: '^' + escapeRegex(nombre) + '$', $options: 'i' } });
    if (exists) return res.status(409).json({ success: false, error: 'Ya existe un pedido con ese nombre' });
    const colorClash = await Clasif.findOne({ color, isActive: true });
    if (colorClash) return res.status(409).json({ success: false, error: `El color ya esta usado por: ${colorClash.nombre}` });
    const last = await Clasif.findOne({}).sort({ orden: -1 });
    const orden = ((last && last.orden) || 0) + 1;
    const doc = await Clasif.create({ nombre, color, orden });
    res.json({ success: true, data: doc });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.put('/api/clasificaciones/:id', auth, roleGuard('admin'), async (req, res) => {
  try {
    if (req.user.usuario !== '3647') return res.status(403).json({ success: false, error: 'Solo admin 3647' });
    const doc = await Clasif.findById(req.params.id);
    if (!doc) return res.status(404).json({ success: false, error: 'No encontrado' });
    const { nombre, color, isActive } = req.body;
    let registrosActualizados = 0;
    let renamedFrom = null, renamedTo = null;

    if (color !== undefined) {
      const c = String(color || '').toLowerCase().trim();
      if (!isHexColor(c)) return res.status(400).json({ success: false, error: 'Color invalido (formato #RRGGBB)' });
      if (c !== doc.color) {
        const colorClash = await Clasif.findOne({ _id: { $ne: doc._id }, color: c, isActive: true });
        if (colorClash) return res.status(409).json({ success: false, error: `El color ya esta usado por: ${colorClash.nombre}` });
        doc.color = c;
      }
    }
    if (typeof isActive === 'boolean') {
      if (doc.isLocked && !isActive) return res.status(403).json({ success: false, error: 'No se puede desactivar este pedido (bloqueado)' });
      doc.isActive = isActive;
    }
    if (nombre !== undefined) {
      const newName = String(nombre || '').trim();
      if (!newName) return res.status(400).json({ success: false, error: 'Nombre no puede estar vacio' });
      if (newName !== doc.nombre) {
        if (doc.isLocked) return res.status(403).json({ success: false, error: 'No se puede renombrar este pedido (bloqueado por compatibilidad)' });
        const dupe = await Clasif.findOne({ _id: { $ne: doc._id }, nombre: { $regex: '^' + escapeRegex(newName) + '$', $options: 'i' } });
        if (dupe) return res.status(409).json({ success: false, error: 'Ya existe un pedido con ese nombre' });
        const oldName = doc.nombre;
        // Cascade: update observaciones starting with oldName followed by ' |' or end-of-string
        const escOld = escapeRegex(oldName);
        const startRe = new RegExp('^' + escOld + '(?=\\s*\\||\\s*$)');
        const matches = await EscReg.find(
          { observaciones: { $regex: '^' + escOld + '(\\s*\\||\\s*$)' } },
          { _id: 1, observaciones: 1 }
        );
        for (const r of matches) {
          const newObs = r.observaciones.replace(startRe, newName);
          await EscReg.updateOne({ _id: r._id }, { $set: { observaciones: newObs } });
        }
        registrosActualizados = matches.length;
        doc.nombre = newName;
        renamedFrom = oldName; renamedTo = newName;
      }
    }
    await doc.save();
    if (renamedFrom) {
      try {
        await audit('UPDATE', {
          palletId: '', escaneadora: '',
          changedBy: req.user.nombre || req.user.usuario, source: 'APP',
          reason: `Renombrar pedido "${renamedFrom}" -> "${renamedTo}" (${registrosActualizados} registros actualizados)`,
          changes: [{ field: 'pedido', before: renamedFrom, after: renamedTo }]
        });
      } catch(e) { /* ignore audit error */ }
    }
    emitEvent('paletizado', 'clasificacion:updated', { id: doc._id, nombre: doc.nombre });
    res.json({ success: true, data: doc, registrosActualizados });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.delete('/api/clasificaciones/:id', auth, roleGuard('admin'), async (req, res) => {
  try {
    if (req.user.usuario !== '3647') return res.status(403).json({ success: false, error: 'Solo admin 3647' });
    const doc = await Clasif.findById(req.params.id);
    if (!doc) return res.status(404).json({ success: false, error: 'No encontrado' });
    if (doc.isLocked) return res.status(403).json({ success: false, error: 'No se puede eliminar este pedido (bloqueado por compatibilidad)' });
    doc.isActive = false;
    await doc.save();
    emitEvent('paletizado', 'clasificacion:deleted', { id: doc._id, nombre: doc.nombre });
    res.json({ success: true, message: `Pedido "${doc.nombre}" desactivado. Los registros existentes se conservan.` });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// ── Conteo de registros por clasificacion (columna "Registros" del panel
// Gestionar Pedidos). UNA sola pasada sobre EscReg via $facet (no N consultas
// por fila) — replica exactamente el mismo regex que usa el rename-cascade de
// arriba (PUT /api/clasificaciones/:id) para que el conteo mostrado sea
// consistente con lo que esa operacion realmente actualizaria. ──
app.get('/api/clasificaciones/counts', auth, roleGuard('admin'), async (req, res) => {
  try {
    if (req.user.usuario !== '3647') return res.status(403).json({ success: false, error: 'Solo admin 3647' });
    const clasifs = await Clasif.find({}, { nombre: 1 });
    if (clasifs.length === 0) return res.json({ success: true, counts: {} });
    const facet = {};
    clasifs.forEach((c, i) => {
      const re = new RegExp('^' + escapeRegex(c.nombre) + '(\\s*\\||\\s*$)');
      facet['c' + i] = [{ $match: { observaciones: re } }, { $count: 'n' }];
    });
    const [result] = await EscReg.aggregate([{ $facet: facet }]);
    const counts = {};
    clasifs.forEach((c, i) => { counts[String(c._id)] = (result['c' + i][0] || {}).n || 0; });
    res.json({ success: true, counts });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// ═══════════ REPORTES: Excel Produccion Bulky/Fierro separados (admin 3647 only) ═══════════
// Endpoint dedicado para el Excel "Reporte_Produccion_Bulky_Fierro_Separados.xlsx" — se
// conecta via Power Query (sin sesion de navegador), por eso admite un token de servicio
// ademas de la sesion JWT normal de admin 3647. Nunca requiere ninguna de las dos vacias:
// si REPORTES_EXCEL_TOKEN no esta configurada, solo queda disponible por sesion admin 3647.
const REPORTES_EXCEL_TOKEN = process.env.REPORTES_EXCEL_TOKEN || '';
// Llave SEPARADA para el consumidor server-a-server mitechnologies-rt (2026-08-06)
// — independiente de REPORTES_EXCEL_TOKEN a proposito, para no romper el Power
// Query de Excel que ya usa esa llave si esta se rota o revoca despues.
const MITECHNOLOGIES_RT_REPORT_TOKEN = process.env.MITECHNOLOGIES_RT_REPORT_TOKEN || '';
function constantTimeTokenMatch(provided, expected) {
  if (!expected || !provided) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
async function reportesExcelGuard(req, res, next) {
  const provided = req.get('X-Report-Token') || req.query.token || '';
  if (constantTimeTokenMatch(provided, REPORTES_EXCEL_TOKEN)) return next();
  if (constantTimeTokenMatch(provided, MITECHNOLOGIES_RT_REPORT_TOKEN)) return next();
  const h = req.headers.authorization;
  if (h && h.startsWith('Bearer ')) {
    try {
      const decoded = jwt.verify(h.split(' ')[1], JWT_SECRET);
      const user = await User.findById(decoded.id).select('-passwordHash');
      if (user && user.isActive && String(user.usuario) === '3647') { req.user = user; return next(); }
    } catch { /* token de sesion invalido o expirado, cae al 403 de abajo */ }
  }
  return res.status(403).json({ success: false, error: 'No autorizado. Se requiere token de reporte (header X-Report-Token o ?token=) o sesion de admin 3647.' });
}

// Normaliza el parametro ?categoria= de la API (tolerante a mayusculas/acentos) a uno
// de los 5 nombres finales exactos. Regresa 'INVALIDA' si no coincide con ninguno,
// para que el endpoint pueda responder 400 en vez de devolver un filtro silenciosamente
// vacio (que se veria como "cero registros" y confundiria mas que un error claro).
function normalizeCategoriaInput(v) {
  const up = String(v || '').trim().toUpperCase();
  if (!up) return null;
  if (up === 'ALMACEN' || up === 'ALMACÉN') return 'Almacén';
  if (up === 'TRG') return 'TRG';
  if (up === 'FBA') return 'FBA';
  if (up === 'BULKY') return 'Bulky';
  if (up === 'FIERRO') return 'Fierro';
  return 'INVALIDA';
}

// Tope de seguridad — evita descargar toda la coleccion si no se manda rango de
// fechas. Con rango de fechas normal (dia/semana/mes) nunca se acerca a este limite.
const REPORTES_EXCEL_SAFETY_CAP = 20000;

app.get('/api/reportes/produccion-excel', reportesExcelGuard, async (req, res) => {
  try {
    const { fechaInicio, fechaFin, turno, destino, categoria } = req.query;

    let categoriaFiltro = null;
    if (categoria) {
      categoriaFiltro = normalizeCategoriaInput(categoria);
      if (categoriaFiltro === 'INVALIDA') {
        return res.status(400).json({ success: false, error: `categoria invalida: "${categoria}". Usa Almacen, TRG, FBA, Bulky o Fierro.` });
      }
    }
    let destinoFiltro = null;
    if (destino) {
      destinoFiltro = normalizeDestino(destino);
      if (!['TRG', 'Almacen', 'FBA'].includes(destinoFiltro)) {
        return res.status(400).json({ success: false, error: `destino invalido: "${destino}". Usa TRG, Almacen o FBA.` });
      }
    }
    if (fechaInicio && !/^\d{4}-\d{2}-\d{2}$/.test(fechaInicio)) {
      return res.status(400).json({ success: false, error: 'fechaInicio debe tener formato YYYY-MM-DD' });
    }
    if (fechaFin && !/^\d{4}-\d{2}-\d{2}$/.test(fechaFin)) {
      return res.status(400).json({ success: false, error: 'fechaFin debe tener formato YYYY-MM-DD' });
    }

    const match = {};
    if (turno) match.turno = rx(turno);

    const pipeline = [{ $match: match }];
    // fechaDateStages() SIEMPRE corre (a diferencia de otros endpoints de este archivo
    // que solo la corren si hay rango) porque aqui _fechaDate tambien se usa para
    // ordenar correctamente por fecha real — "fecha" es texto M/D/YYYY y ordenar como
    // texto rompe el orden cronologico (ej. "12/1/2026" antes que "6/6/2026").
    pipeline.push(...fechaDateStages());
    if (fechaInicio || fechaFin) pipeline.push({ $match: fechaDateRangeMatch(fechaInicio, fechaFin) });
    pipeline.push(
      { $sort: { _fechaDate: 1, createdAt: 1 } },
      { $facet: {
          rows: [{ $limit: REPORTES_EXCEL_SAFETY_CAP }],
          totalCount: [{ $count: 'n' }],
      } },
    );

    const [result] = await EscReg.aggregate(pipeline);
    const rawRows = (result && result.rows) || [];
    const total = (result && result.totalCount && result.totalCount[0] && result.totalCount[0].n) || 0;

    // Clasificacion (normalizeDestino/clasificarRegistro/prepararRegistro) viene del
    // servicio central api/services/reporteProduccionHelpers.js — LA MISMA que usa
    // /api/reportes/produccion-semanal y el export a Excel, para no duplicar la logica
    // de "que cuenta como Almacen/TRG/FBA/Bulky/Fierro" en dos lugares distintos.
    let data = rawRows.map(prepararRegistro);
    if (destinoFiltro) data = data.filter((r) => normalizeDestino(r.destinoOriginal) === destinoFiltro);
    if (categoriaFiltro) data = data.filter((r) => r.categoria === categoriaFiltro);
    const truncado = total > rawRows.length;

    // Resumen diario — se calcula sobre el MISMO arreglo `data` ya filtrado y
    // clasificado (nunca con una consulta aparte), para que sea imposible que se
    // desalinee de la hoja "Datos Dashboard". Bulky/Fierro nunca se vuelven a sumar
    // dentro de Almacen: cada registro ya trae una sola `categoria`.
    const porDia = new Map();
    for (const r of data) {
      const key = r.fecha || 'Sin fecha';
      if (!porDia.has(key)) {
        porDia.set(key, {
          fecha: key, diaSemana: r.diaSemana,
          almacenPallets: 0, almacenPiezas: 0,
          trgPallets: 0, trgPiezas: 0,
          fbaPallets: 0, fbaPiezas: 0,
          bulkyPallets: 0, bulkyPiezas: 0,
          fierroPallets: 0, fierroPiezas: 0,
        });
      }
      const d = porDia.get(key);
      const pz = r.piezas || 0;
      if (r.categoria === 'Almacén') { d.almacenPallets += 1; d.almacenPiezas += pz; }
      else if (r.categoria === 'TRG') { d.trgPallets += 1; d.trgPiezas += pz; }
      else if (r.categoria === 'FBA') { d.fbaPallets += 1; d.fbaPiezas += pz; }
      else if (r.categoria === 'Bulky') { d.bulkyPallets += 1; d.bulkyPiezas += pz; }
      else if (r.categoria === 'Fierro') { d.fierroPallets += 1; d.fierroPiezas += pz; }
    }
    const resumenDiario = [...porDia.values()]
      .sort((a, b) => (parseFechaMDY(a.fecha)?.getTime() || 0) - (parseFechaMDY(b.fecha)?.getTime() || 0))
      .map((d) => ({
        ...d,
        // Bulky+Fierro combinado: SOLO informativo, no se vuelve a sumar en totalPallets/piezas.
        bulkyFierroPallets: d.bulkyPallets + d.fierroPallets,
        bulkyFierroPiezas: d.bulkyPiezas + d.fierroPiezas,
        totalPallets: d.almacenPallets + d.trgPallets + d.fbaPallets + d.bulkyPallets + d.fierroPallets,
        totalPiezas: d.almacenPiezas + d.trgPiezas + d.fbaPiezas + d.bulkyPiezas + d.fierroPiezas,
      }));

    res.json({
      success: true,
      meta: {
        fechaInicio: fechaInicio || null,
        fechaFin: fechaFin || null,
        turno: turno || null,
        destino: destinoFiltro,
        categoria: categoriaFiltro,
        total,
        devueltos: data.length,
        truncado,
        timezone: 'America/Mexico_City',
        generadoEn: new Date().toISOString(),
      },
      data,
      resumenDiario,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ═══════════ REPORTE SEMANAL DE PRODUCCION — modulo web (admin 3647 only) ═══════════
// Reemplaza el flujo de Excel + Power Query: consulta MongoDB directo y regresa
// la semana (Lunes-Domingo) ya armada exactamente como el archivo
// Reporte_Produccion_Bulky_Fierro_Separados.xlsx (Almacen/Bulky+Fierro/TRG/FBA/Total
// por dia + resumen semanal). Usa el MISMO servicio central de clasificacion que
// /api/reportes/produccion-excel (api/services/reporteProduccionHelpers.js) — no hay
// una segunda copia de la logica de Bulky/Fierro/doble-conteo en este archivo.
// Unica funcion que arma la semana completa (query params -> filtros validados ->
// Mongo -> clasificacion -> buildReporteSemanal). La usan TANTO el endpoint JSON
// (vista web) COMO el endpoint de descarga de Excel — para no tener 2 copias de
// "como se arma la semana" en este archivo. Lanza un Error con `.status` (400)
// si algun filtro es invalido; el caller lo captura y responde el status correcto.
async function computeReporteSemanal(query) {
  const { fecha, turno, categoria, destino, escaneadora, pedido, palletId } = query || {};

  let categoriaFiltro = null;
  if (categoria) {
    categoriaFiltro = normalizeCategoriaInput(categoria);
    if (categoriaFiltro === 'INVALIDA') {
      const err = new Error(`categoria invalida: "${categoria}". Usa Almacen, TRG, FBA, Bulky o Fierro.`);
      err.status = 400;
      throw err;
    }
  }
  let destinoFiltro = null;
  if (destino) {
    destinoFiltro = normalizeDestino(destino);
    if (!['TRG', 'Almacen', 'FBA'].includes(destinoFiltro)) {
      const err = new Error(`destino invalido: "${destino}". Usa TRG, Almacen o FBA.`);
      err.status = 400;
      throw err;
    }
  }
  if (fecha && !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
    const err = new Error('fecha debe tener formato YYYY-MM-DD');
    err.status = 400;
    throw err;
  }

  // `fecha` es CUALQUIER dia dentro de la semana deseada; el backend calcula el
  // Lunes de esa semana. Sin `fecha`, se usa "hoy" en America/Mexico_City (mismo
  // criterio de zona horaria que el resto del sistema — America/Monterrey no es
  // un identificador IANA valido, comparte el mismo huso que America/Mexico_City).
  let refDate;
  if (fecha) {
    const [y, m, d] = fecha.split('-').map((n) => parseInt(n, 10));
    refDate = new Date(y, m - 1, d);
  } else {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Mexico_City', year: 'numeric', month: 'numeric', day: 'numeric' })
      .formatToParts(new Date()).reduce((o, p) => (o[p.type] = p.value, o), {});
    refDate = new Date(parseInt(parts.year, 10), parseInt(parts.month, 10) - 1, parseInt(parts.day, 10));
  }
  const semanaInicio = inicioDeSemana(refDate);
  const semanaFin = new Date(semanaInicio.getFullYear(), semanaInicio.getMonth(), semanaInicio.getDate() + 6);
  const pad2 = (n) => String(n).padStart(2, '0');
  const isoInicio = `${semanaInicio.getFullYear()}-${pad2(semanaInicio.getMonth() + 1)}-${pad2(semanaInicio.getDate())}`;
  const isoFin = `${semanaFin.getFullYear()}-${pad2(semanaFin.getMonth() + 1)}-${pad2(semanaFin.getDate())}`;

  const match = {};
  if (turno) match.turno = rx(turno);
  if (escaneadora) match.escaneadora = rx(escaneadora);
  if (pedido) match.pedido = rx(pedido);
  if (palletId) match.palletId = rx(palletId);

  const pipeline = [{ $match: match }];
  pipeline.push(...fechaDateStages());
  pipeline.push({ $match: fechaDateRangeMatch(isoInicio, isoFin) });
  pipeline.push({ $sort: { _fechaDate: 1, createdAt: 1 } });

  const rawRows = await EscReg.aggregate(pipeline);
  // Semana acotada a 7 dias — no necesita el tope de seguridad del export general.
  let registros = rawRows.map(prepararRegistro);
  if (destinoFiltro) registros = registros.filter((r) => normalizeDestino(r.destinoOriginal) === destinoFiltro);
  if (categoriaFiltro) registros = registros.filter((r) => r.categoria === categoriaFiltro);

  const reporte = buildReporteSemanal(registros, semanaInicio);
  const semana = { isoInicio, isoFin, fechaInicio: formatFechaMDY(semanaInicio), fechaFin: formatFechaMDY(semanaFin) };

  return {
    semana,
    dias: reporte.dias,
    resumen: reporte.resumen,
    resumenFilas: reporte.resumenFilas,
    registros,
    filtros: {
      turno: turno || null,
      destino: destinoFiltro,
      categoria: categoriaFiltro,
      escaneadora: escaneadora || null,
      pedido: pedido || null,
      palletId: palletId || null,
    },
  };
}

app.get('/api/reportes/produccion-semanal', auth, roleGuard('admin'), centroOperativoGuard, async (req, res) => {
  try {
    const r = await computeReporteSemanal(req.query);
    res.json({
      success: true,
      semana: r.semana,
      dias: r.dias,
      resumen: r.resumen,
      registros: r.registros,
      meta: {
        ...r.filtros,
        totalRegistros: r.registros.length,
        timezone: 'America/Mexico_City',
        generadoEn: new Date().toISOString(),
      },
    });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

// Descarga del mismo reporte semanal como .xlsx real, generado en el servidor
// con ExcelJS (api/services/reporteProduccionExcel.js) a partir de los MISMOS
// datos que /api/reportes/produccion-semanal — nunca un archivo aparte ni datos
// distintos. Mismo guard de admin 3647 que el resto del modulo.
app.get('/api/reportes/produccion-semanal/excel', auth, roleGuard('admin'), centroOperativoGuard, async (req, res) => {
  try {
    const r = await computeReporteSemanal(req.query);
    const wb = construirWorkbookReporteSemanal({ dias: r.dias, resumen: r.resumen, resumenFilas: r.resumenFilas }, r.semana);
    const buffer = await wb.xlsx.writeBuffer();
    const nombreArchivo = `Reporte_Produccion_Semanal_${r.semana.isoInicio}_a_${r.semana.isoFin}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${nombreArchivo}"`);
    res.send(Buffer.from(buffer));
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

// ═══════════ DASHBOARD DESTINOS FFT (admin 3647 only) ═══════════
// Vista Destino x Tipo de pedido sobre los pallets ya capturados en esta app
// (EscReg). Reutiliza el filtro y el agrupado por pallet ya usado por Centro
// Operativo (buildCentroFilter, applyCentroDateRange, getFilteredPalletsMeta:
// 1 pallet = 1 palletId, cantidad SUMADA por grupo, nunca duplicado) y el
// catalogo REAL y dinamico de Clasificacion (nunca tipos hardcodeados) via
// prepararRegistroFft (api/services/destinoTipoHelpers.js).
//
// El modulo de Areas/Bines/Pallets (mas abajo) cruza este mismo origen (EscReg,
// "destino FFT real") contra el inventario real de BinManagerRO (Cubicaje,
// "donde esta fisicamente el pallet ahorita") por PalletID normalizado —
// nunca se confunden destino FFT, categoria de inventario (BinManagerRO),
// area y bin: son 4 conceptos separados, ver unifiedPalletHelpers.js.

// Rango de fechas por defecto (ultimos 30 dias, America/Mexico_City) cuando el
// caller no manda fecha_inicio/fecha_fin — evita cargar TODO el historico en
// memoria solo por no traer filtro de fecha.
function fftHoyMexico() {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Mexico_City', year: 'numeric', month: 'numeric', day: 'numeric' })
    .formatToParts(new Date()).reduce((o, p) => (o[p.type] = p.value, o), {});
  return new Date(parseInt(parts.year, 10), parseInt(parts.month, 10) - 1, parseInt(parts.day, 10));
}
function fftIso(d) { const pad2 = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
// Auditoria 2026-08-10: pedido explicito de Roman de poder ver "datos
// completos" (todo el historico, sin tope de 30 dias) además de rango o dia
// especifico. sinFecha=1 se propaga como fecha_inicio/fecha_fin vacios --
// applyCentroDateRange/construirCruceFftSinCache ya saben tratar eso como
// "sin filtro de fecha" (nunca como el default de 30 dias).
function fftDefaultRange(query) {
  if (query.sinFecha === '1' || query.sinFecha === 'true') return { fecha_inicio: '', fecha_fin: '' };
  if (query.fecha_inicio || query.fecha_fin) return { fecha_inicio: query.fecha_inicio || query.fecha_fin, fecha_fin: query.fecha_fin || query.fecha_inicio };
  const hoy = fftHoyMexico();
  const hace30 = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() - 29);
  return { fecha_inicio: fftIso(hace30), fecha_fin: fftIso(hoy) };
}

app.get('/api/dashboard-destinos-fft/filtros', auth, roleGuard('admin'), centroOperativoGuard, async (req, res) => {
  try {
    const [destinos, escaneadoras, condiciones, clasifs] = await Promise.all([
      EscReg.distinct('destino'),
      EscReg.distinct('escaneadora'),
      EscReg.distinct('condicion'),
      Clasif.find({ isActive: true }).sort({ orden: 1, nombre: 1 }),
    ]);
    const destinosNorm = [...new Set(destinos.filter(Boolean).map((d) => fftNormalizeDestino(d).valor))].sort();

    // Areas/bines/categorias vienen del inventario real (Cubicaje) — opcional:
    // si Cubicaje no esta configurado/disponible, el resto de filtros FFT deben
    // seguir funcionando (no se bloquea todo el panel por una fuente caida).
    let areas = [], bines = [], categorias = [];
    try {
      const { pallets: inventario } = await leerInventarioCubicajeCacheado();
      areas = [...new Set(inventario.map((p) => p.area).filter(Boolean))].sort();
      bines = [...new Set(inventario.map((p) => fftNormalizeBin(p.locationName).valor))].sort();
      categorias = [...new Set(inventario.map((p) => p.binTypeName).filter(Boolean))].sort();
    } catch (e) { /* cache aun no sincronizado: filtros de inventario quedan vacios, no rompe el resto */ }

    res.json({
      success: true,
      destinos: destinosNorm,
      tipos: clasifs.map((c) => c.nombre),
      escaneadoras: escaneadoras.filter(Boolean).sort(),
      condiciones: condiciones.filter(Boolean).sort(),
      areas, bines, categorias,
      matchStatus: ['matched', 'conflict', 'inventory-only', 'fft-only'],
    });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.get('/api/dashboard-destinos-fft/data', auth, roleGuard('admin'), centroOperativoGuard, async (req, res) => {
  try {
    const tipoFiltro = req.query.tipo || null;
    const rango = fftDefaultRange(req.query);
    const queryConRango = { ...req.query, ...rango };

    const filter = buildCentroFilter(req.query);
    const catalogo = (await Clasif.find({ isActive: true })).map((c) => c.nombre);

    async function registrosDelRango(filtro, q) {
      const { orden, porPallet } = await getFilteredPalletsMeta(filtro, q);
      let regs = orden.map((pid) => prepararRegistroFft({ palletId: pid, ...porPallet.get(pid) }, catalogo));
      if (tipoFiltro) regs = regs.filter((r) => r.tipoPedido === tipoFiltro);
      return regs;
    }

    const registros = await registrosDelRango(filter, queryConRango);
    const totalPallets = registros.length;
    const totalPiezas = registros.reduce((s, r) => s + r.piezas, 0);

    const hoy = fftHoyMexico();
    const hoyStr = `${hoy.getMonth() + 1}/${hoy.getDate()}/${hoy.getFullYear()}`;
    const registrosHoy = registros.filter((r) => r.fecha === hoyStr).length;
    const destinosActivos = new Set(registros.map((r) => r.destino)).size;
    const tiposActivos = new Set(registros.map((r) => r.tipoPedido)).size;

    // Comparacion "vs dia anterior": solo cuando el rango es UN dia exacto, mismo
    // criterio que /api/centro-operativo/resumen — con un rango de varios dias no
    // hay un "dia anterior" unico y correcto que comparar.
    let anterior = null;
    if (rango.fecha_inicio && rango.fecha_inicio === rango.fecha_fin) {
      const [y, m, d] = rango.fecha_inicio.split('-').map((n) => parseInt(n, 10));
      const fPrev = new Date(y, m - 1, d - 1);
      const isoPrev = fftIso(fPrev);
      const regsPrev = await registrosDelRango(filter, { fecha_inicio: isoPrev, fecha_fin: isoPrev });
      anterior = { totalPallets: regsPrev.length, totalPiezas: regsPrev.reduce((s, r) => s + r.piezas, 0) };
    }
    const delta = (key, valorActual) => (anterior ? computeDelta(valorActual, anterior[key]) : null);

    function agrupar(campo) {
      const m = new Map();
      for (const r of registros) {
        const k = r[campo];
        if (!m.has(k)) m.set(k, { pallets: 0, piezas: 0 });
        const b = m.get(k);
        b.pallets += 1;
        b.piezas += r.piezas;
      }
      return [...m.entries()].map(([nombre, v]) => ({ nombre, pallets: v.pallets, piezas: v.piezas })).sort((a, b) => b.pallets - a.pallets);
    }
    const porDestino = agrupar('destino');
    const porTipo = agrupar('tipoPedido');
    const porEscaneadora = agrupar('escaneadora').slice(0, 10);

    const destinosUnicos = [...new Set(registros.map((r) => r.destino))].sort();
    const tiposUnicos = [...new Set(registros.map((r) => r.tipoPedido))].sort();
    const celdas = destinosUnicos.map((d) => ({
      destino: d,
      valores: tiposUnicos.map((t) => registros.filter((r) => r.destino === d && r.tipoPedido === t).length),
    }));

    const porDiaMap = new Map();
    for (const r of registros) {
      if (!r.fecha) continue;
      if (!porDiaMap.has(r.fecha)) porDiaMap.set(r.fecha, { pallets: 0, piezas: 0 });
      const b = porDiaMap.get(r.fecha);
      b.pallets += 1;
      b.piezas += r.piezas;
    }
    const porDia = [...porDiaMap.entries()]
      .map(([fecha, v]) => ({ fecha, fechaDate: parseFechaMDY(fecha), pallets: v.pallets, piezas: v.piezas }))
      .filter((d) => d.fechaDate)
      .sort((a, b) => a.fechaDate - b.fechaDate)
      .map(({ fechaDate, ...rest }) => rest);

    const tablaMap = new Map();
    for (const r of registros) {
      const key = r.destino + '||' + r.tipoPedido;
      if (!tablaMap.has(key)) tablaMap.set(key, { destino: r.destino, tipoPedido: r.tipoPedido, pallets: 0, piezas: 0, ultimoRegistro: null });
      const row = tablaMap.get(key);
      row.pallets += 1;
      row.piezas += r.piezas;
      if (r.ultimoRegistro && (!row.ultimoRegistro || r.ultimoRegistro > row.ultimoRegistro)) row.ultimoRegistro = r.ultimoRegistro;
    }
    const tablaResumen = [...tablaMap.values()]
      .map((row) => ({
        ...row,
        pctPallets: totalPallets > 0 ? Number(((row.pallets / totalPallets) * 100).toFixed(1)) : 0,
        pctPiezas: totalPiezas > 0 ? Number(((row.piezas / totalPiezas) * 100).toFixed(1)) : 0,
      }))
      .sort((a, b) => b.pallets - a.pallets);

    res.json({
      success: true,
      kpis: {
        totalPallets: { value: totalPallets, deltaPct: delta('totalPallets', totalPallets) },
        totalPiezas: { value: totalPiezas, deltaPct: delta('totalPiezas', totalPiezas) },
        registrosHoy: { value: registrosHoy, deltaPct: null },
        destinosActivos: { value: destinosActivos, deltaPct: null },
        tiposActivos: { value: tiposActivos, deltaPct: null },
      },
      graficas: {
        porDestino, porTipo, porEscaneadora, porDia,
        matriz: { destinos: destinosUnicos, tipos: tiposUnicos, celdas },
      },
      tablaResumen,
      meta: {
        fechaInicio: rango.fecha_inicio,
        fechaFin: rango.fecha_fin,
        tipo: tipoFiltro,
        totalPallets,
        timezone: 'America/Mexico_City',
        generadoEn: new Date().toISOString(),
      },
    });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// ── Cruce Inventario (BinManagerRO/Cubicaje) x FFT (EscReg) por PalletID ──
// UNICA funcion que arma el cruce completo (UnifiedPalletRecord[], ver
// api/services/unifiedPalletHelpers.js) — cada endpoint de Areas/Bines/
// Pallets de aqui abajo LEE de esta funcion, nunca recalcula el cruce por su
// cuenta. El lado de inventario es el snapshot COMPLETO actual (sin cap de
// muestra, ver fetchCubicajeLivePalletsAll); el lado FFT se acota al rango de
// fechas pedido (o los ultimos 30 dias por defecto).
// Cache corta en memoria (por instancia serverless tibia) del resultado YA
// CRUZADO — el join en si (leer ~decenas de miles de pallets cacheados +
// agregar EscReg + unificar en JS) resulto ser pesado (~35s la primera vez).
// Dentro de esta ventana, cambiar de pestaña (Resumen/Areas/Destinos/
// Actividad) o el auto-refresh de 30s reutilizan el mismo resultado en vez
// de recalcularlo desde cero cada vez.
const fftCruceCache = new Map();
const FFT_CRUCE_CACHE_TTL_MS = 45000;
async function construirCruceFft(query) {
  const cacheKey = JSON.stringify(query || {});
  const cacheado = fftCruceCache.get(cacheKey);
  if (cacheado && (Date.now() - cacheado.timestamp) < FFT_CRUCE_CACHE_TTL_MS) return cacheado.valor;
  const valor = await construirCruceFftSinCache(query);
  fftCruceCache.set(cacheKey, { valor, timestamp: Date.now() });
  if (fftCruceCache.size > 20) {
    const masVieja = [...fftCruceCache.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp)[0][0];
    fftCruceCache.delete(masVieja);
  }
  return valor;
}

async function construirCruceFftSinCache(query) {
  const rango = fftDefaultRange(query || {});
  // Lee el inventario del CACHE local (rapido) — nunca llama a Cubicaje en vivo
  // dentro de un request interactivo (ver sincronizarInventarioCubicaje/cron).
  const [{ pallets: inventario, totalReal: totalInventario, agotado: agotadoInventario, ultimaSincronizacion, nuncaSincronizado }, catalogo] = await Promise.all([
    leerInventarioCubicajeCacheado(),
    Clasif.find({ isActive: true }).then((docs) => docs.map((c) => c.nombre)),
  ]);

  const filter = buildCentroFilter(query || {});
  const pipeline = [{ $match: filter }];
  // Mismo guard que applyCentroDateRange: sin fecha_inicio/fecha_fin (ej.
  // sinFecha=1) significa "todo el historico", nunca "0 resultados".
  if (rango.fecha_inicio || rango.fecha_fin) {
    pipeline.push(...fechaDateStages());
    pipeline.push({ $match: fechaDateRangeMatch(rango.fecha_inicio, rango.fecha_fin) });
  }
  pipeline.push({ $sort: { createdAt: -1 } });
  const fftDocsCrudos = await EscReg.aggregate(pipeline);

  // 1 registro FFT (el mas reciente) por PalletID normalizado — un pallet con
  // varias filas de escaneo/retrabajo nunca duplica piezas ni aparece 2 veces.
  let palletIdsInvalidos = 0;
  let duplicadosFft = 0;
  const fftPorPallet = new Map();
  for (const doc of fftDocsCrudos) {
    const key = palletIdMatchKey(doc.palletId);
    if (!key) { palletIdsInvalidos++; continue; }
    if (fftPorPallet.has(key)) duplicadosFft++;
    else fftPorPallet.set(key, doc);
  }
  const invPorPallet = new Map();
  for (const p of inventario) {
    const key = palletIdMatchKey(p.palletId);
    if (!key) { palletIdsInvalidos++; continue; }
    if (!invPorPallet.has(key)) invPorPallet.set(key, p);
  }

  const keysUnicas = new Set([...invPorPallet.keys(), ...fftPorPallet.keys()]);
  const registros = [...keysUnicas].map((key) => buildUnifiedRecord(invPorPallet.get(key) || null, fftPorPallet.get(key) || null, catalogo));
  const diagnostico = {
    inventarioConsultado: invPorPallet.size,
    registrosFftConsultados: fftPorPallet.size,
    coincidencias: registros.filter((r) => r.matchStatus === 'matched' || r.matchStatus === 'conflict').length,
    conflictos: registros.filter((r) => r.matchStatus === 'conflict').length,
    soloInventario: registros.filter((r) => r.matchStatus === 'inventory-only').length,
    soloFft: registros.filter((r) => r.matchStatus === 'fft-only').length,
    duplicadosFft,
    palletIdsInvalidos,
  };

  return { registros, rango, totalInventario, agotadoInventario, catalogo, diagnostico, ultimaSincronizacion, nuncaSincronizado };
}

function fftModaCategoria(regs) {
  const m = new Map();
  for (const r of regs) { if (!r.inventory) continue; m.set(r.inventory.category, (m.get(r.inventory.category) || 0) + 1); }
  let top = 'Sin categoría', max = 0;
  for (const [c, n] of m) if (n > max) { max = n; top = c; }
  return top;
}
function fftUltimoMovimiento(regs) {
  let max = null;
  for (const r of regs) { if (r.fft && r.fft.createdAt && (!max || r.fft.createdAt > max)) max = r.fft.createdAt; }
  return max;
}
function fftAgruparPorCampo(regs, extractor) {
  const m = new Map();
  for (const r of regs) {
    const v = extractor(r);
    if (v === null || v === undefined || v === '') continue;
    if (!m.has(v)) m.set(v, { pallets: 0, piezas: 0 });
    const b = m.get(v);
    b.pallets += 1;
    b.piezas += r.fft ? r.fft.pieces : (r.inventory ? r.inventory.pieces : 0);
  }
  return [...m.entries()].map(([nombre, v]) => ({ nombre, pallets: v.pallets, piezas: v.piezas })).sort((a, b) => b.pallets - a.pallets);
}
function fftAgruparPorDia(regs) {
  const m = new Map();
  for (const r of regs) {
    if (!r.fft || !r.fft.date) continue;
    if (!m.has(r.fft.date)) m.set(r.fft.date, { pallets: 0, piezas: 0 });
    const b = m.get(r.fft.date);
    b.pallets += 1;
    b.piezas += r.fft.pieces;
  }
  return [...m.entries()]
    .map(([fecha, v]) => ({ fecha, fechaDate: parseFechaMDY(fecha), pallets: v.pallets, piezas: v.piezas }))
    .filter((d) => d.fechaDate)
    .sort((a, b) => a.fechaDate - b.fechaDate)
    .map(({ fechaDate, ...rest }) => rest);
}
function fftLimpiarDatosSensibles(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const patronSensible = /token|apikey|api[_-]?key|password|secret|authorization|cookie|integrationkey/i;
  const plano = typeof obj.toObject === 'function' ? obj.toObject() : obj;
  const limpio = Array.isArray(plano) ? [] : {};
  for (const [k, v] of Object.entries(plano)) {
    if (patronSensible.test(k)) continue;
    if (Array.isArray(limpio)) limpio.push(v && typeof v === 'object' ? fftLimpiarDatosSensibles(v) : v);
    else limpio[k] = v && typeof v === 'object' ? fftLimpiarDatosSensibles(v) : v;
  }
  return limpio;
}

// "¿A que destinos van los pallets de FFT?" — SIEMPRE desde el campo real
// destino de EscReg (nunca desde la categoria de inventario de BinManagerRO).
// Extraido a funcion pura (recibe el cruce YA calculado) para que
// /resumen-completo pueda reusarla sin recalcular construirCruceFft.
function buildDestinosPayload(registros) {
  const conFft = registros.filter((r) => r.fft);
  const totalPallets = conFft.length;
  const totalPiezas = conFft.reduce((s, r) => s + r.fft.pieces, 0);

  const porDestinoMap = new Map();
  for (const r of conFft) {
    const d = r.fft.destination;
    if (!porDestinoMap.has(d)) porDestinoMap.set(d, []);
    porDestinoMap.get(d).push(r);
  }
  const destinos = [...porDestinoMap.entries()].map(([destino, regs]) => {
    const piezas = regs.reduce((s, r) => s + r.fft.pieces, 0);
    const binesRelacionados = new Set(regs.filter((r) => r.inventory).map((r) => r.inventory.bin)).size;
    return {
      destino,
      pallets: regs.length,
      piezas,
      pctPallets: totalPallets > 0 ? Number(((regs.length / totalPallets) * 100).toFixed(1)) : 0,
      binesRelacionados,
      ultimoMovimiento: fftUltimoMovimiento(regs),
      tiposPedidoPrincipales: fftAgruparPorCampo(regs, (r) => r.fft.orderType).slice(0, 3).map((t) => t.nombre),
    };
  }).sort((a, b) => b.pallets - a.pallets);

  return { destinos, meta: { totalPallets, totalPiezas, generadoEn: new Date().toISOString() } };
}

app.get('/api/dashboard-destinos-fft/destinos', auth, roleGuard('admin'), centroOperativoGuard, async (req, res) => {
  try {
    const { registros } = await construirCruceFft(req.query);
    res.json({ success: true, ...buildDestinosPayload(registros) });
  } catch (error) { res.status(error.status || 500).json({ success: false, error: error.message }); }
});

// Sincroniza AHORA el cache de inventario (admin 3647, bajo demanda) — puede
// tardar hasta ~40s porque llama a Cubicaje en vivo; si el plan de Vercel de
// este proyecto tiene un limite de ejecucion mas corto, puede fallar por
// timeout de la plataforma (no de este codigo) — en ese caso el cron diario
// (ver vercel.json) sigue siendo el mecanismo confiable de refresco.
app.post('/api/dashboard-destinos-fft/sincronizar-inventario', auth, roleGuard('admin'), centroOperativoGuard, async (req, res) => {
  try {
    const r = await sincronizarInventarioCubicaje();
    res.json({ success: true, ...r });
  } catch (error) { res.status(error.status || 500).json({ success: false, error: error.message }); }
});

// Areas y Bines — SOLO inventario real (BinManagerRO), cruzado con FFT para
// destinos relacionados/pedidos/escaneadoras/ultimo movimiento por bin/area.
// "Bines activos" = bines con inventario actual (al menos 1 pallet ahorita).
// Extraido a funcion pura (recibe el cruce YA calculado) por el mismo motivo
// que buildDestinosPayload — reusada por /resumen-completo.
function buildAreasPayload(cruce) {
  const { registros, totalInventario, agotadoInventario, diagnostico, ultimaSincronizacion, nuncaSincronizado } = cruce;
  const conInventario = registros.filter((r) => r.inventory);
  const totalPalletsInv = conInventario.length;
  const totalPiezasInv = conInventario.reduce((s, r) => s + r.inventory.pieces, 0);

  const binesMap = new Map();
  for (const r of conInventario) {
    const bin = r.inventory.bin;
    if (!binesMap.has(bin)) binesMap.set(bin, { bin, area: r.inventory.area, regs: [] });
    binesMap.get(bin).regs.push(r);
  }
  const bines = [...binesMap.values()].map((g) => {
    const piezas = g.regs.reduce((s, r) => s + r.inventory.pieces, 0);
    return {
      bin: g.bin,
      area: g.area,
      categoria: fftModaCategoria(g.regs),
      pallets: g.regs.length,
      piezas,
      pctPallets: totalPalletsInv > 0 ? Number(((g.regs.length / totalPalletsInv) * 100).toFixed(1)) : 0,
      pctPiezas: totalPiezasInv > 0 ? Number(((piezas / totalPiezasInv) * 100).toFixed(1)) : 0,
      destinosRelacionados: [...new Set(g.regs.filter((r) => r.fft).map((r) => r.fft.destination))],
      ultimoMovimiento: fftUltimoMovimiento(g.regs),
      estado: 'Con inventario',
    };
  }).sort((a, b) => b.pallets - a.pallets);

  const areasMap = new Map();
  for (const b of bines) {
    if (!areasMap.has(b.area)) areasMap.set(b.area, { area: b.area, bines: [], pallets: 0, piezas: 0 });
    const g = areasMap.get(b.area);
    g.bines.push(b);
    g.pallets += b.pallets;
    g.piezas += b.piezas;
  }
  const areas = [...areasMap.values()].map((g) => ({
    area: g.area,
    cantidadBines: g.bines.length,
    pallets: g.pallets,
    piezas: g.piezas,
    pctPallets: totalPalletsInv > 0 ? Number(((g.pallets / totalPalletsInv) * 100).toFixed(1)) : 0,
    pctPiezas: totalPiezasInv > 0 ? Number(((g.piezas / totalPiezasInv) * 100).toFixed(1)) : 0,
    destinosRelacionados: [...new Set(g.bines.flatMap((b) => b.destinosRelacionados))],
    ultimoMovimiento: g.bines.reduce((max, b) => (b.ultimoMovimiento && (!max || b.ultimoMovimiento > max) ? b.ultimoMovimiento : max), null),
    estado: 'Activa',
    binesPreview: g.bines.slice().sort((a, b) => b.pallets - a.pallets).slice(0, 5),
  })).sort((a, b) => b.pallets - a.pallets);

  return {
    areas,
    bines,
    resumen: {
      areasActivas: areas.length,
      binesActivos: bines.length,
      palletsSinCruceFFT: diagnostico.soloInventario,
      // Auditoria 2026-08-10: KPIs de Resumen ya NO mezclan totales de EscReg
      // con totales reales -- totalPalletsReal/totalPiezasReal salen de
      // conInventario (el inventario real completo, ya calculado arriba)
      // para que "Pallets/Piezas totales" tambien sean 100% BinManagerRO.
      totalPalletsReal: totalPalletsInv,
      totalPiezasReal: totalPiezasInv,
    },
    diagnostico,
    meta: { totalInventarioReal: totalInventario, agotadoInventario, ultimaSincronizacion, nuncaSincronizado, generadoEn: new Date().toISOString() },
  };
}

app.get('/api/dashboard-destinos-fft/areas', auth, roleGuard('admin'), centroOperativoGuard, async (req, res) => {
  try {
    const cruce = await construirCruceFft(req.query);
    res.json({ success: true, ...buildAreasPayload(cruce) });
  } catch (error) { res.status(error.status || 500).json({ success: false, error: error.message }); }
});

app.get('/api/dashboard-destinos-fft/areas/:areaId', auth, roleGuard('admin'), centroOperativoGuard, async (req, res) => {
  try {
    let areaId;
    try { areaId = decodeURIComponent(req.params.areaId || '').trim(); } catch (e) { return res.status(400).json({ success: false, error: 'areaId invalido' }); }
    if (!areaId) return res.status(400).json({ success: false, error: 'areaId invalido' });

    const { registros } = await construirCruceFft(req.query);
    const delArea = registros.filter((r) => r.inventory && r.inventory.area === areaId);
    if (!delArea.length) return res.json({ success: true, area: areaId, encontrada: false });

    const binesMap = new Map();
    for (const r of delArea) {
      const bin = r.inventory.bin;
      if (!binesMap.has(bin)) binesMap.set(bin, []);
      binesMap.get(bin).push(r);
    }
    const bines = [...binesMap.entries()].map(([bin, regs]) => ({
      bin,
      pallets: regs.length,
      piezas: regs.reduce((s, r) => s + r.inventory.pieces, 0),
      categoria: fftModaCategoria(regs),
      destinosRelacionados: [...new Set(regs.filter((r) => r.fft).map((r) => r.fft.destination))],
      ultimoMovimiento: fftUltimoMovimiento(regs),
      estado: 'Con inventario',
    })).sort((a, b) => b.pallets - a.pallets);

    res.json({
      success: true,
      area: areaId,
      encontrada: true,
      kpis: {
        bines: bines.length,
        pallets: delArea.length,
        piezas: delArea.reduce((s, r) => s + r.inventory.pieces, 0),
        destinosRelacionados: new Set(delArea.filter((r) => r.fft).map((r) => r.fft.destination)).size,
        pedidosDistintos: new Set(delArea.filter((r) => r.fft).map((r) => r.fft.orderNumber).filter(Boolean)).size,
        escaneadorasActivas: new Set(delArea.filter((r) => r.fft).map((r) => r.fft.scanner).filter(Boolean)).size,
        ultimoMovimiento: fftUltimoMovimiento(delArea),
      },
      graficas: {
        porBinPallets: bines.map((b) => ({ nombre: b.bin, pallets: b.pallets, piezas: b.piezas })),
        porDestino: fftAgruparPorCampo(delArea, (r) => (r.fft ? r.fft.destination : null)),
        porTipo: fftAgruparPorCampo(delArea, (r) => (r.fft ? r.fft.orderType : null)),
        porCondicion: fftAgruparPorCampo(delArea, (r) => (r.fft ? r.fft.condition : null)),
        porDia: fftAgruparPorDia(delArea),
        porEscaneadora: fftAgruparPorCampo(delArea, (r) => (r.fft ? r.fft.scanner : null)).slice(0, 10),
      },
      bines,
    });
  } catch (error) { res.status(error.status || 500).json({ success: false, error: error.message }); }
});

app.get('/api/dashboard-destinos-fft/areas/:areaId/bines/:binId', auth, roleGuard('admin'), centroOperativoGuard, async (req, res) => {
  try {
    let areaId, binId;
    try {
      areaId = decodeURIComponent(req.params.areaId || '').trim();
      binId = decodeURIComponent(req.params.binId || '').trim();
    } catch (e) { return res.status(400).json({ success: false, error: 'parametro invalido' }); }
    if (!areaId || !binId) return res.status(400).json({ success: false, error: 'parametro invalido' });

    const { registros } = await construirCruceFft(req.query);
    const delBin = registros.filter((r) => r.inventory && r.inventory.area === areaId && r.inventory.bin === binId);
    if (!delBin.length) return res.json({ success: true, area: areaId, bin: binId, encontrado: false });

    const conCruce = delBin.filter((r) => r.fft);
    const sinCruce = delBin.filter((r) => !r.fft);

    res.json({
      success: true,
      area: areaId,
      bin: binId,
      encontrado: true,
      categoria: fftModaCategoria(delBin),
      destinosRelacionados: [...new Set(conCruce.map((r) => r.fft.destination))],
      kpis: {
        pallets: delBin.length,
        piezas: delBin.reduce((s, r) => s + r.inventory.pieces, 0),
        palletsConCruce: conCruce.length,
        palletsSinCruce: sinCruce.length,
        pedidosDistintos: new Set(conCruce.map((r) => r.fft.orderNumber).filter(Boolean)).size,
        escaneadorasActivas: new Set(conCruce.map((r) => r.fft.scanner).filter(Boolean)).size,
        ultimoMovimiento: fftUltimoMovimiento(delBin),
      },
      graficas: {
        porTipo: fftAgruparPorCampo(delBin, (r) => (r.fft ? r.fft.orderType : null)),
        porDestino: fftAgruparPorCampo(delBin, (r) => (r.fft ? r.fft.destination : null)),
        porCondicion: fftAgruparPorCampo(delBin, (r) => (r.fft ? r.fft.condition : null)),
        porDia: fftAgruparPorDia(delBin),
        porEscaneadora: fftAgruparPorCampo(delBin, (r) => (r.fft ? r.fft.scanner : null)),
        cruceVsSinCruce: [{ nombre: 'Con cruce FFT', pallets: conCruce.length }, { nombre: 'Sin cruce FFT', pallets: sinCruce.length }],
        principalesPedidos: fftAgruparPorCampo(delBin, (r) => (r.fft ? r.fft.orderNumber : null)).slice(0, 10),
      },
      pallets: delBin.map((r) => ({
        palletId: r.palletId,
        piezasInventario: r.inventory.pieces,
        piezasFft: r.fft ? r.fft.pieces : null,
        area: r.inventory.area,
        bin: r.inventory.bin,
        categoria: r.inventory.category,
        destino: r.fft ? r.fft.destination : null,
        tipoPedido: r.fft ? r.fft.orderType : null,
        pedido: r.fft ? r.fft.orderNumber : null,
        escaneadora: r.fft ? r.fft.scanner : null,
        condicion: r.fft ? r.fft.condition : null,
        fecha: r.fft ? r.fft.date : null,
        matchStatus: r.matchStatus,
      })),
    });
  } catch (error) { res.status(error.status || 500).json({ success: false, error: error.message }); }
});

// Tabla/actividad: paginacion, filtros, orden y busqueda EN SERVIDOR sobre el
// conjunto completo ya cruzado — el navegador nunca recibe el dataset entero.
// Extraido a funcion pura (recibe el cruce YA calculado + los query params de
// filtro/paginacion) por el mismo motivo que buildDestinosPayload/buildAreasPayload.
function buildPalletsPayload(registros, query) {
  let filtrados = registros;
  const { area, bin, destino, categoria, tipo, pedido, palletId, escaneadora, condicion, matchStatus, q } = query;
  if (area) filtrados = filtrados.filter((r) => r.inventory && r.inventory.area === area);
  if (bin) filtrados = filtrados.filter((r) => r.inventory && r.inventory.bin === bin);
  if (destino) filtrados = filtrados.filter((r) => r.fft && r.fft.destination === destino);
  if (categoria) filtrados = filtrados.filter((r) => r.inventory && r.inventory.category === categoria);
  if (tipo) filtrados = filtrados.filter((r) => r.fft && r.fft.orderType === tipo);
  if (pedido) filtrados = filtrados.filter((r) => r.fft && r.fft.orderNumber.toLowerCase().includes(String(pedido).toLowerCase()));
  if (palletId) filtrados = filtrados.filter((r) => r.palletId.toLowerCase().includes(String(palletId).toLowerCase()));
  if (escaneadora) filtrados = filtrados.filter((r) => r.fft && r.fft.scanner === escaneadora);
  if (condicion) filtrados = filtrados.filter((r) => r.fft && r.fft.condition === condicion);
  if (matchStatus) filtrados = filtrados.filter((r) => r.matchStatus === matchStatus);
  if (q) {
    const ql = String(q).toLowerCase();
    filtrados = filtrados.filter((r) => r.palletId.toLowerCase().includes(ql) || (r.fft && r.fft.orderNumber.toLowerCase().includes(ql)));
  }

  filtrados = filtrados.slice().sort((a, b) => {
    const ta = a.fft && a.fft.createdAt ? new Date(a.fft.createdAt).getTime() : 0;
    const tb = b.fft && b.fft.createdAt ? new Date(b.fft.createdAt).getTime() : 0;
    return tb - ta;
  });

  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(query.pageSize, 10) || 25));
  const totalRecords = filtrados.length;
  const totalPages = Math.max(1, Math.ceil(totalRecords / pageSize));
  const pageSlice = filtrados.slice((page - 1) * pageSize, page * pageSize);

  const records = pageSlice.map((r) => ({
    palletId: r.palletId,
    area: r.inventory ? r.inventory.area : null,
    bin: r.inventory ? r.inventory.bin : null,
    categoria: r.inventory ? r.inventory.category : null,
    piezasInventario: r.inventory ? r.inventory.pieces : null,
    destino: r.fft ? r.fft.destination : null,
    tipoPedido: r.fft ? r.fft.orderType : null,
    pedido: r.fft ? r.fft.orderNumber : null,
    piezasFft: r.fft ? r.fft.pieces : null,
    escaneadora: r.fft ? r.fft.scanner : null,
    condicion: r.fft ? r.fft.condition : null,
    fecha: r.fft ? r.fft.date : null,
    hora: r.fft && r.fft.createdAt ? r.fft.createdAt : null,
    matchStatus: r.matchStatus,
  }));

  return { records, pagination: { page, pageSize, totalRecords, totalPages } };
}

app.get('/api/dashboard-destinos-fft/pallets', auth, roleGuard('admin'), centroOperativoGuard, async (req, res) => {
  try {
    const { registros } = await construirCruceFft(req.query);
    res.json({ success: true, ...buildPalletsPayload(registros, req.query) });
  } catch (error) { res.status(error.status || 500).json({ success: false, error: error.message }); }
});

// Endpoint UNICO para el Resumen del Dashboard Destinos FFT (auditoria
// 2026-08-10): antes, fftLoad() del frontend disparaba /destinos, /areas y
// /pallets EN PARALELO con el mismo rango de fechas — cada uno llamaba
// construirCruceFft() por su cuenta, y como el cache (fftCruceCache) solo
// guarda el resultado YA terminado (no la promesa en curso), las 3 llegaban
// con el cache frio a la vez y triplicaban el cruce pesado (~35s cada uno)
// en vez de compartirlo — eso es lo que causaba "Tiempo de espera agotado"
// en Resumen. Aqui se llama construirCruceFft() UNA sola vez y se arma la
// respuesta de los 3 con las mismas funciones puras que ya usan los
// endpoints individuales (que se dejan intactos para Areas/Actividad, que
// sí necesitan pedirlos por separado con sus propios filtros/paginacion).
app.get('/api/dashboard-destinos-fft/resumen-completo', auth, roleGuard('admin'), centroOperativoGuard, async (req, res) => {
  try {
    const cruce = await construirCruceFft(req.query);
    res.json({
      success: true,
      destinos: buildDestinosPayload(cruce.registros),
      areas: buildAreasPayload(cruce),
      pallets: buildPalletsPayload(cruce.registros, { ...req.query, page: 1, pageSize: 8 }),
    });
  } catch (error) { res.status(error.status || 500).json({ success: false, error: error.message }); }
});

// Detalle unificado completo de UN PalletID (ambas fuentes + historial FFT +
// productos/SKU via SmartControl si existen + trazabilidad + datos originales
// sin secretos). El PalletID de la URL se trata siempre como texto.
app.get('/api/dashboard-destinos-fft/pallets/:palletId', auth, roleGuard('admin'), centroOperativoGuard, async (req, res) => {
  try {
    let palletIdParam;
    try { palletIdParam = decodeURIComponent(req.params.palletId || '').trim(); } catch (e) { return res.status(400).json({ success: false, error: 'palletId invalido' }); }
    if (!palletIdParam) return res.status(400).json({ success: false, error: 'palletId invalido' });
    const key = palletIdMatchKey(palletIdParam);

    const [{ pallets: inventario }, clasifs] = await Promise.all([
      leerInventarioCubicajeCacheado(),
      Clasif.find({ isActive: true }),
    ]);
    const catalogo = clasifs.map((c) => c.nombre);
    const inv = inventario.find((p) => palletIdMatchKey(p.palletId) === key) || null;
    // `raw` se excluye de la lectura masiva del cache (ver leerInventarioCubicajeCacheado) —
    // aqui, para UN solo pallet, si es barato traerlo.
    const invRaw = inv ? await leerRawInventarioDePallet(inv.palletId) : null;

    const fftDocs = await EscReg.find({ palletId: new RegExp(`^${escapeRegex(palletIdParam)}$`, 'i') }).sort({ createdAt: -1 });
    const fftMasReciente = fftDocs[0] || null;
    const unificado = buildUnifiedRecord(inv, fftMasReciente, catalogo);

    if (!inv && !fftMasReciente) {
      return res.status(404).json({ success: false, error: `PalletID "${palletIdParam}" no se encontro ni en inventario ni en registros FFT` });
    }

    // Productos/SKU/LPN: EscReg no guarda esto — solo existe via el mismo
    // enriquecimiento de SmartControl que ya usa Centro Operativo. Opcional:
    // si SmartControl no responde, el detalle sigue mostrando todo lo demas.
    let productos = [];
    try {
      const pidNorm = normalizePalletId(palletIdParam);
      const enrichment = await getEnrichmentForPallets([pidNorm], false);
      const enr = enrichment.map.get(pidNorm);
      if (enr && enr.productos) productos = enr.productos;
    } catch (e) { /* enriquecimiento opcional */ }

    // Contenido REAL en BinManagerRO (SKU+cantidad+condicion), directo de
    // Cubicaje — auditoria 2026-08-07. Complementa productos (SmartControl):
    // esta fuente es la tarima FISICA reportada por BinManagerRO ahorita
    // mismo, no depende de que SmartControl tenga el LPN indexado.
    const binManagerRO = await fetchCubicajePalletDetail(palletIdParam);

    // Trazabilidad: solo eventos reales, nunca inventados.
    const movimientos = [];
    fftDocs.slice().reverse().forEach((d) => {
      movimientos.push({ evento: 'Registro en FFT', fuente: 'FFT', fecha: d.fecha, hora: d.createdAt ? d.createdAt.toISOString() : null, detalle: `Destino ${d.destino}, turno ${d.turno}` });
    });
    if (inv) {
      movimientos.push({ evento: 'Presente en inventario actual', fuente: 'BinManagerRO', fecha: null, hora: null, detalle: `Bin ${inv.locationName || 'N/D'}, categoria ${inv.binTypeName || 'N/D'}, area ${inv.area || 'N/D'} (${inv.areaFuente})` });
    }

    res.json({
      success: true,
      palletId: unificado.palletId,
      matchStatus: unificado.matchStatus,
      inventory: unificado.inventory,
      fft: unificado.fft,
      fftHistorial: fftDocs.map((d) => ({
        id: String(d._id), destino: d.destino, pedido: d.pedido, cantidad: d.cantidad, condicion: d.condicion,
        escaneadora: d.escaneadora, turno: d.turno, fecha: d.fecha, observaciones: d.observaciones,
        createdAt: d.createdAt ? d.createdAt.toISOString() : null,
      })),
      productos,
      binManagerRO,
      movimientos,
      datosOriginales: {
        inventario: invRaw ? fftLimpiarDatosSensibles(invRaw) : null,
        fft: fftMasReciente ? fftLimpiarDatosSensibles(fftMasReciente) : null,
      },
    });
  } catch (error) { res.status(error.status || 500).json({ success: false, error: error.message }); }
});

// ═══════════ METAS DE PRODUCCION (admin 3647 only) ═══════════
const targetSchema = new mongoose.Schema({
  turno: { type: String, required: true, enum: ['Día', 'Tiempo Extra', 'Noche', 'Global'], unique: true },
  targetPallets: { type: Number, default: 0, min: 0 },
  targetPiezas: { type: Number, default: 0, min: 0 },
  isActive: { type: Boolean, default: true },
  updatedBy: { type: String, default: '' },
}, { timestamps: true });
const ProductionTarget = mongoose.models.ProductionTarget || mongoose.model('ProductionTarget', targetSchema);

app.get('/api/targets', auth, moduleGuard('dashboard'), async (req, res) => {
  try {
    const data = await ProductionTarget.find({});
    res.json({ success: true, data });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.put('/api/targets', auth, roleGuard('admin'), async (req, res) => {
  try {
    if (req.user.usuario !== '3647') return res.status(403).json({ success: false, error: 'Solo admin 3647' });
    const items = Array.isArray(req.body.targets) ? req.body.targets : [req.body];
    const results = [];
    for (const it of items) {
      const turno = it.turno;
      if (!['Día', 'Noche', 'Global'].includes(turno)) continue;
      const tp = parseInt(it.targetPallets, 10), tz = parseInt(it.targetPiezas, 10);
      const targetPallets = Number.isNaN(tp) || tp < 0 ? 0 : tp;
      const targetPiezas = Number.isNaN(tz) || tz < 0 ? 0 : tz;
      const isActive = typeof it.isActive === 'boolean' ? it.isActive : true;
      const doc = await ProductionTarget.findOneAndUpdate(
        { turno },
        { $set: { targetPallets, targetPiezas, isActive, updatedBy: req.user.nombre || req.user.usuario } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      results.push(doc);
    }
    res.json({ success: true, data: results });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// ═══════════ AJUSTES DEL SISTEMA (app_settings) ═══════════
const settingSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, trim: true },
  value: { type: mongoose.Schema.Types.Mixed },
  updatedBy: { type: String, default: '' },
}, { timestamps: true });
const AppSetting = mongoose.models.AppSetting || mongoose.model('AppSetting', settingSchema);

// ═══════════ LPN DUPLICADOS (seguimiento cross-area, solo admin 3647) ═══════════
// Dos tipos, misma coleccion:
// - 'fisico': el LPN esta AHORITA en mas de un bin a la vez (BM.BinContent).
// - 'transferencia': el mismo lote de transferencia masiva pallet-a-pallet
//   se sometio DOS VECES en menos de una hora (BM.ContainerMovements) —
//   caso real que Roman encontro 2026-07-28, causa retrabajo aunque
//   todavia no se vea como duplicado fisico. Ver [[project_mitechpaletizado]].
const lpnDuplicateLocationSchema = new mongoose.Schema({
  binId: Number,
  binCode: String,
  locationId: Number,
  locationName: String,
  warehouseName: String,
  lastMovedBy: String,
  lastMovedDate: Date,
}, { _id: false });
const lpnDuplicateEventSchema = new mongoose.Schema({
  containerMovementId: Number,
  movementDate: Date,
  fromBinCode: String,
  toBinCode: String,
  fromLocationName: String,
  toLocationName: String,
  movementBy: String,
}, { _id: false });
const lpnDuplicateSchema = new mongoose.Schema({
  serialNumber: { type: String, required: true },
  tipo: { type: String, enum: ['fisico', 'transferencia'], required: true, default: 'fisico' },
  productSku: { type: String, default: '' },
  locations: [lpnDuplicateLocationSchema],
  events: [lpnDuplicateEventSchema],
  firstSeenAt: { type: Date, default: Date.now },
  lastSeenAt: { type: Date, default: Date.now },
  // Verificacion en vivo contra SmartControl (appsc.mitechnologiesinc.com,
  // sin el retraso de ~1 dia de BinManagerRO) — se llena en cada /check
  // antes de decidir si vale la pena notificar (ver liveVerifyDuplicate()).
  liveDuplicado: { type: Boolean, default: null },
  liveCheckedAt: Date,
  resuelto: { type: Boolean, default: false },
  resueltoPor: { type: String, default: '' },
  resueltoFecha: Date,
}, { timestamps: true });
lpnDuplicateSchema.index({ serialNumber: 1, tipo: 1 }, { unique: true });
const LpnDuplicate = mongoose.models.LpnDuplicate || mongoose.model('LpnDuplicate', lpnDuplicateSchema);

// Defaults para catalogos (basados en los valores hardcodeados actuales)
const SETTING_DEFAULTS = {
  destinos: ['TRG', 'Almacen', 'FBA'],
  condiciones: ['GRA', 'GRB', 'GRC', 'ICB', 'ICC', 'ICD', 'ICX', 'BOX', 'DNP', 'DMT', 'DMA'],
};
const SETTING_KEYS = Object.keys(SETTING_DEFAULTS);

app.get('/api/settings', auth, async (req, res) => {
  try {
    const docs = await AppSetting.find({});
    const map = {};
    docs.forEach(d => { map[d.key] = d.value; });
    // Rellenar con defaults las keys de catalogo que aun no existan
    for (const k of SETTING_KEYS) { if (map[k] === undefined) map[k] = SETTING_DEFAULTS[k]; }
    res.json({ success: true, data: map });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.put('/api/settings/:key', auth, roleGuard('admin'), async (req, res) => {
  try {
    if (req.user.usuario !== '3647') return res.status(403).json({ success: false, error: 'Solo admin 3647' });
    const key = req.params.key;
    let value = req.body.value;
    // Los catalogos deben ser arrays de strings no vacios y unicos
    if (SETTING_KEYS.includes(key)) {
      if (!Array.isArray(value)) return res.status(400).json({ success: false, error: 'El valor debe ser una lista' });
      value = [...new Set(value.map(v => String(v).trim()).filter(Boolean))];
      if (value.length === 0) return res.status(400).json({ success: false, error: 'La lista no puede quedar vacia' });
    }
    const doc = await AppSetting.findOneAndUpdate(
      { key },
      { $set: { value, updatedBy: req.user.nombre || req.user.usuario } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    res.json({ success: true, data: { key: doc.key, value: doc.value } });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// ═══════════ DIAG NFC (temporary) ═══════════
app.get('/api/diag-nfc', async (req, res) => {
  try {
    if (!seedGuard(req, res)) return;
    const db = mongoose.connection.db;
    const cards = await db.collection('nfc_cards').find({}).toArray();
    const users = await User.find({ role: 'escaneadora' }).select('nombre usuario role isActive _id');
    res.json({ success: true, nfc_cards: cards, escaneadora_users: users, database: db.databaseName });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// ═══════════ SEED (one-time, remove after use) ═══════════
app.get('/api/seed', async (req, res) => {
  try {
    if (!seedGuard(req, res)) return;
    // Drop stale indexes that may conflict (email_1 from old schema)
    try { await mongoose.connection.db.collection('users').dropIndex('email_1'); } catch(e) {}

    const seedUsers = [
      { nombre: 'Administrador',   usuario: '3647',      password: '121101', role: 'admin' },
      { nombre: 'Admin General',   usuario: 'admin',     password: '123456', role: 'admin' },
      // Escaneadoras: acceso por nombre O por numero de empleado
      { nombre: 'Yusley Montes',   usuario: 'yusley',    password: '111111', role: 'escaneadora' },
      { nombre: 'Yusley Montes',   usuario: '1001',      password: '111111', role: 'escaneadora' },
      { nombre: 'Angelica Aleman', usuario: 'angelica',  password: '222222', role: 'escaneadora' },
      { nombre: 'Angelica Aleman', usuario: '1002',      password: '222222', role: 'escaneadora' },
      { nombre: 'Cecilia Perez',   usuario: 'cecilia',   password: '333333', role: 'escaneadora' },
      { nombre: 'Cecilia Perez',   usuario: '1003',      password: '333333', role: 'escaneadora' },
      { nombre: 'Nathalie Lopez',  usuario: 'nathalie',  password: '444444', role: 'escaneadora' },
      { nombre: 'Nathalie Lopez',  usuario: '1004',      password: '444444', role: 'escaneadora' },
      // Viewers: solo dashboard (read-only)
      { nombre: 'Viewer Dashboard', usuario: '2678',     password: 'Sonyqled75', role: 'viewer' },
      { nombre: 'Victor',           usuario: 'victor',   password: '123456',     role: 'viewer' },
      { nombre: 'Brandon',          usuario: 'brandon',  password: 'brandon123', role: 'viewer' },
      // Hector Lider: paso de viewer a escaneadora (modulo de escaneo habilitado via NFC 12:8B:CD:42)
      { nombre: 'Hector Lider',     usuario: 'hector',   password: 'Hector2026!', role: 'escaneadora' },
      // TODO Usuario 2 (modulo escaneadoras) — falta: nombre, usuario, password.
      // Agregar aqui siguiendo el patron de Hector arriba cuando Roman tenga los datos.
    ];
    const results = [];
    for (const u of seedUsers) {
      const exists = await User.findOne({ usuario: u.usuario });
      if (exists) {
        // Update password to ensure it matches
        const hash = await bcrypt.hash(u.password, 10);
        await User.updateOne({ usuario: u.usuario }, { $set: { passwordHash: hash, isActive: true } });
        results.push({ usuario: u.usuario, status: 'updated password' });
        continue;
      }
      const hash = await bcrypt.hash(u.password, 10);
      await User.create({ nombre: u.nombre, usuario: u.usuario, passwordHash: hash, role: u.role, isActive: true });
      results.push({ usuario: u.usuario, status: 'created', role: u.role });
    }
    const total = await User.countDocuments();
    res.json({ success: true, results, totalUsers: total, database: mongoose.connection.db.databaseName });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// ═══════════ SEED NFC (one-time, remove after use) ═══════════
app.get('/api/seed-nfc', async (req, res) => {
  try {
    if (!seedGuard(req, res)) return;
    const db = mongoose.connection.db;
    const col = db.collection('nfc_cards');
    const results = [];

    // Admin 3647 NFC
    const admin = await User.findOne({ usuario: '3647' });
    const adminSerial = '42:3A:D4:42';
    await col.updateOne(
      { serialNumber: adminSerial },
      { $set: { serialNumber: adminSerial, role: 'admin', isActive: true, nombre: 'Administrador', ...(admin ? { userId: admin._id } : {}) }, $setOnInsert: { useCount: 0, createdAt: new Date() } },
      { upsert: true }
    );
    results.push({ serial: adminSerial, nombre: 'Administrador', role: 'admin', linkedUserId: admin?._id || null });

    // Yusley NFC
    const yusley = await User.findOne({ usuario: 'yusley' });
    const yusleySerial = '5A:EF:3B:02';
    await col.updateOne(
      { serialNumber: yusleySerial },
      { $set: { serialNumber: yusleySerial, role: 'escaneadora', isActive: true, nombre: 'Yusley Montes', ...(yusley ? { userId: yusley._id } : {}) }, $setOnInsert: { useCount: 0, createdAt: new Date() } },
      { upsert: true }
    );
    results.push({ serial: yusleySerial, nombre: 'Yusley Montes', role: 'escaneadora', linkedUserId: yusley?._id || null });

    // Hector Lider NFC (escaneadora — modulo de escaneo)
    const hector = await User.findOne({ usuario: 'hector' });
    const hectorSerial = '12:8B:CD:42';
    await col.updateOne(
      { serialNumber: hectorSerial },
      { $set: { serialNumber: hectorSerial, role: 'escaneadora', isActive: true, nombre: 'Hector Lider', ...(hector ? { userId: hector._id } : {}) }, $setOnInsert: { useCount: 0, createdAt: new Date() } },
      { upsert: true }
    );
    results.push({ serial: hectorSerial, nombre: 'Hector Lider', role: 'escaneadora', linkedUserId: hector?._id || null });

    // TODO Usuario 2 (modulo escaneadoras) — falta: NFC serial (PENDIENTE_DE_AGREGAR).
    // Agregar aqui siguiendo el patron de Hector arriba cuando Roman tenga el serial real.

    // Cecilia Perez NFC (escaneadora — ya existia el usuario, solo faltaba la tarjeta)
    const cecilia = await User.findOne({ usuario: 'cecilia' });
    const ceciliaSerial = 'D2:A3:A5:42';
    await col.updateOne(
      { serialNumber: ceciliaSerial },
      { $set: { serialNumber: ceciliaSerial, role: 'escaneadora', isActive: true, nombre: 'Cecilia Perez', ...(cecilia ? { userId: cecilia._id } : {}) }, $setOnInsert: { useCount: 0, createdAt: new Date() } },
      { upsert: true }
    );
    results.push({ serial: ceciliaSerial, nombre: 'Cecilia Perez', role: 'escaneadora', linkedUserId: cecilia?._id || null });

    // Cecilia Perez — segunda tarjeta NFC (misma usuaria, tiene dos)
    const ceciliaSerial2 = '04:A8:68:3A:19:1C:90';
    await col.updateOne(
      { serialNumber: ceciliaSerial2 },
      { $set: { serialNumber: ceciliaSerial2, role: 'escaneadora', isActive: true, nombre: 'Cecilia Perez', ...(cecilia ? { userId: cecilia._id } : {}) }, $setOnInsert: { useCount: 0, createdAt: new Date() } },
      { upsert: true }
    );
    results.push({ serial: ceciliaSerial2, nombre: 'Cecilia Perez', role: 'escaneadora', linkedUserId: cecilia?._id || null });

    const allCards = await col.find({}).toArray();
    res.json({ success: true, results, totalCards: allCards.length, allCards });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// One-off: sube el rol de Hector Lider de viewer a escaneadora (habilita modulo de escaneo).
// El rol efectivo de login viene de User.role, no de nfc_cards.role, asi que este paso
// es necesario ademas de /api/seed-nfc. Idempotente, seguro de llamar mas de una vez.
app.get('/api/setup-hector-escaneadora', async (req, res) => {
  try {
    if (!seedGuard(req, res)) return;
    await User.updateOne({ usuario: 'hector' }, { $set: { role: 'escaneadora' } });
    const user = await User.findOne({ usuario: 'hector' });
    res.json({ success: true, user: { usuario: user.usuario, nombre: user.nombre, role: user.role } });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// ═══════════ MOBILE API ═══════════
app.get('/api/mobile/check/:palletId', async (req, res) => {
  try {
    const doc = await EscReg.findOne({ palletId: req.params.palletId }).sort({ createdAt: -1 });
    res.json({ exists: !!doc, data: doc || null });
  } catch (error) { res.status(500).json({ exists: false, error: error.message }); }
});

app.post('/api/mobile/register', async (req, res) => {
  try {
    const { pallet_id, cantidad, destino, fecha, turno, condicion, operador, pedido, clasificacion } = req.body;
    if (!pallet_id || !destino || !fecha || !turno) return res.status(400).json({ success: false, error: 'Campos requeridos: pallet_id, destino, fecha, turno' });
    const hasPedidoMobile = pedido && pedido.trim();
    if (!hasPedidoMobile && (!condicion || !condicion.trim())) return res.status(400).json({ success: false, error: 'Condicion es obligatoria' });
    const pid = normalizePalletId(pallet_id);
    const dest = normalizeDestino(destino);
    const qty = parseInt(cantidad, 10) || 0;
    if (qty <= 0) return res.status(400).json({ success: false, error: 'Cantidad debe ser mayor a 0' });
    if (pedido && pedido.trim() && !clasificacion) return res.status(400).json({ success: false, error: 'Clasificacion es obligatoria cuando hay pedido' });

    const exists = await EscReg.findOne({ palletId: pid });
    if (exists) {
      emitEvent('paletizado', 'registro:duplicado', { palletId: pid, escaneadora: operador, fecha, source: 'mobile' });
      return res.status(409).json({ success: false, error: `Pallet ${pid} ya registrado`, duplicate: true });
    }

    let obs = '';
    if (clasificacion) { obs = clasificacion === 'BULKY' ? 'LPN | BULKY' : clasificacion; }

    const hasPed = pedido && pedido.trim();
    const doc = await EscReg.create({ palletId: pid, cantidad: qty, condicion: condicion.trim(), destino: dest, turno, escaneadora: operador || '', fecha, pedido: pedido || '', fechaSalida: hasPed ? fecha : '', incidencias: '', observaciones: obs });
    emitEvent('paletizado', 'registro:nuevo', { id: doc._id, palletId: pid, cantidad: qty, destino: dest, turno, escaneadora: operador, fecha, condicion: condicion.trim(), source: 'mobile' });
    res.json({ success: true, id: doc._id, message: 'Registrado desde app movil' });
  } catch (error) {
    emitEvent('paletizado', 'registro:error', { error: error.message, source: 'mobile' });
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/mobile/recent', async (req, res) => {
  try {
    const { operador, limit } = req.query;
    const filter = {};
    if (operador) filter.escaneadora = rx(operador);
    const docs = await EscReg.find(filter).sort({ createdAt: -1 }).limit(parseInt(limit) || 50);
    res.json({ success: true, data: docs, total: docs.length });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.get('/api/mobile/stats', async (req, res) => {
  try {
    const { operador } = req.query;
    const now = new Date();
    const todayStr = `${now.getMonth()+1}/${now.getDate()}/${now.getFullYear()}`;
    const filter = { fecha: todayStr };
    if (operador) filter.escaneadora = rx(operador);
    const todayCount = await EscReg.countDocuments(filter);
    const lastFilter = operador ? { escaneadora: rx(operador) } : {};
    const lastDoc = await EscReg.findOne(lastFilter).sort({ createdAt: -1 });
    const byDestino = await EscReg.aggregate([{ $match: filter }, { $group: { _id: '$destino', total: { $sum: 1 } } }]);
    res.json({
      success: true,
      today: todayCount,
      last: lastDoc ? { pallet_id: lastDoc.palletId, destino: lastDoc.destino, fecha: lastDoc.fecha, turno: lastDoc.turno } : null,
      byDestino: byDestino.map(d => ({ destino: d._id, total: d.total }))
    });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// ═══════════ PUSHER CONFIG (public key only) ═══════════
app.get('/api/realtime-config', (req, res) => {
  if (!process.env.PUSHER_KEY) return res.json({ enabled: false });
  res.json({ enabled: true, key: process.env.PUSHER_KEY, cluster: process.env.PUSHER_CLUSTER || 'us2' });
});

// ═══════════ AUDIT ═══════════
app.get('/api/audit', auth, roleGuard('admin'), async (req, res) => {
  try {
    if (req.user.usuario !== '3647') return res.status(403).json({ success: false, error: 'Solo admin 3647' });
    const { action, escaneadora, palletId, fecha, field, limit } = req.query;
    const filter = { action: { $in: ['UPDATE','DELETE','CORRECTION','MANUAL_EDIT'] } };
    if (action) filter.action = action;
    if (escaneadora) { filter.$or = [{ escaneadora: rx(escaneadora) }, { changedBy: rx(escaneadora) }]; }
    if (palletId) filter.palletId = rx(palletId);
    if (field) filter['changes.field'] = rx(field);
    if (fecha) {
      // Use timezone-aware range: the date string is LOCAL (Mexico CST = UTC-6)
      // Build range from local midnight to local midnight+24h
      const d = new Date(fecha + 'T00:00:00-06:00');
      const next = new Date(d.getTime() + 24*60*60*1000);
      filter.timestamp = { $gte: d, $lt: next };
    }
    const data = await mongoose.connection.db.collection('audit_logs').find(filter).sort({ timestamp: -1 }).limit(parseInt(limit)||500).toArray();
    const total = await mongoose.connection.db.collection('audit_logs').countDocuments(filter);
    res.json({ success: true, data, total });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// Admin correction entry (only admin 3647)
app.post('/api/audit', auth, roleGuard('admin'), async (req, res) => {
  try {
    if (req.user.usuario !== '3647') return res.status(403).json({ success: false, error: 'Solo admin 3647' });
    const { action, palletId, escaneadora, field, oldValue, newValue, reason, source } = req.body;
    const validActions = ['UPDATE', 'DELETE', 'CORRECTION'];
    const act = validActions.includes(action) ? action : 'CORRECTION';
    await audit(act, { palletId, escaneadora, reason, changedBy: req.user.nombre || req.user.usuario, source: source || 'APP',
      changes: field ? [{ field, before: oldValue || '', after: newValue || '' }] : []
    });
    res.json({ success: true, message: 'Correccion registrada' });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// Scan for recent DB changes — auto-detect modifications made outside the API
// (e.g. Atlas UI edits, direct DB updates) and create audit entries for them
app.get('/api/audit/scan', auth, roleGuard('admin'), async (req, res) => {
  try {
    if (req.user.usuario !== '3647') return res.status(403).json({ success: false, error: 'Solo admin 3647' });
    const auditCol = mongoose.connection.db.collection('audit_logs');
    const since = new Date(Date.now() - 24*60*60*1000);
    let detected = 0;

    // 1. Find records where updatedAt != createdAt (modified) in last 24h
    //    that have NO corresponding audit UPDATE entry after their updatedAt
    const modified = await EscReg.find({
      updatedAt: { $gte: since },
      $expr: { $ne: ['$updatedAt', '$createdAt'] }
    }).sort({ updatedAt: -1 }).limit(200);

    for (const rec of modified) {
      // Check if there's already an audit entry for this pallet around this time
      const existing = await auditCol.findOne({
        palletId: rec.palletId,
        action: { $in: ['UPDATE', 'MANUAL_EDIT'] },
        timestamp: { $gte: new Date(rec.updatedAt.getTime() - 60000) } // within 1 min
      });
      if (!existing) {
        await audit('MANUAL_EDIT', {
          palletId: rec.palletId, escaneadora: rec.escaneadora,
          changedBy: 'Detectado automaticamente', source: 'ATLAS',
          reason: 'Modificacion detectada en DB (no hecha via API)',
          changes: [{ field: 'Estado actual', before: '(desconocido)', after: JSON.stringify({ cantidad: rec.cantidad, condicion: rec.condicion, destino: rec.destino, turno: rec.turno }) }]
        });
        detected++;
      }
    }

    res.json({ success: true, detected, scanned: modified.length });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// Audit stats for chart
app.get('/api/audit/stats', auth, roleGuard('admin'), async (req, res) => {
  try {
    if (req.user.usuario !== '3647') return res.status(403).json({ success: false, error: 'Solo admin 3647' });
    const col = mongoose.connection.db.collection('audit_logs');
    const filter = { action: { $in: ['UPDATE','DELETE','CORRECTION','MANUAL_EDIT'] } };
    if (req.query.fecha) {
      const d = new Date(req.query.fecha + 'T00:00:00-06:00');
      const next = new Date(d.getTime() + 24*60*60*1000);
      filter.timestamp = { $gte: d, $lt: next };
    }
    // By escaneadora
    const byEsc = await col.aggregate([
      { $match: filter },
      { $group: { _id: '$escaneadora', total: { $sum: 1 } } },
      { $sort: { total: -1 } }
    ]).toArray();
    // By action
    const byAction = await col.aggregate([
      { $match: filter },
      { $group: { _id: '$action', total: { $sum: 1 } } },
      { $sort: { total: -1 } }
    ]).toArray();
    const total = await col.countDocuments(filter);
    res.json({ success: true, total, byEscaneadora: byEsc, byAction: byAction });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// ═══════════ GLOBAL SEARCH ═══════════
app.get('/api/search', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q || q.length < 2) return res.json({ success: true, data: [], total: 0 });

    // 1. Exact palletId match first
    const exact = await EscReg.find({ palletId: q }).sort({ createdAt: -1 }).limit(5);

    // 2. PalletId starts with query (but not the exact match already collected above)
    const startsWith = await EscReg.find({ palletId: { $regex: '^' + escapeRegex(q), $options: 'i', $ne: q } }).sort({ createdAt: -1 }).limit(20);

    // 3. Broader match (palletId contains, or pedido match)
    const broader = await EscReg.find({
      palletId: { $ne: q },
      $or: [
        { palletId: rx(q) },
        { pedido: rx(q) },
      ]
    }).sort({ createdAt: -1 }).limit(30);

    // Deduplicate by _id, preserve order (exact → startsWith → broader)
    const seen = new Set();
    const data = [];
    for (const arr of [exact, startsWith, broader]) {
      for (const r of arr) {
        const id = r._id.toString();
        if (!seen.has(id)) { seen.add(id); data.push(r); }
      }
    }

    res.json({ success: true, data: data.slice(0, 50), total: data.length });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// ═══════════ HISTORIAL (paginacion real desde backend — sin limite oculto) ═══════════
// mode=registros -> pagina real (page/pageSize) + meta completa (totalRecords/totalDates reales)
// mode=condicion|pedidos -> vistas ya agrupadas por fecha en el frontend; se devuelven completas
//   (limite de seguridad muy por encima del volumen real, en vez del limite fijo de 1000 anterior)
app.get('/api/historial', auth, moduleGuard('dashboard'), async (req, res) => {
  try {
    const {
      mode = 'registros',
      page, pageSize,
      q, fecha, fechaInicio, fechaFin,
      escaneadora, condicion, pedido, turno,
      orden,
    } = req.query;

    const filter = {};
    if (fecha) filter.fecha = fecha; // exact match (compat con el buscador de fecha existente)
    if (escaneadora) filter.escaneadora = rx(escaneadora);
    if (condicion) filter.condicion = rx(condicion);
    if (pedido) filter.pedido = rx(pedido);
    if (turno) filter.turno = rx(turno);
    if (q) {
      filter.$or = [
        { palletId: rx(q) },
        { pedido: rx(q) },
        { escaneadora: rx(q) },
        { condicion: rx(q) },
        { observaciones: rx(q) },
      ];
    }

    const pipeline = [{ $match: filter }, ...fechaDateStages()];
    if (!fecha && (fechaInicio || fechaFin)) {
      pipeline.push({ $match: fechaDateRangeMatch(fechaInicio, fechaFin) });
    }

    let sortStage = { _fechaDate: -1, createdAt: -1 }; // default: fecha descendente (mas nuevo primero)
    if (orden === 'fecha_asc') sortStage = { _fechaDate: 1, createdAt: 1 };
    else if (orden === 'cantidad_desc') sortStage = { cantidad: -1, _fechaDate: -1 };
    else if (orden === 'cantidad_asc') sortStage = { cantidad: 1, _fechaDate: -1 };

    if (mode === 'registros') {
      const pageNum = Math.max(1, parseInt(page) || 1);
      const size = Math.min(1000, Math.max(1, parseInt(pageSize) || 100));

      pipeline.push({
        $facet: {
          data: [{ $sort: sortStage }, { $skip: (pageNum - 1) * size }, { $limit: size }, { $project: { _fechaDate: 0 } }],
          totalCount: [{ $count: 'count' }],
          totalDatesArr: [{ $group: { _id: '$fecha' } }, { $count: 'count' }],
        },
      });

      const [result] = await EscReg.aggregate(pipeline);
      const totalRecords = result.totalCount[0]?.count || 0;
      const totalDates = result.totalDatesArr[0]?.count || 0;
      const totalPages = Math.max(1, Math.ceil(totalRecords / size));
      const data = await EscReg.populate(result.data, { path: 'capturadoPor', select: 'nombre' });

      return res.json({
        success: true,
        data,
        total: totalRecords, // compat con el frontend anterior (resp.total)
        meta: {
          totalRecords,
          currentPage: pageNum,
          pageSize: size,
          totalPages,
          totalDates,
          hasNextPage: pageNum < totalPages,
          hasPrevPage: pageNum > 1,
        },
      });
    }

    // condicion / pedidos: sin paginar (el frontend las agrupa por fecha), pero ya no truncadas a 1000
    pipeline.push({ $sort: sortStage }, { $limit: 20000 }, { $project: { _fechaDate: 0 } });
    const rawData = await EscReg.aggregate(pipeline);
    const data = await EscReg.populate(rawData, { path: 'capturadoPor', select: 'nombre' });
    const total = await EscReg.countDocuments(filter);
    res.json({ success: true, data, total });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// ══════════════════════════════════════════════
// CENTRO OPERATIVO API (solo admin 3647) — modulo independiente. Rediseño 2026-07-31:
// reemplaza el "muestreo de los ultimos N pallets" (temporal, se reiniciaba cada 5 min,
// tope fijo de 20-30) por un ENRIQUECIMIENTO PERSISTENTE por pallet (coleccion Mongo
// PalletEnrichment, arriba en este archivo) que nunca se descarta y crece con el uso:
//
//   1. /resumen, /produccion, /televisiones piden TODOS los palletId que cumplen el
//      filtro (barato: un $group sobre EscReg, solo strings, no documentos completos).
//   2. getEnrichmentForPallets() busca cuales de esos YA estan enriquecidos (lookup
//      local en Mongo, sin tocar SmartControl) y enriquece unos pocos mas de los que
//      faltan en cada request (acotado por tiempo, ver CENTRO_ENRICH_DEADLINE_MS).
//   3. Cada respuesta incluye `cobertura: {enriquecidos, total, porcentaje}` — nunca se
//      presenta un total exacto cuando no lo es, pero a diferencia del muestreo viejo,
//      la cobertura real SUBE con cada visita al modulo hasta llegar a 100%, en vez de
//      quedarse fija para siempre en "20 de 4200".
//   4. Un cron diario (/api/cron/enrich-pallets, ver vercel.json) hace un lote extra
//      cada noche para que la cobertura tambien avance en dias sin uso del modulo
//      (Vercel Hobby solo permite cron 1x/dia — por eso el enriquecimiento "de paso"
//      en cada carga de pagina es la fuente principal de progreso, no el cron).
//
// Arquitectura: frontend -> estas rutas -> EscReg (Mongo, datos propios de esta app,
// exactos) + SmartControl (appsc.mitechnologiesinc.com, en vivo, via scFetchJson/
// fetchScPalletLive) + Cubicaje/BinManagerRO (via X-Integration-Key, servidor-a-servidor,
// nunca desde el navegador — misma llave que ya usan /api/sc-pallets/live y
// /api/lpn-duplicates/check).
// ══════════════════════════════════════════════

function centroOperativoGuard(req, res, next) {
  if (req.user.usuario !== '3647') return res.status(403).json({ success: false, error: 'Solo admin 3647' });
  next();
}

// ── Llamada directa a Cubicaje (server-to-server, misma llave que ya usan los otros
// proxies de este archivo) — para la reconciliacion contra BinManagerRO. ──
async function cubicajeFetch(path, timeoutMs = 8000) {
  const base = process.env.CUBICAJE_API_BASE_URL;
  const key = process.env.CUBICAJE_INTEGRATION_KEY;
  if (!base || !key) return { configured: false, ok: false, data: null, error: 'CUBICAJE_API_BASE_URL/CUBICAJE_INTEGRATION_KEY no configuradas' };
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`${base.replace(/\/$/, '')}${path}`, { headers: { 'X-Integration-Key': key }, signal: controller.signal });
    const data = await resp.json().catch(() => null);
    return { configured: true, ok: resp.ok && data?.success, status: resp.status, data, error: data?.error || (!resp.ok ? `Cubicaje respondio ${resp.status}` : null) };
  } catch (e) {
    return { configured: true, ok: false, data: null, error: e.name === 'AbortError' ? 'Cubicaje no respondio a tiempo' : e.message };
  } finally { clearTimeout(t); }
}
// Busca un palletId EXACTO en BinManagerRO (via el mismo endpoint paginado que usa
// /api/sc-pallets/live) — usa el parametro `search` como prefijo y filtra el exacto.
async function findInBinManagerRO(palletId) {
  const r = await cubicajeFetch(`/api/integrations/live-pallets?search=${encodeURIComponent(palletId)}&limit=5&offset=0`);
  if (!r.ok) return { found: false, configured: r.configured, error: r.error };
  const match = (r.data.data || []).find((row) => normalizePalletId(row.palletId) === palletId);
  return { found: !!match, configured: true, row: match || null };
}

// Filtro Mongo compartido por todos los endpoints de este modulo. `escaneadoras`
// es una lista separada por comas de nombres EXACTOS (vienen del selector multiple,
// poblado con /filtros -> nunca texto libre adivinado).
function buildCentroFilter(query) {
  const { fecha, escaneadoras, turno, condicion, destino, pedido, q, palletId } = query;
  const filter = {};
  if (fecha) filter.fecha = fecha;
  if (escaneadoras) {
    const list = String(escaneadoras).split(',').map((s) => s.trim()).filter(Boolean);
    if (list.length) filter.escaneadora = { $in: list.map((s) => new RegExp(`^${escapeRegex(s)}$`, 'i')) };
  }
  if (turno) filter.turno = rx(turno);
  if (condicion) filter.condicion = rx(condicion);
  if (destino) filter.destino = rx(destino);
  if (pedido) filter.pedido = rx(pedido);
  if (palletId) filter.palletId = rx(palletId);
  if (q) {
    filter.$or = [
      { palletId: rx(q) }, { pedido: rx(q) }, { escaneadora: rx(q) },
      { condicion: rx(q) }, { destino: rx(q) }, { observaciones: rx(q) },
    ];
  }
  return filter;
}

// Aplica el rango de fechas (fecha_inicio/fecha_fin) a un pipeline de aggregate ya
// armado, siguiendo exactamente el patron de /api/historial (fechaDateStages +
// fechaDateRangeMatch) para no reinventar el manejo de fechas string M/D/YYYY.
function applyCentroDateRange(pipeline, query) {
  if (!query.fecha && (query.fecha_inicio || query.fecha_fin)) {
    pipeline.push(...fechaDateStages());
    pipeline.push({ $match: fechaDateRangeMatch(query.fecha_inicio, query.fecha_fin) });
    pipeline.push({ $project: { _fParts: 0, _fY: 0, _fM: 0, _fD: 0, _fechaDate: 0 } });
  }
}

function previousDayFecha(fecha) {
  const d = parseFechaMDY(fecha);
  if (!d) return null;
  d.setDate(d.getDate() - 1);
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}

// ── Estado de conexion de las 2 APIs reales que usa este modulo ──
// Ultimo chequeo EXITOSO por fuente (en memoria del proceso/instancia tibia — se
// pierde en cold start, igual que cualquier otro cache en memoria de este archivo).
// Usado por /estado para no reportar "conectado" solo porque existen env vars, sino
// porque una llamada real respondio bien, con cuando fue y cuanto tardo.
const lastSuccessfulCheck = { smartControl: null, binManagerRO: null, aplicacion: null };

async function checkSourceHealth(name, fn) {
  const t0 = Date.now();
  try {
    const result = await fn();
    const latencyMs = Date.now() - t0;
    lastSuccessfulCheck[name] = new Date().toISOString();
    return { estado: 'ok', latencyMs, ultimaConsultaExitosa: lastSuccessfulCheck[name], ...result };
  } catch (e) {
    return { estado: e.name === 'AbortError' ? 'timeout' : 'error', latencyMs: Date.now() - t0, ultimaConsultaExitosa: lastSuccessfulCheck[name], error: e.message || 'error' };
  }
}
app.get('/api/centro-operativo/estado', auth, roleGuard('admin'), centroOperativoGuard, async (req, res) => {
  const [aplicacion, smartControl, binManagerRO] = await Promise.all([
    checkSourceHealth('aplicacion', async () => {
      const registros = await EscReg.estimatedDocumentCount();
      return { registrosDisponibles: registros };
    }),
    checkSourceHealth('smartControl', async () => {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 6000);
      try {
        const resp = await fetch('https://appsc.mitechnologiesinc.com/', { signal: controller.signal });
        if (!resp.ok && resp.status >= 500) throw new Error(`SmartControl respondio ${resp.status}`);
        return {};
      } finally { clearTimeout(t); }
    }),
    checkSourceHealth('binManagerRO', async () => {
      const base = process.env.CUBICAJE_API_BASE_URL;
      const key = process.env.CUBICAJE_INTEGRATION_KEY;
      if (!base || !key) { const e = new Error('CUBICAJE_API_BASE_URL/CUBICAJE_INTEGRATION_KEY no configuradas'); e.name = 'NotConfigured'; throw e; }
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 6000);
      try {
        const resp = await fetch(`${base.replace(/\/$/, '')}/api/integrations/live-pallets-stats`, { headers: { 'X-Integration-Key': key }, signal: controller.signal });
        const data = await resp.json().catch(() => null);
        if (!resp.ok) throw new Error(resp.status === 401 ? 'Error de autenticacion' : `Cubicaje respondio ${resp.status}`);
        const totalRegistros = (data?.data || []).reduce((s, r) => s + (r.count || 0), 0);
        return { registrosDisponibles: totalRegistros };
      } finally { clearTimeout(t); }
    }),
  ]);
  if (binManagerRO.error === 'CUBICAJE_API_BASE_URL/CUBICAJE_INTEGRATION_KEY no configuradas') binManagerRO.estado = 'no_configurado';

  const [enrichStats] = await Promise.all([PalletEnrichment.estimatedDocumentCount()]);
  const conectadas = [aplicacion, smartControl, binManagerRO].filter((s) => s.estado === 'ok').length;

  res.json({
    success: true,
    fuentesConectadas: conectadas,
    fuentesTotal: 3,
    fuentes: { aplicacion, smartControl, binManagerRO },
    palletsEnriquecidos: enrichStats,
    timestamp: new Date().toISOString(),
  });
});

// ── Valores reales para poblar los selectores de filtro (nunca texto escrito a mano) ──
app.get('/api/centro-operativo/filtros', auth, roleGuard('admin'), centroOperativoGuard, async (req, res) => {
  try {
    const [escaneadoras, turnos, condiciones, destinos] = await Promise.all([
      EscReg.distinct('escaneadora'),
      EscReg.distinct('turno'),
      EscReg.distinct('condicion'),
      EscReg.distinct('destino'),
    ]);
    res.json({
      success: true,
      escaneadoras: escaneadoras.filter(Boolean).sort(),
      turnos: turnos.filter(Boolean).sort(),
      condiciones: condiciones.filter(Boolean).sort(),
      destinos: destinos.filter(Boolean).sort(),
      // Workcenter NO se guarda en EscReg (solo vive en vivo en SmartControl por pallet) —
      // no hay un catalogo real de donde sacar esta lista sin muestrear primero.
      workcenters: [],
      workcentersDisponible: false,
    });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

async function classifyLpn(lpn) {
  const raw = await scFetchJson(`https://appsc.mitechnologiesinc.com/Classification/GetDataLicensePlateNumber_ApiAR?LPN=${encodeURIComponent(lpn)}`, 7000);
  const arr = scTryParse(raw.WorkPlanLicensePlateNumber) || [];
  return Array.isArray(arr) ? arr[0] : null;
}

// Enriquece UN pallet contra SmartControl y lo guarda PERMANENTEMENTE en
// PalletEnrichment (a diferencia del muestreo viejo, esto nunca se descarta ni
// expira — la proxima vez que se pida este pallet, ya esta resuelto sin tocar
// SmartControl). Usado tanto por las rutas bajo demanda como por el cron nocturno.
async function enrichOnePallet(palletId) {
  const now = new Date();
  try {
    const live = await fetchScPalletLive(palletId);
    const productos = live.productos || [];
    const candidatosPorProducto = productos.map((p) => p.NumeroSerie).filter(Boolean);
    const infoPorLpn = new Map();
    await Promise.all(candidatosPorProducto.map(async (lpn) => {
      try { infoPorLpn.set(lpn, await classifyLpn(lpn)); } catch { infoPorLpn.set(lpn, null); }
    }));
    const enriquecidos = productos.map((p) => {
      const info = p.NumeroSerie ? infoPorLpn.get(p.NumeroSerie) : null;
      return {
        lpn: p.NumeroSerie || null,
        sku: (info && info.SKU) || p.SKU || null,
        marca: info ? normalizeBrand(info.Brand) : null,
        modelo: info ? normalizeModelo(info.MFGSKU) : null,
        pulgadas: info ? parseInchesFromDescription(info.ItemDescription) : null,
        tvTypeTags: info ? parseTvTypeTags(info.ItemDescription) : [],
        condicion: p.Condicion || null,
      };
    });
    const doc = {
      palletId, foundInSmartControl: true,
      workcenter: live.workcenter || null,
      cantidadTotalSc: live.cantidadTotal ?? null,
      condicionesSc: live.condiciones || null,
      ubicacionSc: live.ubicacion || null,
      lpns: [...dedupeUniqueLpns(productos.map((p) => p.NumeroSerie))],
      productos: enriquecidos,
      marcas: [...new Set(enriquecidos.map((e) => e.marca).filter(Boolean))],
      modelos: [...new Set(enriquecidos.map((e) => e.modelo).filter(Boolean))],
      pulgadas: [...new Set(enriquecidos.map((e) => e.pulgadas).filter(Boolean))],
      tvTypeTags: [...new Set(enriquecidos.flatMap((e) => e.tvTypeTags))],
      lastSyncedAt: now, syncError: '',
    };
    await PalletEnrichment.findOneAndUpdate({ palletId }, { $set: doc }, { upsert: true, setDefaultsOnInsert: true });
    return doc;
  } catch (e) {
    await PalletEnrichment.findOneAndUpdate(
      { palletId },
      { $set: { palletId, lastSyncedAt: now, syncError: e.message || 'error desconocido' }, $setOnInsert: { foundInSmartControl: false } },
      { upsert: true, setDefaultsOnInsert: true },
    );
    return null;
  }
}

// Cuantos pallets NUEVOS se enriquecen "de paso" por request. Acotado para no
// arriesgar el timeout de la funcion (mismo principio que ya causo el incidente de
// /api/lpn-duplicates/check) — pero a diferencia del muestreo viejo, este trabajo es
// INCREMENTAL Y PERMANENTE: cada visita al modulo deja mas pallets resueltos para
// siempre, la cobertura solo sube. Medido contra produccion: con BATCH=15 cada
// llamada tardaba ~13s (aceptable una vez, pero /resumen+/produccion+/televisiones
// lo hacian los 3 por separado en la MISMA carga de pagina = ~40s combinados). Por
// eso SOLO /resumen enriquece pallets nuevos (una vez por carga); /produccion y
// /televisiones leen nada mas lo que ya esta en cache (instantaneo).
const CENTRO_ENRICH_BATCH = 8;
const CENTRO_ENRICH_DEADLINE_MS = 4000;

// Dado un arreglo de palletId (puede ser TODO el filtro, miles de ids — son solo
// strings, barato), regresa el enriquecimiento ya conocido y, si `allowNew` es true,
// enriquece un lote nuevo de los que faltan. `cobertura` refleja el estado real,
// nunca se disfraza de exacto.
async function getEnrichmentForPallets(palletIds, allowNew = true) {
  if (palletIds.length === 0) return { map: new Map(), total: 0, enriquecidos: 0, nuevos: 0, agotado: false, cobertura: 100 };
  const existentes = await PalletEnrichment.find({ palletId: { $in: palletIds } }).lean();
  const map = new Map(existentes.map((e) => [e.palletId, e]));
  const faltantes = palletIds.filter((pid) => !map.has(pid));

  let nuevos = 0, agotado = false;
  if (allowNew) {
    const aEnriquecerAhora = faltantes.slice(0, CENTRO_ENRICH_BATCH);
    const deadline = Date.now() + CENTRO_ENRICH_DEADLINE_MS;
    const BATCH = 8;
    for (let i = 0; i < aEnriquecerAhora.length; i += BATCH) {
      if (Date.now() > deadline) { agotado = true; break; }
      const lote = aEnriquecerAhora.slice(i, i + BATCH);
      const resultados = await Promise.all(lote.map((pid) => enrichOnePallet(pid)));
      resultados.forEach((doc, idx) => { if (doc) { map.set(lote[idx], doc); nuevos++; } });
    }
    if (faltantes.length > aEnriquecerAhora.length) agotado = true;
  }

  const enriquecidos = [...palletIds].filter((pid) => map.has(pid) && map.get(pid).foundInSmartControl).length;
  return {
    map, total: palletIds.length, enriquecidos, nuevos,
    agotado,
    cobertura: palletIds.length > 0 ? Number(((enriquecidos / palletIds.length) * 100).toFixed(1)) : 100,
  };
}

// Trae TODOS los palletId distintos que cumplen el filtro (barato: solo strings, no
// documentos completos) + sus metadatos de EscReg (cantidad sumada, campos mas
// recientes) — reemplaza el tope fijo de 500/20 registros del enfoque anterior.
// La deduplicacion por palletId (un pallet puede tener mas de un registro por
// correcciones) se hace DENTRO de Mongo via $group ($last tras $sort para los campos
// descriptivos, $sum para cantidad) — no se traen registros crudos para reducirlos en
// Node. Con filtros amplios/sin fecha (miles de registros) traer documentos completos
// sin reducir del lado del servidor fue exactamente el mismo problema ya encontrado y
// corregido en /exportar y en el muestreo viejo — aqui se evita desde el diseño.
async function getFilteredPalletsMeta(filter, query) {
  const pipeline = [{ $match: filter }];
  applyCentroDateRange(pipeline, query);
  pipeline.push(
    { $sort: { createdAt: -1 } },
    { $group: {
        _id: '$palletId',
        cantidad: { $sum: '$cantidad' },
        escaneadora: { $first: '$escaneadora' },
        turno: { $first: '$turno' },
        condicion: { $first: '$condicion' },
        destino: { $first: '$destino' },
        pedido: { $first: '$pedido' },
        fecha: { $first: '$fecha' },
        // Aditivo para Dashboard Destinos FFT (normalizeOrderType necesita el primer
        // token de observaciones) — no afecta a los callers existentes, que ya ignoran
        // campos extra en el objeto que arma este mismo loop.
        observaciones: { $first: '$observaciones' },
        createdAt: { $first: '$createdAt' },
    } },
  );
  const grupos = await EscReg.aggregate(pipeline);
  const porPallet = new Map();
  const orden = [];
  for (const g of grupos) {
    const pid = normalizePalletId(g._id);
    if (!pid) continue;
    porPallet.set(pid, { cantidad: g.cantidad, escaneadora: g.escaneadora, turno: g.turno, condicion: g.condicion, destino: g.destino, pedido: g.pedido, fecha: g.fecha, observaciones: g.observaciones, createdAt: g.createdAt });
    orden.push(pid);
  }
  return { orden, porPallet };
}

// Combina metadatos de EscReg (exactos) + enriquecimiento SmartControl (persistente,
// cobertura creciente) en una sola lista por pallet — usado por /resumen, /produccion
// y /televisiones para no repetir esta fusion 3 veces.
async function buildEnrichedPalletList(filter, query, allowNew = true) {
  const { orden, porPallet } = await getFilteredPalletsMeta(filter, query);
  const enrichment = await getEnrichmentForPallets(orden, allowNew);
  const perPallet = orden.map((pid) => {
    const meta = porPallet.get(pid);
    const enr = enrichment.map.get(pid);
    return {
      palletId: pid, cantidad: meta.cantidad, escaneadora: meta.escaneadora, turno: meta.turno,
      condicion: meta.condicion, destino: meta.destino, pedido: meta.pedido, fecha: meta.fecha,
      workcenter: enr?.workcenter || null,
      lpns: enr?.lpns || [],
      lpnCount: enr?.lpns?.length || 0,
      marca: enr?.marcas?.[0] || null,
      marcas: enr?.marcas || [],
      modelo: enr?.modelos?.[0] || null,
      modelos: enr?.modelos || [],
      pulgadas: enr?.pulgadas || [],
      tvTypeTags: enr?.tvTypeTags || [],
      productos: enr?.productos || [],
      identificado: !!(enr && enr.foundInSmartControl && enr.marcas && enr.marcas.length),
      enriquecido: !!enr,
    };
  });
  return {
    perPallet,
    cobertura: { total: enrichment.total, enriquecidos: enrichment.enriquecidos, nuevos: enrichment.nuevos, porcentaje: enrichment.cobertura, agotado: enrichment.agotado },
  };
}

// ── Fuentes de datos: reconciliacion Aplicacion vs SmartControl vs BinManagerRO ──
// Acotado a una PAGINA de pallets del filtro actual (no todo el historico) — cada fila
// implica 1 lookup a BinManagerRO (barato, pero no gratis a miles); el enriquecimiento de
// SmartControl reusa el cache persistente igual que /pallets. `modo` filtra el resultado
// ya calculado (todas/coincide/diferencia/incompleto), no cambia lo que se consulta.
app.get('/api/centro-operativo/sources', auth, roleGuard('admin'), centroOperativoGuard, async (req, res) => {
  try {
    const filter = buildCentroFilter(req.query);
    const pageNum = Math.max(1, parseInt(req.query.page) || 1);
    const size = Math.min(50, Math.max(1, parseInt(req.query.pageSize) || 20));
    const pipeline = [{ $match: filter }];
    applyCentroDateRange(pipeline, req.query);
    pipeline.push({
      $facet: {
        data: [{ $sort: { createdAt: -1 } }, { $skip: (pageNum - 1) * size }, { $limit: size }],
        totalCount: [{ $count: 'count' }],
      },
    });
    const [result] = await EscReg.aggregate(pipeline);
    const totalRecords = result.totalCount[0]?.count || 0;
    const registros = result.data;
    const palletIds = registros.map((r) => normalizePalletId(r.palletId)).filter(Boolean);

    const [{ map: enrichMap }, bmroResults] = await Promise.all([
      getEnrichmentForPallets(palletIds),
      Promise.all(palletIds.map((pid) => findInBinManagerRO(pid).catch(() => ({ found: false, configured: false })))),
    ]);
    const bmroByPallet = new Map(palletIds.map((pid, i) => [pid, bmroResults[i]]));

    let coincide = 0, diferencia = 0, incompleto = 0;
    const filas = registros.map((r) => {
      const pid = normalizePalletId(r.palletId);
      const enr = enrichMap.get(pid);
      const bmro = bmroByPallet.get(pid);
      const scCantidad = enr?.cantidadTotalSc ?? null;
      const bmCantidad = bmro?.row?.cantidadTotal ?? null;
      const valores = [r.cantidad, scCantidad, bmCantidad].filter((v) => v != null);
      let estado;
      if (valores.length < 2) estado = 'Incompleto';
      else estado = new Set(valores.map(String)).size === 1 ? 'Coincide' : 'Diferencia';
      if (estado === 'Coincide') coincide++; else if (estado === 'Diferencia') diferencia++; else incompleto++;
      return {
        palletId: r.palletId,
        aplicacion: { presente: true, cantidad: r.cantidad, condicion: r.condicion, destino: r.destino },
        smartControl: enr ? { presente: enr.foundInSmartControl, cantidad: scCantidad, condicion: enr.condicionesSc, workcenter: enr.workcenter } : { presente: false },
        binManagerRO: bmro?.configured === false ? { presente: false, noConfigurado: true } : { presente: !!bmro?.found, cantidad: bmCantidad, categoria: bmro?.row?.binTypeName ?? null, ubicacion: bmro?.row?.locationName ?? null },
        estado,
      };
    });

    const modo = req.query.modo;
    const filasFiltradas = modo && modo !== 'todas'
      ? filas.filter((f) => (modo === 'coincide' && f.estado === 'Coincide') || (modo === 'diferencia' && f.estado === 'Diferencia') || (modo === 'incompleto' && f.estado === 'Incompleto'))
      : filas;

    res.json({
      success: true,
      filas: filasFiltradas,
      resumen: { coincide, diferencia, incompleto, totalPagina: filas.length },
      total: totalRecords,
      meta: { totalRecords, currentPage: pageNum, pageSize: size, totalPages: Math.max(1, Math.ceil(totalRecords / size)) },
    });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// ── KPIs principales (2 filas de 6) ──
app.get('/api/centro-operativo/resumen', auth, roleGuard('admin'), centroOperativoGuard, async (req, res) => {
  try {
    const filter = buildCentroFilter(req.query);

    async function kpisBase(baseFilter, query) {
      const pipeline = [{ $match: baseFilter }];
      applyCentroDateRange(pipeline, query);
      pipeline.push({ $group: {
        _id: null,
        pallets: { $addToSet: '$palletId' },
        piezas: { $sum: '$cantidad' },
        escaneadoras: { $addToSet: '$escaneadora' },
        pedidos: { $addToSet: { $cond: [{ $and: [{ $ne: ['$pedido', ''] }, { $ne: ['$pedido', null] }] }, '$pedido', '$$REMOVE'] } },
        registrosIncompletos: { $sum: { $cond: [{ $or: [{ $eq: ['$condicion', ''] }, { $lte: ['$cantidad', 0] }] }, 1, 0] } },
        primeraFecha: { $min: '$createdAt' },
        ultimaFecha: { $max: '$createdAt' },
        totalRegistros: { $sum: 1 },
      } });
      const [r] = await EscReg.aggregate(pipeline);
      if (!r) return { totalPallets: 0, totalPiezas: 0, escaneadorasActivas: 0, pedidosTrabajados: 0, registrosIncompletos: 0, promedioPorPallet: 0, produccionPorHora: 0 };
      const totalPallets = r.pallets.filter(Boolean).length;
      const totalPiezas = r.piezas || 0;
      const horas = r.primeraFecha && r.ultimaFecha
        ? Math.max(1, (new Date(r.ultimaFecha) - new Date(r.primeraFecha)) / (1000 * 60 * 60))
        : 1;
      return {
        totalPallets,
        totalPiezas,
        escaneadorasActivas: r.escaneadoras.filter(Boolean).length,
        pedidosTrabajados: r.pedidos.length,
        registrosIncompletos: r.registrosIncompletos || 0,
        promedioPorPallet: Number(safeDivide(totalPiezas, totalPallets).toFixed(2)),
        produccionPorHora: Number(safeDivide(totalPiezas, horas).toFixed(1)),
      };
    }

    const actual = await kpisBase(filter, req.query);
    const { perPallet, cobertura } = await buildEnrichedPalletList(filter, req.query);
    const marcas = new Set(), modelos = new Set(), pulgadas = new Set(), workcenters = new Set(), lpns = new Set();
    for (const p of perPallet) {
      if (p.marca) marcas.add(p.marca);
      if (p.modelo) modelos.add(p.modelo);
      for (const pu of p.pulgadas) pulgadas.add(pu);
      if (p.workcenter) workcenters.add(p.workcenter);
      for (const l of p.lpns) lpns.add(l);
    }

    // Comparacion "vs dia anterior": solo cuando el filtro es UN dia exacto (no rango, no
    // multi-dia) — con un rango no hay un "dia anterior" unico y correcto que comparar.
    let anterior = null;
    if (req.query.fecha) {
      const fechaPrev = previousDayFecha(req.query.fecha);
      if (fechaPrev) {
        const filtroPrev = buildCentroFilter({ ...req.query, fecha: fechaPrev });
        anterior = await kpisBase(filtroPrev, { ...req.query, fecha: fechaPrev });
      }
    }
    const delta = (key) => anterior ? computeDelta(actual[key], anterior[key]) : null;
    const parcial = cobertura.porcentaje < 100;

    res.json({
      success: true,
      kpis: {
        totalPallets: { value: actual.totalPallets, deltaPct: delta('totalPallets') },
        totalPiezas: { value: actual.totalPiezas, deltaPct: delta('totalPiezas') },
        lpnUnicos: { value: lpns.size, deltaPct: null, parcial },
        escaneadorasActivas: { value: actual.escaneadorasActivas, deltaPct: delta('escaneadorasActivas') },
        marcasProcesadas: { value: marcas.size, deltaPct: null, parcial },
        modelosProcesados: { value: modelos.size, deltaPct: null, parcial },
        pulgadasDiferentes: { value: pulgadas.size, deltaPct: null, parcial },
        pedidosTrabajados: { value: actual.pedidosTrabajados, deltaPct: delta('pedidosTrabajados') },
        promedioPorPallet: { value: actual.promedioPorPallet, deltaPct: delta('promedioPorPallet') },
        produccionPorHora: { value: actual.produccionPorHora, deltaPct: delta('produccionPorHora') },
        workcentersActivos: { value: workcenters.size, deltaPct: null, parcial },
        registrosIncompletos: { value: actual.registrosIncompletos, deltaPct: delta('registrosIncompletos') },
      },
      cobertura,
      deltaDisponible: !!anterior,
    });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// ── Graficas operativas: por escaneadora, por hora, por condicion, por destino ──
app.get('/api/centro-operativo/produccion', auth, roleGuard('admin'), centroOperativoGuard, async (req, res) => {
  try {
    const filter = buildCentroFilter(req.query);

    const porCondicionPipeline = [{ $match: filter }];
    applyCentroDateRange(porCondicionPipeline, req.query);
    porCondicionPipeline.push({ $group: { _id: { $ifNull: ['$condicion', 'Sin condicion'] }, piezas: { $sum: '$cantidad' } } }, { $sort: { piezas: -1 } });

    const porDestinoPipeline = [{ $match: filter }];
    applyCentroDateRange(porDestinoPipeline, req.query);
    porDestinoPipeline.push({ $group: { _id: { $ifNull: ['$destino', 'Sin destino'] }, piezas: { $sum: '$cantidad' } } }, { $sort: { piezas: -1 } });

    // Piezas por hora del dia (0-23, tz Mexico), separado dia/noche usando las mismas
    // franjas reales ya establecidas en el resto de la app (calcTurnoFromHour): Dia+Extra
    // (7:00-22:00) se muestran como "Dia", el resto (22:00-7:00) como "Noche" — 2 series,
    // como pide el modulo, en vez de las 3 franjas internas de negocio.
    const porHoraPipeline = [{ $match: filter }];
    applyCentroDateRange(porHoraPipeline, req.query);
    porHoraPipeline.push(
      { $addFields: { hora: { $hour: { date: '$createdAt', timezone: 'America/Mexico_City' } } } },
      { $group: {
          _id: '$hora',
          dia: { $sum: { $cond: [{ $and: [{ $gte: ['$hora', 7] }, { $lt: ['$hora', 22] }] }, '$cantidad', 0] } },
          noche: { $sum: { $cond: [{ $or: [{ $gte: ['$hora', 22] }, { $lt: ['$hora', 7] }] }, '$cantidad', 0] } },
      } },
      { $sort: { _id: 1 } },
    );

    const [porCondicion, porDestino, porHoraRaw] = await Promise.all([
      EscReg.aggregate(porCondicionPipeline),
      EscReg.aggregate(porDestinoPipeline),
      EscReg.aggregate(porHoraPipeline),
    ]);
    const totalCond = porCondicion.reduce((s, c) => s + c.piezas, 0);
    const totalDest = porDestino.reduce((s, c) => s + c.piezas, 0);
    const porHora = Array.from({ length: 24 }, (_, h) => {
      const row = porHoraRaw.find((r) => r._id === h);
      return { hora: h, dia: row?.dia || 0, noche: row?.noche || 0 };
    });

    // Produccion por escaneadora (piezas/pallets exactos de Mongo; LPN unicos/modelos
    // vienen del enriquecimiento persistente — cobertura crece con el uso, nunca se reinicia).
    const porEscPipeline = [{ $match: filter }];
    applyCentroDateRange(porEscPipeline, req.query);
    porEscPipeline.push({ $group: { _id: '$escaneadora', piezas: { $sum: '$cantidad' }, pallets: { $addToSet: '$palletId' } } });
    const porEscRaw = await EscReg.aggregate(porEscPipeline);

    // allowNew=false: solo /resumen enriquece pallets nuevos (una vez por carga de
    // pagina) — este endpoint solo lee lo que ya esta en cache, para no repetir el
    // costo de SmartControl 3 veces en la misma carga.
    const { perPallet, cobertura } = await buildEnrichedPalletList(filter, req.query, false);
    const lpnPorEsc = new Map(), modelosPorEsc = new Map(), pedidosPorEsc = new Map();
    // porDia/porWorkcenter: derivados del MISMO perPallet ya cargado arriba (cero
    // consultas nuevas a Mongo/SmartControl) — alimentan la pestaña "Produccion"
    // (tendencia diaria/semanal, produccion por workcenter) sin tocar los campos
    // existentes de esta respuesta.
    const porDiaMap = new Map(), porWorkcenterMap = new Map();
    for (const p of perPallet) {
      if (p.escaneadora) {
        if (!lpnPorEsc.has(p.escaneadora)) { lpnPorEsc.set(p.escaneadora, new Set()); modelosPorEsc.set(p.escaneadora, new Set()); pedidosPorEsc.set(p.escaneadora, new Set()); }
        for (const l of p.lpns) lpnPorEsc.get(p.escaneadora).add(l);
        for (const m of p.modelos) modelosPorEsc.get(p.escaneadora).add(m);
        if (p.pedido) pedidosPorEsc.get(p.escaneadora).add(p.pedido);
      }
      if (p.fecha) {
        const d = porDiaMap.get(p.fecha) || { piezas: 0, pallets: 0 };
        d.piezas += p.cantidad || 0; d.pallets += 1;
        porDiaMap.set(p.fecha, d);
      }
      if (p.workcenter) {
        porWorkcenterMap.set(p.workcenter, (porWorkcenterMap.get(p.workcenter) || 0) + (p.cantidad || 0));
      }
    }

    const porEscaneadora = porEscRaw
      .map((r) => ({
        escaneadora: r._id || 'Sin asignar',
        piezas: r.piezas,
        pallets: r.pallets.filter(Boolean).length,
        lpnUnicos: lpnPorEsc.get(r._id)?.size ?? 0,
        modelos: modelosPorEsc.get(r._id)?.size ?? 0,
        pedidos: pedidosPorEsc.get(r._id)?.size ?? 0,
      }))
      .sort((a, b) => b.piezas - a.piezas);

    // Solo se envia porDia cuando el filtro cubre mas de un dia — con un solo dia
    // no hay "tendencia" que mostrar y se evita mandar un arreglo de 1 elemento.
    const porDia = porDiaMap.size > 1
      ? [...porDiaMap.entries()].map(([fecha, v]) => ({ fecha, ...v })).sort((a, b) => parseFechaMDY(a.fecha) - parseFechaMDY(b.fecha))
      : [];
    const porWorkcenter = [...porWorkcenterMap.entries()]
      .map(([workcenter, piezas]) => ({ workcenter, piezas }))
      .sort((a, b) => b.piezas - a.piezas);

    res.json({
      success: true,
      porEscaneadora,
      porHora,
      porCondicion: porCondicion.map((c) => ({ condicion: c._id, piezas: c.piezas, porcentaje: totalCond > 0 ? (c.piezas / totalCond) * 100 : 0 })),
      porDestino: porDestino.map((d) => ({ destino: d._id, piezas: d.piezas, porcentaje: totalDest > 0 ? (d.piezas / totalDest) * 100 : 0 })),
      porDia,
      porWorkcenter,
      cobertura,
    });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// ── Resumen de televisiones: por marca, por modelo, por pulgadas, por tipo ──
// Trabaja sobre PRODUCTOS individuales (cada TV real, no un representante por pallet) —
// asi un pallet mixto aporta correctamente a varias marcas/modelos/pulgadas a la vez.
app.get('/api/centro-operativo/televisiones', auth, roleGuard('admin'), centroOperativoGuard, async (req, res) => {
  try {
    const filter = buildCentroFilter(req.query);
    // allowNew=false: mismo motivo que /produccion — solo /resumen paga el costo de
    // enriquecer pallets nuevos por carga de pagina.
    const { perPallet, cobertura } = await buildEnrichedPalletList(filter, req.query, false);
    // Aplana: cada producto identificado de cada pallet enriquecido = 1 pieza real.
    const productosIdentificados = [];
    for (const p of perPallet) {
      for (const prod of p.productos) {
        if (prod.marca) productosIdentificados.push({ ...prod, palletId: p.palletId });
      }
    }

    const porMarcaGrupos = groupByFoldingCase(productosIdentificados, (p) => p.marca);
    const porMarca = porMarcaGrupos.map((g) => ({
      marca: g.key,
      piezas: g.total,
      pallets: new Set(g.items.map((i) => i.palletId)).size,
      modelos: new Set(g.items.map((i) => i.modelo)).size,
      pulgadas: [...new Set(g.items.map((i) => i.pulgadas).filter(Boolean))].sort((a, b) => a - b),
      porcentaje: g.porcentaje,
    }));

    const porModeloGrupos = groupByFoldingCase(productosIdentificados, (p) => `${p.marca}|${p.modelo}`);
    const porModelo = porModeloGrupos.map((g) => {
      const [marca, modelo] = g.key.split('|');
      return {
        marca, modelo,
        pulgadas: g.items[0]?.pulgadas ?? null,
        sku: g.items[0]?.sku ?? null,
        piezas: g.total,
        pallets: new Set(g.items.map((i) => i.palletId)).size,
        porcentaje: g.porcentaje,
      };
    });

    const porPulgadasGrupos = groupBy(productosIdentificados.filter((p) => p.pulgadas), (p) => p.pulgadas);
    const sinPulgadas = productosIdentificados.filter((p) => !p.pulgadas).length;
    const totalPulgadasPiezas = porPulgadasGrupos.reduce((s, g) => s + g.total, 0) + sinPulgadas;
    const porPulgadas = porPulgadasGrupos
      .sort((a, b) => a.key - b.key)
      .map((g) => ({ pulgadas: g.key, piezas: g.total, porcentaje: totalPulgadasPiezas > 0 ? (g.total / totalPulgadasPiezas) * 100 : 0 }));
    if (sinPulgadas > 0) porPulgadas.push({ pulgadas: null, label: 'Sin identificar', piezas: sinPulgadas, porcentaje: totalPulgadasPiezas > 0 ? (sinPulgadas / totalPulgadasPiezas) * 100 : 0 });

    // Tipo de panel/resolucion: parseado de la descripcion real, nunca inventado — cada
    // producto puede aportar varios tags (ej. '4K' y 'LED' a la vez).
    const tipoCount = new Map();
    for (const p of productosIdentificados) for (const tag of p.tvTypeTags) tipoCount.set(tag, (tipoCount.get(tag) || 0) + 1);
    const porTipo = [...tipoCount.entries()].sort((a, b) => b[1] - a[1]).map(([tipo, piezas]) => ({ tipo, piezas }));

    res.json({
      success: true,
      porMarca, porModelo, porPulgadas, porTipo,
      totalTelevisiones: productosIdentificados.length,
      cobertura,
    });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// ── Pallets recientes: paginado server-side (mismo patron que /api/historial) ──
app.get('/api/centro-operativo/pallets', auth, roleGuard('admin'), centroOperativoGuard, async (req, res) => {
  try {
    const filter = buildCentroFilter(req.query);
    const pageNum = Math.max(1, parseInt(req.query.page) || 1);
    const size = Math.min(200, Math.max(1, parseInt(req.query.pageSize) || 25));
    const orden = req.query.orden;
    let sortStage = { createdAt: -1 };
    if (orden === 'fecha_asc') sortStage = { createdAt: 1 };
    else if (orden === 'cantidad_desc') sortStage = { cantidad: -1, createdAt: -1 };
    else if (orden === 'cantidad_asc') sortStage = { cantidad: 1, createdAt: -1 };

    const pipeline = [{ $match: filter }];
    applyCentroDateRange(pipeline, req.query);
    pipeline.push({
      $facet: {
        data: [{ $sort: sortStage }, { $skip: (pageNum - 1) * size }, { $limit: size }],
        totalCount: [{ $count: 'count' }],
      },
    });
    const [result] = await EscReg.aggregate(pipeline);
    const totalRecords = result.totalCount[0]?.count || 0;
    const totalPages = Math.max(1, Math.ceil(totalRecords / size));

    // Enriquecer la pagina visible (25-200 filas) contra el cache PERSISTENTE — si ya
    // se enriquecio antes (por este modulo o por el cron), no vuelve a tocar SmartControl.
    // Solo las filas realmente nuevas disparan una llamada en vivo (acotado, ver
    // getEnrichmentForPallets) — y ese trabajo queda guardado para siempre.
    const palletIdsPagina = result.data.map((r) => normalizePalletId(r.palletId)).filter(Boolean);
    const { map: enrichMap } = await getEnrichmentForPallets(palletIdsPagina);
    const enriquecidos = result.data.map((r) => {
      const pid = normalizePalletId(r.palletId);
      const enr = enrichMap.get(pid);
      const skuCount = enr ? new Set((enr.productos || []).map((p) => p.sku).filter(Boolean)).size : null;
      return {
        palletId: r.palletId, fecha: r.fecha, hora: r.createdAt, cantidad: r.cantidad,
        condicion: r.condicion, destino: r.destino, workcenter: enr?.workcenter || null, escaneadora: r.escaneadora,
        turno: r.turno || null, pedido: r.pedido, estado: r.incidencias ? 'Con incidencia' : 'Completado',
        ultimoMovimiento: null, lpnUnicos: enr?.lpns?.length ?? null,
        marcas: enr?.marcas || [], modelos: enr?.modelos || [], pulgadas: enr?.pulgadas || [],
        mixto: skuCount != null ? skuCount > 1 : null, skuCount,
        enriquecido: !!enr,
      };
    });

    res.json({
      success: true,
      data: enriquecidos,
      total: totalRecords,
      meta: { totalRecords, currentPage: pageNum, pageSize: size, totalPages, hasNextPage: pageNum < totalPages, hasPrevPage: pageNum > 1 },
    });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// ── Detalle completo de un pallet (para el drawer) — refresca y persiste via
// enrichOnePallet (no duplica la logica de fetch+clasificacion) + reconciliacion
// contra BinManagerRO (3ra fuente) para la pestaña "Comparacion de fuentes". ──
app.get('/api/centro-operativo/pallets/:palletId', auth, roleGuard('admin'), centroOperativoGuard, async (req, res) => {
  try {
    const palletId = normalizePalletId(req.params.palletId);
    if (!palletId) return res.status(400).json({ success: false, error: 'palletId requerido' });

    const [registro, live, enrichDoc, bmro] = await Promise.all([
      EscReg.findOne({ palletId: rx(palletId) }).sort({ createdAt: -1 }),
      fetchScPalletLive(palletId).catch(() => null),
      enrichOnePallet(palletId),
      findInBinManagerRO(palletId).catch(() => ({ found: false, configured: false })),
    ]);
    const enriquecidos = (enrichDoc?.productos || []).map((p) => ({
      ...p, cantidad: 1, estado: p.marca ? 'Identificado' : 'Sin identificar',
    }));
    const lpns = enrichDoc?.lpns || [];

    const alertas = [];
    if (enriquecidos.length === 0) alertas.push('Pallet sin contenido reportado por SmartControl.');
    const sinIdentificar = enriquecidos.filter((e) => !e.marca).length;
    if (sinIdentificar > 0) alertas.push(`${sinIdentificar} pieza(s) sin marca/modelo identificado.`);
    const sinPulgadas = enriquecidos.filter((e) => e.marca && !e.pulgadas).length;
    if (sinPulgadas > 0) alertas.push(`${sinPulgadas} pieza(s) identificadas sin pulgadas detectadas en la descripcion.`);
    if (registro && live?.cantidadTotal != null && Number(live.cantidadTotal) !== registro.cantidad) {
      alertas.push(`Cantidad registrada en la app (${registro.cantidad}) distinta a SmartControl (${live.cantidadTotal}).`);
    }
    if (registro && bmro.found && bmro.row?.cantidadTotal != null && Number(bmro.row.cantidadTotal) !== registro.cantidad) {
      alertas.push(`Cantidad registrada en la app (${registro.cantidad}) distinta a BinManagerRO (${bmro.row.cantidadTotal}).`);
    }

    // Comparacion de fuentes: que fuente reporta este pallet y con que valores —
    // acotado a ESTE pallet (barato, 1 consulta a cada fuente), no a todo el historico.
    const fuentes = {
      aplicacion: registro ? { presente: true, cantidad: registro.cantidad, condicion: registro.condicion, destino: registro.destino } : { presente: false },
      smartControl: live ? { presente: true, cantidad: live.cantidadTotal ?? null, condicion: live.condiciones ?? null, workcenter: live.workcenter ?? null } : { presente: false },
      binManagerRO: bmro.configured === false ? { presente: false, noConfigurado: true } : { presente: bmro.found, cantidad: bmro.row?.cantidadTotal ?? null, categoria: bmro.row?.binTypeName ?? null, ubicacion: bmro.row?.locationName ?? null },
    };
    const comparacion = [
      { campo: 'Cantidad', aplicacion: fuentes.aplicacion.cantidad ?? '—', smartControl: fuentes.smartControl.cantidad ?? '—', binManagerRO: fuentes.binManagerRO.cantidad ?? '—' },
      { campo: 'Condicion', aplicacion: fuentes.aplicacion.condicion ?? '—', smartControl: fuentes.smartControl.condicion ?? '—', binManagerRO: fuentes.binManagerRO.categoria ?? '—' },
    ].map((row) => {
      const vals = [row.aplicacion, row.smartControl, row.binManagerRO].filter((v) => v !== '—');
      const coincide = new Set(vals.map(String)).size <= 1;
      return { ...row, estado: vals.length <= 1 ? 'Sin suficiente informacion' : (coincide ? 'Coincide' : 'Diferencia') };
    });

    res.json({
      success: true,
      data: {
        resumen: {
          palletId,
          estado: registro?.incidencias ? 'Con incidencia' : (registro ? 'Completado' : 'No escaneado en la app'),
          cantidadTotal: live?.cantidadTotal ?? registro?.cantidad ?? null,
          lpnUnicos: lpns.length,
          skuDistintos: new Set(enriquecidos.map((e) => e.sku).filter(Boolean)).size,
          marcas: enrichDoc?.marcas || [],
          modelos: enrichDoc?.modelos || [],
          pulgadas: enrichDoc?.pulgadas || [],
          condiciones: live?.condiciones || registro?.condicion || null,
          destino: registro?.destino || null,
          workcenter: enrichDoc?.workcenter || null,
          escaneadora: registro?.escaneadora || null,
          turno: registro?.turno || null,
          pedido: registro?.pedido || null,
          fechaCreacion: registro?.createdAt || null,
          ultimoMovimiento: live?.movimientos?.[0]?.FechaMovimiento || null,
          observaciones: registro?.observaciones || '',
        },
        contenido: enriquecidos,
        distribucion: {
          porMarca: groupBy(enriquecidos.filter((e) => e.marca), (e) => e.marca),
          porModelo: groupBy(enriquecidos.filter((e) => e.modelo), (e) => e.modelo),
          porPulgadas: groupBy(enriquecidos.filter((e) => e.pulgadas), (e) => e.pulgadas),
          porCondicion: groupBy(enriquecidos.filter((e) => e.condicion), (e) => e.condicion),
        },
        fotografias: live?.fotos || [],
        movimientos: live?.movimientos || [],
        alertas,
        mixto: detectMixedPallet(enriquecidos.map((e) => ({ brand: e.marca, modelo: e.modelo, sku: e.sku }))),
        fuentes, comparacion,
      },
    });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// ── Datos para exportacion (respeta los mismos filtros que /resumen y /pallets) ──
// Regresa JSON crudo, no un archivo — CSV/Excel/PDF se generan del lado del CLIENTE
// reutilizando exportCSV()/ExcelJS/jsPDF+html2canvas, que YA estaban cargados en
// index.html para el export del Dashboard (ver exportDashboardExcel/exportDashboardPDF).
// Asi no se agrega ninguna dependencia nueva ni se duplica la logica de generar el
// archivo; este endpoint solo trae el set COMPLETO de pallets que cumple el filtro
// (hasta un tope), ya que la tabla en pantalla solo tiene la pagina visible.
app.get('/api/centro-operativo/exportar', auth, roleGuard('admin'), centroOperativoGuard, async (req, res) => {
  try {
    const filter = buildCentroFilter(req.query);
    const pipeline = [{ $match: filter }];
    applyCentroDateRange(pipeline, req.query);
    // 2000 (no 5000): exportar sin filtro (~4200 pallets reales medidos) tardaba ~9.6s solo
    // en transferencia — el mismo problema real que ya se encontro y corrigio en
    // buildSampledEnrichment. Se ordena por mas reciente antes de recortar, para que un
    // export truncado traiga los pallets mas relevantes, no un subconjunto arbitrario.
    pipeline.push({ $sort: { createdAt: -1 } }, { $limit: 2000 }, { $project: { palletId: 1, fecha: 1, cantidad: 1, condicion: 1, destino: 1, turno: 1, escaneadora: 1, pedido: 1, createdAt: 1 } });
    const pallets = await EscReg.aggregate(pipeline);
    const totalCount = await EscReg.countDocuments(filter);
    res.json({
      success: true,
      pallets,
      truncado: totalCount > pallets.length,
      totalReal: totalCount,
      generado: new Date().toISOString(),
      rango: req.query.fecha || `${req.query.fecha_inicio || '(sin inicio)'} a ${req.query.fecha_fin || '(sin fin)'}`,
    });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// ── Cron nocturno de respaldo: Vercel Hobby solo permite 1 ejecucion/dia, por eso NO
// es la via principal para avanzar la cobertura (eso pasa "de paso" en cada carga real
// del modulo, ver getEnrichmentForPallets) — esto es solo para que la cobertura tambien
// avance en dias sin uso. Autenticado con el header que Vercel Cron manda automaticamente
// (`Authorization: Bearer $CRON_SECRET`) cuando CRON_SECRET esta configurada; sin esa env
// var, responde 503 en vez de correr sin proteccion.
app.get('/api/cron/enrich-pallets', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret) return res.status(503).json({ success: false, error: 'CRON_SECRET no configurada' });
  if (req.headers.authorization !== `Bearer ${secret}`) return res.status(401).json({ success: false, error: 'No autorizado' });
  try {
    const CRON_BATCH = 150;
    const CRON_DEADLINE_MS = 50000;
    const todosLosPallets = await EscReg.aggregate([
      { $sort: { createdAt: -1 } },
      { $group: { _id: '$palletId' } },
      { $limit: 5000 },
    ]);
    const ids = todosLosPallets.map((r) => normalizePalletId(r._id)).filter(Boolean);
    const yaEnriquecidos = await PalletEnrichment.distinct('palletId', { palletId: { $in: ids } });
    const yaSet = new Set(yaEnriquecidos);
    const faltantes = ids.filter((pid) => !yaSet.has(pid)).slice(0, CRON_BATCH);

    let procesados = 0;
    const deadline = Date.now() + CRON_DEADLINE_MS;
    const BATCH = 10;
    for (let i = 0; i < faltantes.length; i += BATCH) {
      if (Date.now() > deadline) break;
      const lote = faltantes.slice(i, i + BATCH);
      await Promise.all(lote.map((pid) => enrichOnePallet(pid)));
      procesados += lote.length;
    }
    res.json({ success: true, procesados, faltantesEsteLote: faltantes.length, pendientesTotal: ids.length - yaSet.size - procesados });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// Cron diario: refresca el cache local del inventario de BinManagerRO/Cubicaje
// (ver vercel.json) — mismo patron de proteccion (CRON_SECRET) que
// /api/cron/enrich-pallets. Es el mecanismo CONFIABLE de refresco (los crons
// de Vercel tienen mas margen de ejecucion que un request normal de usuario);
// el boton "Sincronizar ahora" del modulo es un complemento bajo demanda.
app.get('/api/cron/sync-cubicaje-inventory', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret) return res.status(503).json({ success: false, error: 'CRON_SECRET no configurada' });
  if (req.headers.authorization !== `Bearer ${secret}`) return res.status(401).json({ success: false, error: 'No autorizado' });
  try {
    const r = await sincronizarInventarioCubicaje();
    res.json({ success: true, ...r });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// ═══════════ HEALTH ═══════════
app.get('/api/health', async (req, res) => {
  try {
    const registros = await EscReg.countDocuments();
    const usuarios = await User.countDocuments();
    res.json({ success: true, status: 'OK', database: 'MongoDB Atlas', registros, usuarios, timestamp: new Date().toISOString() });
  } catch (error) { res.status(500).json({ success: false, status: 'ERROR', error: error.message }); }
});

module.exports = app;
