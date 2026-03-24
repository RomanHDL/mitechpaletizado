/**
 * migrate-csv.js — Migrar datos de Google Sheets (CSV) a MongoDB Atlas
 *
 * USO:
 *   1. Abre el Google Sheet: https://docs.google.com/spreadsheets/d/1nAouHO7k2s7kSzrz2IX3GF_Y0Ba0ZDhx_JZsaR3rK44
 *   2. Ve a la hoja "anterior" → Archivo → Descargar → CSV (.csv)
 *      Guárdalo como: backend/scripts/anterior.csv
 *   3. Ve a la hoja "formulario de escaneadores" → Archivo → Descargar → CSV (.csv)
 *      Guárdalo como: backend/scripts/formulario.csv
 *   4. Ejecuta:  node scripts/migrate-csv.js
 *
 * El script lee ambos CSVs y los inserta en MongoDB Atlas.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const dns = require('dns');

dns.setServers(['8.8.8.8', '8.8.4.4']);

const Pallet = require('../models/Pallet');

function parseCSV(text) {
  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];

  // Parse header
  const headers = parseCSVLine(lines[0]);

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    const row = {};
    headers.forEach((h, idx) => {
      row[h.trim()] = (values[idx] || '').trim();
    });
    rows.push(row);
  }
  return rows;
}

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (c === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += c;
    }
  }
  result.push(current);
  return result;
}

// Map CSV columns to our Pallet model
// Expected columns (may vary):
// Marca temporal, Número de pallet, Cantidad, CONDICION, Destino/¿Dónde va el pallet?, Fecha, Turno, Escaneadora, Pedido
function mapRowToPallet(row, source) {
  const keys = Object.keys(row);

  // Find columns by pattern matching (headers may differ between sheets)
  const findCol = (patterns) => {
    for (const p of patterns) {
      const key = keys.find(k => k.toLowerCase().includes(p.toLowerCase()));
      if (key) return row[key];
    }
    return '';
  };

  const palletId = findCol(['pallet', 'número', 'numero', 'Pallet']) || '';
  const cantidad = findCol(['cantidad', 'qty', 'Cantidad']) || '0';
  const condicion = findCol(['condicion', 'CONDICION', 'condición']) || '';
  const destino = findCol(['destino', 'Dónde', 'donde', '¿Dónde']) || '';
  const fecha = findCol(['fecha', 'Fecha']) || '';
  const turno = findCol(['turno', 'Turno']) || '';
  const escaneadora = findCol(['escaneadora', 'Escaneadora', 'scanner']) || '';
  const pedido = findCol(['pedido', 'Pedido', 'orden']) || '';
  const timestamp = findCol(['marca temporal', 'timestamp', 'Marca']) || '';

  if (!palletId || !destino) return null;

  return {
    palletId: palletId.split('-')[0].trim(),
    cantidad: parseInt(cantidad.replace(/,/g, '')) || 0,
    condicion,
    destino,
    fecha: fecha || (timestamp ? timestamp.split(' ')[0] : ''),
    turno,
    escaneadora,
    pedido,
    observaciones: '',
    producto: '',
    source,
  };
}

async function migrate() {
  console.log('═══════════════════════════════════════');
  console.log('  Migración Google Sheets → MongoDB');
  console.log('═══════════════════════════════════════');

  // Connect to MongoDB
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`✓ Conectado a MongoDB (${mongoose.connection.db.databaseName})`);

  const existingCount = await Pallet.countDocuments();
  console.log(`  Pallets existentes en DB: ${existingCount}`);

  let totalImported = 0;
  let totalSkipped = 0;

  // Process each CSV file
  const files = [
    { name: 'anterior.csv', source: 'migrated-anterior' },
    { name: 'formulario.csv', source: 'migrated-formulario' },
  ];

  for (const file of files) {
    const filePath = path.join(__dirname, file.name);

    if (!fs.existsSync(filePath)) {
      console.log(`\n⚠ ${file.name} no encontrado — saltando`);
      console.log(`  (Descárgalo del Google Sheet y guárdalo en backend/scripts/${file.name})`);
      continue;
    }

    console.log(`\n── Procesando ${file.name} ──`);
    const text = fs.readFileSync(filePath, 'utf-8');
    const rows = parseCSV(text);
    console.log(`  Filas encontradas: ${rows.length}`);

    if (rows.length > 0) {
      console.log(`  Columnas: ${Object.keys(rows[0]).join(', ')}`);
    }

    const docs = [];
    let skipped = 0;

    for (const row of rows) {
      const mapped = mapRowToPallet(row, file.source);
      if (!mapped || !mapped.palletId) {
        skipped++;
        continue;
      }
      docs.push(mapped);
    }

    if (docs.length > 0) {
      // Check for duplicates by palletId + fecha
      const existing = await Pallet.find({
        palletId: { $in: docs.map(d => d.palletId) }
      }).select('palletId fecha');

      const existingKeys = new Set(existing.map(e => `${e.palletId}|${e.fecha}`));

      const toInsert = docs.filter(d => !existingKeys.has(`${d.palletId}|${d.fecha}`));
      const dupes = docs.length - toInsert.length;

      if (toInsert.length > 0) {
        await Pallet.insertMany(toInsert);
        console.log(`  ✓ Insertados: ${toInsert.length}`);
      }
      if (dupes > 0) {
        console.log(`  ⊘ Duplicados omitidos: ${dupes}`);
      }
      console.log(`  ⊘ Filas inválidas: ${skipped}`);

      totalImported += toInsert.length;
      totalSkipped += skipped + dupes;
    } else {
      console.log(`  No se encontraron registros válidos`);
    }
  }

  const finalCount = await Pallet.countDocuments();
  console.log('\n═══════════════════════════════════════');
  console.log(`  RESULTADO:`);
  console.log(`  Importados: ${totalImported}`);
  console.log(`  Omitidos:   ${totalSkipped}`);
  console.log(`  Total en DB: ${finalCount}`);
  console.log('═══════════════════════════════════════');

  await mongoose.disconnect();
}

migrate().catch(err => {
  console.error('ERROR:', err);
  process.exit(1);
});
