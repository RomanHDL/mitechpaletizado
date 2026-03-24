const mongoose = require('mongoose');

const errorSchema = new mongoose.Schema({
  palletId: { type: String, required: true, index: true },
  fecha: { type: String, required: true },
  defecto: { type: String, required: true },
  tipo: { type: String, default: '' },
}, {
  timestamps: true
});

errorSchema.index({ fecha: 1 });

module.exports = mongoose.model('PalletError', errorSchema);
