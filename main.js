'use strict';
/* ═══════════════════════════════════════════════════════════════
   QUANTIC STUDIO CANVA — processo principal (Electron)
   Segurança:
   • renderer isolado (contextIsolation + sandbox, sem Node)
   • rede só pelo processo principal, com lista de hosts permitidos
   • chaves de API cifradas com o cofre do Windows (safeStorage/DPAPI)
   • navegação travada, links externos abrem no navegador padrão
   • atualização automática assinada pelo GitHub Releases
   ═══════════════════════════════════════════════════════════════ */
const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, net, session, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');

let autoUpdater = null;
try { autoUpdater = require('electron-updater').autoUpdater; } catch (e) { /* dev sem dependência */ }

const APP_NAME = 'Quantic Studio Canva';
app.setName(APP_NAME);
if (process.platform === 'win32') app.setAppUserModelId('studio.quantic.canva');

// Hosts que podem receber a chave de API (Authorization) e POST
const API_HOSTS = new Set(['api.atlascloud.ai', 'api.apiverse.ai']);
const MAX_RESPONSE_BYTES = 600 * 1024 * 1024; // 600 MB

/* ────────────── arquivos de configuração ────────────── */
const userDir = () => app.getPath('userData');
const settingsFile = () => path.join(userDir(), 'settings.json');
const keysFile = () => path.join(userDir(), 'keys.dat.json');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}
function writeJsonAtomic(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}
let settings = {};
function saveSettings() { try { writeJsonAtomic(settingsFile(), settings); } catch (e) { console.error('settings', e); } }

/* ────────────── chaves (cofre do Windows) ────────────── */
let keyCache = {};
function loadKeys() {
  const raw = readJson(keysFile(), {});
  keyCache = {};
  for (const [p, v] of Object.entries(raw)) {
    try {
      keyCache[p] = safeStorage.isEncryptionAvailable() && v.enc
        ? safeStorage.decryptString(Buffer.from(v.enc, 'base64'))
        : (v.plain || '');
    } catch (e) { keyCache[p] = ''; }
  }
}
function storeKey(provider, value) {
  if (!['atlas', 'apiverse'].includes(provider)) return;
  keyCache[provider] = String(value || '').trim().slice(0, 500);
  const out = {};
  for (const [p, v] of Object.entries(keyCache)) {
    if (!v) continue;
    out[p] = safeStorage.isEncryptionAvailable()
      ? { enc: safeStorage.encryptString(v).toString('base64') }
      : { plain: v };
  }
  try { writeJsonAtomic(keysFile(), out); } catch (e) { console.error('keys', e); }
}

/* ────────────── pasta de saída ────────────── */
function defaultFolder() {
  const dir = path.join(app.getPath('videos'), APP_NAME);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  return dir;
}
function outFolder() {
  const f = settings.folder;
  if (f && fs.existsSync(f)) return f;
  return defaultFolder();
}
// Nome de arquivo seguro: sem caminho, sem caracteres reservados do Windows
function safeName(name) {
  let n = path.basename(String(name || 'arquivo')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^\.+/, '').slice(0, 180);
  if (!n) n = 'arquivo';
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(n)) n = '_' + n;
  return n;
}
function uniquePath(dir, name) {
  let p = path.join(dir, name);
  if (!fs.existsSync(p)) return p;
  const ext = path.extname(name), base = name.slice(0, name.length - ext.length);
  for (let i = 2; i < 1000; i++) { p = path.join(dir, `${base} (${i})${ext}`); if (!fs.existsSync(p)) return p; }
  return path.join(dir, `${base}-${Date.now()}${ext}`);
}

