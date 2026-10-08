// Чистая логика: сопоставление с маршрутами, поиск новых рейсов / изменений цены, текст уведомлений.
export const lc = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е');
const terms = (s) => String(s || '').split(',').map((x) => lc(x.trim())).filter(Boolean);

// Маршрут: from / to — подстроки (через запятую = «или»), пусто = любой; minPrice — минимальная цена, ₽
export function matchRoute(item, routes) {
  const s = lc(item.srcText), d = lc(item.dstText);
  for (const r of routes || []) {
    if (r.enabled === false) continue;
    const f = terms(r.from), t = terms(r.to);
    if (f.length && !f.some((x) => s.includes(x))) continue;
    if (t.length && !t.some((x) => d.includes(x))) continue;
    if (r.minPrice && item.rub < Number(r.minPrice)) continue;
    return r;
  }
  return null;
}

// known: { [key]: { p: цена, m: подходил ли маршрутам } }
export function diff(items, known, opts, routes) {
  const next = { ...known };
  const events = [];
  let matched = 0;
  for (const it of items) {
    const route = matchRoute(it, routes);
    const prev = known[it.key];
    if (route) {
      matched++;
      if (!prev || !prev.m) {
        if (opts.baselined || opts.notifyExisting) events.push({ kind: 'new', item: it, route });
      } else if (prev.p !== it.rub && opts.notifyPriceChange) {
        events.push({ kind: 'price', item: it, route, oldRub: prev.p });
      }
    }
    next[it.key] = { p: it.rub, m: !!route };
  }
  return { events, next, matched };
}

export const cap = (obj, n) => Object.fromEntries(Object.entries(obj).slice(-n));
export const rubFmt = (n) => Math.round(n).toLocaleString('ru-RU').replace(/ /g, ' ') + ' ₽';

export function formatEvent(e) {
  const it = e.item;
  const lines = [];
  if (e.kind === 'new') lines.push(`🆕 Новый рейс: ${it.from} → ${it.to}`);
  else {
    const d = it.rub - e.oldRub;
    lines.push(`💱 Цена изменилась: ${it.from} → ${it.to}`, `${rubFmt(e.oldRub)} → ${rubFmt(it.rub)} (${d > 0 ? '+' : '−'}${rubFmt(Math.abs(d))})`);
  }
  if (e.kind === 'new') lines.push(`💰 ${rubFmt(it.rub)}`);
  if (it.load) lines.push(`📦 ${it.load}`);
  if (it.when) lines.push(`🕒 Погрузка: ${it.when}`);
  if (it.km) lines.push(`🛣 ${it.km}`);
  if (it.srcName || it.dstName) lines.push(`📍 ${it.srcName || ''} → ${it.dstName || ''}`);
  return lines.join('\n');
}

// Одно сообщение на пачку событий, порциями ≤ limit символов
export function formatMessages(events, limit = 3500) {
  const parts = events.map(formatEvent);
  const out = [];
  let cur = '';
  for (const p of parts) {
    if (cur && (cur + '\n\n' + p).length > limit) { out.push(cur); cur = p; } else cur = cur ? cur + '\n\n' + p : p;
  }
  if (cur) out.push(cur);
  return out;
}
