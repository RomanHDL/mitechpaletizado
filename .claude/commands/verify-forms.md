# Verificar Formularios del Dashboard

Agente que verifica que todos los formularios del dashboard funcionen correctamente. Revisa estructura HTML, validaciones JS, envío de datos y flujo completo.

## Instrucciones

Lee `index.html` completo y ejecuta las siguientes verificaciones:

### 1. Estructura HTML del Formulario (view-formulario, ~línea 1151)
- [ ] Todos los campos requeridos tienen atributo `required` y/o validación JS
- [ ] Los IDs de elementos existen y son únicos: `inv-pallet`, `inv-qty`, `inv-condicion-group`, `inv-destino`, `inv-pedido`, `inv-turno`, `inv-escaneadora`
- [ ] El `<form id="inventario-form">` tiene `onsubmit="submitInventarioForm(event)"`
- [ ] El botón submit (`inv-submit-btn`) está dentro del form
- [ ] El div de status (`inv-status`) existe para mostrar mensajes de éxito/error
- [ ] El div de warning (`inv-pallet-warn`) existe para validación en tiempo real

### 2. Campos y Opciones
- [ ] **Pallet ID** (`inv-pallet`): input text, required, placeholder coherente
- [ ] **Cantidad QTY** (`inv-qty`): input number, required, min=1
- [ ] **Condición** (checkboxes `inv-condicion`): al menos las opciones GRA, GRB, GRC, ICB, ICC, ICD, ICX, BOX, DNP, DMT, DMA existen
- [ ] **Destino** (`inv-destino`): select con opciones que coincidan con los destinos reales del sistema (TRG, HV, Almacén, etc.)
- [ ] **Pedido** (`inv-pedido`): input text, opcional
- [ ] **Turno** (`inv-turno`): select con Day (Día) y Night (Noche)
- [ ] **Escaneadora** (`inv-escaneadora`): select con nombres de operadoras

### 3. Validación JavaScript
- [ ] `submitInventarioForm()` existe y previene submit por defecto (`e.preventDefault()`)
- [ ] Valida campos obligatorios: pallet, qty, condicion, destino, turno, escaneadora
- [ ] Muestra mensaje de error si faltan campos (`showInvStatus`)
- [ ] `validatePalletInput()` funciona para validación en tiempo real:
  - Detecta menos de 6 dígitos
  - Detecta duplicados contra `allSheetData`
  - Muestra warning amarillo (advertencia) o rojo (duplicado)
- [ ] El event listener de `input` está conectado al campo `inv-pallet`

### 4. Envío de Datos
- [ ] La URL de Apps Script (`APPS_SCRIPT_URL`) está definida y es válida (comienza con `https://script.google.com/macros/s/`)
- [ ] El fetch usa `method: 'POST'` y `mode: 'no-cors'`
- [ ] El body del JSON incluye todos los campos: pallet, qty, condicion, destino, pedido, turno, escaneadora
- [ ] En éxito: muestra mensaje, resetea form, llama `fetchSheetData()` para refrescar datos
- [ ] En error: muestra mensaje de error al usuario
- [ ] El botón se deshabilita durante el envío y se rehabilita en `finally`

### 5. Flujo Post-Envío
- [ ] Después de enviar, `fetchSheetData()` se llama para recargar datos del Sheet
- [ ] El formulario se resetea completamente (`form.reset()`)
- [ ] El mensaje de status desaparece después de 4 segundos
- [ ] El warning de pallet se limpia al resetear

### 6. Consistencia con el Backend
- [ ] Los campos enviados al Apps Script coinciden con las columnas del Google Sheet de pallets
- [ ] Los valores de turno del formulario ("Day (día)", "Night (Noche)") son compatibles con la normalización del backend (`server.js` usa CASE WHEN para normalizar)
- [ ] Los destinos del formulario coinciden con los destinos esperados en `v_resumen_destino` y el CASE del backend

## Formato de Reporte

Genera un reporte con:
1. **Estado general**: OK / Problemas encontrados
2. **Por cada verificación**: PASS o FAIL con descripción del problema
3. **Correcciones sugeridas**: si hay FAILs, propón el fix exacto
4. **Preguntar al usuario** si quiere que aplique las correcciones automáticamente

$ARGUMENTS
