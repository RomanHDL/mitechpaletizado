const express = require('express');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const User = require('../models/User');
const auth = require('../middleware/auth');

const { authorize: auth3647Authorize } = require('../auth3647');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'mitech-jwt-secret-2026';

// Session helpers
function sessions() { return mongoose.connection.db.collection('active_sessions'); }

async function checkAndSetSession(user, deviceId) {
  if (user.role !== 'escaneadora') return { allowed: true };

  // If no deviceId provided, generate one server-side
  const did = deviceId || ('srv_' + Date.now() + '_' + Math.random().toString(36).substr(2, 8));

  const col = sessions();
  // Clean expired sessions (older than 12h)
  await col.deleteMany({ expiresAt: { $lt: new Date() } });

  // Check active session on different device
  const existing = await col.findOne({ userId: user._id.toString(), deviceId: { $ne: did } });
  if (existing) {
    return { allowed: false, error: 'Este usuario ya tiene una sesion activa en otro dispositivo. Cierra sesion en el otro dispositivo o pide apoyo al administrador.' };
  }

  // Upsert session for this device
  await col.updateOne(
    { userId: user._id.toString() },
    { $set: { userId: user._id.toString(), deviceId: did, createdAt: new Date(), expiresAt: new Date(Date.now() + 12*60*60*1000) } },
    { upsert: true }
  );
  return { allowed: true, deviceId: did };
}

async function clearSession(userId) {
  await sessions().deleteMany({ userId: userId.toString() });
}

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { usuario, password, deviceId } = req.body;
    if (!usuario || !password) {
      return res.status(400).json({ success: false, error: 'Usuario y contraseña son requeridos' });
    }

    const user = await User.findOne({ usuario: usuario.toLowerCase().trim() });
    if (!user || !user.isActive) {
      return res.status(401).json({ success: false, error: 'Credenciales incorrectas' });
    }

    const valid = await user.comparePassword(password);
    if (!valid) {
      return res.status(401).json({ success: false, error: 'Credenciales incorrectas' });
    }

    // Session restriction for escaneadoras
    const sessionCheck = await checkAndSetSession(user, deviceId);
    if (!sessionCheck.allowed) {
      return res.status(403).json({ success: false, error: sessionCheck.error, sessionConflict: true });
    }

    const token = jwt.sign({ id: user._id, role: user.role }, JWT_SECRET, { expiresIn: '12h' });

    // Si es usuario 3647, autorizar este dispositivo para cantidad 0
    if (user.usuario === '3647') {
      await auth3647Authorize(sessionCheck.deviceId || deviceId);
    }

    res.json({
      success: true,
      token,
      deviceId: sessionCheck.deviceId,
      user: { id: user._id, nombre: user.nombre, usuario: user.usuario, role: user.role }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/auth/nfc
router.post('/nfc', async (req, res) => {
  try {
    const { serialNumber, deviceId } = req.body;
    if (!serialNumber) {
      return res.status(400).json({ success: false, error: 'Numero de serie NFC requerido' });
    }

    const db = mongoose.connection.db;
    const card = await db.collection('nfc_cards').findOne({
      serialNumber: serialNumber.toUpperCase().trim(),
      isActive: true,
    });

    if (!card) {
      return res.status(401).json({ success: false, error: 'Tarjeta NFC no autorizada' });
    }

    let user;
    if (card.userId) user = await User.findById(card.userId);
    if (!user) user = await User.findOne({ role: card.role, isActive: true });
    if (!user) {
      return res.status(401).json({ success: false, error: 'No hay usuario asociado a esta tarjeta' });
    }

    // Session restriction for escaneadoras
    const sessionCheck = await checkAndSetSession(user, deviceId);
    if (!sessionCheck.allowed) {
      return res.status(403).json({ success: false, error: sessionCheck.error, sessionConflict: true });
    }

    const token = jwt.sign({ id: user._id, role: user.role }, JWT_SECRET, { expiresIn: '12h' });

    // Si es usuario 3647, autorizar este dispositivo para cantidad 0
    if (user.usuario === '3647') {
      await auth3647Authorize(sessionCheck.deviceId || deviceId);
    }

    await db.collection('nfc_cards').updateOne(
      { _id: card._id },
      { $set: { lastUsed: new Date() }, $inc: { useCount: 1 } }
    );

    res.json({
      success: true,
      token,
      deviceId: sessionCheck.deviceId,
      user: { id: user._id, nombre: user.nombre, usuario: user.usuario, role: user.role },
      nfc: { serial: card.serialNumber, role: card.role }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/auth/logout
router.post('/logout', auth, async (req, res) => {
  try {
    await clearSession(req.user._id);
    res.json({ success: true, message: 'Sesion cerrada' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/auth/me
router.get('/me', auth, async (req, res) => {
  // For escaneadoras, verify device matches active session
  const deviceId = req.headers['x-device-id'];
  if (req.user.role === 'escaneadora' && deviceId) {
    const session = await sessions().findOne({ userId: req.user._id.toString() });
    if (session && session.deviceId !== deviceId) {
      return res.status(401).json({ success: false, error: 'Sesion invalida para este dispositivo' });
    }
  }

  res.json({
    success: true,
    user: { id: req.user._id, nombre: req.user.nombre, usuario: req.user.usuario, role: req.user.role }
  });
});

module.exports = router;
