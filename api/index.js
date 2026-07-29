const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Pusher = require('pusher');

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
const VALID_DESTINOS = ['TRG', 'ALMACEN'];
const VALID_CLASIFICACIONES = ['', 'BOX', 'BULKY', 'HV', 'HV TELEVISIONES', '9X7251Z'];
function normalizeDestino(d) { const u = (d||'').trim(); const up = u.toUpperCase(); if (up === 'ALMACEN' || up === 'ALMACÉN') return 'Almacen'; if (up === 'TRG') return 'TRG'; return u; }
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
app.get('/api/sc-pallets/live', auth, roleGuard('admin'), async (req, res) => {
  if (req.user.usuario !== '3647') return res.status(403).json({ success: false, error: 'Solo admin 3647' });
  const base = process.env.CUBICAJE_API_BASE_URL;
  const key = process.env.CUBICAJE_INTEGRATION_KEY;
  if (!base || !key) return res.status(503).json({ success: false, error: 'CUBICAJE_API_BASE_URL/CUBICAJE_INTEGRATION_KEY no configuradas para este proyecto' });
  try {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 100));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const search = (req.query.search || '').trim();
    const params = new URLSearchParams({ limit, offset });
    if (search) params.set('search', search);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    let resp;
    try {
      resp = await fetch(`${base.replace(/\/$/, '')}/api/integrations/live-pallets?${params.toString()}`, {
        headers: { 'X-Integration-Key': key },
        signal: controller.signal,
      });
    } finally { clearTimeout(timeout); }
    const data = await resp.json();
    if (!resp.ok || !data.success) return res.status(resp.status === 401 ? 502 : resp.status).json({ success: false, error: data.error || `Cubicaje respondio ${resp.status}` });
    res.json({
      success: true,
      data: (data.data || []).map(r => ({ palletId: r.palletId, BinTypeID: r.binTypeId, binTypeName: r.binTypeName, cantidadTotal: r.cantidadTotal, skuCount: r.skuCount, locationName: r.locationName ?? null })),
      total: data.total || 0,
      limit, offset,
    });
  } catch (error) {
    const msg = error.name === 'AbortError' ? 'Cubicaje no respondio a tiempo' : error.message;
    res.status(502).json({ success: false, error: 'No se pudo consultar Cubicaje: ' + msg });
  }
});

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
async function applyLiveVerification(doc, now) {
  let liveDuplicado = null;
  try {
    const { duplicadoEnVivo } = await liveVerifyDuplicate(doc);
    liveDuplicado = duplicadoEnVivo;
  } catch { /* si SmartControl falla, no se toca el estado — se reintenta en el siguiente ciclo */ }
  doc.liveDuplicado = liveDuplicado;
  doc.liveCheckedAt = now;
  if (liveDuplicado === false && !doc.resuelto) {
    doc.resuelto = true;
    doc.resueltoPor = 'sistema (verificado en vivo contra SmartControl)';
    doc.resueltoFecha = now;
  }
  await doc.save();
  return liveDuplicado;
}

