/**
 * sync-sheets.js
 * Sincroniza datos de Google Sheets → MySQL (paletizado_db)
 *
 * Uso:
 *   node sync-sheets.js          (sync una vez)
 *   node sync-sheets.js --auto   (sync cada 60 segundos)
 */

const mysql = require('mysql2/promise');
const https = require('https');
const config = require('./config');

// ── NUEVO SPREADSHEET OFICIAL ──
// spreadsheetId: 1nAouHO7k2s7kSzrz2IX3GF_Y0Ba0ZDhx_JZsaR3rK44
// Hoja "anterior" = datos históricos
// Hoja "formulario de escaneadores" = registros nuevos
const NEW_SPREADSHEET_ID = '1nAouHO7k2s7kSzrz2IX3GF_Y0Ba0ZDhx_JZsaR3rK44';
const SHEET_HISTORICO = `https://docs.google.com/spreadsheets/d/${NEW_SPREADSHEET_ID}/gviz/tq?tqx=out:json&sheet=anterior`;
const SHEET_NUEVOS = `https://docs.google.com/spreadsheets/d/${NEW_SPREADSHEET_ID}/gviz/tq?tqx=out:json&sheet=formulario%20de%20escaneadores`;
const SHEET_ERRORES = `https://docs.google.com/spreadsheets/d/${NEW_SPREADSHEET_ID}/gviz/tq?tqx=out:json&sheet=Liberaci%C3%B3n%20de%20Pallet`;

// =============================================
// Fetch URL y extraer JSON del wrapper JSONP
// =============================================
function fetchSheet(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    // Google devuelve: google.visualization.Query.setResponse({...})
                    // o: window.processErrorsData({...})
                    // Extraemos el JSON entre el primer '(' y el último ')'
                    const start = data.indexOf('(');
                    const end = data.lastIndexOf(')');
                    if (start === -1 || end === -1) {
                        throw new Error('No se pudo extraer JSON del response JSONP');
                    }
                    const jsonStr = data.substring(start + 1, end);
                    resolve(JSON.parse(jsonStr));
                } catch (e) {
                    reject(new Error('Error parseando respuesta: ' + e.message));
                }
            });
            res.on('error', reject);
        }).on('error', reject);
    });
}

