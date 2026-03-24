const mongoose = require('mongoose');

const resumenPaletizadoSchema = new mongoose.Schema({
  turno: { type: String, required: true, enum: ['Day (dia)', 'Night (noche)'] },
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

resumenPaletizadoSchema.index({ fecha: 1, turno: 1 });
resumenPaletizadoSchema.index({ createdAt: -1 });

module.exports = mongoose.model('ResumenPaletizado', resumenPaletizadoSchema);
