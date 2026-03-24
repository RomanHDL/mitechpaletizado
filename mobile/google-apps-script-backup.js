// ═══════════════════════════════════════════════════════════════
// Google Apps Script — LECTURA + ESCRITURA para MI-TECH Paletizado
//
// NUEVO SPREADSHEET OFICIAL:
//   https://docs.google.com/spreadsheets/d/1nAouHO7k2s7kSzrz2IX3GF_Y0Ba0ZDhx_JZsaR3rK44/edit
//
// INSTRUCCIONES DE DEPLOY:
// 1. Abrir el Google Sheet nuevo (link arriba)
// 2. Ir a Extensiones → Apps Script
// 3. Pegar este código completo (reemplazar todo el contenido)
// 4. Click en "Deploy" → "New deployment"
// 5. Tipo: "Web app"
// 6. Ejecutar como: "Yo" (tu cuenta)
// 7. Quién tiene acceso: "Cualquier persona"
// 8. Click en "Deploy" y copiar la URL generada
// 9. Pegar la URL en index.html → buscar APPS_SCRIPT_URL y reemplazar
//
// FUNCIONES:
// - doGet con action=readAll → lee "anterior" + "formulario de escaneadores" y devuelve JSONP
// - doGet con pallet=xxx     → escribe nueva fila en "formulario de escaneadores"
// - doPost                   → escribe nueva fila en "formulario de escaneadores"
// ═══════════════════════════════════════════════════════════════

var SPREADSHEET_ID = '1nAouHO7k2s7kSzrz2IX3GF_Y0Ba0ZDhx_JZsaR3rK44';
var SHEET_HISTORICO = 'anterior';
var SHEET_NUEVOS = 'formulario de escaneadores';

// ── LECTURA: Devuelve datos combinados de ambas hojas ──
function readAllSheets() {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);

  var allRows = [];

  // Leer hoja "anterior" (histórico)
  var sheetHist = ss.getSheetByName(SHEET_HISTORICO);
  if (sheetHist && sheetHist.getLastRow() > 1) {
    var dataHist = sheetHist.getDataRange().getValues();
    for (var i = 1; i < dataHist.length; i++) {
      allRows.push(dataHist[i]);
    }
  }

  // Leer hoja "formulario de escaneadores" (nuevos)
  var sheetNew = ss.getSheetByName(SHEET_NUEVOS);
  if (sheetNew && sheetNew.getLastRow() > 1) {
    var dataNew = sheetNew.getDataRange().getValues();
    for (var i = 1; i < dataNew.length; i++) {
      allRows.push(dataNew[i]);
    }
  }

  // Construir respuesta compatible con formato gviz (que espera processSheetData)
  // Columnas: A=Timestamp, B=Pallet, C=Qty, D=Condición, E=Destino, F=Fecha, G=Turno, H=Escaneadora, I=Pedido
  var cols = [
    {id: 'A', label: 'Marca temporal', type: 'datetime'},
    {id: 'B', label: 'Número de pallet', type: 'string'},
    {id: 'C', label: 'Cantidad', type: 'number'},
    {id: 'D', label: 'CONDICION', type: 'string'},
    {id: 'E', label: 'Destino', type: 'string'},
    {id: 'F', label: 'Fecha', type: 'datetime'},
    {id: 'G', label: 'Turno', type: 'string'},
    {id: 'H', label: 'Escaneadora', type: 'string'},
    {id: 'I', label: 'Pedido', type: 'string'}
  ];

  var rows = [];
  for (var i = 0; i < allRows.length; i++) {
    var row = allRows[i];
    var cells = [];

    for (var j = 0; j < 9; j++) {
      var val = (j < row.length) ? row[j] : '';

      if (val instanceof Date && !isNaN(val.getTime())) {
        var m = val.getMonth() + 1;
        var d = val.getDate();
        var y = val.getFullYear();
        var h = val.getHours();
        var min = val.getMinutes();
        var sec = val.getSeconds();
        cells.push({
          v: 'Date(' + y + ',' + (m - 1) + ',' + d + ',' + h + ',' + min + ',' + sec + ')',
          f: m + '/' + d + '/' + y + ' ' + h + ':' + (min < 10 ? '0' : '') + min + ':' + (sec < 10 ? '0' : '') + sec
        });
      } else if (val === '' || val === null || val === undefined) {
        cells.push(null);
      } else {
        cells.push({v: String(val), f: String(val)});
      }
    }

    rows.push({c: cells});
  }

  return {
    version: '0.6',
    status: 'ok',
    table: {cols: cols, rows: rows}
  };
}