// =============================================
// Convertir fecha Google (Date(y,m,d,...)) a YYYY-MM-DD
// =============================================
function parseGoogleDate(cell) {
    if (!cell) return null;

    // Si tiene formato legible (cell.f), intentar parsear "M/d/yyyy" o "M/d/yyyy H:mm:ss"
    if (cell.f) {
        const datePart = cell.f.split(' ')[0]; // "3/1/2026"
        const parts = datePart.split('/');
        if (parts.length === 3) {
            const m = parts[0].padStart(2, '0');
            const d = parts[1].padStart(2, '0');
            const y = parts[2];
            return `${y}-${m}-${d}`;
        }
    }

    // Si tiene valor crudo tipo "Date(2026,2,1)" (mes 0-indexed en Google)
    if (cell.v && typeof cell.v === 'string' && cell.v.startsWith('Date(')) {
        const match = cell.v.match(/Date\((\d+),(\d+),(\d+)/);
        if (match) {
            const y = match[1];
            const m = (parseInt(match[2]) + 1).toString().padStart(2, '0');
            const d = match[3].padStart(2, '0');
            return `${y}-${m}-${d}`;
        }
    }

    return null;
}

// =============================================
// Sincronizar PALLETS
// =============================================
async function syncPalletsFromSheet(pool, sheetUrl, label) {
    console.log(`  Descargando ${label}...`);
    let response;
    try {
        response = await fetchSheet(sheetUrl);
    } catch (err) {
        console.error(`  ERROR descargando ${label}: ${err.message}`);
        return { total: 0, inserted: 0, skipped: 0 };
    }

    if (!response || !response.table || !response.table.rows) {
        console.warn(`  ${label}: respuesta vacía o inválida`);
        return { total: 0, inserted: 0, skipped: 0 };
    }

    const rows = response.table.rows;
    let inserted = 0;
    let skipped = 0;

    for (const r of rows) {
        const c = r.c;
        if (!c || !c[4] || c[4].v === null) {
            skipped++;
            continue;
        }

        const pallet_id = (c[1] && c[1].v != null) ? c[1].v.toString().trim() : null;
        const cantidad = (c[2] && c[2].v != null) ? parseFloat(c[2].v.toString().replace(/,/g, '')) || 0 : 0;
        const producto = (c[3] && c[3].v != null) ? c[3].v.toString().trim() : null;
        const destino = (c[4] && c[4].v != null) ? c[4].v.toString().trim() : '';
        const fecha = parseGoogleDate(c[5]);
        const turno = (c[6] && c[6].v != null) ? c[6].v.toString().trim() : 'N/A';
        const condicion = (c[7] && c[7].v != null) ? c[7].v.toString().trim() : null;
        const observaciones = (c[8] && c[8].v != null) ? c[8].v.toString().trim() : null;

        if (!pallet_id || !fecha) {
            skipped++;
            continue;
        }

        try {
            const [result] = await pool.query(
                `INSERT IGNORE INTO pallets (pallet_id, cantidad, producto, destino, fecha, turno, condicion, observaciones)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [pallet_id, cantidad, producto, destino, fecha, turno, condicion, observaciones]
            );
            if (result.affectedRows > 0) inserted++;
            else skipped++;
        } catch (e) {
            console.error(`    Error insertando pallet ${pallet_id}:`, e.message);
            skipped++;
        }
    }

    return { total: rows.length, inserted, skipped };
}

async function syncPallets(pool) {
    // Lee de AMBAS hojas y combina resultados
    const hist = await syncPalletsFromSheet(pool, SHEET_HISTORICO, 'HISTORICO (anterior)');
    const nuevos = await syncPalletsFromSheet(pool, SHEET_NUEVOS, 'NUEVOS (formulario de escaneadores)');
    return {
        total: hist.total + nuevos.total,
        inserted: hist.inserted + nuevos.inserted,
        skipped: hist.skipped + nuevos.skipped
    };
}

// =============================================
// Sincronizar ERRORES
// =============================================
async function syncErrores(pool) {
    console.log('  Descargando errores de Google Sheets...');
    const response = await fetchSheet(SHEET_ERRORES);

    if (!response || !response.table || !response.table.rows) {
        throw new Error('Respuesta de errores inválida');
    }

    const rows = response.table.rows;
    let inserted = 0;
    let skipped = 0;

    for (const r of rows) {
        const c = r.c;
        // Col J (c[9]) = Defecto - es el campo principal
        if (!c || !c[9] || c[9].v === null) {
            skipped++;
            continue;
        }

        const defecto = c[9].v.toString().trim();
        if (defecto === '' || defecto === '-') {
            skipped++;
            continue;
        }

        const pallet_id = (c[3] && c[3].v != null) ? c[3].v.toString().trim() : 'N/A';
        const fecha = parseGoogleDate(c[1]);
        const tipo = (c[11] && c[11].v != null) ? c[11].v.toString().trim() : null;

        if (!fecha) {
            skipped++;
            continue;
        }

        try {
            const [result] = await pool.query(
                `INSERT IGNORE INTO errores_pallet (pallet_id, fecha, defecto, tipo)
                 VALUES (?, ?, ?, ?)`,
                [pallet_id, fecha, defecto, tipo]
            );
            if (result.affectedRows > 0) inserted++;
            else skipped++;
        } catch (e) {
            console.error(`    Error insertando error ${pallet_id}:`, e.message);
            skipped++;
        }
    }

    return { total: rows.length, inserted, skipped };
}

// =============================================
// EJECUCIÓN PRINCIPAL
// =============================================
const INTERVALO = 30; // segundos entre cada sync
const pool = mysql.createPool(config.db); // Pool persistente

async function runSync() {
    const timestamp = new Date().toLocaleString('es-MX');

    try {
        const palletResult = await syncPallets(pool);
        const errorResult = await syncErrores(pool);

        // Solo mostrar detalle si hubo datos nuevos
        if (palletResult.inserted > 0 || errorResult.inserted > 0) {
            console.log(`[${timestamp}] +${palletResult.inserted} pallets, +${errorResult.inserted} errores nuevos`);
        } else {
            process.stdout.write(`\r[${timestamp}] Sin cambios - MySQL al día (${palletResult.total} pallets, ${errorResult.total} errores)   `);
        }
    } catch (error) {
        console.error(`\n[${timestamp}] ERROR: ${error.message}`);
    }
}

// =============================================
// INICIO
// =============================================
console.log('===========================================');
console.log('  Google Sheets → MySQL (Tiempo Real)');
console.log(`  Sincronizando cada ${INTERVALO} segundos`);
console.log('  Ctrl+C para detener');
console.log('===========================================');

runSync();
setInterval(runSync, INTERVALO * 1000);
