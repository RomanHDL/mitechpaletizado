import * as SecureStore from 'expo-secure-store';

const K = {
  operator:    'mt_operator',
  lastDestino: 'mt_last_destino',
  todayCount:  'mt_count',
  recentList:  'mt_recent',
};

// ── Operator ──
export async function getOperator() {
  try { return await SecureStore.getItemAsync(K.operator); }
  catch { return null; }
}

export async function setOperator(name) {
  try { await SecureStore.setItemAsync(K.operator, name); }
  catch { /* silent */ }
}

export async function clearOperator() {
  try { await SecureStore.deleteItemAsync(K.operator); }
  catch { /* silent */ }
}

// ── Last destino ──
export async function getLastDestino() {
  try { return await SecureStore.getItemAsync(K.lastDestino); }
  catch { return null; }
}

export async function setLastDestino(val) {
  try { await SecureStore.setItemAsync(K.lastDestino, val); }
  catch { /* silent */ }
}

// ── Today count per operator (local, no backend needed) ──
function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

export async function getTodayCount(operator) {
  try {
    const raw = await SecureStore.getItemAsync(K.todayCount);
    const data = JSON.parse(raw || '{}');
    // If stored date is not today, return 0
    if (data._day !== todayKey()) return 0;
    return data[operator] || 0;
  } catch { return 0; }
}

export async function incrementTodayCount(operator) {
  try {
    const raw = await SecureStore.getItemAsync(K.todayCount);
    let data = JSON.parse(raw || '{}');
    // Reset if it's a new day
    if (data._day !== todayKey()) data = { _day: todayKey() };
    data[operator] = (data[operator] || 0) + 1;
    await SecureStore.setItemAsync(K.todayCount, JSON.stringify(data));
    return data[operator];
  } catch { return 0; }
}

// ── Recent pallets (local history, works offline) ──
export async function addRecentPallet(entry) {
  try {
    const raw = await SecureStore.getItemAsync(K.recentList);
    const arr = JSON.parse(raw || '[]');
    arr.unshift(entry);
    if (arr.length > 30) arr.length = 30;
    await SecureStore.setItemAsync(K.recentList, JSON.stringify(arr));
  } catch { /* silent */ }
}

export async function getRecentPallets(operator) {
  try {
    const raw = await SecureStore.getItemAsync(K.recentList);
    const arr = JSON.parse(raw || '[]');
    const today = todayKey();
    return arr.filter((p) => {
      const matchOp = !operator || p.operator === operator;
      const matchDay = p._day === today;
      return matchOp && matchDay;
    });
  } catch { return []; }
}
