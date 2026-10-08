import { fetchLatestVersion, isNewer, loadHandle, saveHandle, hasWriteAccess, verifyFolder, applyUpdate, REPO } from './updater.js';

const $ = (id) => document.getElementById(id);
const say = (t, cls = '') => { $('msg').className = cls; $('msg').textContent = t; };
const current = chrome.runtime.getManifest().version;
$('cur').textContent = current;

async function refresh() {
  try {
    const latest = await fetchLatestVersion();
    $('latest').textContent = latest + (isNewer(latest, current) ? '  — есть обновление' : '  — актуальная');
  } catch (e) { $('latest').textContent = 'не удалось проверить'; say(String(e.message || e), 'err'); }
  const h = await loadHandle();
  $('folder').textContent = h ? `${h.name} (${(await hasWriteAccess(h)) ? 'доступ есть' : 'нужно подтвердить доступ'})` : 'не выбрана';
  $('auto').checked = (await chrome.storage.sync.get({ autoUpdate: true })).autoUpdate;
}

$('pick').onclick = async () => {
  try {
    const h = await showDirectoryPicker({ mode: 'readwrite' });
    if (!(await verifyFolder(h))) return say('В этой папке нет manifest.json этого расширения. Выберите папку, из которой оно загружено.', 'err');
    await saveHandle(h);
    say('Папка сохранена.', 'ok');
    refresh();
  } catch (e) { say(String(e.message || e), 'err'); }
};
$('grant').onclick = async () => {
  const h = await loadHandle();
  if (!h) return say('Сначала выберите папку.', 'err');
  await h.requestPermission({ mode: 'readwrite' });
  refresh();
};
$('check').onclick = async () => { say('Проверяю…'); await refresh(); say(''); };
$('apply').onclick = async () => {
  try {
    const h = await loadHandle();
    if (!h) return say('Сначала выберите папку расширения.', 'err');
    if (!(await hasWriteAccess(h))) await h.requestPermission({ mode: 'readwrite' });
    say('Скачиваю и устанавливаю…');
    await applyUpdate(h);
  } catch (e) { say(String(e.message || e), 'err'); }
};
$('auto').onchange = () => chrome.storage.sync.set({ autoUpdate: $('auto').checked });
$('latest').title = `github.com/${REPO}`;
refresh();
