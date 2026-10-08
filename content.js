const DEFAULTS = {
  enabled: false,
  intervalSec: 30,     // период проверки (в режиме API не чаще раза в 15 с)
  loadWaitSec: 4,      // режим «таблица»: ожидание отрисовки списка после загрузки
  rowSelector: 'tr[data-testid^="table-row__cargoes_"]',
  nextSelector: '',    // кнопка «следующая страница», если появится пагинация
  maxPages: 10,        // максимум страниц / подгрузок за один проход (по 40 рейсов)
  pageWaitSec: 2,
  mode: 'api',         // 'api' — прямой запрос списка, 'dom' — чтение таблицы с перезагрузкой
  priceDivisor: 100,   // Amount в API хранится в копейках
  routes: [],          // [{ from, to, minPrice, enabled }]
  notifyExisting: false,
  notifyPriceChange: true,
  priceMinDelta: 1000,     // уведомлять об изменении цены, только если она изменилась не меньше чем на N ₽
  priceCooldownMin: 0,     // и не чаще раза в N минут для одного рейса
  sound: true
};

const norm = (s) => s.replace(/\s+/g, ' ').trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const logic = () => import(chrome.runtime.getURL('logic.js'));

function maxPrice(text) {
  const re = /(\d[\d\s ]*(?:[.,]\d+)?)\s*(?:₽|руб|р\.)/gi;
  let m, best = 0;
  while ((m = re.exec(text))) {
    const n = parseFloat(m[1].replace(/[\s ]/g, '').replace(',', '.'));
    if (n > best) best = n;
  }
  return best;
}

function beep() {
  // браузер разрешает звук только после действия пользователя на странице — иначе пропускаем без ошибки
  if (!navigator.userActivation?.hasBeenActive) return;
  try {
    const ctx = new AudioContext();
    if (ctx.state === 'suspended') { ctx.close(); return; }
    [0, 0.25, 0.5].forEach((d) => {
      const o = ctx.createOscillator();
      o.frequency.value = 880;
      o.connect(ctx.destination);
      o.start(ctx.currentTime + d);
      o.stop(ctx.currentTime + d + 0.15);
    });
  } catch (e) {}
}

function highlight(el) {
  el.style.outline = '3px solid #e53935';
  el.style.background = '#fff3cd';
}

function scrollables(rows) {
  const out = [document.scrollingElement];
  for (let el = rows[rows.length - 1]?.parentElement; el; el = el.parentElement) {
    if (el.scrollHeight > el.clientHeight + 5 && /(auto|scroll)/.test(getComputedStyle(el).overflowY)) out.push(el);
  }
  return out;
}

// ---------- Режим «таблица»: перезагрузка страницы, прокрутка, чтение строк ----------
async function collectAll(cfg) {
  const all = new Map();
  const grab = () => {
    document.querySelectorAll(cfg.rowSelector).forEach((el) => {
      const cells = [...el.querySelectorAll('td')];
      const text = norm(el.innerText || '');
      if (text.length < 10 || cells.length < 9) return;
      const cell = (i) => (cells[i]?.innerText || '').trim();
      const lines = (i) => cell(i).split('\n').map((x) => x.trim()).filter(Boolean);
      const [srcCity, srcName = ''] = [lines(1)[0] || '', (lines(1)[1] || '').split(';')[0]];
      const [dstCity, dstName = ''] = [lines(3)[0] || '', (lines(3)[1] || '').split(';')[0]];
      // цена в таблице меняется, поэтому в ключ она не входит — только откуда/куда/даты
      const key = [1, 3, 5].map((i) => norm(cell(i))).join('|');
      if (all.has(key)) return;
      all.set(key, {
        el, key, from: srcCity, to: dstCity, srcName, dstName,
        srcText: norm(cell(1)), dstText: norm(cell(3)),
        rub: maxPrice(cell(8)), when: lines(5)[0] || '', load: (cell(8).match(/\d+\s*грузомест\S*/) || [''])[0],
        km: (cell(4).match(/\d[\d\s]*км/) || [''])[0]
      });
    });
  };
  const wait = Math.max(0.5, cfg.pageWaitSec) * 1000;

  grab();
  let stalls = 0;
  for (let page = 0; page < cfg.maxPages; page++) {
    const before = document.querySelectorAll(cfg.rowSelector).length;
    const next = cfg.nextSelector && document.querySelector(cfg.nextSelector);
    if (next) {
      if (next.disabled || next.getAttribute('aria-disabled') === 'true') break;
      next.click();
    } else {
      const rows = document.querySelectorAll(cfg.rowSelector);
      rows[rows.length - 1]?.scrollIntoView({ block: 'end' });
      scrollables([...rows]).forEach((el) => (el.scrollTop = el.scrollHeight));
    }
    if (next) await sleep(wait);
    else {                                // ждём, пока подгрузится новая порция (до 4× паузы)
      const t0 = Date.now();
      while (Date.now() - t0 < wait * 4 && document.querySelectorAll(cfg.rowSelector).length <= before) await sleep(300);
      await sleep(300);
    }
    grab();
    if (!next && document.querySelectorAll(cfg.rowSelector).length <= before && ++stalls >= 2) break;
  }
  return { items: [...all.values()], complete: false };
}

