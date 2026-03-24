# Changelog — MI-TECH Paletizado

Registro enumerado de cambios del proyecto. Cada entrada tiene un numero secuencial y nombre descriptivo.

> Ultima actualizacion: 2026-03-06

---

### #051 — Orden Cronológico Web + Drive
- **Commit:** `b2f8ce7`
- **Tipo:** feat
- **Fecha:** 2026-03-06
- **Descripcion:** Registros del spreadsheet se ordenan por timestamp al cargar, sincronizando el orden entre formulario web y Google Form de Drive
- **Archivos:** index.html

---

### #050 — Mood Nathy Fondo Claro
- **Commit:** `518e43c`
- **Tipo:** fix
- **Fecha:** 2026-03-06
- **Descripcion:** Mood Nathy cambiado a fondo claro rosado (#fdf2f6), cards blancas, sidebar rosa suave, acentos #e8749c
- **Archivos:** index.html

---

### #049 — Mood Nathy Rosa Pastel
- **Commit:** `17fe3bf`
- **Tipo:** fix
- **Fecha:** 2026-03-06
- **Descripcion:** Rosa cambiado a tono pastel suave #f2a5c4 sobre fondo oscuro púrpura. Botones con texto oscuro para contraste
- **Archivos:** index.html

---

### #048 — Mood Nathy Rosa Cálido
- **Commit:** `29ebcb5`
- **Tipo:** fix
- **Fecha:** 2026-03-06
- **Descripcion:** Rosa cambiado a tono cálido elegante #d6336c (sin neón), fondos y bordes ajustados
- **Archivos:** index.html

---

### #047 — Mood Nathy Rosa Más Vivo
- **Commit:** `e9f73da`
- **Tipo:** fix
- **Fecha:** 2026-03-06
- **Descripcion:** Color rosa actualizado de #ec4899 a #ff2d87 (rosa neón más vivo) en todo el tema Mood Nathy
- **Archivos:** index.html

---

### #046 — Mood Nathy (Tema Dark Rosa)
- **Commit:** `d9bfb77`
- **Tipo:** feat
- **Fecha:** 2026-03-06
- **Descripcion:** Nuevo mood con paleta dark rosa/púrpura. Toggle switch en Configuración con persistencia en localStorage. Cambia acentos, sidebar, cards, botones y formulario a rosa #ec4899
- **Archivos:** index.html

---

### #045 — Checkboxes Condición en Vertical
- **Commit:** `13b0b7f`
- **Tipo:** fix
- **Fecha:** 2026-03-06
- **Descripcion:** Checkboxes de condición cambiados a layout vertical (columna) para mejor legibilidad
- **Archivos:** index.html

---

### #044 — Condición con Checkboxes Múltiples
- **Commit:** `8d3f4ac`
- **Tipo:** feat
- **Fecha:** 2026-03-06
- **Descripcion:** Campo condición cambiado de dropdown a checkboxes múltiples estilo chips/tags. Permite seleccionar varias condiciones que se envían separadas por coma
- **Archivos:** index.html

---

### #043 — Formulario Google Forms Cards
- **Commit:** `afd5af2`
- **Tipo:** feat
- **Fecha:** 2026-03-06
- **Descripcion:** Reemplaza step-by-step por cards visibles con scroll vertical estilo Google Forms real. Header con borde de color, 7 question cards, inputs underline, footer con enviar/borrar
- **Archivos:** index.html

---

### #042 — Formulario Step-by-Step
- **Commit:** `31e4f76`
- **Tipo:** feat
- **Fecha:** 2026-03-06
- **Descripcion:** Formulario desglosado pregunta por pregunta con barra de progreso, navegacion con flechas y Enter, animaciones y auto-focus
- **Archivos:** index.html

---

### #041 — Formulario Fullscreen
- **Commit:** `95061b8`
- **Tipo:** feat
- **Fecha:** 2026-03-06
- **Descripcion:** Formulario ocupa toda la pantalla centrado como app de Google Forms, header oculto, panel con sombra y max-width 600px
- **Archivos:** index.html

---

### #040 — Formulario Estilo Google Forms
- **Commit:** `4dc64f8`
- **Tipo:** feat
- **Fecha:** 2026-03-06
- **Descripcion:** Rediseño del formulario con layout centrado tipo Google Forms, condiciones como menu desplegable, campos agrupados en filas y responsive movil
- **Archivos:** index.html

---

### #039 — PDF Reporte Completo
- **Commit:** `df54fbe`
- **Tipo:** feat
- **Fecha:** 2026-03-05
- **Descripcion:** Rediseño completo del PDF: tema blanco limpio, todas las tablas, errores, ordenes y seccion de recomendaciones inteligentes
- **Archivos:** index.html

---

### #038 — Export PDF Reporte Dashboard
- **Commit:** `dba7400`
- **Tipo:** feat
- **Fecha:** 2026-03-05
- **Descripcion:** Boton Exportar PDF en dashboard que genera reporte con KPIs, graficos, tablas y ordenes respetando filtros
- **Archivos:** index.html

---

### #037 — URL Apps Script Texto Plano
- **Commit:** `ada8953`
- **Tipo:** fix
- **Fecha:** 2026-03-05
- **Descripcion:** Actualizar URL de Apps Script a deploy con setNumberFormat para forzar texto plano en fechas
- **Archivos:** index.html

---

### #036 — URL Apps Script Nueva
- **Commit:** `eacfba2`
- **Tipo:** fix
- **Fecha:** 2026-03-05
- **Descripcion:** Actualizar URL de Apps Script a nueva implementacion con formato de fecha sin ceros
- **Archivos:** index.html

---

### #035 — Agente Changelog
- **Commit:** `25d05dc`
- **Tipo:** feat
- **Fecha:** 2026-03-05
- **Descripcion:** Skill /changelog para registro enumerado de commits, pre-push actualiza changelog automaticamente
- **Archivos:** .claude/commands/changelog.md, .claude/commands/pre-push.md, CHANGELOG.md, CLAUDE.md

---

### #034 — Timestamp Sin Ceros
- **Commit:** `9e1982c`
- **Tipo:** feat
- **Fecha:** 2026-03-05
- **Descripcion:** El formulario envia timestamp sin ceros iniciales en mes/dia (M/d/yyyy)
- **Archivos:** index.html

---

### #033 — Validacion Pallet >1000
- **Commit:** `6dffd66`
- **Tipo:** feat
- **Fecha:** 2026-03-05
- **Descripcion:** Bloquea envio si el Pallet ID difiere mas de 1000 del ultimo registrado, con advertencia en tiempo real
- **Archivos:** index.html

---

### #032 — Export Excel Ordenes
- **Commit:** `7d58643`
- **Tipo:** feat
- **Fecha:** 2026-03-05
- **Descripcion:** Filtro de fechas desde/hasta y boton exportar Excel en pestana Ordenes (respeta filtros)
- **Archivos:** index.html

---

### #031 — Revert a Mobile
- **Commit:** `63162fa`
- **Tipo:** revert
- **Fecha:** 2026-03-05
- **Descripcion:** Revertir skills y export para regresar al estado de mejoras mobile
- **Archivos:** CLAUDE.md, index.html, .claude/commands/

---

### #030 — Export Excel + Skills
- **Commit:** `c02f072`
- **Tipo:** feat
- **Fecha:** 2026-03-05
- **Descripcion:** Primera version de filtro fechas y export Excel (revertido en #031)
- **Archivos:** index.html

---

### #029 — Skills Mobile y Panel
- **Commit:** `a84972d`
- **Tipo:** feat
- **Fecha:** 2026-03-05
- **Descripcion:** Skills mobile-fix y add-dashboard-panel, CLAUDE.md actualizado (revertido en #031)
- **Archivos:** CLAUDE.md, .claude/commands/

---

### #028 — Fix Mobile Completo
- **Commit:** `ab5fb3d`
- **Tipo:** fix
- **Fecha:** 2026-03-05
- **Descripcion:** Mejorar vista Ordenes y dashboard completo en celular
- **Archivos:** index.html

---

### #027 — Dashboard Ordenes
- **Commit:** `4a3595f`
- **Tipo:** feat
- **Fecha:** 2026-03-05
- **Descripcion:** Panel de Ordenes Especiales en el Dashboard principal antes de Ultimos Registros
- **Archivos:** index.html

---

### #026 — Cards Mobile Ordenes
- **Commit:** `946fa0c`
- **Tipo:** feat
- **Fecha:** 2026-03-05
- **Descripcion:** Tarjetas en vez de tabla para Ordenes en vista mobile
- **Archivos:** index.html

---

### #025 — Secciones Desplegables
- **Commit:** `9d3c6f3`
- **Tipo:** feat
- **Fecha:** 2026-03-05
- **Descripcion:** Graficos desplegables/colapsables en mobile para dashboard y ordenes
- **Archivos:** index.html

---

### #024 — Pre-Push Obligatorio
- **Commit:** `ee8e6c7`
- **Tipo:** feat
- **Fecha:** 2026-03-05
- **Descripcion:** Agente pre-push con soporte push/pull, hecho obligatorio en CLAUDE.md
- **Archivos:** CLAUDE.md, .claude/commands/pre-push.md

---

### #023 — Dashboard Ordenes Tab
- **Commit:** `c64b5a7`
- **Tipo:** feat
- **Fecha:** 2026-03-05
- **Descripcion:** Dashboard con KPIs y graficos dentro de la pestana Ordenes
- **Archivos:** index.html

---

### #022 — Formulario + Config + Skills
- **Commit:** `048a048`
- **Tipo:** feat
- **Fecha:** 2026-03-05
- **Descripcion:** Validacion de formulario, vista Configuracion, fix CSS y skills de Claude Code
- **Archivos:** index.html, CLAUDE.md, .claude/commands/

---

### #021 — Alertas Pallet ID
- **Commit:** `dd613b3`
- **Tipo:** feat
- **Fecha:** 2026-03-04
- **Descripcion:** Advertencias en tiempo real en formulario para Pallet ID (menos de 6 digitos, duplicados)
- **Archivos:** index.html

---

### #020 — Fix Filtro Pedidos
- **Commit:** `d418045`
- **Tipo:** fix
- **Fecha:** 2026-03-04
- **Descripcion:** Corregir filtro de pedidos en Ordenes para caracteres especiales
- **Archivos:** index.html

---

### #019 — Fix Desfase Columnas
- **Commit:** `d23715f`
- **Tipo:** fix
- **Fecha:** 2026-03-04
- **Descripcion:** Corregir desfase de columnas en tablas Palets y Ordenes
- **Archivos:** index.html

---

### #018 — Fix Ordenes Especiales
- **Commit:** `60b8393`
- **Tipo:** fix
- **Fecha:** 2026-03-04
- **Descripcion:** Usar columna directa del Sheet para detectar ordenes especiales
- **Archivos:** index.html

---

### #017 — Tab Ordenes Especiales
- **Commit:** `b3df2ea`
- **Tipo:** feat
- **Fecha:** 2026-03-04
- **Descripcion:** Reemplazar pestana Envios por Ordenes Especiales con tabla completa
- **Archivos:** index.html

---

### #016 — Campos Operador y Pedido
- **Commit:** `a5d6ee4`
- **Tipo:** feat
- **Fecha:** 2026-03-04
- **Descripcion:** Agregar campos Operador y Pedido + filtros dinamicos en pestana Palets
- **Archivos:** index.html

---

### #015 — Menu Hamburguesa
- **Commit:** `4494f49`
- **Tipo:** feat
- **Fecha:** 2026-03-03
- **Descripcion:** Menu hamburguesa mobile y renombrar Inventario a Formulario
- **Archivos:** index.html

---

### #014 — Fix Escaneadoras
- **Commit:** `0d44986`
- **Tipo:** fix
- **Fecha:** 2026-03-03
- **Descripcion:** Corregir nombres de escaneadoras sin acentos
- **Archivos:** index.html

---

### #013 — Envio Apps Script
- **Commit:** `c99f13f`
- **Tipo:** feat
- **Fecha:** 2026-03-03
- **Descripcion:** Enviar inventario directo al Google Sheet via Apps Script
- **Archivos:** index.html

---

### #012 — Asterisco Obligatorio
- **Commit:** `6f62a2f`
- **Tipo:** style
- **Fecha:** 2026-03-03
- **Descripcion:** Agregar asterisco obligatorio a Turno y Escaneadora
- **Archivos:** index.html

---

### #011 — Multi Condicion
- **Commit:** `70c3002`
- **Tipo:** feat
- **Fecha:** 2026-03-03
- **Descripcion:** Permitir seleccion multiple en Condicion del formulario
- **Archivos:** index.html

---

### #010 — Layout Vertical Form
- **Commit:** `51a8a93`
- **Tipo:** style
- **Fecha:** 2026-03-03
- **Descripcion:** Cambiar formulario Inventario a layout vertical tipo celular
- **Archivos:** index.html

---

### #009 — Formulario Inventario
- **Commit:** `8b3c160`
- **Tipo:** feat
- **Fecha:** 2026-03-03
- **Descripcion:** Agregar formulario Inventario conectado a Google Forms
- **Archivos:** index.html

---

### #008 — Fix Tabla Palets
- **Commit:** `cc315fb`
- **Tipo:** fix
- **Fecha:** 2026-03-03
- **Descripcion:** Refrescar tabla Palets al recibir datos del SpreadSheet
- **Archivos:** index.html

---

### #007 — Fix Div Palets
- **Commit:** `e7f256f`
- **Tipo:** fix
- **Fecha:** 2026-03-03
- **Descripcion:** Cerrar div content-grid para que vista Palets no quede oculta
- **Archivos:** index.html

---

### #006 — Vista Palets
- **Commit:** `3583599`
- **Tipo:** feat
- **Fecha:** 2026-03-03
- **Descripcion:** Vista Palets con tabla completa, busqueda y filtro por turno
- **Archivos:** index.html

---

### #005 — Backend MySQL
- **Commit:** `8ce2727`
- **Tipo:** feat
- **Fecha:** 2026-03-03
- **Descripcion:** Backend con MySQL + sincronizacion automatica desde Google Sheets
- **Archivos:** backend/

---

### #004 — Staticfile Railway
- **Commit:** `ec60030`
- **Tipo:** feat
- **Fecha:** 2026-03-03
- **Descripcion:** Agregar Staticfile para deploy en Railway/Cloud Foundry
- **Archivos:** Staticfile

---

### #003 — Merge Inicial
- **Commit:** `4c59c91`
- **Tipo:** merge
- **Fecha:** 2026-03-03
- **Descripcion:** Merge branch main del repositorio remoto
- **Archivos:** -

---

### #002 — Primer Commit
- **Commit:** `ec47fe7`
- **Tipo:** feat
- **Fecha:** 2026-03-03
- **Descripcion:** Primer commit con dashboard de paletizado
- **Archivos:** index.html, dashboard Paletizado.html

---

### #001 — Inicio Proyecto
- **Commit:** `f1d9d32`
- **Tipo:** feat
- **Fecha:** 2026-03-03
- **Descripcion:** Commit inicial del repositorio
- **Archivos:** README.md
