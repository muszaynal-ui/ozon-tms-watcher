import { fetchLatestVersion, isNewer, loadHandle, hasWriteAccess, applyUpdate } from './updater.js';
const DEFAULTS = {
  enabled: false, intervalSec: 30, loadWaitSec: 4,
  rowSelector: 'tr[data-testid^="table-row__cargoes_"]', rules: '', exclude: '', minPrice: 0,
  nextSelector: '', maxPages: 10, pageWaitSec: 2, mode: 'api'
};
const ids = Object.keys(DEFAULTS);
const $ = (id) => document.getElementById(id);
const status = (t) => { $('status').textContent = t; setTimeout(() => ($('status').textContent = ''), 2500); };

chrome.storage.sync.get(DEFAULTS).then((cfg) => {
  ids.forEach((k) => (typeof DEFAULTS[k] === 'boolean' ? ($(k).checked = cfg[k]) : ($(k).value = cfg[k])));
});

$('save').onclick = async () => {
  const cfg = {};
  ids.forEach((k) => {
    const el = $(k);
    cfg[k] = typeof DEFAULTS[k] === 'boolean' ? el.checked
      : typeof DEFAULTS[k] === 'number' ? Number(el.value) : el.value;
  });
  await chrome.storage.sync.set(cfg);
  await chrome.storage.local.set({ baselined: false, seen: [] }); // новые критерии — новая точка отсчёта
  status('Сохранено. Обновите вкладку tms.ozon.ru.');
};

$('reset').onclick = async () => {
  await chrome.storage.local.set({ baselined: false, seen: [] });
  status('Список сброшен');
};

$('diag').onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https:\/\/tms\.ozon\.ru\//.test(tab.url || '')) return status('Откройте вкладку tms.ozon.ru со списком рейсов');
  status('Собираю (около 10–15 сек)…');
  chrome.tabs.sendMessage(tab.id, { type: 'diagnose' }, (data) => {
    if (chrome.runtime.lastError || !data) return status('Нет ответа: обновите вкладку (F5) и повторите');
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'tms-diagnostics.json';
    a.click();
    status('Файл tms-diagnostics.json сохранён в Загрузки');
  });
};

$('ver').textContent = chrome.runtime.getManifest().version;
$('upd').onclick = (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); };

const current = chrome.runtime.getManifest().version;
async function checkUpdate() {
  $('updInfo').textContent = 'проверяю…';
  try {
    const latest = await fetchLatestVersion();
    const newer = isNewer(latest, current);
    $('updInfo').textContent = newer ? `доступна ${latest} (у вас ${current})` : `актуальная (на GitHub ${latest})`;
    $('doUpd').disabled = !newer;
    chrome.action.setBadgeText({ text: newer ? '↑' : '' });
  } catch (e) { $('updInfo').textContent = 'ошибка: ' + (e.message || e); }
}
$('chk').onclick = checkUpdate;
$('doUpd').onclick = async () => {
  try {
    const h = await loadHandle();
    if (!h) { status('Сначала выберите папку расширения'); return chrome.runtime.openOptionsPage(); }
    if (!(await hasWriteAccess(h))) await h.requestPermission({ mode: 'readwrite' });
    if (!(await hasWriteAccess(h))) { status('Нужен доступ к папке'); return chrome.runtime.openOptionsPage(); }
    $('updInfo').textContent = 'устанавливаю…';
    await applyUpdate(h);
  } catch (e) { $('updInfo').textContent = 'ошибка: ' + (e.message || e); }
};
checkUpdate();
