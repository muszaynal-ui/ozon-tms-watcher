const $ = (id) => document.getElementById(id);
const say = (t, cls = '') => { $('msg').className = cls; $('msg').textContent = t; };

const SYNC = { intervalSec: 30, mode: 'api', maxPages: 10, notifyExisting: false, notifyPriceChange: true, priceMinDelta: 1000, priceCooldownMin: 0, sound: true, linkTemplate: '', bookEnabled: false, routes: [] };
const SECRET = { tgEnabled: false, tgToken: '', tgChats: '', waEnabled: false, waProfile: '', waToken: '', waTo: '' };

function addRow(r = { from: '', to: '', minPrice: 0, enabled: true }) {
  const tr = document.createElement('tr');
  tr.innerHTML = `<td><input type="checkbox" class="en" title="Включён"></td>
    <td><input type="text" class="from" placeholder="любой"></td>
    <td><input type="text" class="to" placeholder="любой"></td>
    <td><input type="number" class="min" min="0" step="1000"></td>
    <td><select class="book"><option value="off">нет</option><option value="confirm">по кнопке</option></select></td>
    <td><select class="slot"><option value="max">дорогой</option><option value="earliest">ранний</option></select></td>
    <td><button class="del" title="Удалить">✕</button></td>`;
  tr.querySelector('.en').checked = r.enabled !== false;
  tr.querySelector('.from').value = r.from || '';
  tr.querySelector('.to').value = r.to || '';
  tr.querySelector('.min').value = r.minPrice || 0;
  tr.querySelector('.book').value = r.book === 'confirm' ? 'confirm' : 'off';
  tr.querySelector('.slot').value = r.slot === 'earliest' ? 'earliest' : 'max';
  tr.querySelector('.del').onclick = () => tr.remove();
  $('routes').tBodies[0].append(tr);
}

async function load() {
  const s = { ...SYNC, ...(await chrome.storage.sync.get(SYNC)) };
  const n = { ...SECRET, ...((await chrome.storage.local.get('notify')).notify || {}) };
  ['intervalSec', 'mode', 'maxPages', 'priceMinDelta', 'priceCooldownMin', 'linkTemplate'].forEach((k) => ($(k).value = s[k]));
  ['notifyExisting', 'notifyPriceChange', 'sound', 'bookEnabled'].forEach((k) => ($(k).checked = s[k]));
  Object.keys(SECRET).forEach((k) => (typeof SECRET[k] === 'boolean' ? ($(k).checked = n[k]) : ($(k).value = n[k])));
  (s.routes.length ? s.routes : [undefined]).forEach((r) => addRow(r));
}

async function save() {
  const routes = [...$('routes').tBodies[0].rows].map((tr) => ({
    enabled: tr.querySelector('.en').checked,
    from: tr.querySelector('.from').value.trim(),
    to: tr.querySelector('.to').value.trim(),
    minPrice: Number(tr.querySelector('.min').value) || 0,
    book: tr.querySelector('.book').value,
    slot: tr.querySelector('.slot').value
  })).filter((r) => r.from || r.to || r.minPrice);

  const sync = {
    routes,
    intervalSec: Math.max(5, Number($('intervalSec').value) || 30),
    mode: $('mode').value,
    maxPages: Math.min(50, Math.max(1, Number($('maxPages').value) || 10)),
    priceMinDelta: Math.max(0, Number($('priceMinDelta').value) || 0),
    priceCooldownMin: Math.max(0, Number($('priceCooldownMin').value) || 0),
    linkTemplate: $('linkTemplate').value.trim(),
    bookEnabled: $('bookEnabled').checked,
    notifyExisting: $('notifyExisting').checked,
    notifyPriceChange: $('notifyPriceChange').checked,
    sound: $('sound').checked
  };
  const notify = {};
  Object.keys(SECRET).forEach((k) => (notify[k] = typeof SECRET[k] === 'boolean' ? $(k).checked : $(k).value.trim()));

  await chrome.storage.sync.set(sync);
  await chrome.storage.local.set({ notify });
  // новые маршруты — новая точка отсчёта (иначе подходящие рейсы, уже виденные, не будут считаться новыми)
  await chrome.storage.local.set({ known: {}, baselined: false });
  say('Сохранено. Обновите вкладку tms.ozon.ru, чтобы настройки вступили в силу.', 'ok');
}

$('addRoute').onclick = () => addRow();
$('save').onclick = save;
$('test').onclick = async () => {
  await save();
  say('Отправляю тест…');
  chrome.runtime.sendMessage({ type: 'test-notify' }, (r) => {
    if (chrome.runtime.lastError || !r) return say('Нет ответа от фонового скрипта', 'err');
    if (!r.sent) return say('Нет включённых каналов: включите Telegram и/или WhatsApp и заполните поля.', 'err');
    r.errors.length ? say(`Отправлено: ${r.sent - r.errors.length} из ${r.sent}\n${r.errors.join('\n')}`, 'err')
      : say(`Тест отправлен (${r.sent}).`, 'ok');
  });
};
load();
