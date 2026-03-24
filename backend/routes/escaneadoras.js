const express = require('express');
const router = express.Router();
const EscaneadoraRegistro = require('../models/EscaneadoraRegistro');
const auth = require('../middleware/auth');
const roleGuard = require('../middleware/roleGuard');

// Todas las rutas requieren autenticación y rol admin o escaneadora
router.use(auth, roleGuard('admin', 'escaneadora'));

// POST /api/escaneadoras — Crear registro
router.post('/', async (req, res) => {
  try {
    const { palletId, cantidad, condicion, destino, turno, escaneadora, fecha, pedido, incidencias, observaciones } = req.body;

    if (!palletId || !destino || !turno || !escaneadora || !fecha) {
      return res.status(400).json({ success: false, error: 'Campos requeridos: palletId, destino, turno, escaneadora, fecha' });
    }

    // Check duplicate
    const exists = await EscaneadoraRegistro.findOne({ palletId: palletId.trim() });
    if (exists) {
      return res.status(409).json({ success: false, error: `Pallet ID duplicado. El pallet ${palletId.trim()} ya fue registrado.`, duplicate: true });
    }

    const doc = await EscaneadoraRegistro.create({
      palletId: palletId.trim(),
      cantidad: parseInt(cantidad) || 0,
      condicion: condicion || '',
      destino,
      turno,
      escaneadora,
      fecha,
      pedido: pedido || '',
      incidencias: incidencias || '',
      observaciones: observaciones || '',
      capturadoPor: req.user._id,
    });

    res.json({ success: true, id: doc._id, message: 'Registro guardado' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/escaneadoras — Listar registros
router.get('/', async (req, res) => {
  try {
    const { fecha, escaneadora, turno, limit } = req.query;
    const filter = {};
    if (fecha) filter.fecha = fecha;
    if (escaneadora) filter.escaneadora = { $regex: escaneadora, $options: 'i' };
    if (turno) filter.turno = { $regex: turno, $options: 'i' };

    const registros = await EscaneadoraRegistro.find(filter)
      .sort({ createdAt: -1 })
      .limit(parseInt(limit) || 200)
      .populate('capturadoPor', 'nombre usuario');

    res.json({ success: true, data: registros, total: registros.length });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/escaneadoras/:id — Registro individual
router.get('/:id', async (req, res) => {
  try {
    const doc = await EscaneadoraRegistro.findById(req.params.id).populate('capturadoPor', 'nombre usuario');
    if (!doc) return res.status(404).json({ success: false, error: 'No encontrado' });
    res.json({ success: true, data: doc });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
