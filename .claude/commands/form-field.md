# Agregar o Modificar Campo del Formulario

Agente para agregar, modificar o eliminar campos del formulario de inventario (estilo Google Forms).

## Parámetros
- `$ARGUMENTS` — Acción y campo (ej: "agregar campo Producto tipo select", "cambiar condición a dropdown", "eliminar campo pedido")

## Instrucciones

### Paso 1: Leer estado actual
1. Leer la sección HTML del formulario (`#inventario-form` dentro de `.inventario-form-panel`)
2. Leer el JS de envío (`submitInventarioForm`) para ver los campos actuales
3. Identificar el orden de campos y sus IDs

### Paso 2: Modificar HTML
Cada campo sigue este patrón de card:

**Input de texto/número:**
```html
<div class="inv-question-card">
    <label class="inv-question-label"><i class="fa-solid fa-[icono]" style="margin-right: 6px; color: #[color];"></i>[Nombre] <span class="inv-req">*</span></label>
    <input type="[text|number]" id="inv-[nombre]" placeholder="Ej: ..." required>
</div>
```

**Select dropdown:**
```html
<div class="inv-question-card">
    <label class="inv-question-label"><i class="fa-solid fa-[icono]" style="margin-right: 6px; color: #[color];"></i>[Nombre] <span class="inv-req">*</span></label>
    <select id="inv-[nombre]" required>
        <option value="" disabled selected>Seleccionar...</option>
        <option value="val1">Val1</option>
    </select>
</div>
```

**Checkboxes múltiples (como condición):**
```html
<div class="inv-question-card">
    <label class="inv-question-label"><i class="fa-solid fa-[icono]" style="margin-right: 6px; color: #[color];"></i>[Nombre] <span class="inv-req">*</span></label>
    <div class="inv-checkbox-group">
        <label class="inv-checkbox"><input type="checkbox" name="inv-[nombre]" value="val1"><span>Val1</span></label>
        <!-- más opciones -->
    </div>
</div>
```

**Campo opcional:** Reemplazar `<span class="inv-req">*</span>` con `<span style="color:var(--text-muted); font-size:0.85rem; font-weight:400;">(opcional)</span>` y quitar `required`.

### Paso 3: Actualizar JS de envío
En `submitInventarioForm`:
1. Agregar/modificar la lectura del campo:
   - Input/Select: `const campo = document.getElementById('inv-campo').value;`
   - Checkboxes: `const campo = Array.from(document.querySelectorAll('input[name="inv-campo"]:checked')).map(c => c.value).join(', ');`
2. Agregar a la validación de campos obligatorios si aplica
3. Agregar al `JSON.stringify` del body del fetch

### Paso 4: Verificar
- El campo aparece como card en el formulario
- Se envía correctamente al Apps Script
- El reset del formulario limpia el nuevo campo
- Mobile responsive (el CSS de `.inv-question-card` ya lo maneja)

### Iconos sugeridos por tipo
- Texto/ID: fa-barcode, fa-hashtag
- Cantidad: fa-cubes, fa-calculator
- Selección: fa-tags, fa-list
- Ubicación: fa-location-dot, fa-warehouse
- Persona: fa-user, fa-users
- Fecha/Hora: fa-clock, fa-calendar
- Documento: fa-file-lines, fa-clipboard