app.post('/api/lpn-duplicates/check', auth, async (req, res) => {
  const base = process.env.CUBICAJE_API_BASE_URL;
  const key = process.env.CUBICAJE_INTEGRATION_KEY;
  if (!base || !key) return res.status(503).json({ success: false, error: 'CUBICAJE_API_BASE_URL/CUBICAJE_INTEGRATION_KEY no configuradas para este proyecto' });
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

    for (const g of fresh) {
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
      if (esNuevoOReaparecio) nuevos.push(doc);
    }

    // Auto-resolver los que Cubicaje ya no reporta como duplicados (se corrigieron)
    const pendientes = await LpnDuplicate.find({ resuelto: false }).select('serialNumber tipo');
    const aResolver = pendientes.filter(p => !freshKeys.has(`${p.serialNumber}|${p.tipo}`)).map(p => p._id);
    if (aResolver.length > 0) {
      await LpnDuplicate.updateMany(
        { _id: { $in: aResolver } },
        { $set: { resuelto: true, resueltoPor: 'sistema (ya no duplicado)', resueltoFecha: now } },
      );
    }

    // Verificacion en vivo (SmartControl, sin el retraso de BinManagerRO)
    // antes de notificar — BinManagerRO puede tardar horas en reflejar que
    // algo ya se corrigio, y no queremos avisarle a 3647 de un problema
    // que ya no existe. applyLiveVerification ademas auto-resuelve el doc
    // si SmartControl confirma que ya no esta duplicado.
    const nuevosLive = await Promise.all(nuevos.map(doc => applyLiveVerification(doc, now)));
    const confirmadosEnVivo = nuevos.filter((_doc, i) => nuevosLive[i] !== false);

    // Re-verificacion en vivo de un lote acotado de LPN YA pendientes
    // (no nuevos en este ciclo). Sin esto, un LPN que ya se corrigio en la
    // realidad se quedaba "pendiente" para siempre: `fresh` viene de
    // BinManagerRO via Cubicaje, que tarda ~1 dia en reflejar la correccion
    // (ver [[project_cubicaje_binmanagerro_lag]]), y antes de este cambio
    // solo se re-verificaba en vivo a los recien detectados, nunca a los
    // que ya llevaban rato en la lista. Se prioriza a los que tienen la
    // verificacion en vivo mas vieja (o nula) y se acota a 8 por ciclo para
    // no exceder el tiempo limite de una funcion serverless de Vercel — con
    // 59 pendientes, cubre todo el rezago en unos pocos ciclos de 5 min.
    const nuevosIds = nuevos.map(d => d._id);
    const rezagados = await LpnDuplicate.find({ resuelto: false, _id: { $nin: nuevosIds } })
      .sort({ liveCheckedAt: 1 })
      .limit(8);
    await Promise.all(rezagados.map(doc => applyLiveVerification(doc, now)));

    if (confirmadosEnVivo.length > 0) {
      emitEvent('paletizado', 'lpn:duplicado', {
        count: confirmadosEnVivo.length,
        items: confirmadosEnVivo.slice(0, 10).map(d => ({ serialNumber: d.serialNumber, productSku: d.productSku, tipo: d.tipo })),
      });
    }
    const totalPendientes = await LpnDuplicate.countDocuments({ resuelto: false });
    res.json({ success: true, nuevos: nuevos.length, confirmadosEnVivo: confirmadosEnVivo.length, reverificados: rezagados.length, totalPendientes });
  } catch (error) {
    const msg = error.name === 'AbortError' ? 'Cubicaje no respondio a tiempo' : error.message;
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

function parseInches(desc) {
  if (!desc) return null;
  const m = String(desc).match(/(\d{2,3})\s*("|”|Class|Clase|in\.)/i);
  return m ? parseInt(m[1], 10) : null;
}

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
    const { turno, palletsTotales, palletsTRG, palletsAlmacen, palletsEnProceso, asistencia, absentismo, tareasPendientes, fecha } = req.body;
    if (!turno || !fecha || palletsTotales===undefined || palletsTotales==='' || palletsTRG===undefined || palletsTRG==='' || palletsAlmacen===undefined || palletsAlmacen==='' || palletsEnProceso===undefined || palletsEnProceso==='' || asistencia===undefined || asistencia==='' || absentismo===undefined || absentismo==='' || !tareasPendientes) {
      return res.status(400).json({ success: false, error: 'Todos los campos son obligatorios' });
    }
    const nums = {
      palletsTotales: parseInt(palletsTotales, 10), palletsTRG: parseInt(palletsTRG, 10),
      palletsAlmacen: parseInt(palletsAlmacen, 10), palletsEnProceso: parseInt(palletsEnProceso, 10),
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
  destinos: ['TRG', 'Almacen'],
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

// ═══════════ HEALTH ═══════════
app.get('/api/health', async (req, res) => {
  try {
    const registros = await EscReg.countDocuments();
    const usuarios = await User.countDocuments();
    res.json({ success: true, status: 'OK', database: 'MongoDB Atlas', registros, usuarios, timestamp: new Date().toISOString() });
  } catch (error) { res.status(500).json({ success: false, status: 'ERROR', error: error.message }); }
});

module.exports = app;
