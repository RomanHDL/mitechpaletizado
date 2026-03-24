const express = require('express');
const router = express.Router();
const Pallet = require('../models/Pallet');

// POST /api/pallets — Crear un pallet nuevo
router.post('/', async (req, res) => {
  try {
    const { pallet_id, palletId, cantidad, qty, condicion, destino, turno, escaneadora, pedido, fecha, producto, observaciones, source } = req.body;

    const id = palletId || pallet_id;
    if (!id || !destino || !turno) {
      return res.status(400).json({ success: false, error: 'Campos requeridos: palletId, destino, turno' });
    }

    const now = new Date();
    const defaultFecha = `${now.getMonth() + 1}/${now.getDate()}/${now.getFullYear()}`;

    const pallet = await Pallet.create({
      palletId: id,
      cantidad: parseInt(cantidad || qty) || 0,
      condicion: condicion || '',
      destino,
      turno,
      escaneadora: escaneadora || '',
      pedido: pedido || '',
      fecha: fecha || defaultFecha,
      producto: producto || '',
      observaciones: observaciones || '',
      source: source || 'web',
    });

    console.log(`[POST /api/pallets] Pallet creado: ${id} → ${destino} (${turno})`);
    res.json({ success: true, id: pallet._id, palletId: id, message: 'Pallet registrado en MongoDB' });
  } catch (error) {
    console.error('[POST /api/pallets] Error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/pallets — Todos los pallets (con filtros)
router.get('/', async (req, res) => {
  try {
    const { fecha, turno, destino, fecha_inicio, fecha_fin, limit } = req.query;
    const filter = {};

    if (fecha) filter.fecha = fecha;
    if (turno) filter.turno = { $regex: turno, $options: 'i' };
    if (destino) filter.destino = { $regex: destino, $options: 'i' };
    if (fecha_inicio && fecha_fin) {
      // For date ranges, we need to compare string dates — works for M/D/YYYY
      // Better to filter in-memory after fetching, or store as Date objects too
    }

    const pallets = await Pallet.find(filter)
      .sort({ createdAt: -1 })
      .limit(parseInt(limit) || 0);

    res.json({ success: true, data: pallets, total: pallets.length });
  } catch (error) {
    console.error('[GET /api/pallets] Error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/pallets/today — Pallets de hoy
router.get('/today', async (req, res) => {
  try {
    const now = new Date();
    const todayStr = `${now.getMonth() + 1}/${now.getDate()}/${now.getFullYear()}`;
    const todayISO = now.toISOString().split('T')[0];
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const todayPadded = `${mm}/${dd}/${now.getFullYear()}`;

    const pallets = await Pallet.find({
      fecha: { $in: [todayStr, todayISO, todayPadded] }
    }).sort({ createdAt: -1 });

    res.json({ success: true, data: pallets, total: pallets.length, fecha: todayStr });
  } catch (error) {
    console.error('[GET /api/pallets/today] Error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/pallets/by-user/:user — Pallets por escaneadora
router.get('/by-user/:user', async (req, res) => {
  try {
    const pallets = await Pallet.find({
      escaneadora: { $regex: req.params.user, $options: 'i' }
    }).sort({ createdAt: -1 }).limit(200);

    res.json({ success: true, data: pallets, total: pallets.length });
  } catch (error) {
    console.error('[GET /api/pallets/by-user] Error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// DELETE /api/pallets/:id
router.delete('/:id', async (req, res) => {
  try {
    const result = await Pallet.findByIdAndDelete(req.params.id);
    if (!result) return res.status(404).json({ success: false, error: 'No encontrado' });
    res.json({ success: true, message: 'Pallet eliminado' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
