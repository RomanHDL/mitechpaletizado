# Agente de Deploy — Verificar, Commit, Push y Pull

Agente que verifica la integridad del proyecto y ejecuta operaciones git de forma segura. Usa este agente SIEMPRE que necesites hacer push, pull, commit o cualquier operación que suba/baje cambios.

## Instrucciones

Detecta automáticamente qué operación necesita el usuario según el contexto o `$ARGUMENTS`:
- Si dice "push", "subir", "deploy" → ejecuta flujo PUSH
- Si dice "pull", "bajar", "actualizar" → ejecuta flujo PULL
- Si no especifica → ejecuta flujo PUSH (por defecto)

---

## FLUJO PUSH (subir cambios)

### Paso 1: Verificación de estructura
Ejecutar estos comandos en paralelo:
```bash
# Verificar que los 11 archivos existen en la RAÍZ (no en .claude/)
for f in index.html backend/server.js backend/config.js backend/package.json backend/package-lock.json backend/sync-sheets.js START-SERVER.bat .gitignore Staticfile "dashboard Paletizado.html" README.md; do test -f "$f" && echo "OK: $f" || echo "FAIL: $f"; done

# Git status
git status

# Verificar .gitignore
cat .gitignore
```

**Si algún archivo del proyecto está dentro de `.claude/` en vez de la raíz, MOVERLO con `mv` antes de continuar.** Esto es CRÍTICO — si los archivos están en `.claude/`, git los verá como "deleted" y el repo en GitHub quedará vacío.

### Paso 2: Validación del código
Ejecutar en paralelo:
```bash
# HTML: verificar estructura básica
wc -l index.html          # debe ser > 2000 líneas
head -1 index.html         # debe ser <!DOCTYPE html>
tail -1 index.html         # debe ser </html>

# Verificar que las 5 vistas existen
grep -c "view-dashboard\|view-palets\|view-ordenes\|view-formulario\|view-configuracion" index.html  # debe ser >= 10

# Verificar CDNs y URLs críticas
grep -c "chart.js\|flatpickr\|font-awesome" index.html  # debe ser > 0
grep -c "APPS_SCRIPT_URL" index.html                      # debe ser > 0

# Backend: verificar integridad
grep -c "app.listen(config.port" backend/server.js         # debe ser 1
grep -c "express.static" backend/server.js                 # debe ser 1
grep "express\|mysql2\|cors" backend/package.json          # las 3 deps
```

### Paso 3: Revisar cambios
```bash
git diff --stat            # resumen de cambios
git diff                   # cambios detallados
git status                 # archivos sin trackear
```

Verificar que:
- NO hay archivos "deleted" en git status
- NO se incluye `node_modules/`
- NO hay archivos sensibles (.env, credenciales extra)
- Los cambios tienen sentido (no hay código borrado por accidente)

### Paso 4: Reporte y acción
Generar reporte:
```
==========================================
  PRE-PUSH TEST REPORT
==========================================
Estructura:    [PASS/FAIL]
HTML válido:   [PASS/FAIL]
Backend:       [PASS/FAIL]
Cambios:       [PASS/FAIL]
RESULTADO:     [LISTO / BLOQUEADO]
==========================================
```

Si TODO es PASS:
1. Hacer `git add` de los archivos modificados (nombrarlos explícitamente, NO usar `git add .`)
2. Generar mensaje de commit basado en los cambios (prefijo feat:/fix:/refactor: según corresponda)
3. Hacer `git commit` con el mensaje
4. **OBLIGATORIO: Actualizar CHANGELOG.md** — Agregar entrada para el nuevo commit con formato `### #NNN — Nombre Descriptivo` al inicio del changelog. Incluir el commit en el `git add` y hacer un segundo commit `docs: actualizar changelog #NNN` si es necesario, o incluir CHANGELOG.md en el commit original.
5. Hacer `git push origin main`
6. Confirmar éxito mostrando el hash del commit

Si alguno es FAIL:
1. Listar problemas encontrados
2. Corregirlos automáticamente si es posible (como mover archivos de .claude/ a raíz)
3. Si no se puede corregir automáticamente, explicar qué hacer
4. Volver a ejecutar las verificaciones después de corregir

---

## FLUJO PULL (bajar cambios)

### Paso 1: Pre-pull check
```bash
git status                 # verificar si hay cambios locales sin commit
git stash list             # verificar si hay stashes previos
```

Si hay cambios locales sin commit:
- Preguntar al usuario si quiere hacer stash, commit, o descartar
- NO hacer pull con cambios sin guardar (puede causar conflictos)

### Paso 2: Ejecutar pull
```bash
git pull origin main
```

### Paso 3: Post-pull verification
Ejecutar las mismas verificaciones del flujo PUSH (estructura, HTML, backend) para asegurar que el pull no corrompió nada.

Si hay conflictos de merge:
1. Mostrar los archivos en conflicto
2. Leer los archivos y resolver los conflictos preservando ambos cambios cuando sea posible
3. Verificar que el código resultante funciona
4. Hacer commit del merge

### Paso 4: Confirmar éxito
```bash
git log --oneline -3       # mostrar últimos commits
git status                 # verificar que está limpio
```

---

## REGLAS IMPORTANTES

- NUNCA hacer `git add .` o `git add -A` — siempre nombrar archivos explícitamente
- NUNCA hacer `git push --force`
- NUNCA hacer `git reset --hard` sin preguntar
- NUNCA hacer commit si hay verificaciones FAIL
- SIEMPRE verificar que los archivos están en la raíz, no en .claude/
- SIEMPRE mostrar el reporte antes de ejecutar push/pull
- Si el usuario pide push y hay cambios sin commit, hacer commit primero
- El mensaje de commit debe seguir el formato: `feat:`, `fix:`, `refactor:` + descripción en español

$ARGUMENTS
