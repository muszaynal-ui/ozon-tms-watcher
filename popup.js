import { fetchLatestVersion, isNewer, loadHandle, hasWriteAccess, applyUpdate } from './updater.js';

const $ = (id) => document.getElementById(id);
const status = (t) => { $('status').textContent = t; setTimeout(() => ($('status').textContent = ''), 3500); };
const openUpdate = () => chrome.tabs.create({ url: chrome.runtime.getURL('update.html') });

async function render() {
  const [{ enabled = false }, st] = await Promise.all([chrome.storage.sync.get('enabled'), chrome.storage.local.get(
    ['lastCheck', 'lastTotal', 'lastMatched', 'lastEvents', 'modeUsed', 'apiError', 'lastSend'])]);
  $('enabled').checked = enabled;
  const t = st.lastCheck ? new Date(st.lastCheck).toLocaleTimeString('ru-RU') : '—';
  const send = st.lastSend ? (st.lastSend.errors.length ? `<span class="err">ошибка отправки: ${st.lastSend.errors[0]}</span>` : `<span class="ok">отправлено: ${st.lastSend.ok}</span>`) : '—';
  $('state').innerHTML = `Последняя проверка: <b>${t}</b><br>Рейсов просмотрено: <b>${st.lastTotal ?? '—'}</b>, подходят: <b>${st.lastMatched ?? '—'}</b><br>Режим: <b>${st.modeUsed || '—'}</b>`
    + (st.apiError ? `<br><span class="err">API: ${st.apiError}</span>` : '') + `<br>Рассылка: ${send}`;
}

$('enabled').onchange = async () => {
  await chrome.storage.sync.set({ enabled: $('enabled').checked });
  await chrome.storage.local.set({ known: {}, baselined: false });
  status('Обновите вкладку tms.ozon.ru');
};
$('settings').onclick = () => chrome.runtime.openOptionsPage();
$('reset').onclick = async () => { await chrome.storage.local.set({ known: {}, baselined: false }); status('Сброшено'); };
render();

$('diag').onclick = async (e) => {
  e.preventDefault();
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
    if (!h) { status('Сначала выберите папку расширения'); return openUpdate(); }
    if (!(await hasWriteAccess(h))) await h.requestPermission({ mode: 'readwrite' });
    if (!(await hasWriteAccess(h))) { status('Нужен доступ к папке'); return openUpdate(); }
    $('updInfo').textContent = 'устанавливаю…';
    await applyUpdate(h);
  } catch (e) { $('updInfo').textContent = 'ошибка: ' + (e.message || e); }
};
checkUpdate();

$('ver').textContent = chrome.runtime.getManifest().version;
$('upd').onclick = (e) => { e.preventDefault(); openUpdate(); };

$('hist').onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('history.html') });

// Режим записи: пишем запросы сайта и клики, пока пользователь проходит бронирование
async function recLabel() {
  const { recording } = await chrome.storage.local.get('recording');
  $('rec').textContent = recording ? '■ Остановить запись и сохранить файл' : '● Записать бронирование (для разработчика)';
}
$('rec').onclick = async () => {
  const { recording } = await chrome.storage.local.get('recording');
  if (!recording) {
    await chrome.storage.local.set({ recording: true, recLog: [], uiLog: [] });
    status('Запись идёт. Откройте рейс на сайте и пройдите бронирование, затем нажмите «Остановить».');
  } else {
    await chrome.storage.local.set({ recording: false });
    const data = await chrome.storage.local.get(['recLog', 'uiLog']);
    const blob = new Blob([JSON.stringify({ collectedAt: new Date().toISOString(), version: chrome.runtime.getManifest().version, ...data }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'tms-recording.json';
    a.click();
    status('Файл tms-recording.json сохранён в Загрузки');
  }
  recLabel();
};
recLabel();
