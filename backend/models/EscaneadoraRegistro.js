const mongoose = require('mongoose');

const escaneadoraRegistroSchema = new mongoose.Schema({
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

escaneadoraRegistroSchema.index({ fecha: 1, turno: 1 });
escaneadoraRegistroSchema.index({ escaneadora: 1, fecha: 1 });
escaneadoraRegistroSchema.index({ createdAt: -1 });

module.exports = mongoose.model('EscaneadoraRegistro', escaneadoraRegistroSchema);