// ---------- Режим API: тот же GraphQL-запрос, что делает сам сайт ----------
const GQL_URL = '/p-api/graphql-decorator/gql?op=CargoesList';
const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

// FirstArrivalTimes приходят в UTC — показываем по времени склада отправления
function fmtDate(iso, offsetSec) {
  const d = new Date(new Date(iso).getTime() + (offsetSec ?? 10800) * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

function parseTask(t, cfg) {
  const fixed = t.__typename === 'FixedFreightTask';
  const src = fixed ? t.Route?.StartPoint?.Aggregate : t.Src;
  const dst = fixed ? t.Route?.EndPoint?.Aggregate : t.Dst;
  const money = fixed ? t.MaxPrice : t.TotalPrice;
  const dates = fixed ? (t.FirstArrivalTimes || []).slice(0, 3).map((x) => fmtDate(x, src?.UTCOffsetSeconds)) : [];
  const city = (a) => a?.ClusterName || a?.Name || '';
  const place = (a) => norm(`${a?.ClusterName || ''} ${a?.Name || ''} ${a?.Address || ''}`);
  return {
    el: null,
    key: `${t.__typename}:${t.ID}`,
    from: city(src), to: city(dst), srcName: src?.Name || '', dstName: dst?.Name || '',
    srcText: place(src), dstText: place(dst),
    rub: money ? Math.round(Number(money.Amount) / cfg.priceDivisor) : 0,
    when: dates.join(', '),
    load: fixed ? `${t.PalletsCount ?? ''} паллет` : `${t.CargoesAvailable ?? ''} грузомест`,
    km: t.TransitDistanceMeters ? `${Math.round(t.TransitDistanceMeters / 1000)} км` : ''
  };
}

async function gql(variables) {
  const { CARGOES_QUERY } = await import(chrome.runtime.getURL('query.js'));
  const r = await fetch(GQL_URL, {
    method: 'POST', credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ operationName: 'CargoesList', variables, query: CARGOES_QUERY })
  });
  if (!r.ok) throw new Error(`CargoesList HTTP ${r.status}`);
  const j = await r.json();
  if (j.errors?.length) throw new Error('GraphQL: ' + JSON.stringify(j.errors[0]).slice(0, 300));
  return j;
}

async function collectAllApi(cfg) {
  // фильтры страницы (тип, высокий тариф) берём из последнего запроса сайта, если он был
  const { gqlCapture = [] } = await chrome.storage.local.get('gqlCapture');
  let base = { HighTariffOnly: false, Types: [] };
  try {
    const last = JSON.parse(gqlCapture.filter((c) => c.url.includes('CargoesList')).at(-1).body);
    base = { ...last.variables.input }; delete base.Cursor;
  } catch (e) {}

  const all = new Map();
  let token = '', complete = false;
  for (let page = 0; page < cfg.maxPages; page++) {
    const j = await gql({ input: { ...base, Cursor: { Token: token, Limit: 40 } } });
    const data = j.data?.SearchLogisticTasks;
    if (page === 0) await chrome.storage.local.set({ apiSample: JSON.stringify(j).slice(0, 4000) });
    const tasks = data?.Tasks || [];
    tasks.forEach((t) => { const p = parseTask(t, cfg); if (!all.has(p.key)) all.set(p.key, p); });
    const c = data?.Cursor;
    const next = typeof c === 'string' ? c : c?.Token || '';
    if (!tasks.length || !next || next === token) { complete = true; break; }
    token = next;
    await sleep(400); // не частим
  }
  if (!all.size) throw new Error('API вернул пустой список');
  return { items: [...all.values()], complete };
}

