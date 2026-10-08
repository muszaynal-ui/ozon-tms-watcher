// Автообновление из GitHub. Chrome не обновляет «распакованные» расширения сам, поэтому:
// 1) раз в час сверяем version в manifest.json на GitHub;
// 2) если папка расширения уже выбрана (и доступ выдан) — перезаписываем файлы и перезагружаем расширение;
// 3) иначе показываем значок «↑» и уведомление, обновление запускается кнопкой на странице «Обновления».
export const REPO = 'muszaynal-ui/ozon-tms-watcher';
export const BRANCH = 'main';
const RAW = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/`;

const idb = () => new Promise((res, rej) => {
  const r = indexedDB.open('updater', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('kv');
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
export async function saveHandle(h) {
  const db = await idb();
  await new Promise((res, rej) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(h, 'dir'); t.oncomplete = res; t.onerror = () => rej(t.error); });
}
export async function loadHandle() {
  const db = await idb();
  return new Promise((res, rej) => { const q = db.transaction('kv').objectStore('kv').get('dir'); q.onsuccess = () => res(q.result || null); q.onerror = () => rej(q.error); });
}

export const isNewer = (a, b) => {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0); }
  return false;
};

// Читаем версию двумя способами (raw-CDN бывает с задержкой, API — без кэша) и берём бо́льшую
export async function fetchLatestVersion() {
  const t = Date.now();
  const sources = [
    async () => (await (await fetch(`${RAW}manifest.json?t=${t}`, { cache: 'no-store' })).json()).version,
    async () => (await (await fetch(`https://api.github.com/repos/${REPO}/contents/manifest.json?ref=${BRANCH}&t=${t}`,
      { cache: 'no-store', headers: { Accept: 'application/vnd.github.raw+json' } })).json()).version
  ];
  const found = [];
  const errors = [];
  for (const s of sources) {
    try { const v = await s(); if (/^\d+\.\d+\.\d+$/.test(v)) found.push(v); } catch (e) { errors.push(String(e.message || e)); }
  }
  if (!found.length) throw new Error('GitHub недоступен: ' + errors.join('; '));
  return found.reduce((a, b) => (isNewer(b, a) ? b : a));
}

export async function hasWriteAccess(handle) {
  return !!handle && (await handle.queryPermission({ mode: 'readwrite' })) === 'granted';
}

// Проверяет, что выбранная папка — это именно это расширение
export async function verifyFolder(handle) {
  try {
    const f = await (await handle.getFileHandle('manifest.json')).getFile();
    return JSON.parse(await f.text()).name === chrome.runtime.getManifest().name;
  } catch (e) { return false; }
}

async function writeFile(root, path, data) {
  const parts = path.split('/');
  let dir = root;
  for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
  const w = await (await dir.getFileHandle(parts.at(-1), { create: true })).createWritable();
  await w.write(data);
  await w.close();
}

export async function applyUpdate(handle) {
  if (!(await hasWriteAccess(handle))) throw new Error('Нет доступа к папке — выберите её на странице «Обновления»');
  if (!(await verifyFolder(handle))) throw new Error('Выбрана не та папка (не найден manifest.json этого расширения)');

  const tree = await (await fetch(`https://api.github.com/repos/${REPO}/git/trees/${BRANCH}?recursive=1`, { cache: 'no-store' })).json();
  const files = (tree.tree || []).filter((n) => n.type === 'blob' && !n.path.startsWith('.') && !/^README/i.test(n.path));
  if (!files.length) throw new Error('Не удалось получить список файлов с GitHub');

  // сначала скачиваем всё, и только потом пишем — чтобы не оставить половину файлов при обрыве
  const blobs = [];
  for (const f of files) {
    const r = await fetch(`${RAW}${f.path}?t=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) throw new Error(`Не скачался ${f.path}: ${r.status}`);
    blobs.push([f.path, await r.arrayBuffer()]);
  }
  blobs.sort((a) => (a[0] === 'manifest.json' ? 1 : -1)); // manifest — последним
  for (const [p, data] of blobs) await writeFile(handle, p, data);
  chrome.runtime.reload();
}
