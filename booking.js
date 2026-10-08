// Чистые функции бронирования (без сети): переменные запросов, выбор слота, разбор результата.
export const rubOf = (money, divisor = 100) => Math.round(Number(money?.Amount || 0) / divisor);

// Как у самого сайта: окно слотов от завтрашней полуночи (UTC) на 11 дней вперёд
export function slotsVars(taskId, cursor = null, now = new Date()) {
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  const end = start + 11 * 864e5;
  return { input: { TaskID: String(taskId), Cursor: cursor, LoadingSlotsDateRange: { StartDate: new Date(start).toISOString(), EndDate: new Date(end).toISOString() } } };
}

// Берём только слоты не дешевле минимальной цены маршрута.
// strategy: 'max' — самый дорогой (при равенстве — ранний), 'earliest' — самый ранний
export function pickSlot(slots, route, strategy = 'max', divisor = 100) {
  const min = Number(route?.minPrice) || 0;
  const ok = (slots || []).filter((s) => s.SlotID != null && rubOf(s.Price, divisor) >= min);
  if (!ok.length) return null;
  const byTime = (a, b) => new Date(a.ArrivalTime) - new Date(b.ArrivalTime);
  return ok.slice().sort(strategy === 'earliest' ? byTime : (a, b) => rubOf(b.Price, divisor) - rubOf(a.Price, divisor) || byTime(a, b))[0];
}

// LastPrice — цена слота, которую мы видели: если она успела измениться, сайт отклонит бронь
export function acceptVars(taskId, slot) {
  return { input: { TaskID: String(taskId), Slots: [{ ArrivalTime: slot.ArrivalTime, LastPrice: { Amount: slot.Price.Amount, CurrencyCode: slot.Price.CurrencyCode }, SlotID: slot.SlotID }] } };
}

export function parseAccept(json) {
  const r = json?.data?.AcceptFixedFreightTasksBatch?.Result;
  if (!r) return { ok: false, text: 'Пустой ответ сайта' };
  if (r.__typename === 'AcceptFixedFreightTasksBatchSuccess') return { ok: true, text: 'Забронировано' };
  const extra = [r.IntersectionParams?.Text, r.IntersectionSlots?.Text].filter(Boolean).join('; ');
  return { ok: false, text: `Отказ: ${r.Code || r.__typename}${r.Meta ? ' ' + JSON.stringify(r.Meta) : ''}${extra ? ' — ' + extra : ''}` };
}