/* ────────────── HTTP pelo processo principal ────────────── */
function checkUrl(u, method, headers) {
  let url;
  try { url = new URL(u); } catch (e) { throw new Error('URL inválida'); }
  if (url.protocol !== 'https:') throw new Error('apenas HTTPS é permitido');
  const hasAuth = Object.keys(headers || {}).some(h => h.toLowerCase() === 'authorization');
  const isApi = API_HOSTS.has(url.hostname);
  if ((hasAuth || method !== 'GET') && !isApi) throw new Error('host não autorizado: ' + url.hostname);
  return url;
}
function buildBody(b) {
  if (!b) return undefined;
  if (b.kind === 'text') return b.text;
  if (b.kind === 'bytes') return Buffer.from(b.bytes);
  if (b.kind === 'form') {
    const fd = new FormData();
    for (const p of b.parts || []) {
      if (p.bytes) fd.append(p.name, new Blob([Buffer.from(p.bytes)], { type: p.type }), safeName(p.filename));
      else fd.append(p.name, String(p.value));
    }
    return fd;
  }
  return undefined;
}
async function httpRequest(req) {
  const method = String(req.method || 'GET').toUpperCase();
  const headers = Object.assign({}, req.headers || {});
  checkUrl(req.url, method, headers);
  const body = buildBody(req.body);
  if (body instanceof FormData) {
    for (const k of Object.keys(headers)) if (k.toLowerCase() === 'content-type') delete headers[k];
  }
  const ctrl = new AbortController();
  const timeout = Math.min(Math.max(+req.timeoutMs || 30000, 1000), 15 * 60 * 1000);
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await net.fetch(req.url, { method, headers, body, signal: ctrl.signal, redirect: 'follow' });
    const len = +(r.headers.get('content-length') || 0);
    if (len > MAX_RESPONSE_BYTES) throw new Error('resposta grande demais');
    const buf = Buffer.from(await r.arrayBuffer());
    const h = {};
    r.headers.forEach((v, k) => { h[k] = v; });
    return { status: r.status, headers: h, bytes: new Uint8Array(buf) };
  } catch (e) {
    if (e.name === 'AbortError') return { error: 'tempo esgotado (' + Math.round(timeout / 1000) + 's) — sem resposta do servidor' };
    return { error: e.message || String(e) };
  } finally { clearTimeout(t); }
}
async function downloadTo(url, name) {
  checkUrl(url, 'GET', {});
  const dir = outFolder();
  const dest = uniquePath(dir, safeName(name));
  const tmp = dest + '.part';
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10 * 60 * 1000);
  try {
    const r = await net.fetch(url, { signal: ctrl.signal });
    if (!r.ok || !r.body) throw new Error('download falhou (HTTP ' + r.status + ')');
    await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(tmp));
    fs.renameSync(tmp, dest);
    return { path: dest };
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    return { error: e.name === 'AbortError' ? 'download demorou demais' : (e.message || String(e)) };
  } finally { clearTimeout(t); }
}

/* ────────────── IPC ────────────── */
function fromApp(ev) {
  // só aceita mensagens da página local do app
  const u = ev.senderFrame && ev.senderFrame.url;
  return typeof u === 'string' && u.startsWith('file://');
}
function registerIpc() {
  ipcMain.on('keys:getSync', (ev, p) => { ev.returnValue = fromApp(ev) ? (keyCache[p] || '') : ''; });
  ipcMain.on('app:versionSync', ev => { ev.returnValue = app.getVersion(); });
  ipcMain.handle('keys:set', (ev, p, v) => { if (fromApp(ev)) storeKey(p, v); return true; });
  ipcMain.handle('http', (ev, req) => fromApp(ev) ? httpRequest(req).catch(e => ({ error: e.message })) : { error: 'negado' });
  ipcMain.handle('fs:getFolder', ev => {
    if (!fromApp(ev)) return null;
    const f = outFolder();
    return { path: f, name: path.basename(f) };
  });
  ipcMain.handle('fs:pickFolder', async ev => {
    if (!fromApp(ev)) return null;
    const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(ev.sender), {
      title: 'Pasta para salvar os vídeos', defaultPath: outFolder(), properties: ['openDirectory', 'createDirectory']
    });
    if (r.canceled || !r.filePaths[0]) return null;
    settings.folder = r.filePaths[0]; saveSettings();
    return { path: settings.folder, name: path.basename(settings.folder) };
  });
  ipcMain.handle('fs:write', (ev, name, bytes) => {
    if (!fromApp(ev)) return { error: 'negado' };
    try {
      const dest = uniquePath(outFolder(), safeName(name));
      fs.writeFileSync(dest, Buffer.from(bytes));
      return { path: dest };
    } catch (e) { return { error: e.message }; }
  });
  ipcMain.handle('fs:download', (ev, url, name) => fromApp(ev) ? downloadTo(url, name) : { error: 'negado' });
  ipcMain.handle('fs:openFolder', ev => { if (fromApp(ev)) shell.openPath(outFolder()); return true; });
  ipcMain.handle('update:install', ev => {
    if (fromApp(ev) && autoUpdater) setImmediate(() => autoUpdater.quitAndInstall(false, true));
    return true;
  });
}