// ---------- Проверка: сравнить с маршрутами и состоянием, отправить события ----------
async function scan(cfg, collect = collectAll) {
  const L = await logic();
  const { items, complete } = await collect(cfg);
  const st = await chrome.storage.local.get(['known', 'baselined']);
  const { events, next, matched } = L.diff(items, st.known || {},
    { baselined: !!st.baselined, notifyExisting: cfg.notifyExisting, notifyPriceChange: cfg.notifyPriceChange,
      priceMinDelta: cfg.priceMinDelta, priceCooldownMin: cfg.priceCooldownMin }, cfg.routes);

  // при полном проходе забываем пропавшие рейсы, при неполном — только ограничиваем размер
  const known = complete ? Object.fromEntries(items.map((i) => [i.key, next[i.key]])) : L.cap(next, 4000);
  await chrome.storage.local.set({
    known, baselined: true, lastCheck: Date.now(), lastTotal: items.length, lastMatched: matched, lastEvents: events.length
  });

  if (events.length) {
    events.forEach((e) => e.item.el && highlight(e.item.el));
    chrome.runtime.sendMessage({
      type: 'notify',
      events: events.map((e) => ({ ...e, item: { ...e.item, el: undefined } }))
    });
    if (cfg.sound) beep();
    document.title = `(${events.length}) РЕЙСЫ — ${document.title.replace(/^\(\d+\) РЕЙСЫ — /, '')}`;
  }
}

// ---------- Диагностика (кнопка в popup) ----------
function cssPath(el) {
  const parts = [];
  for (let n = el; n && n.nodeType === 1 && parts.length < 6; n = n.parentElement) {
    let p = n.tagName.toLowerCase();
    const tid = n.getAttribute('data-testid');
    if (tid) p += `[data-testid="${tid}"]`;
    else if (n.id) p += `#${n.id}`;
    else if (typeof n.className === 'string' && n.className.trim()) p += '.' + n.className.trim().split(/\s+/).slice(0, 2).join('.');
    parts.unshift(p);
  }
  return parts.join(' > ');
}

function cleanHTML(el, max = 6000) {
  const c = el.cloneNode(true);
  c.querySelectorAll('svg').forEach((s) => s.replaceWith('<svg/>'));
  c.querySelectorAll('input[type=password]').forEach((i) => i.removeAttribute('value'));
  return c.outerHTML.replace(/\s+/g, ' ').slice(0, max);
}

function getNetLog() {
  return new Promise((resolve) => {
    const h = (e) => {
      if (e.source === window && e.data && e.data.__tmsRes) {
        window.removeEventListener('message', h);
        resolve(e.data.log);
      }
    };
    window.addEventListener('message', h);
    window.postMessage({ __tmsReq: true }, '*');
    setTimeout(() => resolve([]), 1500);
  });
}

