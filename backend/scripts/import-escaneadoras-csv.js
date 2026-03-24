/**
 * import-escaneadoras-csv.js — Importar registros de escaneadoras desde CSV a MongoDB
 *
 * USO:
 *   1. Exporta la hoja "formulario de escaneadores" del Google Sheet como CSV
 *      Sheet: https://docs.google.com/spreadsheets/d/1nAouHO7k2s7kSzrz2IX3GF_Y0Ba0ZDhx_JZsaR3rK44
 *      Tab gid: 392751254
 *   2. Guarda el archivo como: backend/scripts/escaneadoras.csv
 *   3. Ejecuta: cd backend && node scripts/import-escaneadoras-csv.js
 *
 * El script:
 *   - Lee el CSV y detecta columnas automaticamente
 *   - Mapea las columnas a campos del modelo EscaneadoraRegistro
 *   - Filtra registros anteriores al 20 de marzo de 2026
 *   - Inserta en MongoDB Atlas
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const dns = require('dns');

dns.setServers(['8.8.8.8', '8.8.4.4']);

const EscaneadoraRegistro = require('../models/EscaneadoraRegistro');

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

function parseCSV(text) {
  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length < 2) return { headers: [], rows: [] };
  const headers = parseCSVLine(lines[0]).map(h => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = (values[idx] || '').trim();
    });
    rows.push(row);
  }
  return { headers, rows };
}

// Auto-detect column mapping
function findColumn(headers, patterns) {
  for (const p of patterns) {
    const found = headers.find(h => h.toLowerCase().trim() === p.toLowerCase().trim());
    if (found) return found;
  }
  for (const p of patterns) {
    const found = headers.find(h => h.toLowerCase().includes(p.toLowerCase()));
    if (found) return found;
  }
  return null;
}

const CUTOFF = new Date('2026-03-20');

function parseDate(str) {
  if (!str) return null;
  // Try M/D/YYYY
  const parts = str.split('/');
  if (parts.length === 3) {
    const m = parseInt(parts[0]), d = parseInt(parts[1]), y = parseInt(parts[2]);
    if (y > 2000) return new Date(y, m - 1, d);
  }
  // Try ISO
  const iso = new Date(str);
  if (!isNaN(iso)) return iso;
  // Try from timestamp "M/D/YYYY H:MM:SS"
  const tsParts = str.split(' ');
  if (tsParts.length >= 1) {
    const dp = tsParts[0].split('/');
    if (dp.length === 3) {
      return new Date(parseInt(dp[2]), parseInt(dp[0]) - 1, parseInt(dp[1]));
    }
  }
  return null;
}

async function importCSV() {
  const csvPath = path.join(__dirname, 'escaneadoras.csv');

  console.log('═══════════════════════════════════════════');
  console.log('  Importar Escaneadoras CSV → MongoDB');
  console.log('═══════════════════════════════════════════');

  if (!fs.existsSync(csvPath)) {
    console.error(`\nERROR: No se encontro el archivo: ${csvPath}`);
    console.log('\nPasos:');
    console.log('  1. Abre el Google Sheet');
    console.log('  2. Ve a la hoja "formulario de escaneadores" (gid=392751254)');
    console.log('  3. Archivo → Descargar → CSV (.csv)');
    console.log('  4. Guarda como: backend/scripts/escaneadoras.csv');
    console.log('  5. Ejecuta de nuevo este script');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`\nConectado a MongoDB (${mongoose.connection.db.databaseName})`);

  const text = fs.readFileSync(csvPath, 'utf-8');
  const { headers, rows } = parseCSV(text);

  console.log(`\nColumnas detectadas (${headers.length}):`);
  headers.forEach((h, i) => console.log(`  [${i}] "${h}"`));
  console.log(`\nFilas en CSV: ${rows.length}`);

  // Auto-map columns
  const colMap = {
    escaneadora: findColumn(headers, ['escaneadora', 'Escaneadora', 'operador', 'Operador', 'operadora', 'Operadora', 'nombre', 'scanner']),
    turno: findColumn(headers, ['turno', 'Turno', 'shift', 'Shift']),
    fecha: findColumn(headers, ['fecha', 'Fecha', 'date', 'Date', 'Marca temporal', 'marca temporal', 'timestamp']),
    linea: findColumn(headers, ['linea', 'Linea', 'línea', 'Línea', 'line', 'area', 'Area', 'área']),
    palletsEscaneados: findColumn(headers, ['pallets', 'Pallets', 'pallets_escaneados', 'cantidad', 'Cantidad', 'qty', 'total', 'Total']),
    horaInicio: findColumn(headers, ['hora_inicio', 'Hora inicio', 'horainicio', 'inicio', 'Inicio', 'start']),
    horaFin: findColumn(headers, ['hora_fin', 'Hora fin', 'horafin', 'fin', 'Fin', 'end']),
    incidencias: findColumn(headers, ['incidencias', 'Incidencias', 'incidencia', 'Incidencia']),
    observaciones: findColumn(headers, ['observaciones', 'Observaciones', 'notas', 'Notas', 'comentarios', 'Comentarios']),
  };

  console.log('\nMapeo de columnas:');
  for (const [field, col] of Object.entries(colMap)) {
    console.log(`  ${field} → ${col || '(no encontrada)'}`);
  }

  if (!colMap.escaneadora) {
    console.error('\nERROR: No se pudo detectar la columna de escaneadora/operador.');
    console.log('Columnas disponibles:', headers.join(', '));
    console.log('\nNecesito al menos una columna que contenga: escaneadora, operador, operadora, nombre, scanner');
    process.exit(1);
  }

  const docs = [];
  let skipped = 0;
  let oldDates = 0;

  for (const row of rows) {
    const escaneadora = colMap.escaneadora ? row[colMap.escaneadora] : '';
    const turno = colMap.turno ? row[colMap.turno] : '';
    const fechaRaw = colMap.fecha ? row[colMap.fecha] : '';

    if (!escaneadora) {
      skipped++;
      continue;
    }

    // Filtrar por fecha
    const parsedDate = parseDate(fechaRaw);
    if (parsedDate && parsedDate < CUTOFF) {
      oldDates++;
      continue;
    }

    const fecha = fechaRaw ? fechaRaw.split(' ')[0] : '';

    // Collect extra columns
    const mappedCols = new Set(Object.values(colMap).filter(Boolean));
    const datosExtra = {};
    for (const [k, v] of Object.entries(row)) {
      if (!mappedCols.has(k) && v) datosExtra[k] = v;
    }

    docs.push({
      escaneadora,
      turno: turno || 'Sin turno',
      fecha: fecha || `${new Date().getMonth()+1}/${new Date().getDate()}/${new Date().getFullYear()}`,
      linea: colMap.linea ? row[colMap.linea] || '' : '',
      palletsEscaneados: parseInt(colMap.palletsEscaneados ? row[colMap.palletsEscaneados] : '0') || 0,
      horaInicio: colMap.horaInicio ? row[colMap.horaInicio] || '' : '',
      horaFin: colMap.horaFin ? row[colMap.horaFin] || '' : '',
      incidencias: colMap.incidencias ? row[colMap.incidencias] || '' : '',
      observaciones: colMap.observaciones ? row[colMap.observaciones] || '' : '',
      datosExtra,
      source: 'csv-import',
    });
  }

  console.log(`\nRegistros validos: ${docs.length}`);
  console.log(`Omitidos (sin escaneadora): ${skipped}`);
  console.log(`Omitidos (antes del 20/03/2026): ${oldDates}`);

  if (docs.length > 0) {
    const result = await EscaneadoraRegistro.insertMany(docs);
    console.log(`\nInsertados en MongoDB: ${result.length}`);
  } else {
    console.log('\nNo hay registros para insertar.');
  }

  const total = await EscaneadoraRegistro.countDocuments();
  console.log(`\nTotal registros escaneadoras en DB: ${total}`);

  console.log('═══════════════════════════════════════════');
  await mongoose.disconnect();
}

importCSV().catch(err => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
