# Agente de Changelog — Registro Enumerado de Commits

Genera y mantiene un registro enumerado de commits con nombres descriptivos para identificar cada cambio del proyecto.

## Instrucciones

Detecta la operacion segun `$ARGUMENTS`:
- Si dice "generar", "crear", "actualizar" o no especifica → genera/actualiza el CHANGELOG.md
- Si dice "ver", "mostrar", "listar" → muestra el changelog actual sin modificar

---

## FLUJO GENERAR/ACTUALIZAR

### Paso 1: Obtener commits
```bash
git log --oneline --reverse
```

### Paso 2: Leer CHANGELOG.md existente (si existe)
Leer el archivo `CHANGELOG.md` en la raiz del proyecto para saber cual fue el ultimo commit registrado.

### Paso 3: Generar entradas nuevas
Para cada commit NO registrado aun, crear una entrada con este formato:

```
### #NNN — Nombre descriptivo
- **Commit:** `hash_corto`
- **Tipo:** feat / fix / refactor / revert
- **Fecha:** YYYY-MM-DD
- **Descripcion:** Resumen claro de que se hizo y por que
- **Archivos:** lista de archivos afectados (de git show --stat)
```

Reglas para el nombre descriptivo:
- Debe ser un nombre CORTO y memorable (3-6 palabras max)
- En espanol
- Que identifique el cambio sin leer el detalle
- Ejemplos: "Export Excel Ordenes", "Validacion Pallet >1000", "Mobile Cards Ordenes", "Filtro Fechas Ordenes"

La numeracion (#NNN) es secuencial desde #001 para el primer commit del proyecto.

### Paso 4: Escribir CHANGELOG.md
Formato del archivo:

```markdown
# Changelog — MI-TECH Paletizado

Registro enumerado de cambios del proyecto. Cada entrada tiene un numero secuencial y nombre descriptivo.

> Ultima actualizacion: FECHA

---

### #NNN — Nombre descriptivo
- **Commit:** `hash`
- **Tipo:** feat/fix/refactor
- **Fecha:** YYYY-MM-DD
- **Descripcion:** ...
- **Archivos:** ...

---

(... entradas anteriores, mas recientes primero ...)
```

### Paso 5: Confirmar
Mostrar resumen:
```
CHANGELOG actualizado: #001 a #NNN
Nuevos registros: X
Total commits: NNN
```

---

## FLUJO VER/MOSTRAR

1. Leer CHANGELOG.md
2. Mostrar las ultimas 10 entradas en formato tabla resumido:
```
| #   | Nombre                    | Tipo    | Fecha      | Commit  |
|-----|---------------------------|---------|------------|---------|
| 015 | Timestamp Sin Ceros       | feat    | 2026-03-05 | 9e1982c |
| 014 | Validacion Pallet >1000   | feat    | 2026-03-05 | 6dffd66 |
| ... |                           |         |            |         |
```

---

## REGLAS

- NUNCA borrar entradas existentes del changelog
- Solo AGREGAR commits nuevos que no esten registrados
- Mantener numeracion secuencial sin saltos
- Los commits de merge y revert tambien se registran
- Ordenar de mas reciente a mas antiguo en el archivo
- El nombre descriptivo NO debe ser igual al mensaje de commit, debe ser mas corto y memorable

$ARGUMENTS
