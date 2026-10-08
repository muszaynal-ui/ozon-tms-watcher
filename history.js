const $ = (id) => document.getElementById(id);
const rub = (n) => Math.round(n).toLocaleString('ru-RU').replace(/ /g, ' ') + ' ₽';
const when = (t) => new Date(t).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

function spark(pts) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 300 60');
  svg.setAttribute('preserveAspectRatio', 'none');
  const ys = pts.map((p) => p[1]), min = Math.min(...ys), max = Math.max(...ys);
  const t0 = pts[0][0], t1 = pts.at(-1)[0] || t0 + 1;
  const x = (t) => (t1 === t0 ? 150 : 5 + ((t - t0) / (t1 - t0)) * 290);
  const y = (v) => (max === min ? 30 : 55 - ((v - min) / (max - min)) * 50);
  // ступенчатая линия: цена держится до следующего изменения
  let d = '';
  pts.forEach((p, i) => { d += (i ? `L${x(p[0])},${y(pts[i - 1][1])} ` : 'M') + `${x(p[0])},${y(p[1])} `; });
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', d); path.setAttribute('fill', 'none'); path.setAttribute('stroke', '#1565c0'); path.setAttribute('stroke-width', '2');
  svg.append(path);
  return svg;
}

async function render() {
  const { history = {}, lastCheck = 0 } = await chrome.storage.local.get(['history', 'lastCheck']);
  const only = $('onlyLive').checked;
  $('list').replaceChildren();
  const rows = Object.entries(history).filter(([, h]) => h.pts?.length).sort((a, b) => b[1].seen - a[1].seen);
  let shown = 0;
  for (const [, h] of rows) {
    const live = h.seen >= lastCheck - 1000;
    if (only && !live) continue;
    shown++;
    const pts = h.pts, first = pts[0][1], cur = pts.at(-1)[1];
    const ys = pts.map((p) => p[1]);
    const box = el('div', 'ride');
    const head = el('div', 'head');
    head.append(el('span', 'route', `${h.from} → ${h.to}`), el('span', live ? 'live' : 'gone', live ? '● в списке' : `не виден с ${when(h.seen)}`));
    box.append(head, el('div', 'meta', [h.srcName && `${h.srcName} → ${h.dstName}`, h.load, h.when].filter(Boolean).join(' · ')));
    const d = cur - first;
    const stats = el('div', 'stats');
    [['Начальная', rub(first)], ['Сейчас', rub(cur)], ['Мин', rub(Math.min(...ys))], ['Макс', rub(Math.max(...ys))]].forEach(([k, v]) => {
      const s = el('span'); s.append(`${k}: `, el('b', '', v)); stats.append(s);
    });
    stats.append(el('span', d > 0 ? 'up' : d < 0 ? 'down' : '', `Изменение: ${d > 0 ? '+' : d < 0 ? '−' : ''}${rub(Math.abs(d))}`));
    box.append(stats);
    if (pts.length > 1) box.append(spark(pts));
    const det = el('details'); det.append(el('summary', '', `Изменений цены: ${pts.length - 1}`));
    const tb = el('table');
    pts.slice().reverse().forEach(([t, v], i, arr) => {
      const prev = arr[i + 1]; const tr = el('tr');
      tr.append(el('td', '', when(t)), el('td', '', rub(v)), el('td', prev ? (v > prev[1] ? 'up' : 'down') : '', prev ? `${v > prev[1] ? '+' : '−'}${rub(Math.abs(v - prev[1]))}` : 'первая'));
      tb.append(tr);
    });
    det.append(tb); box.append(det);
    $('list').append(box);
  }
  $('empty').textContent = shown ? '' : 'Пока пусто: история появляется, когда мониторинг видит подходящие рейсы.';
}
$('onlyLive').onchange = render;
$('clear').onclick = async () => { if (confirm('Удалить всю историю цен?')) { await chrome.storage.local.set({ history: {} }); render(); } };
chrome.storage.onChanged.addListener((c) => { if (c.history) render(); });
render();
