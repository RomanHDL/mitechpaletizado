# Agregar Vista/Pestaña al Dashboard

Agrega una nueva vista (tab) al dashboard en `index.html`.

## Instrucciones

1. Lee `index.html` completo para entender la estructura de vistas existentes
2. El dashboard tiene 5 vistas manejadas por `switchView()`: dashboard, palets, ordenes, formulario, configuracion
3. Para agregar una nueva vista:

### Sidebar (nav)
- Agrega un `<li class="nav-item" onclick="switchView('nombre_vista')">` en la lista `.nav-list` (~línea 700)
- Usa un icono de Font Awesome 6 consistente con las demás

### Sección HTML
- Crea un `<div id="section-nombre_vista" class="section" style="display:none;">` dentro de `.main-content`
- Usa las clases CSS existentes: `.card`, `.data-table`, `.stat-card`, etc.
- Sigue el tema oscuro (variables CSS: --bg-card, --text-main, --text-muted, --accent-primary, etc.)

### JavaScript
- Actualiza la función `switchView()` para incluir la nueva vista en el array de secciones
- Agrega funciones de carga de datos si se necesitan (fetch a Google Sheets via JSONP o al backend `/api/...`)

### Estilo
- Reutiliza clases CSS existentes siempre que sea posible
- Si necesitas CSS nuevo, agrégalo en el bloque `<style>` existente

4. Describe la nueva vista al usuario cuando termines

## Input esperado
El usuario describirá qué información o funcionalidad necesita la nueva pestaña. Ejemplo: "una pestaña de reportes mensuales con tabla y gráfico"

$ARGUMENTS
