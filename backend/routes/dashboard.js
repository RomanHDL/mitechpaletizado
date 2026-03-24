const express = require('express');
const router = express.Router();
const EscaneadoraRegistro = require('../models/EscaneadoraRegistro');
const auth = require('../middleware/auth');
const roleGuard = require('../middleware/roleGuard');

// Dashboard solo para admin
router.use(auth, roleGuard('admin'));

// Helper: normalize turno for grouping
function normalizeTurno(t) {
  if (!t) return 'Otro';
  const l = t.toLowerCase();
  if (l.includes('noche') || l.includes('night')) return 'Noche';
  if (l.includes('día') || l.includes('dia') || l.includes('day')) return 'Día';
  return t;
}

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

// GET /api/dashboard/resumen — KPIs y resumen general
router.get('/resumen', async (req, res) => {
  try {
    const { fecha, fecha_inicio, fecha_fin, escaneadora, turno } = req.query;
    const filter = {};

    if (fecha) {
      filter.fecha = fecha;
    } else if (fecha_inicio && fecha_fin) {
      // Get all records and filter in memory for string dates
    }
    if (escaneadora) filter.escaneadora = { $regex: escaneadora, $options: 'i' };
    if (turno) filter.turno = { $regex: turno, $options: 'i' };

    let registros = await EscaneadoraRegistro.find(filter).sort({ createdAt: -1 });

    // Date range filter (string dates M/D/YYYY)
    if (!fecha && fecha_inicio && fecha_fin) {
      const start = new Date(fecha_inicio);
      const end = new Date(fecha_fin);
      end.setHours(23, 59, 59, 999);
      registros = registros.filter(r => {
        const parts = r.fecha.split('/');
        if (parts.length !== 3) return true;
        const d = new Date(parseInt(parts[2]), parseInt(parts[0]) - 1, parseInt(parts[1]));
        return d >= start && d <= end;
      });
    }

    const now = new Date();
    const hoyStr = `${now.getMonth() + 1}/${now.getDate()}/${now.getFullYear()}`;
    const registrosHoy = registros.filter(r => r.fecha === hoyStr);

    // Por escaneadora
    const porEscaneadora = {};
    registros.forEach(r => {
      const key = r.escaneadora;
      if (!porEscaneadora[key]) porEscaneadora[key] = { registros: 0, unidades: 0 };
      porEscaneadora[key].registros++;
      porEscaneadora[key].unidades += (r.cantidad || 0);
    });

    // Por turno (with dynamic calculation fallback)
    const porTurno = {};
    registros.forEach(r => {
      let t = normalizeTurno(r.turno);
      if (t === 'Otro' && r.createdAt) t = calcTurnoFromHour(new Date(r.createdAt));
      if (!porTurno[t]) porTurno[t] = { registros: 0, unidades: 0 };
      porTurno[t].registros++;
      porTurno[t].unidades += (r.cantidad || 0);
    });

    // Por destino
    const porDestino = {};
    registros.forEach(r => {
      const d = r.destino || 'Otro';
      if (!porDestino[d]) porDestino[d] = { registros: 0, unidades: 0 };
      porDestino[d].registros++;
      porDestino[d].unidades += (r.cantidad || 0);
    });

    // Por condicion
    const porCondicion = {};
    registros.forEach(r => {
      const c = r.condicion || 'Sin condición';
      if (!porCondicion[c]) porCondicion[c] = 0;
      porCondicion[c]++;
    });

    // Total unidades
    const totalUnidades = registros.reduce((sum, r) => sum + (r.cantidad || 0), 0);

    // Escaneadoras unicas y fechas unicas
    const escaneadoras = [...new Set(registros.map(r => r.escaneadora))].sort();
    const fechas = [...new Set(registros.map(r => r.fecha))].sort();

    res.json({
      success: true,
      totalRegistros: registros.length,
      registrosHoy: registrosHoy.length,
      totalUnidades,
      fechaHoy: hoyStr,
      porEscaneadora: Object.entries(porEscaneadora).map(([nombre, d]) => ({ nombre, ...d })),
      porTurno: Object.entries(porTurno).map(([turno, d]) => ({ turno, ...d })),
      porDestino: Object.entries(porDestino).map(([destino, d]) => ({ destino, ...d })),
      porCondicion: Object.entries(porCondicion).map(([condicion, total]) => ({ condicion, total })),
      escaneadoras,
      fechas,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/dashboard/registros — Registros con filtros para tabla
router.get('/registros', async (req, res) => {
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

    let query = EscaneadoraRegistro.find(filter).sort({ createdAt: -1 });
    if (skip) query = query.skip(parseInt(skip));
    query = query.limit(parseInt(limit) || 100);

    let registros = await query.populate('capturadoPor', 'nombre');

    // Date range filter
    if (!fecha && fecha_inicio && fecha_fin) {
      const start = new Date(fecha_inicio);
      const end = new Date(fecha_fin);
      end.setHours(23, 59, 59, 999);
      registros = registros.filter(r => {
        const parts = r.fecha.split('/');
        if (parts.length !== 3) return true;
        const d = new Date(parseInt(parts[2]), parseInt(parts[0]) - 1, parseInt(parts[1]));
        return d >= start && d <= end;
      });
    }

    const total = await EscaneadoraRegistro.countDocuments(filter);

    res.json({ success: true, data: registros, total, filteredCount: registros.length });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/dashboard/tendencias — Últimos 7 días TRABAJADOS (con registros reales)
router.get('/tendencias', async (req, res) => {
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
      { $group: {
          _id: '$fecha',
          dia: { $sum: { $cond: [{ $or: [{ $regexMatch: { input: '$turnoLower', regex: /day|día|dia/ } }] }, 1, 0] } },
          noche: { $sum: { $cond: [{ $or: [{ $regexMatch: { input: '$turnoLower', regex: /night|noche/ } }] }, 1, 0] } },
          total: { $sum: 1 }
      }},
      { $match: { total: { $gt: 0 } } },
      { $sort: { _id: -1 } },
      { $limit: limit },
      { $sort: { _id: 1 } },
      { $project: { _id: 0, date: '$_id', dia: 1, noche: 1, total: 1 } }
    );

    let tendencia = await EscaneadoraRegistro.aggregate(pipeline);

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

    let registros = await EscaneadoraRegistro.find(proFilter);
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
      if (t === 'Otro' && r.createdAt) t = calcTurnoFromHour(new Date(r.createdAt));
      if (!turnoStats[t]) { turnoStats[t] = 0; turnoDates[t] = new Set(); }
      turnoStats[t]++;
      turnoDates[t].add(r.fecha);
    });
    const promedios = Object.entries(turnoStats).map(([turno, total]) => ({
      turno, totalRegistros: total, totalDias: turnoDates[turno].size,
      promedio: turnoDates[turno].size > 0 ? (total / turnoDates[turno].size).toFixed(1) : 0,
    }));

    res.json({ success: true, tendencia, promedios });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/dashboard/catalogos — Listas para filtros
router.get('/catalogos', async (req, res) => {
  try {
    const escaneadoras = await EscaneadoraRegistro.distinct('escaneadora');
    const destinos = await EscaneadoraRegistro.distinct('destino');
    const turnos = await EscaneadoraRegistro.distinct('turno');
    const fechas = await EscaneadoraRegistro.distinct('fecha');

    res.json({
      success: true,
      escaneadoras: escaneadoras.sort(),
      destinos: destinos.sort(),
      turnos: turnos.sort(),
      fechas: fechas.sort(),
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
