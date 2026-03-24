# Diagnosticar Sincronización Google Sheets - MySQL

Diagnostica problemas con la sincronización de datos entre Google Sheets y MySQL.

## Instrucciones

1. Lee `backend/server.js` (sección SYNC AUTOMÁTICO) y `backend/sync-sheets.js` para entender el flujo de sync
2. El sync funciona así:
   - Fetch JSONP desde Google Sheets public URLs
   - Parseo de respuesta: extraer JSON entre `(` y `)` del wrapper JSONP
   - Parseo de fechas: `parseGoogleDate()` maneja formatos `Date(y,m,d)` y `M/d/yyyy`
   - INSERT IGNORE en MySQL para evitar duplicados
3. Puntos de fallo comunes:
   - **Google cambia estructura del Sheet**: nuevas columnas, columnas movidas → los índices c[0], c[1], etc. ya no coinciden
   - **Formato de fecha cambia**: el Sheet devuelve un formato inesperado
   - **Conexión MySQL caída**: verificar config.js (host, user, password, database)
   - **Sheet no público**: el fetch JSONP requiere que el Sheet sea público (o "cualquier persona con el enlace")
   - **JSONP parse error**: Google cambió el wrapper de respuesta
4. Si el usuario reporta datos faltantes, verifica qué columnas del Sheet mapean a qué campos de la DB
5. Propón y aplica la corrección

## Mapeo de columnas conocido

### Sheet Pallets (gid=1543653429)
- c[1] → pallet_id
- c[2] → cantidad
- c[3] → producto
- c[4] → destino (campo de filtro para filas válidas)
- c[5] → fecha
- c[6] → turno
- c[7] → condicion
- c[8] → observaciones

### Sheet Errores (Liberación de Pallet)
- c[1] → fecha
- c[3] → pallet_id
- c[9] → defecto (campo de filtro para filas válidas)
- c[11] → tipo

$ARGUMENTS
