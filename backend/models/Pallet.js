const mongoose = require('mongoose');

const palletSchema = new mongoose.Schema({
  palletId: { type: String, required: true, index: true },
  cantidad: { type: Number, default: 0 },
  condicion: { type: String, default: '' },
  destino: { type: String, required: true },
  turno: { type: String, required: true },
  escaneadora: { type: String, default: '' },
  pedido: { type: String, default: '' },
  fecha: { type: String, required: true }, // M/D/YYYY format from original sheet
  producto: { type: String, default: '' },
  observaciones: { type: String, default: '' },
  source: { type: String, enum: ['migrated-anterior', 'migrated-formulario', 'web', 'mobile'], default: 'web' },
}, {
  timestamps: true // adds createdAt + updatedAt
});

// Index for fast date + shift queries
palletSchema.index({ fecha: 1, turno: 1 });
palletSchema.index({ escaneadora: 1 });
palletSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Pallet', palletSchema);
