import { fetchLatestVersion, isNewer, loadHandle, hasWriteAccess, applyUpdate } from './updater.js';
import { formatMessages } from './logic.js';

// Диагностика: тело запроса CargoesList (фильтры) и, в режиме записи, действий пользователя (бронирование и т.п.)
const NOISE = /op=(Me|ExistsUnconfirmedOrders\w*|LogisticianBanners|ClustersRequiringAggregate|Claims|CargoesInfo|FavoriteDirections)\b|tracker|browser-metrics|sentry|\/vars\//;
chrome.webRequest.onBeforeRequest.addListener(
  (d) => {
    try {
      const raw = d.requestBody && d.requestBody.raw && d.requestBody.raw[0] && d.requestBody.raw[0].bytes;
      const body = raw ? new TextDecoder().decode(raw) : '';
      if (/op=CargoesList/.test(d.url) && raw) {
        chrome.storage.local.get('gqlCapture').then(({ gqlCapture = [] }) => {
          gqlCapture.push({ t: Date.now(), url: d.url, method: d.method, body: body.slice(0, 8000) });
          chrome.storage.local.set({ gqlCapture: gqlCapture.slice(-6) });
        });
        return;
      }
      chrome.storage.local.get(['recording', 'recLog']).then(({ recording, recLog = [] }) => {
        if (!recording || NOISE.test(d.url) || (d.method === 'GET' && !/gql/.test(d.url))) return;
        let op = '';
        try { op = JSON.parse(body).operationName || ''; } catch (e) {}
        recLog.push({ t: Date.now(), method: d.method, url: d.url, op, body: body.slice(0, 6000) });
        chrome.storage.local.set({ recLog: recLog.slice(-150) });
      });
    } catch (e) {}
  },
  { urls: ['https://tms.ozon.ru/*'], types: ['xmlhttprequest'] },
  ['requestBody']
);

// ---------- Автообновление ----------
async function checkForUpdate() {
  try {
    const latest = await fetchLatestVersion();
    const current = chrome.runtime.getManifest().version;
    await chrome.storage.local.set({ latestVersion: latest, lastUpdateCheck: Date.now() });
    if (!isNewer(latest, current)) { chrome.action.setBadgeText({ text: '' }); return; }

    const { autoUpdate = true } = await chrome.storage.sync.get('autoUpdate');
    const handle = await loadHandle();
    if (autoUpdate && (await hasWriteAccess(handle))) {
      await applyUpdate(handle); // перезагрузит расширение
      return;
    }
    chrome.action.setBadgeText({ text: '↑' });
    chrome.action.setBadgeBackgroundColor({ color: '#e53935' });
    const { notifiedVersion } = await chrome.storage.local.get('notifiedVersion');
    if (notifiedVersion !== latest) {
      await chrome.storage.local.set({ notifiedVersion: latest });
      chrome.notifications.create('update', {
        type: 'basic',
        iconUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        title: 'Доступно обновление расширения',
        message: `Версия ${latest} (у вас ${current}). Откройте расширение → «Обновления».`
      });
    }
  } catch (e) {
    chrome.storage.local.set({ updateError: String(e.message || e) });
  }
}

chrome.runtime.onInstalled.addListener(() => { chrome.alarms.create('update-check', { periodInMinutes: 60 }); checkForUpdate(); });
chrome.runtime.onStartup.addListener(() => { chrome.alarms.create('update-check', { periodInMinutes: 60 }); checkForUpdate(); });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'update-check') checkForUpdate(); });
chrome.notifications.onClicked.addListener(async (id) => {
  if (id === 'update') return chrome.tabs.create({ url: chrome.runtime.getURL('update.html') });
  const [tab] = await chrome.tabs.query({ url: 'https://tms.ozon.ru/*' });   // клик по уведомлению — к вкладке TMS
  if (tab) { chrome.tabs.update(tab.id, { active: true }); chrome.windows.update(tab.windowId, { focused: true }); }
});
chrome.runtime.onMessage.addListener((msg) => { if (msg.type === 'check-update') checkForUpdate(); });

// ---------- Уведомления: Chrome + Telegram + WhatsApp (Wappi) ----------
const ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const list = (s) => String(s || '').split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean);

async function post(url, headers, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const text = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 200)}`);
  return text;
}

// Возвращает массив ошибок (пустой — всё отправлено)
async function sendAll(text) {
  const { notify: n = {} } = await chrome.storage.local.get('notify');
  const jobs = [];
  if (n.tgEnabled && n.tgToken) {
    for (const chat of list(n.tgChats)) {
      jobs.push(['Telegram ' + chat, post(`https://api.telegram.org/bot${n.tgToken}/sendMessage`, {},
        { chat_id: chat, text, disable_web_page_preview: true })]);
    }
  }
  if (n.waEnabled && n.waToken && n.waProfile) {
    for (const to of list(n.waTo)) {
      const phone = to.replace(/[^\d]/g, '');
      jobs.push(['WhatsApp ' + phone, post(`https://wappi.pro/api/sync/message/send?profile_id=${encodeURIComponent(n.waProfile)}`,
        { Authorization: n.waToken }, { body: text, recipient: phone })]);
    }
  }
  const res = await Promise.allSettled(jobs.map((j) => j[1]));
  const errors = res.map((r, i) => (r.status === 'rejected' ? `${jobs[i][0]}: ${r.reason.message}` : null)).filter(Boolean);
  await chrome.storage.local.set({ lastSend: { t: Date.now(), ok: jobs.length - errors.length, errors } });
  return { sent: jobs.length, errors };
}

chrome.runtime.onMessage.addListener((msg, _s, reply) => {
  if (msg.type === 'notify') {
    const first = msg.events[0].item;
    chrome.notifications.create({
      type: 'basic', iconUrl: ICON, requireInteraction: true, priority: 2,
      title: `Рейсы: ${msg.events.length}`,
      message: msg.events.slice(0, 3).map((e) => `${e.kind === 'new' ? 'Новый' : 'Цена'}: ${e.item.from} → ${e.item.to} · ${e.item.rub} ₽`).join('\n') || first.from
    });
    (async () => {
      const { linkTemplate = '' } = await chrome.storage.sync.get('linkTemplate');
      for (const part of formatMessages(msg.events, 3500, linkTemplate)) await sendAll(part);
    })();
  } else if (msg.type === 'notify-text') {
    (async () => { for (const part of msg.text.match(/[\s\S]{1,3500}/g) || []) await sendAll(part); })();
  } else if (msg.type === 'test-notify') {
    sendAll('✅ Тест: уведомления от «Ozon TMS — мониторинг рейсов» работают.').then(reply);
    return true;
  }
});
