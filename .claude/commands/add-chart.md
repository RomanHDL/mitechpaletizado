# Agregar Gráfico al Dashboard

Agrega un nuevo gráfico Chart.js al dashboard en `index.html`.

## Instrucciones

1. Lee `index.html` para entender los gráficos existentes (Chart.js) y cómo obtienen datos
2. El dashboard usa Chart.js v4 con tema oscuro. Convenciones:
   - Colores de fondo de gráficos: transparente (el card ya tiene --bg-card)
   - Paleta de colores: usa las variables CSS o los colores del array existente en los otros charts
   - Labels y tooltips en español
   - `responsive: true`, `maintainAspectRatio: false`
3. Para agregar el gráfico:

### HTML
- Crea un `<div class="card">` con un `<canvas id="chart-nombre">` dentro
- Colócalo en la sección apropiada del dashboard

### JavaScript
- Crea la instancia `new Chart(ctx, { type: '...', data: {...}, options: {...} })`
- Obtén los datos del backend (`/api/dashboard/...`) o directamente del Sheet
- Si necesitas un nuevo endpoint, menciónalo (el usuario puede usar `/add-endpoint`)

### Datos
- Si los datos vienen del backend, usa `fetch('/api/dashboard/...')` con manejo de error
- Si vienen del Sheet, reutiliza los datos ya cargados por `fetchSheetData()` o `fetchErrorsData()`

4. Describe el gráfico agregado al usuario

## Input esperado
El usuario describirá qué quiere visualizar. Ejemplo: "gráfico de barras con producción por día de la semana"

$ARGUMENTS
