# Refactorizar Sección del index.html

Extrae, reorganiza o mejora una sección específica del monolítico `index.html`.

## Instrucciones

1. Lee `index.html` completo (~2700 líneas) — todo el CSS, HTML y JS está en un solo archivo
2. Estructura del archivo:
   - Líneas 1-700: `<style>` (CSS completo)
   - Líneas 700-1200: HTML (sidebar + secciones: dashboard, palets, ordenes, formulario, configuracion)
   - Líneas 1200-2743: `<script>` (toda la lógica JS)
3. Según lo que pida el usuario:
   - **Mover estilos**: agrupa CSS relacionado y comenta las secciones
   - **Reorganizar JS**: agrupa funciones por vista/funcionalidad
   - **Mejorar sección HTML**: reestructura una vista manteniendo las clases CSS y IDs existentes
4. IMPORTANTE: No cambies IDs de elementos ni nombres de funciones que estén referenciados en otros lugares
5. Verifica que `switchView()`, los onclick, y las funciones de carga de datos sigan funcionando
6. Describe los cambios realizados

$ARGUMENTS
