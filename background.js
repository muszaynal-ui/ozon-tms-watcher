import { fetchLatestVersion, isNewer, loadHandle, hasWriteAccess, applyUpdate } from './updater.js';

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== 'notify') return;
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    title: `Новых рейсов: ${msg.items.length}`,
    message: msg.items.slice(0, 3).join('\n').slice(0, 300),
    priority: 2,
    requireInteraction: true
  });
});

// Диагностика: запоминаем тело GraphQL-запроса CargoesList (запрос + переменные фильтров)
chrome.webRequest.onBeforeRequest.addListener(
  (d) => {
    try {
      const raw = d.requestBody && d.requestBody.raw && d.requestBody.raw[0] && d.requestBody.raw[0].bytes;
      if (!raw) return;
      const body = new TextDecoder().decode(raw).slice(0, 8000);
      chrome.storage.local.get('gqlCapture').then(({ gqlCapture = [] }) => {
        gqlCapture.push({ t: Date.now(), url: d.url, method: d.method, body });
        chrome.storage.local.set({ gqlCapture: gqlCapture.slice(-6) });
      });
    } catch (e) {}
  },
  { urls: ['https://tms.ozon.ru/*gql?op=CargoesList*', 'https://tms.ozon.ru/*gql?op=FavoriteDirections*'] },
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
chrome.notifications.onClicked.addListener((id) => { if (id === 'update') chrome.runtime.openOptionsPage(); });
chrome.runtime.onMessage.addListener((msg) => { if (msg.type === 'check-update') checkForUpdate(); });