async function diagnose() {
  const cfg = { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
  const out = { collectedAt: new Date().toISOString(), url: location.href, title: document.title,
    viewport: [innerWidth, innerHeight] };

  const rows = [...document.querySelectorAll(cfg.rowSelector)];
  out.rowSelector = cfg.rowSelector;
  out.rowsOnLoad = rows.length;
  out.headers = [...document.querySelectorAll('th')].map((t) => norm(t.innerText));
  out.firstRowsCells = rows.slice(0, 5).map((r) => [...r.querySelectorAll('td')].map((td) => norm(td.innerText)));
  out.firstRowHTML = rows[0] ? cleanHTML(rows[0], 9000) : null;
  out.tableContainerPath = rows[0] ? cssPath(rows[0].closest('table') || rows[0]) : null;

  // фильтры и кнопки над таблицей
  out.inputs = [...document.querySelectorAll('input:not([type=password]), select, textarea')].slice(0, 40).map((i) => ({
    path: cssPath(i), type: i.type, placeholder: i.placeholder, value: i.value, name: i.name, aria: i.getAttribute('aria-label')
  }));
  out.buttons = [...document.querySelectorAll('button, [role=button], a')].slice(0, 120).map((b) => ({
    text: norm(b.innerText).slice(0, 60), aria: b.getAttribute('aria-label'), testid: b.getAttribute('data-testid'),
    disabled: b.disabled || b.getAttribute('aria-disabled'), path: cssPath(b)
  })).filter((b) => b.text || b.aria || b.testid);

  // кандидаты на пагинацию
  const pagRe = /след|далее|ещ[её]|показать|загруз|next|more|^\d{1,3}$|[›»>]/i;
  out.paginationCandidates = [...document.querySelectorAll('button, a, li, [role=button], [class*=agination], [class*=pager]')]
    .filter((e) => pagRe.test(norm(e.innerText).slice(0, 30)) || /agination|pager/i.test(String(e.className)))
    .slice(0, 40).map((e) => ({ text: norm(e.innerText).slice(0, 40), path: cssPath(e), html: cleanHTML(e, 500) }));

  // нижняя часть страницы после таблицы
  const table = rows[0]?.closest('table');
  out.afterTableHTML = table?.parentElement ? cleanHTML(table.parentElement, 3000) : null;

  // прокручиваемые контейнеры
  out.scrollables = scrollables(rows).map((e) => ({ path: e === document.scrollingElement ? 'document' : cssPath(e),
    scrollHeight: e.scrollHeight, clientHeight: e.clientHeight }));

  // тест подгрузки: сколько строк даёт прокрутка
  const steps = [];
  let prev = rows.length;
  for (let i = 0; i < 8; i++) {
    const cur = document.querySelectorAll(cfg.rowSelector);
    cur[cur.length - 1]?.scrollIntoView({ block: 'end' });
    scrollables([...cur]).forEach((e) => (e.scrollTop = e.scrollHeight));
    await sleep(Math.max(1500, cfg.pageWaitSec * 1000));
    const n = document.querySelectorAll(cfg.rowSelector).length;
    steps.push(n);
    if (n <= prev) break;
    prev = n;
  }
  out.scrollTest = { rowCountPerStep: steps, note: 'если число растёт — бесконечная прокрутка; если нет — пагинация/всё уже загружено' };

  out.network = (await getNetLog()).filter((n) => !/kaspersky|cdns\.ozon\.ru\/v1\/mc/.test(n.url));
  out.resources = performance.getEntriesByType('resource')
    .filter((r) => ['fetch', 'xmlhttprequest', 'other', 'beacon'].includes(r.initiatorType) && !/kaspersky|\.(png|jpe?g|svg|woff2?|css)(\?|$)/i.test(r.name))
    .map((r) => ({ type: r.initiatorType, url: r.name.slice(0, 300), ms: Math.round(r.duration) }));
  out.scrollTest.rowCountPerStep = out.scrollTest.rowCountPerStep.concat([document.querySelectorAll(cfg.rowSelector).length]);
  out.currentSettings = cfg;
  out.apiSample = (await chrome.storage.local.get('apiSample')).apiSample || null;
  out.apiState = await chrome.storage.local.get(['apiError', 'modeUsed']);
  out.gqlCapture = (await chrome.storage.local.get('gqlCapture')).gqlCapture || [];
  return out;
}

chrome.runtime.onMessage.addListener((msg, _s, reply) => {
  if (msg.type !== 'diagnose') return;
  diagnose().then(reply).catch((e) => reply({ error: String(e) }));
  return true;
});

function runDom(cfg) {
  setTimeout(async () => {
    await scan(cfg);
    const jitter = 1 + Math.random() * 0.2; // небольшой разброс, чтобы не бить строго по таймеру
    setTimeout(() => location.reload(), Math.max(5, cfg.intervalSec) * 1000 * jitter);
  }, cfg.loadWaitSec * 1000);
}

function runApi(cfg) {
  const tick = async () => {
    try {
      await scan(cfg, collectAllApi);
      await chrome.storage.local.set({ apiError: '', modeUsed: 'api' });
    } catch (e) {
      // API не сработал — переключаемся на чтение таблицы
      await chrome.storage.local.set({ apiError: String(e.message || e), modeUsed: 'dom' });
      return runDom(cfg);
    }
    const jitter = 1 + Math.random() * 0.2;
    setTimeout(tick, Math.max(15, cfg.intervalSec) * 1000 * jitter); // не чаще раза в 15 с: за проход уходит до 10 запросов
  };
  setTimeout(tick, 1500);
}

(async function main() {
  const cfg = { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
  if (!cfg.enabled) return;
  cfg.mode === 'api' ? runApi(cfg) : runDom(cfg);
})();
