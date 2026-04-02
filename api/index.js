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
const VALID_CLASIFICACIONES = ['', 'BOX', 'BULKY', 'HV', 'HV TELEVISIONES'];
function normalizeDestino(d) { const u = (d||'').trim(); const up = u.toUpperCase(); if (up === 'ALMACEN' || up === 'ALMACÉN') return 'Almacen'; if (up === 'TRG') return 'TRG'; return u; }
function normalizePalletId(id) { return (id||'').trim().toUpperCase(); }

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
  role: { type: String, enum: ['admin', 'escaneadora', 'viewer'], required: true },
  isActive: { type: Boolean, default: true },
}, { timestamps: true });

userSchema.methods.comparePassword = async function(p) { return bcrypt.compare(p, this.passwordHash); };
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
  incidencias: { type: String, default: '' },
  observaciones: { type: String, default: '' },
  capturadoPor: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
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
  } catch { return res.status(401).json({ success: false, error: 'Token invalido' }); }
}

function roleGuard(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ success: false, error: 'No autenticado' });
    if (!roles.includes(req.user.role)) return res.status(403).json({ success: false, error: 'Sin permisos' });
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
  const did = deviceId || ('srv_' + Date.now() + '_' + Math.random().toString(36).substr(2, 8));
  const col = sessionsCol();
  await col.deleteMany({ expiresAt: { $lt: new Date() } });
  const existing = await col.findOne({ userId: user._id.toString(), deviceId: { $ne: did } });
  if (existing) return { allowed: false, error: 'Este usuario ya tiene una sesion activa en otro dispositivo. Cierra sesion en el otro dispositivo o pide apoyo al administrador.', sessionConflict: true };
  await col.updateOne({ userId: user._id.toString() }, { $set: { userId: user._id.toString(), deviceId: did, createdAt: new Date(), expiresAt: new Date(Date.now()+12*60*60*1000) } }, { upsert: true });
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
    res.json({ success: true, token, deviceId: sc.deviceId, user: { id: user._id, nombre: user.nombre, usuario: user.usuario, role: user.role } });
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
    res.json({ success: true, token, deviceId: sc.deviceId, user: { id: user._id, nombre: user.nombre, usuario: user.usuario, role: user.role }, nfc: { serial: card.serialNumber, role: card.role } });
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
  res.json({ success: true, user: { id: req.user._id, nombre: req.user.nombre, usuario: req.user.usuario, role: req.user.role } });
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
      user: { id: target._id, nombre: target.nombre, usuario: target.usuario, role: target.role },
      impersonation: true,
      admin: req.user.usuario
    });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// ═══════════ ESCANEADORAS ═══════════