// ── ESCRITURA: Agrega fila a "formulario de escaneadores" ──
function writeRecord(params) {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName(SHEET_NUEVOS);

  if (!sheet) {
    return {result: 'error', message: 'Hoja "' + SHEET_NUEVOS + '" no encontrada'};
  }

  var timestamp = params.timestamp || '';
  var fecha = '';
  if (timestamp) {
    fecha = timestamp.split(' ')[0];
  } else {
    var now = new Date();
    fecha = (now.getMonth() + 1) + '/' + now.getDate() + '/' + now.getFullYear();
    timestamp = fecha + ' ' + now.getHours() + ':' + (now.getMinutes() < 10 ? '0' : '') + now.getMinutes() + ':' + (now.getSeconds() < 10 ? '0' : '') + now.getSeconds();
  }

  sheet.appendRow([
    timestamp,
    params.pallet || '',
    params.qty || '',
    params.condicion || '',
    params.destino || '',
    fecha,
    params.turno || '',
    params.escaneadora || '',
    params.pedido || ''
  ]);

  var lastRow = sheet.getLastRow();
  sheet.getRange(lastRow, 1).setNumberFormat('@');

  return {result: 'ok', row: lastRow, sheet: SHEET_NUEVOS};
}

// ── doGet: Maneja tanto lectura como escritura via GET ──
function doGet(e) {
  try {
    var params = e ? (e.parameter || {}) : {};
    var action = params.action || '';
    var callback = params.callback || '';

    // LECTURA: action=readAll → devuelve datos combinados
    if (action === 'readAll') {
      var data = readAllSheets();
      var json = JSON.stringify(data);

      if (callback) {
        // JSONP: envuelve en callback para evitar CORS
        return ContentService
          .createTextOutput(callback + '(' + json + ');')
          .setMimeType(ContentService.MimeType.JAVASCRIPT);
      }
      return ContentService
        .createTextOutput(json)
        .setMimeType(ContentService.MimeType.JSON);
    }

    // ESCRITURA: si tiene parámetro pallet → escribir registro
    if (params.pallet) {
      var result = writeRecord(params);
      var json = JSON.stringify(result);

      if (callback) {
        return ContentService
          .createTextOutput(callback + '(' + json + ');')
          .setMimeType(ContentService.MimeType.JAVASCRIPT);
      }
      return ContentService
        .createTextOutput(json)
        .setMimeType(ContentService.MimeType.JSON);
    }

    // STATUS: sin parámetros → health check
    return ContentService
      .createTextOutput(JSON.stringify({
        status: 'active',
        service: 'MI-TECH Paletizado',
        spreadsheet: SPREADSHEET_ID,
        sheets: [SHEET_HISTORICO, SHEET_NUEVOS]
      }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    var errorJson = JSON.stringify({result: 'error', message: err.toString()});
    var cb = (e && e.parameter) ? e.parameter.callback : '';
    if (cb) {
      return ContentService
        .createTextOutput(cb + '(' + errorJson + ');')
        .setMimeType(ContentService.MimeType.JAVASCRIPT);
    }
    return ContentService
      .createTextOutput(errorJson)
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// ── doPost: Escritura via POST (usado por la app móvil) ──
function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    var result = writeRecord(data);

    return ContentService
      .createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({result: 'error', message: err.toString()}))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
