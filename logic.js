// Чистая логика: сопоставление с маршрутами, поиск новых рейсов / изменений цены, текст уведомлений.
export const lc = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е');
const terms = (s) => String(s || '').split(',').map((x) => lc(x.trim())).filter(Boolean);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Совпадение по ЦЕЛЫМ словам: «краснодар» не найдёт «Краснодарский край», «москва» — «Московская область».
// Чтобы искать по началу слова, добавьте * в конце: «москов*».
export function hasTerm(text, term) {
  const prefix = term.endsWith('*');
  const t = esc(prefix ? term.slice(0, -1) : term);
  return new RegExp(`(?<![\\p{L}\\p{N}])${t}${prefix ? '' : '(?![\\p{L}\\p{N}])'}`, 'u').test(text);
}

// Маршрут: from / to — подстроки (через запятую = «или»), пусто = любой; minPrice — минимальная цена, ₽
export function matchRoute(item, routes) {
  const s = lc(item.srcText), d = lc(item.dstText);
  for (const r of routes || []) {
    if (r.enabled === false) continue;
    const f = terms(r.from), t = terms(r.to);
    if (f.length && !f.some((x) => hasTerm(s, x))) continue;
    if (t.length && !t.some((x) => hasTerm(d, x))) continue;
    if (r.minPrice && item.rub < Number(r.minPrice)) continue;
    return r;
  }
  return null;
}

// known: { [key]: { p: цена на момент последнего уведомления/первого появления, m: подходил ли, t: время уведомления } }
// opts.priceMinDelta — минимальное изменение цены, ₽ (сравниваем с ценой в ПОСЛЕДНЕМ уведомлении, поэтому мелкие шаги копятся);
// opts.priceCooldownMin — не чаще чем раз в N минут для одного рейса.
export function diff(items, known, opts, routes) {
  const next = { ...known };
  const events = [];
  const now = opts.now ?? Date.now();
  const minDelta = Number(opts.priceMinDelta) || 0;
  const cooldown = (Number(opts.priceCooldownMin) || 0) * 60000;
  let matched = 0;
  for (const it of items) {
    const route = matchRoute(it, routes);
    const prev = known[it.key];
    if (!route) { next[it.key] = { p: it.rub, m: false, t: prev?.t || 0 }; continue; }
    matched++;
    if (!prev || !prev.m) {
      if (opts.baselined || opts.notifyExisting) events.push({ kind: 'new', item: it, route });
      next[it.key] = { p: it.rub, m: true, t: now };
    } else if (!opts.notifyPriceChange) {
      next[it.key] = { p: it.rub, m: true, t: prev.t };
    } else {
      const delta = Math.abs(it.rub - prev.p);
      if (delta > 0 && delta >= minDelta && now - (prev.t || 0) >= cooldown) {
        events.push({ kind: 'price', item: it, route, oldRub: prev.p });
        next[it.key] = { p: it.rub, m: true, t: now };
      } // иначе оставляем старую цену как точку отсчёта
    }
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
