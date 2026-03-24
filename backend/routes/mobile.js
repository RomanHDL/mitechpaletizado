const express = require('express');
const router = express.Router();
const Pallet = require('../models/Pallet');

// GET /api/mobile/check/:palletId — Duplicate check
router.get('/check/:palletId', async (req, res) => {
  try {
    const pallet = await Pallet.findOne({ palletId: req.params.palletId }).sort({ createdAt: -1 });
    res.json({ exists: !!pallet, data: pallet || null });
  } catch (error) {
    res.status(500).json({ exists: false, error: error.message });
  }
});

// POST /api/mobile/register — Register pallet from mobile app
router.post('/register', async (req, res) => {
  try {
    const { pallet_id, cantidad, destino, fecha, turno, condicion, operador, pedido, items } = req.body;

    if (!pallet_id || !destino || !fecha || !turno) {
      return res.status(400).json({ success: false, error: 'Campos requeridos: pallet_id, destino, fecha, turno' });
    }

    const totalQty = (items && items.length > 0)
      ? items.reduce((sum, i) => sum + (i.cantidad || 1), 0)
      : (cantidad || 0);

    const skuSummary = (items && items.length > 0)
      ? items.map(i => `${i.sku}(${i.cantidad || 1})`).join(', ')
      : '';

    const pallet = await Pallet.create({
      palletId: pallet_id,
      cantidad: totalQty,
      producto: skuSummary,
      destino,
      fecha,
      turno,
      condicion: condicion || '',
      escaneadora: operador || '',
      pedido: pedido || '',
      observaciones: pedido ? `${operador || ''} | Pedido: ${pedido}` : (operador || ''),
      source: 'mobile',
    });

    console.log(`[MOBILE] Pallet registrado: ${pallet_id} → ${destino}`);
    res.json({
      success: true,
      id: pallet._id,
      total_qty: totalQty,
      items_count: items ? items.length : 0,
      message: 'Pallet registrado desde app movil'
    });
  } catch (error) {
    console.error('[MOBILE] Error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/mobile/recent
router.get('/recent', async (req, res) => {
  try {
    const { operador, limit } = req.query;
    const filter = {};
    if (operador) {
      filter.$or = [
        { escaneadora: { $regex: operador, $options: 'i' } },
        { observaciones: { $regex: operador, $options: 'i' } }
      ];
    }

    const pallets = await Pallet.find(filter)
      .sort({ createdAt: -1 })
      .limit(parseInt(limit) || 50);

    res.json({ success: true, data: pallets, total: pallets.length });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/mobile/stats
router.get('/stats', async (req, res) => {
  try {
    const { operador } = req.query;
    const now = new Date();
    const todayStr = `${now.getMonth() + 1}/${now.getDate()}/${now.getFullYear()}`;

    const filter = { fecha: todayStr };
    if (operador) {
      filter.$or = [
        { escaneadora: { $regex: operador, $options: 'i' } },
        { observaciones: { $regex: operador, $options: 'i' } }
      ];
    }

    const todayCount = await Pallet.countDocuments(filter);

    const lastFilter = operador
      ? { $or: [{ escaneadora: { $regex: operador, $options: 'i' } }, { observaciones: { $regex: operador, $options: 'i' } }] }
      : {};
    const lastPallet = await Pallet.findOne(lastFilter).sort({ createdAt: -1 });

    const destinoCounts = await Pallet.aggregate([
      { $match: filter },
      { $group: { _id: '$destino', total: { $sum: 1 } } }
    ]);

    res.json({
      success: true,
      today: todayCount,
      last: lastPallet ? { pallet_id: lastPallet.palletId, destino: lastPallet.destino, fecha: lastPallet.fecha, turno: lastPallet.turno } : null,
      byDestino: destinoCounts.map(d => ({ destino: d._id, total: d.total }))
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
