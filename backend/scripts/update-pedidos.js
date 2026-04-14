// Script unico para marcar pallets como pedidos con su clasificacion
// Ejecutar: cd backend && node scripts/update-pedidos.js

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const dns = require('dns');
dns.setServers(['8.8.8.8', '8.8.4.4']);
const mongoose = require('mongoose');

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) { console.error('MONGODB_URI no definida'); process.exit(1); }

// Pallets a actualizar: { palletId: clasificacion }
const updates = {
  // Alejandro
  '343105': 'Alejandro',
  '343167': 'Alejandro',
  '343278': 'Alejandro',
  '343343': 'Alejandro',
  // Lorena
  '343432': 'Lorena',
  '343341': 'Lorena',
  // Jesus
  '343378': 'Jesus',
};

async function run() {
  await mongoose.connect(MONGODB_URI);
  const db = mongoose.connection.db;
  const col = db.collection('escaneadoraregistros');

  console.log('Conectado a MongoDB\n');

  for (const [palletId, clasificacion] of Object.entries(updates)) {
    const doc = await col.findOne({ palletId });
    if (!doc) {
      console.log(`[SKIP] ${palletId} — no encontrado en la DB`);
      continue;
    }

    // Marcar como pedido: poner clasificacion en observaciones, pedido = clasificacion
    const newObs = doc.observaciones
      ? (doc.observaciones.includes(clasificacion) ? doc.observaciones : clasificacion + ' | ' + doc.observaciones)
      : clasificacion;

    await col.updateOne(
      { palletId },
      { $set: { pedido: clasificacion, observaciones: newObs } }
    );
    console.log(`[OK] ${palletId} → pedido: "${clasificacion}", obs: "${newObs}"`);
  }

  console.log('\nListo. Todos los pallets actualizados.');
  await mongoose.disconnect();
}

run().catch(err => { console.error(err); process.exit(1); });
