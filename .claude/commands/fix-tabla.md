# Diagnosticar y Corregir Tabla del Dashboard

Diagnostica y corrige problemas en las tablas de datos del dashboard (`index.html`).

## Instrucciones

1. Lee `index.html` enfocándote en las secciones de tablas:
   - Tabla de "Últimos Registros" en el Dashboard (~sección section-dashboard)
   - Tabla de "Palets" (~sección section-palets, id: palets-table-body)
   - Tabla de "Órdenes" (~sección section-ordenes, id: ordenes-table-body)
2. Las tablas se llenan con datos de Google Sheets via JSONP (`fetchSheetData()`, `fetchErrorsData()`)
3. Problemas comunes a verificar:
   - **Desfase de columnas**: los índices de columna del Sheet (c[0], c[1], etc.) no coinciden con los headers HTML
   - **Filtros rotos**: los filtros de búsqueda/fecha no aplican correctamente sobre los datos
   - **Caracteres especiales**: datos con acentos, ñ, o símbolos que rompen filtros o renderizado
   - **Fechas mal parseadas**: la función `parseGoogleDate()` no maneja el formato devuelto por el Sheet
4. Al encontrar el problema, corrige en el HTML/JS inline directamente
5. Explica qué causaba el problema y qué se cambió

## Input esperado
El usuario describirá el síntoma visual o funcional. Ejemplo: "la columna destino muestra el producto", "el filtro de pedidos no encuentra nada"

$ARGUMENTS
