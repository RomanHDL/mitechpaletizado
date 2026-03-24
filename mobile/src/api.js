import { API_BASE, nowTimestamp, todayStr } from './config';

// ── Timeout wrapper ──
function fetchWithTimeout(url, opts = {}, ms = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

// ═══════════════════════════════════════
// DUPLICATE CHECK
// ═══════════════════════════════════════
export async function checkDuplicate(palletId) {
  try {
    const r = await fetchWithTimeout(`${API_BASE}/api/mobile/check/${encodeURIComponent(palletId)}`);
    const j = await r.json();
    return j.exists ? j.data : null;
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════
// REGISTER PALLET — Direct to MongoDB via Express API
// ═══════════════════════════════════════
export async function registerPallet({ palletId, cantidad, condicion, destino, turno, operador, pedido, items }) {
  const timestamp = nowTimestamp();
  const fecha = todayStr();
  const turnoSheet = turno === 'Day' ? 'Day (día)' : 'Night (noche)';

  let apiResult = { success: false, id: null };
  try {
    console.log(`[API] POST → ${API_BASE}/api/mobile/register`);
    const r = await fetchWithTimeout(`${API_BASE}/api/mobile/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pallet_id: palletId,
        cantidad,
        destino,
        fecha,
        turno: turnoSheet,
        condicion: condicion.join(', '),
        operador,
        pedido: pedido || null,
        items: items.map(i => ({ sku: i.sku, cantidad: i.qty })),
      }),
    }, 8000);
    const j = await r.json();
    console.log(`[API] Respuesta:`, JSON.stringify(j));
    apiResult = { success: j.success, id: j.id };
  } catch (err) {
    console.error(`[API] ERROR:`, err.message || err);
  }

  if (!apiResult.success) {
    throw new Error(
      'No se pudo guardar en MongoDB. Verifica tu conexión y vuelve a intentar.'
    );
  }

  return {
    success: true,
    id: apiResult.id,
    googleSent: false,
    backupSent: false,
    apiSent: true,
    offline: false,
  };
}

// ═══════════════════════════════════════
// RECENT PALLETS
// ═══════════════════════════════════════
export async function fetchRecent(operador, limit = 50) {
  try {
    const params = new URLSearchParams({ limit: String(limit) });
    if (operador) params.append('operador', operador);
    const r = await fetchWithTimeout(`${API_BASE}/api/mobile/recent?${params}`);
    const j = await r.json();
    return j.success ? j.data : [];
  } catch {
    return [];
  }
}

// ═══════════════════════════════════════
// TODAY STATS
// ═══════════════════════════════════════
export async function fetchStats(operador) {
  try {
    const params = new URLSearchParams();
    if (operador) params.append('operador', operador);
    const r = await fetchWithTimeout(`${API_BASE}/api/mobile/stats?${params}`);
    const j = await r.json();
    return j.success ? j : { today: 0, last: null, byDestino: [] };
  } catch {
    return { today: 0, last: null, byDestino: [] };
  }
}

// ═══════════════════════════════════════
// HEALTH CHECK
// ═══════════════════════════════════════
export async function checkHealth() {
  try {
    const r = await fetchWithTimeout(`${API_BASE}/api/health`, {}, 3000);
    return r.ok;
  } catch {
    return false;
  }
}