app.post('/api/escaneadoras', auth, roleGuard('admin', 'escaneadora'), async (req, res) => {
  try {
    const { palletId, cantidad, condicion, destino, turno, escaneadora, fecha, pedido, incidencias, observaciones } = req.body;
    if (!palletId || !destino || !turno || !escaneadora || !fecha) return res.status(400).json({ success: false, error: 'Campos requeridos: palletId, destino, turno, escaneadora, fecha' });
    if (!condicion || !condicion.trim()) return res.status(400).json({ success: false, error: 'El campo condicion es obligatorio' });
    const pid = normalizePalletId(palletId);
    const dest = normalizeDestino(destino);
    const qty = parseInt(cantidad) || 0;
    if (qty <= 0) return res.status(400).json({ success: false, error: 'Cantidad debe ser mayor a 0' });
    // If pedido is present, clasificacion is required (stored in observaciones as first tag)
    if (pedido && pedido.trim()) {
      const obs = (observaciones || '').trim().toUpperCase();
      const firstTag = obs.split('|')[0].trim();
      if (!firstTag || !['BULKY', 'BOX', 'HV', 'HV TELEVISIONES', 'LPN', 'JESSY'].includes(firstTag)) {
        return res.status(400).json({ success: false, error: 'Clasificacion es obligatoria cuando hay pedido' });
      }
    }
    const exists = await EscReg.findOne({ palletId: pid });
    if (exists) {
      emitEvent('paletizado', 'registro:duplicado', { palletId: pid, escaneadora, fecha });
      return res.status(409).json({ success: false, error: `Pallet ID duplicado. El pallet ${pid} ya fue registrado.`, duplicate: true });
    }
    const doc = await EscReg.create({ palletId: pid, cantidad: qty, condicion: condicion.trim(), destino: dest, turno, escaneadora, fecha, pedido: pedido || '', incidencias: incidencias || '', observaciones: observaciones || '', capturadoPor: req.user._id });
    emitEvent('paletizado', 'registro:nuevo', { id: doc._id, palletId: pid, cantidad: qty, destino: dest, turno, escaneadora, fecha, condicion: condicion.trim(), source: 'web' });
    res.json({ success: true, id: doc._id, message: 'Registro guardado' });
  } catch (error) {
    emitEvent('paletizado', 'registro:error', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/escaneadoras', auth, roleGuard('admin', 'escaneadora'), async (req, res) => {
  try {
    const { fecha, escaneadora, turno, limit } = req.query;
    const filter = {};
    if (fecha) filter.fecha = fecha;
    if (escaneadora) filter.escaneadora = { $regex: escaneadora, $options: 'i' };
    if (turno) filter.turno = { $regex: turno, $options: 'i' };
    const registros = await EscReg.find(filter).sort({ createdAt: -1 }).limit(parseInt(limit) || 200);
    res.json({ success: true, data: registros, total: registros.length });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.get('/api/escaneadoras/:id', auth, roleGuard('admin', 'escaneadora'), async (req, res) => {
  try {
    const doc = await EscReg.findById(req.params.id);
    if (!doc) return res.status(404).json({ success: false, error: 'No encontrado' });
    res.json({ success: true, data: doc });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// ── UPDATE pallet (admin only, with audit) ──
app.put('/api/escaneadoras/:id', auth, roleGuard('admin'), async (req, res) => {
  try {
    const doc = await EscReg.findById(req.params.id);
    if (!doc) return res.status(404).json({ success: false, error: 'No encontrado' });
    const oldData = doc.toObject();
    const allowed = ['palletId','cantidad','condicion','destino','turno','escaneadora','fecha','pedido','incidencias','observaciones'];
    const changes = [];
    allowed.forEach(f => {
      if (req.body[f] !== undefined && String(req.body[f]) !== String(oldData[f])) {
        changes.push({ field: f, oldValue: String(oldData[f]), newValue: String(req.body[f]) });
        doc[f] = f === 'cantidad' ? parseInt(req.body[f]) || 0 : (f === 'palletId' ? normalizePalletId(req.body[f]) : (f === 'destino' ? normalizeDestino(req.body[f]) : req.body[f]));
      }
    });
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
      snapshot: { palletId: snapshot.palletId, cantidad: snapshot.cantidad, condicion: snapshot.condicion, destino: snapshot.destino, turno: snapshot.turno, escaneadora: snapshot.escaneadora, fecha: snapshot.fecha, pedido: snapshot.pedido || '', incidencias: snapshot.incidencias || '', observaciones: snapshot.observaciones || '' },
      changes: [{ field: 'registro', before: 'ACTIVO', after: 'ELIMINADO' }]
    });
    emitEvent('paletizado', 'registro:deleted', { palletId: snapshot.palletId, deletedBy: req.user.nombre || req.user.usuario });
    res.json({ success: true, message: `Pallet ${snapshot.palletId} eliminado`, deletedPallet: snapshot });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// ═══════════ DASHBOARD (admin only) ═══════════
function normalizeTurno(t) {
  if (!t) return 'Otro';
  const l = t.toLowerCase();
  if (l.includes('noche') || l.includes('night')) return 'Noche';
  if (l.includes('día') || l.includes('dia') || l.includes('day')) return 'Día';
  return t;
}

app.get('/api/dashboard/resumen', auth, roleGuard('admin', 'viewer'), async (req, res) => {
  try {
    const { fecha, fecha_inicio, fecha_fin, escaneadora, turno } = req.query;
    const filter = {};
    if (fecha) filter.fecha = fecha;
    if (escaneadora) filter.escaneadora = { $regex: escaneadora, $options: 'i' };
    if (turno) filter.turno = { $regex: turno, $options: 'i' };

    let registros = await EscReg.find(filter).sort({ createdAt: -1 });

    if (!fecha && fecha_inicio && fecha_fin) {
      const start = new Date(fecha_inicio), end = new Date(fecha_fin);
      end.setHours(23, 59, 59, 999);
      registros = registros.filter(r => {
        const p = r.fecha.split('/');
        if (p.length !== 3) return true;
        const d = new Date(parseInt(p[2]), parseInt(p[0]) - 1, parseInt(p[1]));
        return d >= start && d <= end;
      });
    }

    const now = new Date();
    const hoyStr = `${now.getMonth()+1}/${now.getDate()}/${now.getFullYear()}`;
    // "Registros Hoy" is ALWAYS today's real count, independent of filters
    const registrosHoyCount = await EscReg.countDocuments({ fecha: hoyStr });

    const porEscaneadora = {}, porTurno = {}, porDestino = {}, porCondicion = {};
    let totalUnidades = 0;

    registros.forEach(r => {
      const e = r.escaneadora, d = r.destino || 'Otro', c = r.condicion || 'Sin condicion';
      let t = normalizeTurno(r.turno);
      if (t === 'Otro' && r.createdAt) t = calcTurnoFromHour(new Date(r.createdAt));
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

    res.json({
      success: true,
      totalRegistros: registros.length,
      registrosHoy: registrosHoyCount,
      totalUnidades,
      fechaHoy: hoyStr,
      porEscaneadora: Object.entries(porEscaneadora).map(([nombre, d]) => ({ nombre, ...d })),
      porTurno: Object.entries(porTurno).map(([turno, d]) => ({ turno, ...d })),
      porDestino: Object.entries(porDestino).map(([destino, d]) => ({ destino, ...d })),
      porCondicion: Object.entries(porCondicion).map(([condicion, total]) => ({ condicion, total })),
      escaneadoras: [...new Set(registros.map(r => r.escaneadora))].sort(),
      fechas: [...new Set(registros.map(r => r.fecha))].sort(),
    });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.get('/api/dashboard/registros', auth, roleGuard('admin', 'viewer'), async (req, res) => {
  try {
    const { fecha, fecha_inicio, fecha_fin, escaneadora, turno, busqueda, limit, skip } = req.query;
    const filter = {};
    if (fecha) filter.fecha = fecha;
    if (escaneadora) filter.escaneadora = { $regex: escaneadora, $options: 'i' };
    if (turno) filter.turno = { $regex: turno, $options: 'i' };
    if (busqueda) {
      filter.$or = [
        { palletId: { $regex: busqueda, $options: 'i' } },
        { escaneadora: { $regex: busqueda, $options: 'i' } },
        { destino: { $regex: busqueda, $options: 'i' } },
        { pedido: { $regex: busqueda, $options: 'i' } },
        { observaciones: { $regex: busqueda, $options: 'i' } },
      ];
    }
    let query = EscReg.find(filter).sort({ createdAt: -1 });
    if (skip) query = query.skip(parseInt(skip));
    query = query.limit(parseInt(limit) || 2000);
    let registros = await query.populate('capturadoPor', 'nombre');

    if (!fecha && fecha_inicio && fecha_fin) {
      const start = new Date(fecha_inicio), end = new Date(fecha_fin);
      end.setHours(23, 59, 59, 999);
      registros = registros.filter(r => {
        const p = r.fecha.split('/');
        if (p.length !== 3) return true;
        const d = new Date(parseInt(p[2]), parseInt(p[0]) - 1, parseInt(p[1]));
        return d >= start && d <= end;
      });
    }

    const total = await EscReg.countDocuments(filter);
    res.json({ success: true, data: registros, total, filteredCount: registros.length });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// Helper: calculate turno dynamically from createdAt hour
function calcTurnoFromHour(date) {
  if (!date) return 'Otro';
  const h = date.getHours(), m = date.getMinutes();
  const mins = h * 60 + m;
  // Day: 7:00 AM (420) to 5:10 PM (1030)
  if (mins >= 420 && mins <= 1030) return 'Dia';
  // Night: 10:00 PM (1320) to 7:00 AM (420 next day)
  if (mins >= 1320 || mins < 420) return 'Noche';
  return 'Otro';
}

app.get('/api/dashboard/tendencias', auth, roleGuard('admin', 'viewer'), async (req, res) => {
  try {
    const limit = parseInt(req.query.dias) || 7;
    const { fecha, fecha_inicio, fecha_fin, escaneadora, turno } = req.query;

    // Build match filter for aggregation
    const matchFilter = {};
    if (fecha) matchFilter.fecha = fecha;
    if (escaneadora) matchFilter.escaneadora = { $regex: escaneadora, $options: 'i' };
    if (turno) matchFilter.turno = { $regex: turno, $options: 'i' };

    const pipeline = [];
    if (Object.keys(matchFilter).length > 0) pipeline.push({ $match: matchFilter });

    pipeline.push(
      { $addFields: { turnoLower: { $toLower: '$turno' } } },
      { $group: { _id: '$fecha', dia: { $sum: { $cond: [{ $or: [{ $regexMatch: { input: '$turnoLower', regex: /day|día|dia/ } }] }, 1, 0] } }, noche: { $sum: { $cond: [{ $or: [{ $regexMatch: { input: '$turnoLower', regex: /night|noche/ } }] }, 1, 0] } }, total: { $sum: 1 } } },
      { $match: { total: { $gt: 0 } } },
      { $sort: { _id: -1 } },
      { $limit: limit },
      { $sort: { _id: 1 } },
      { $project: { _id: 0, date: '$_id', dia: 1, noche: 1, total: 1 } }
    );

    let tendencia = await EscReg.aggregate(pipeline);

    // Date range filter (string dates M/D/YYYY)
    if (!fecha && fecha_inicio && fecha_fin) {
      const start = new Date(fecha_inicio), end = new Date(fecha_fin);
      end.setHours(23, 59, 59, 999);
      tendencia = tendencia.filter(t => {
        const p = t.date.split('/');
        if (p.length !== 3) return true;
        const d = new Date(parseInt(p[2]), parseInt(p[0]) - 1, parseInt(p[1]));
        return d >= start && d <= end;
      });
    }

    // Promedios - use same filters
    const proFilter = {};
    if (fecha) proFilter.fecha = fecha;
    if (escaneadora) proFilter.escaneadora = { $regex: escaneadora, $options: 'i' };
    if (turno) proFilter.turno = { $regex: turno, $options: 'i' };

    let registros = await EscReg.find(proFilter);
    if (!fecha && fecha_inicio && fecha_fin) {
      const start = new Date(fecha_inicio), end = new Date(fecha_fin);
      end.setHours(23, 59, 59, 999);
      registros = registros.filter(r => {
        const p = r.fecha.split('/');
        if (p.length !== 3) return true;
        const d = new Date(parseInt(p[2]), parseInt(p[0]) - 1, parseInt(p[1]));
        return d >= start && d <= end;
      });
    }

    const turnoStats = {}, turnoDates = {};
    registros.forEach(r => {
      let t = normalizeTurno(r.turno);
      // Dynamic turno calculation if turno is empty/unknown
      if (t === 'Otro' && r.createdAt) t = calcTurnoFromHour(new Date(r.createdAt));
      if (!turnoStats[t]) { turnoStats[t]=0; turnoDates[t]=new Set(); }
      turnoStats[t]++; turnoDates[t].add(r.fecha);
    });
    const promedios = Object.entries(turnoStats).map(([turno, total]) => ({ turno, totalRegistros: total, totalDias: turnoDates[turno].size, promedio: turnoDates[turno].size > 0 ? (total / turnoDates[turno].size).toFixed(1) : 0 }));
    res.json({ success: true, tendencia, promedios });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.get('/api/dashboard/catalogos', auth, roleGuard('admin', 'viewer'), async (req, res) => {
  try {
    const escaneadoras = await EscReg.distinct('escaneadora');
    const destinos = await EscReg.distinct('destino');
    const turnos = await EscReg.distinct('turno');
    const fechas = await EscReg.distinct('fecha');
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

app.post('/api/resumen', auth, roleGuard('admin', 'escaneadora'), async (req, res) => {
  try {
    const { turno, palletsTotales, palletsTRG, palletsAlmacen, palletsEnProceso, asistencia, absentismo, tareasPendientes, fecha } = req.body;
    if (!turno || !fecha || palletsTotales===undefined || palletsTotales==='' || palletsTRG===undefined || palletsTRG==='' || palletsAlmacen===undefined || palletsAlmacen==='' || palletsEnProceso===undefined || palletsEnProceso==='' || asistencia===undefined || asistencia==='' || absentismo===undefined || absentismo==='' || !tareasPendientes) {
      return res.status(400).json({ success: false, error: 'Todos los campos son obligatorios' });
    }
    const doc = await Resumen.create({
      turno, palletsTotales: parseInt(palletsTotales), palletsTRG: parseInt(palletsTRG),
      palletsAlmacen: parseInt(palletsAlmacen), palletsEnProceso: parseInt(palletsEnProceso),
      asistencia: parseInt(asistencia), absentismo: parseInt(absentismo), tareasPendientes,
      fecha, capturadoPor: req.user._id, nombreCaptura: req.user.nombre,
    });
    res.json({ success: true, id: doc._id, message: 'Resumen guardado' });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.get('/api/resumen', auth, roleGuard('admin', 'escaneadora'), async (req, res) => {
  try {
    const { fecha, turno, limit } = req.query;
    const filter = {};
    if (fecha) filter.fecha = fecha;
    if (turno) filter.turno = { $regex: turno, $options: 'i' };
    const docs = await Resumen.find(filter).sort({ createdAt: -1 }).limit(parseInt(limit)||100);
    res.json({ success: true, data: docs, total: docs.length });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// ═══════════ DIAG NFC (temporary) ═══════════
app.get('/api/diag-nfc', async (req, res) => {
  try {
    const db = mongoose.connection.db;
    const cards = await db.collection('nfc_cards').find({}).toArray();
    const users = await User.find({ role: 'escaneadora' }).select('nombre usuario role isActive _id');
    res.json({ success: true, nfc_cards: cards, escaneadora_users: users, database: db.databaseName });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// ═══════════ SEED (one-time, remove after use) ═══════════
app.get('/api/seed', async (req, res) => {
  try {
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

    const allCards = await col.find({}).toArray();
    res.json({ success: true, results, totalCards: allCards.length, allCards });
    res.json({ success: true, status: 'linked', card, linkedUser: yusley ? { id: yusley._id, nombre: yusley.nombre, usuario: yusley.usuario } : null });
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
    if (!condicion || !condicion.trim()) return res.status(400).json({ success: false, error: 'Condicion es obligatoria' });
    const pid = normalizePalletId(pallet_id);
    const dest = normalizeDestino(destino);
    const qty = parseInt(cantidad) || 0;
    if (qty <= 0) return res.status(400).json({ success: false, error: 'Cantidad debe ser mayor a 0' });
    if (pedido && pedido.trim() && !clasificacion) return res.status(400).json({ success: false, error: 'Clasificacion es obligatoria cuando hay pedido' });

    const exists = await EscReg.findOne({ palletId: pid });
    if (exists) {
      emitEvent('paletizado', 'registro:duplicado', { palletId: pid, escaneadora: operador, fecha, source: 'mobile' });
      return res.status(409).json({ success: false, error: `Pallet ${pid} ya registrado`, duplicate: true });
    }

    let obs = '';
    if (clasificacion) { obs = clasificacion === 'BULKY' ? 'LPN | BULKY' : clasificacion; }

    const doc = await EscReg.create({ palletId: pid, cantidad: qty, condicion: condicion.trim(), destino: dest, turno, escaneadora: operador || '', fecha, pedido: pedido || '', incidencias: '', observaciones: obs });
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
    if (operador) filter.escaneadora = { $regex: operador, $options: 'i' };
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
    if (operador) filter.escaneadora = { $regex: operador, $options: 'i' };
    const todayCount = await EscReg.countDocuments(filter);
    const lastFilter = operador ? { escaneadora: { $regex: operador, $options: 'i' } } : {};
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
    if (escaneadora) { filter.$or = [{ escaneadora: { $regex: escaneadora, $options: 'i' } }, { changedBy: { $regex: escaneadora, $options: 'i' } }]; }
    if (palletId) filter.palletId = { $regex: palletId, $options: 'i' };
    if (field) filter['changes.field'] = { $regex: field, $options: 'i' };
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

    // 2. PalletId starts with query
    const startsWith = await EscReg.find({ palletId: { $regex: '^' + q, $options: 'i' }, palletId: { $ne: q } }).sort({ createdAt: -1 }).limit(20);

    // 3. Broader match (palletId contains, or pedido match)
    const broader = await EscReg.find({
      palletId: { $ne: q },
      $or: [
        { palletId: { $regex: q, $options: 'i' } },
        { pedido: { $regex: q, $options: 'i' } },
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

// ═══════════ HISTORIAL (no date limit, full data) ═══════════
app.get('/api/historial', auth, roleGuard('admin', 'viewer'), async (req, res) => {
  try {
    const { q, fecha } = req.query;
    const filter = {};
    if (fecha) filter.fecha = fecha;
    if (q) {
      filter.$or = [
        { palletId: { $regex: q, $options: 'i' } },
        { pedido: { $regex: q, $options: 'i' } },
        { escaneadora: { $regex: q, $options: 'i' } },
        { condicion: { $regex: q, $options: 'i' } },
        { observaciones: { $regex: q, $options: 'i' } },
      ];
    }
    const data = await EscReg.find(filter).sort({ createdAt: -1 }).limit(1000);
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
