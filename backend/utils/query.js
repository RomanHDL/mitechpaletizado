// Shared query helpers (mirror of the inline helpers in api/index.js)

// Escape regex metacharacters so user input can't break/inject the $regex query.
function escapeRegex(str) {
  return String(str == null ? '' : str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Case-insensitive "contains" filter built from a safe (escaped) user string.
function rx(str) {
  return { $regex: escapeRegex(str), $options: 'i' };
}

// Parse a stored M/D/YYYY (unpadded) date string → Date at local midnight, or null if invalid.
// Dates are stored unpadded (e.g. "6/6/2026"); do NOT pad them.
function parseFechaMDY(f) {
  if (!f || typeof f !== 'string') return null;
  const p = f.split('/');
  if (p.length !== 3) return null;
  const mo = parseInt(p[0], 10), da = parseInt(p[1], 10), yr = parseInt(p[2], 10);
  if (Number.isNaN(mo) || Number.isNaN(da) || Number.isNaN(yr)) return null;
  return new Date(yr, mo - 1, da);
}

// Keep a record if its date is within [start, end]; unparseable dates are kept (not dropped).
function inDateRange(fechaStr, start, end) {
  const d = parseFechaMDY(fechaStr);
  if (!d) return true;
  return d >= start && d <= end;
}

module.exports = { escapeRegex, rx, parseFechaMDY, inDateRange };
