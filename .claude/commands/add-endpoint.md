# Agregar Endpoint API

Agrega un nuevo endpoint REST al backend en `backend/server.js`.

## Instrucciones

1. Lee `backend/server.js` completo para entender la estructura actual de endpoints
2. Identifica la sección correcta donde agregar el nuevo endpoint (PALLETS, VISTAS DEL DASHBOARD, ERRORES, etc.)
3. Sigue el patrón existente:
   - Usa `async (req, res) => { try { ... } catch (error) { ... } }`
   - Usa el `pool` de MySQL con queries parametrizadas (nunca concatenar valores directamente)
   - Responde siempre con `{ success: true, data: ... }` en éxito y `{ success: false, error: error.message }` en error
   - Loguea errores con `console.error('Error METODO /api/ruta:', error)`
4. Si el endpoint necesita normalizar turnos o destinos, usa los mismos CASE de MySQL que ya existen en otros endpoints
5. Describe brevemente el endpoint agregado al usuario

## Input esperado
El usuario describirá qué datos necesita exponer o qué operación necesita. Ejemplo: "un endpoint que devuelva el conteo de pallets por producto"

$ARGUMENTS
