/**
 * seed-users.js — Crear usuarios iniciales en MongoDB
 *
 * Uso: cd backend && node scripts/seed-users.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const dns = require('dns');
dns.setServers(['8.8.8.8', '8.8.4.4']);

const User = require('../models/User');

const users = [
  { nombre: 'Administrador',   usuario: 'admin',     password: 'Admin2026!',  role: 'admin' },
  { nombre: 'Yusley Montes',   usuario: 'yusley',    password: 'Scan2026!',   role: 'escaneadora' },
  { nombre: 'Angelica Aleman', usuario: 'angelica',  password: 'Scan2026!',   role: 'escaneadora' },
  { nombre: 'Cecilia Perez',   usuario: 'cecilia',   password: 'Scan2026!',   role: 'escaneadora' },
  { nombre: 'Nathalie Lopez',  usuario: 'nathalie',  password: 'Scan2026!',   role: 'escaneadora' },
];

async function seed() {
  console.log('══════════════════════════════════════');
  console.log('  Seed: usuarios → MongoDB');
  console.log('══════════════════════════════════════');

  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Conectado a MongoDB');

  for (const u of users) {
    const exists = await User.findOne({ usuario: u.usuario });
    if (exists) {
      console.log(`  [SKIP] ${u.usuario} ya existe (role: ${exists.role})`);
      continue;
    }
    const passwordHash = await User.hashPassword(u.password);
    await User.create({ nombre: u.nombre, usuario: u.usuario, passwordHash, role: u.role });
    console.log(`  [OK] ${u.usuario} creado (role: ${u.role})`);
  }

  const total = await User.countDocuments();
  console.log(`\nTotal usuarios en DB: ${total}`);
  console.log('══════════════════════════════════════');
  console.log('\nCredenciales:');
  users.forEach(u => console.log(`  ${u.usuario} / ${u.password} (${u.role})`));

  await mongoose.disconnect();
}

seed().catch(err => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
