# Agregar Mood/Theme al Dashboard

Agente para agregar un nuevo tema visual (mood) al dashboard.

## Parámetros
- `$ARGUMENTS` — Nombre del mood y color principal (ej: "moodOcean azul marino", "moodSunset naranja")

## Instrucciones

### Paso 1: Definir paleta
A partir del color dado, generar una paleta coherente:
- `--bg-dark`: fondo principal (claro u oscuro según contexto)
- `--bg-card`: fondo de cards
- `--text-main`: texto principal (contraste con bg)
- `--text-muted`: texto secundario
- `--accent-primary`: color principal del mood
- `--accent-success`, `--accent-warning`: variantes
- `--border-color`: bordes

### Paso 2: Agregar CSS
En index.html, después de los CSS variables de `:root`, agregar:
```css
/* Mood [Nombre] — tema [descripción] */
:root.mood-[nombre] {
    --bg-dark: #xxx;
    --bg-card: #xxx;
    /* ... todas las variables */
}

:root.mood-[nombre] body { background-color: var(--bg-dark); }
:root.mood-[nombre] .sidebar { ... }
:root.mood-[nombre] .nav-item:hover { ... }
:root.mood-[nombre] .nav-item.active { ... }
:root.mood-[nombre] .panel { ... }
:root.mood-[nombre] .kpi-card { ... }
:root.mood-[nombre] .btn-export { ... }
:root.mood-[nombre] .inv-header-card { ... }
:root.mood-[nombre] .inv-question-card:focus-within { ... }
:root.mood-[nombre] .inv-btn-submit { ... }
:root.mood-[nombre] .inv-checkbox:has(input:checked) { ... }

.mood-switch-[nombre] input:checked ~ .mood-track { background: #accent; }
```

### Paso 3: Agregar toggle en Configuración
En `#view-configuracion`, agregar un bloque con:
- Título con icono fa-palette
- Toggle switch (label.mood-switch > input checkbox + .mood-track + .mood-knob)
- Label de estado (Activado/Desactivado)
- Descripción breve

### Paso 4: Agregar JS
Antes del cierre `</script>`:
```javascript
window.toggleMood[Nombre] = function () {
    const on = document.getElementById('mood-[nombre]-toggle').checked;
    document.documentElement.classList.toggle('mood-[nombre]', on);
    document.getElementById('mood-[nombre]-label').textContent = on ? 'Activado' : 'Desactivado';
    localStorage.setItem('mood[Nombre]', on ? '1' : '0');
};

if (localStorage.getItem('mood[Nombre]') === '1') {
    document.documentElement.classList.add('mood-[nombre]');
    const toggle = document.getElementById('mood-[nombre]-toggle');
    if (toggle) toggle.checked = true;
    const label = document.getElementById('mood-[nombre]-label');
    if (label) label.textContent = 'Activado';
}
```

### Paso 5: Desactivar otros moods
Si hay múltiples moods, asegurar que activar uno desactive los demás (quitar clase del root y desmarcar toggle).

### Reglas
- Botones con fondo de color accent deben tener texto con buen contraste (blanco u oscuro)
- Probar que el sidebar, cards, formulario, y gráficos se vean bien
- Guardar preferencia en localStorage
