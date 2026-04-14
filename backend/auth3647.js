// Rastreo de dispositivos autorizados por usuario 3647
// Cuando 3647 inicia sesion en un dispositivo, ese dispositivo queda
// autorizado por 12 horas para registrar cantidad 0 en piezas,
// incluso si despues se inicia sesion con otra cuenta de escaneadora.
// Se persiste en MongoDB para sobrevivir reinicios del servidor.

const mongoose = require('mongoose');

const TTL = 12 * 60 * 60 * 1000; // 12 horas

function collection() {
  return mongoose.connection.db.collection('auth3647_devices');
}

async function authorize(deviceId) {
  if (!deviceId) return;
  const now = new Date();
  await collection().updateOne(
    { deviceId },
    { $set: { deviceId, authorizedAt: now, expiresAt: new Date(now.getTime() + TTL) } },
    { upsert: true }
  );
}

async function isAuthorized(deviceId) {
  if (!deviceId) return false;
  const doc = await collection().findOne({
    deviceId,
    expiresAt: { $gt: new Date() }
  });
  return !!doc;
}

module.exports = { authorize, isAuthorized };