/* ────────────── janela ────────────── */
let win = null;
function createWindow() {
  const b = settings.bounds || {};
  win = new BrowserWindow({
    width: b.width || 1600, height: b.height || 940, x: b.x, y: b.y,
    minWidth: 1100, minHeight: 680,
    backgroundColor: '#07060d', title: APP_NAME, show: false,
    icon: path.join(__dirname, 'build', 'icon.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, sandbox: true, nodeIntegration: false,
      webSecurity: true, spellcheck: false, devTools: !app.isPackaged || process.env.QSC_DEVTOOLS === '1'
    }
  });
  if (settings.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());

  const wc = win.webContents;
  // trava de navegação: nada sai da página local
  wc.on('will-navigate', (e, url) => { if (!url.startsWith('file://')) { e.preventDefault(); openExternal(url); } });
  wc.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
  wc.on('will-attach-webview', e => e.preventDefault());
  // "Sair com geração em andamento?" — o beforeunload da página chega aqui
  wc.on('will-prevent-unload', e => {
    const c = dialog.showMessageBoxSync(win, {
      type: 'warning', buttons: ['Sair mesmo assim', 'Continuar no app'], defaultId: 1, cancelId: 1,
      title: APP_NAME, message: 'Há vídeos sendo gerados.',
      detail: 'Se sair agora, a geração continua na nuvem e o app retoma o resultado na próxima abertura.'
    });
    if (c === 0) e.preventDefault();
  });
  wc.on('render-process-gone', (_e, d) => {
    if (d.reason === 'clean-exit') return;
    const c = dialog.showMessageBoxSync(win, { type: 'error', buttons: ['Recarregar', 'Fechar'], message: 'A tela do app travou (' + d.reason + ').', detail: 'Seu projeto foi salvo automaticamente.' });
    if (c === 0) wc.reload(); else app.quit();
  });

  const persistBounds = () => {
    if (!win || win.isDestroyed()) return;
    settings.maximized = win.isMaximized();
    if (!settings.maximized && !win.isMinimized()) settings.bounds = win.getBounds();
    saveSettings();
  };
  win.on('close', persistBounds);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}
function openExternal(url) {
  try { const u = new URL(url); if (u.protocol === 'https:' || u.protocol === 'http:') shell.openExternal(url); } catch (e) {}
}

/* ────────────── atualizações ────────────── */
function setupUpdates() {
  if (!autoUpdater || !app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  const send = m => { if (win && !win.isDestroyed()) win.webContents.send('update', m); };
  autoUpdater.on('update-available', i => send({ type: 'available', version: i.version }));
  autoUpdater.on('update-downloaded', i => send({ type: 'ready', version: i.version }));
  autoUpdater.on('error', e => send({ type: 'error', message: String(e && e.message || e) }));
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 8000);
  setInterval(check, 4 * 60 * 60 * 1000);
}

/* ────────────── ciclo de vida ────────────── */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(() => {
    settings = readJson(settingsFile(), {});
    loadKeys();
    registerIpc();
    Menu.setApplicationMenu(null);
    // nega permissões que o app não usa (câmera, microfone, localização…)
    session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(['clipboard-sanitized-write', 'clipboard-read', 'fullscreen'].includes(perm)));
    createWindow();
    setupUpdates();
  });
  app.on('window-all-closed', () => app.quit());
}
