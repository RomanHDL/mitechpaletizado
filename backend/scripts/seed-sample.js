/**
 * seed-sample.js — Inserta datos de ejemplo para probar el sistema
 *
 * Uso: cd backend && node scripts/seed-sample.js
 *
 * Esto inserta registros representativos para que el dashboard funcione
 * mientras se completa la migración del Google Sheet.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const dns = require('dns');
dns.setServers(['8.8.8.8', '8.8.4.4']);

const Pallet = require('../models/Pallet');

const sampleData = [
  // Históricos (simulando hoja "anterior")
  { palletId: '100001', cantidad: 48, condicion: 'GRB', destino: 'Almacén', turno: 'Day (día)', escaneadora: 'Angélica Alemán', fecha: '3/1/2026', source: 'migrated-anterior' },
  { palletId: '100002', cantidad: 36, condicion: 'GRA', destino: 'TRG', turno: 'Day (día)', escaneadora: 'Nathalie López', fecha: '3/1/2026', source: 'migrated-anterior' },
  { palletId: '100003', cantidad: 24, condicion: 'GRB', destino: 'Almacén', turno: 'Night (noche)', escaneadora: 'Cecilia Pérez', fecha: '3/1/2026', source: 'migrated-anterior' },
  { palletId: '100004', cantidad: 48, condicion: 'ICB', destino: 'HV (High Value)', turno: 'Day (día)', escaneadora: 'Yusley Montes', fecha: '3/2/2026', source: 'migrated-anterior' },
  { palletId: '100005', cantidad: 36, condicion: 'GRB', destino: 'Almacén', turno: 'Night (noche)', escaneadora: 'Cecilia Pérez', fecha: '3/2/2026', source: 'migrated-anterior' },
  { palletId: '100006', cantidad: 48, condicion: 'GRA', destino: 'TRG', turno: 'Day (día)', escaneadora: 'Angélica Alemán', fecha: '3/3/2026', source: 'migrated-anterior' },
  { palletId: '100007', cantidad: 24, condicion: 'GRC', destino: 'Almacén', turno: 'Day (día)', escaneadora: 'Nathalie López', fecha: '3/3/2026', source: 'migrated-anterior' },
  { palletId: '100008', cantidad: 36, condicion: 'GRB', destino: 'BOX', turno: 'Night (noche)', escaneadora: 'Cecilia Pérez', fecha: '3/3/2026', source: 'migrated-anterior' },
  { palletId: '100009', cantidad: 48, condicion: 'GRB', destino: 'Almacén', turno: 'Day (día)', escaneadora: 'Angélica Alemán', fecha: '3/4/2026', source: 'migrated-anterior' },
  { palletId: '100010', cantidad: 36, condicion: 'ICB', destino: 'TRG', turno: 'Day (día)', escaneadora: 'Yusley Montes', fecha: '3/4/2026', source: 'migrated-anterior' },
  { palletId: '100011', cantidad: 24, condicion: 'GRA', destino: 'Almacén', turno: 'Night (noche)', escaneadora: 'Cecilia Pérez', fecha: '3/4/2026', source: 'migrated-anterior' },
  { palletId: '100012', cantidad: 48, condicion: 'GRB', destino: 'Almacén', turno: 'Day (día)', escaneadora: 'Nathalie López', fecha: '3/5/2026', source: 'migrated-anterior' },
  { palletId: '100013', cantidad: 36, condicion: 'GRB', destino: 'TRG', turno: 'Night (noche)', escaneadora: 'Cecilia Pérez', fecha: '3/5/2026', source: 'migrated-anterior' },
  { palletId: '100014', cantidad: 48, condicion: 'GRA', destino: 'HV (High Value)', turno: 'Day (día)', escaneadora: 'Angélica Alemán', fecha: '3/6/2026', source: 'migrated-anterior' },
  { palletId: '100015', cantidad: 24, condicion: 'GRB', destino: 'Almacén', turno: 'Day (día)', escaneadora: 'Yusley Montes', fecha: '3/6/2026', source: 'migrated-anterior' },
  // Más recientes (simulando hoja "formulario de escaneadores")
  { palletId: '200001', cantidad: 48, condicion: 'GRB', destino: 'Almacén', turno: 'Day (día)', escaneadora: 'Angélica Alemán', fecha: '3/17/2026', source: 'migrated-formulario' },
  { palletId: '200002', cantidad: 36, condicion: 'GRA', destino: 'TRG', turno: 'Day (día)', escaneadora: 'Nathalie López', fecha: '3/17/2026', source: 'migrated-formulario' },
  { palletId: '200003', cantidad: 24, condicion: 'GRB', destino: 'Almacén', turno: 'Night (noche)', escaneadora: 'Cecilia Pérez', fecha: '3/17/2026', source: 'migrated-formulario' },
  { palletId: '200004', cantidad: 48, condicion: 'ICB', destino: 'HV (High Value)', turno: 'Day (día)', escaneadora: 'Yusley Montes', fecha: '3/18/2026', source: 'migrated-formulario' },
  { palletId: '200005', cantidad: 36, condicion: 'GRB', destino: 'Almacén', turno: 'Night (noche)', escaneadora: 'Cecilia Pérez', fecha: '3/18/2026', source: 'migrated-formulario' },
  { palletId: '200006', cantidad: 48, condicion: 'GRA', destino: 'TRG', turno: 'Day (día)', escaneadora: 'Angélica Alemán', fecha: '3/19/2026', source: 'migrated-formulario' },
  { palletId: '200007', cantidad: 24, condicion: 'GRB', destino: 'Almacén', turno: 'Day (día)', escaneadora: 'Nathalie López', fecha: '3/19/2026', source: 'migrated-formulario' },
  { palletId: '200008', cantidad: 36, condicion: 'GRC', destino: 'BOX', turno: 'Night (noche)', escaneadora: 'Cecilia Pérez', fecha: '3/19/2026', source: 'migrated-formulario' },
];

async function seed() {
  console.log('═══════════════════════════════════════');
  console.log('  Seed: datos de ejemplo → MongoDB');
  console.log('═══════════════════════════════════════');

  await mongoose.connect(process.env.MONGODB_URI);
  console.log('✓ Conectado a MongoDB');

  const existing = await Pallet.countDocuments();
  if (existing > 0) {
    console.log(`⚠ Ya hay ${existing} pallets en la DB. ¿Borrar e insertar de nuevo?`);
    console.log('  (Para borrar primero, ejecuta: node -e "require(\'dotenv\').config();const m=require(\'mongoose\');const d=require(\'dns\');d.setServers([\'8.8.8.8\']);m.connect(process.env.MONGODB_URI).then(()=>m.connection.db.dropCollection(\'pallets\')).then(()=>{console.log(\'Colección borrada\');process.exit(0)})"');
    console.log('  Insertando sin borrar...');
  }

  const result = await Pallet.insertMany(sampleData);
  console.log(`✓ Insertados ${result.length} pallets de ejemplo`);

  const total = await Pallet.countDocuments();
  console.log(`  Total en DB: ${total}`);

  await mongoose.disconnect();
  console.log('═══════════════════════════════════════');
}

seed().catch(err => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
