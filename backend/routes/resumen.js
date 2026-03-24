const express = require('express');
const router = express.Router();
const ResumenPaletizado = require('../models/ResumenPaletizado');
const auth = require('../middleware/auth');
const roleGuard = require('../middleware/roleGuard');

router.use(auth, roleGuard('admin', 'escaneadora'));

// POST /api/resumen — Create
router.post('/', async (req, res) => {
  try {
    const { turno, palletsTotales, palletsTRG, palletsAlmacen, palletsEnProceso, asistencia, absentismo, tareasPendientes, fecha } = req.body;
    if (!turno || !fecha || palletsTotales===undefined || palletsTotales==='' || palletsTRG===undefined || palletsTRG==='' || palletsAlmacen===undefined || palletsAlmacen==='' || palletsEnProceso===undefined || palletsEnProceso==='' || asistencia===undefined || asistencia==='' || absentismo===undefined || absentismo==='' || !tareasPendientes) {
      return res.status(400).json({ success: false, error: 'Todos los campos son obligatorios' });
    }
    const doc = await ResumenPaletizado.create({
      turno,
      palletsTotales: parseInt(palletsTotales),
      palletsTRG: parseInt(palletsTRG),
      palletsAlmacen: parseInt(palletsAlmacen),
      palletsEnProceso: parseInt(palletsEnProceso),
      asistencia: parseInt(asistencia),
      absentismo: parseInt(absentismo),
      tareasPendientes,
      fecha,
      capturadoPor: req.user._id,
      nombreCaptura: req.user.nombre,
    });
    res.json({ success: true, id: doc._id, message: 'Resumen guardado' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/resumen — List with filters
router.get('/', async (req, res) => {
  try {
    const { fecha, turno, limit } = req.query;
    const filter = {};
    if (fecha) filter.fecha = fecha;
    if (turno) filter.turno = { $regex: turno, $options: 'i' };
    const docs = await ResumenPaletizado.find(filter).sort({ createdAt: -1 }).limit(parseInt(limit) || 100);
    res.json({ success: true, data: docs, total: docs.length });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
