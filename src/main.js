'use strict';
// 主进程：窗口、菜单、文件读取、目录扫描、文件监视、导出
const { app, BrowserWindow, Menu, dialog, ipcMain, shell, nativeTheme, screen, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');
const { pathToFileURL, fileURLToPath } = require('url');
const store = require('./store');
const { renderMarkdown, MD_EXTENSIONS } = require('./markdown');

const APP_NAME = 'QH阅读';
const MAX_RECENT = 15;
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB
const IGNORE_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', '.idea', '.vscode', '$RECYCLE.BIN', 'System Volume Information']);
const EXEC_EXTENSIONS = new Set([
  '.exe', '.com', '.bat', '.cmd', '.msi', '.msp', '.ps1', '.psm1', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh',
  '.scr', '.pif', '.lnk', '.url', '.reg', '.hta', '.cpl', '.jar', '.appref-ms', '.application', '.gadget', '.inf', '.scf',
]);
const IMAGE_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.avif': 'image/avif',
};

let mainWindow = null;
let pendingPath = null; // 启动时通过命令行 / 文件关联传入的路径
let watcher = null;
let watchedFile = null;
let watchTimer = null;
let lastHash = null;
let docDirty = false; // 编辑模式下是否有未保存的修改（由页面同步过来）

app.setAppUserModelId('com.zippos.qhreader');

// ---------- 单实例：再次双击 .md 文件时复用已打开的窗口 ----------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv, workingDirectory) => {
    const p = getPathArg(argv, workingDirectory);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
      if (p) sendToRenderer('app:openPath', describePath(p));
    } else if (p) {
      pendingPath = p;
    }
  });

  app.whenReady().then(() => {
    const theme = store.get().theme;
    nativeTheme.themeSource = ['system', 'light', 'dark'].includes(theme) ? theme : 'system';
    pendingPath = getPathArg(process.argv, process.cwd());
    createWindow();
    buildMenu();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => {
  unwatch();
  store.flush();
});

// ---------- 窗口 ----------
function createWindow() {
  const saved = store.get().window || {};
  const bounds = { width: saved.width || 1200, height: saved.height || 800 };
  if (Number.isFinite(saved.x) && Number.isFinite(saved.y) && isOnScreen(saved)) {
    bounds.x = saved.x;
    bounds.y = saved.y;
  }

  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: APP_NAME,
    backgroundColor: themeColors().color,
    // 标题栏与工具栏合一，只保留系统的最小化 / 最大化 / 关闭按钮
    titleBarStyle: 'hidden',
    titleBarOverlay: themeColors(),
    icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  if (saved.maximized) mainWindow.maximize();
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow && mainWindow.show());

  // 页面内的链接一律不在应用内导航；http(s) 链接交给系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    openExternalSafe(url);
  });

  mainWindow.webContents.on('context-menu', (_event, params) => showContextMenu(params));

  // 有未保存的修改时，关闭窗口前先询问
  mainWindow.on('close', async (event) => {
    if (!docDirty) return;
    event.preventDefault();
    const choice = await askUnsaved();
    if (choice === 'save') {
      sendToRenderer('app:saveThenClose');
    } else if (choice === 'discard') {
      docDirty = false;
      mainWindow.close();
    }
  });

  const saveBounds = debounce(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const prev = store.get().window || {};
    if (mainWindow.isMaximized()) {
      store.set({ window: { ...prev, maximized: true } });
    } else {
      store.set({ window: { ...mainWindow.getBounds(), maximized: false } });
    }
  }, 300);
  ['resize', 'move', 'maximize', 'unmaximize'].forEach((ev) => mainWindow.on(ev, saveBounds));

  mainWindow.on('closed', () => {
    mainWindow = null;
    unwatch();
  });
}

function isOnScreen(b) {
  try {
    return screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return b.x + 60 < a.x + a.width && b.x + (b.width || 200) - 60 > a.x && b.y + 40 < a.y + a.height && b.y >= a.y - 8;
    });
  } catch {
    return false;
  }
}

function sendToRenderer(channel, ...args) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...args);
}

// ---------- 命令行参数（文件关联 / 拖到 exe 上） ----------
function getPathArg(argv, cwd) {
  const args = argv.slice(app.isPackaged ? 1 : 2);
  for (const a of args) {
    if (!a || a.startsWith('-')) continue;
    const p = path.resolve(cwd || process.cwd(), a);
    try {
      const st = fs.statSync(p);
      if (st.isFile() || st.isDirectory()) return p;
    } catch {
      /* 不是路径，忽略 */
    }
  }
  return null;
}

function describePath(p) {
  try {
    const st = fs.statSync(p);
    return { path: p, type: st.isDirectory() ? 'dir' : 'file' };
  } catch {
    return null;
  }
}

function openExternalSafe(url) {
  if (typeof url === 'string' && /^(https?|mailto):/i.test(url)) shell.openExternal(url);
}

// 标题栏按钮区域的颜色，与页面工具栏背景一致
function themeColors() {
  const dark = nativeTheme.shouldUseDarkColors;
  return { color: dark ? '#1e1e1e' : '#ffffff', symbolColor: dark ? '#e5e5ea' : '#3a3a3c', height: 44 };
}

nativeTheme.on('updated', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const colors = themeColors();
  mainWindow.setTitleBarOverlay(colors);
  mainWindow.setBackgroundColor(colors.color);
});

// ---------- 右键菜单 ----------
function showContextMenu(params) {
  const items = [];
  const hasSelection = !!(params.selectionText && params.selectionText.trim());
  if (params.isEditable) {
    items.push(
      { label: '剪切', role: 'cut', enabled: params.editFlags.canCut },
      { label: '复制', role: 'copy', enabled: params.editFlags.canCopy },
      { label: '粘贴', role: 'paste', enabled: params.editFlags.canPaste },
      { type: 'separator' },
      { label: '全选', role: 'selectAll' },
    );
  } else {
    if (hasSelection) items.push({ label: '复制', accelerator: 'CmdOrCtrl+C', role: 'copy' });
    if (params.linkURL && /^(https?|mailto):/i.test(params.linkURL)) {
      items.push({ label: '复制链接地址', click: () => clipboard.writeText(params.linkURL) });
    }
    if (params.mediaType === 'image' && params.srcURL) {
      items.push({ label: '复制图片', click: () => mainWindow && mainWindow.webContents.copyImageAt(params.x, params.y) });
    }
    if (items.length) items.push({ type: 'separator' });
    items.push({ label: '全选', accelerator: 'CmdOrCtrl+A', role: 'selectAll' });
  }
  Menu.buildFromTemplate(items).popup({ window: mainWindow });
}

// ---------- 菜单 ----------
function buildMenu() {
  const settings = store.get();
  const recent = settings.recent || [];
  const theme = settings.theme || 'system';
  const act = (action, arg) => () => sendToRenderer('menu:action', action, arg);

  const recentItems = recent.length
    ? [
        ...recent.map((p, i) => ({ label: `${i + 1}. ${truncateMiddle(p, 70)}`, click: act('open-path', p) })),
        { type: 'separator' },
        {
          label: '清空最近打开',
          click: () => {
            store.set({ recent: [] });
            buildMenu();
            sendToRenderer('recent:changed');
          },
        },
      ]
    : [{ label: '（空）', enabled: false }];

  const template = [
    {
      label: '文件(&F)',
      submenu: [
        { label: '打开文件…', accelerator: 'CmdOrCtrl+O', click: act('open-file') },
        { label: '打开文件夹…', accelerator: 'CmdOrCtrl+Shift+O', click: act('open-folder') },
        { label: '最近打开', submenu: recentItems },
        { type: 'separator' },
        { label: '重新加载', accelerator: 'F5', click: act('reload') },
        { label: '保存', accelerator: 'CmdOrCtrl+S', click: act('save') },
        { label: '在资源管理器中显示', click: act('reveal') },
        { label: '关闭文档', accelerator: 'CmdOrCtrl+W', click: act('close') },
        { type: 'separator' },
        { label: '导出为 HTML…', accelerator: 'CmdOrCtrl+E', click: act('export-html') },
        { label: '导出为 PDF…', accelerator: 'CmdOrCtrl+Shift+E', click: act('export-pdf') },
        { label: '打印…', accelerator: 'CmdOrCtrl+P', click: act('print') },
        { type: 'separator' },
        { label: '退出', accelerator: 'Alt+F4', role: 'quit' },
      ],
    },
    {
      label: '编辑(&E)',
      submenu: [
        { label: '撤销', accelerator: 'CmdOrCtrl+Z', role: 'undo' },
        { label: '重做', accelerator: 'CmdOrCtrl+Y', role: 'redo' },
        { type: 'separator' },
        { label: '剪切', accelerator: 'CmdOrCtrl+X', role: 'cut' },
        { label: '复制', accelerator: 'CmdOrCtrl+C', role: 'copy' },
        { label: '粘贴', accelerator: 'CmdOrCtrl+V', role: 'paste' },
        { label: '全选', accelerator: 'CmdOrCtrl+A', role: 'selectAll' },
      ],
    },
    {
      label: '查看(&V)',
      submenu: [
        { label: '切换 阅读 / 编辑 模式', accelerator: 'CmdOrCtrl+/', click: act('toggle-edit') },
        { type: 'separator' },
        { label: '文件侧栏', accelerator: 'CmdOrCtrl+B', click: act('toggle-sidebar') },
        { label: '大纲面板', accelerator: 'CmdOrCtrl+Shift+B', click: act('toggle-outline') },
        { type: 'separator' },
        { label: '查找…', accelerator: 'CmdOrCtrl+F', click: act('find') },
        { type: 'separator' },
        { label: '放大', accelerator: 'CmdOrCtrl+=', click: act('zoom-in') },
        { label: '缩小', accelerator: 'CmdOrCtrl+-', click: act('zoom-out') },
        { label: '重置缩放', accelerator: 'CmdOrCtrl+0', click: act('zoom-reset') },
        { type: 'separator' },
        {
          label: '主题',
          submenu: [
            { label: '跟随系统', type: 'radio', checked: theme === 'system', click: act('theme', 'system') },
            { label: '浅色', type: 'radio', checked: theme === 'light', click: act('theme', 'light') },
            { label: '深色', type: 'radio', checked: theme === 'dark', click: act('theme', 'dark') },
          ],
        },
        { type: 'separator' },
        { label: '开发者工具', accelerator: 'F12', role: 'toggleDevTools' },
      ],
    },
    {
      label: '导航(&G)',
      submenu: [
        { label: '后退', accelerator: 'Alt+Left', click: act('back') },
        { label: '前进', accelerator: 'Alt+Right', click: act('forward') },
        { type: 'separator' },
        { label: '回到顶部', accelerator: 'CmdOrCtrl+Home', click: act('scroll-top') },
        { label: '跳到底部', accelerator: 'CmdOrCtrl+End', click: act('scroll-bottom') },
      ],
    },
    {
      label: '帮助(&H)',
      submenu: [
        { label: '快捷键', accelerator: 'F1', click: act('shortcuts') },
        { label: '关于', click: showAbout },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function showAbout() {
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: '关于 ' + APP_NAME,
    message: `${APP_NAME} ${app.getVersion()}`,
    detail:
      '一个本地化的 Markdown 文件阅读器。\n\n' +
      '支持：文件夹浏览、大纲导航、代码高亮、明暗主题、文内查找、导出 HTML / PDF、文件改动自动刷新。\n\n' +
      `Electron ${process.versions.electron} · Chromium ${process.versions.chrome} · Node ${process.versions.node}`,
    buttons: ['确定'],
  });
}

// ---------- 文件读取与渲染 ----------
function decodeBuffer(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.toString('utf8', 3), encoding: 'UTF-8 BOM' };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: buf.toString('utf16le', 2), encoding: 'UTF-16 LE' };
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'UTF-8' };
  } catch {
    try {
      return { text: new TextDecoder('gbk').decode(buf), encoding: 'GBK' };
    } catch {
      return { text: buf.toString('utf8'), encoding: 'UTF-8' };
    }
  }
}

const CJK_RE = /[㐀-䶿一-鿿豈-﫿぀-ヿ가-힯]/g;
function countText(text) {
  const cjk = (text.match(CJK_RE) || []).length;
  const words = (text.replace(CJK_RE, ' ').match(/[A-Za-z0-9_À-ɏ'’-]+/g) || []).length;
  const chars = text.replace(/\s/g, '').length;
  return { words: cjk + words, chars, lines: text.split(/\r?\n/).length };
}

function dirToUrl(dir) {
  const withSep = dir.endsWith(path.sep) ? dir : dir + path.sep;
  return pathToFileURL(withSep).href;
}

async function loadDocument(filePath) {
  let st;
  try {
    st = await fsp.stat(filePath);
  } catch {
    return { error: '文件不存在或无法访问：' + filePath };
  }
  if (!st.isFile()) return { error: '不是一个文件：' + filePath };
  if (st.size > MAX_FILE_SIZE) return { error: '文件过大（超过 20MB），暂不支持打开' };

  let buf;
  try {
    buf = await fsp.readFile(filePath);
  } catch (e) {
    return { error: '读取失败：' + e.message };
  }
  const { text, encoding } = decodeBuffer(buf);
  let rendered;
  try {
    rendered = renderMarkdown(text);
  } catch (e) {
    return { error: '渲染失败：' + e.message };
  }
  const dir = path.dirname(filePath);
  return {
    path: filePath,
    name: path.basename(filePath),
    dir,
    baseUrl: dirToUrl(dir),
    html: rendered.html,
    toc: rendered.toc,
    title: rendered.title || path.basename(filePath, path.extname(filePath)),
    encoding,
    hash: crypto.createHash('md5').update(buf).digest('hex'),
    stats: { size: st.size, mtime: st.mtimeMs, ...countText(text) },
  };
}

function addRecent(filePath) {
  const list = (store.get().recent || []).filter((p) => p.toLowerCase() !== filePath.toLowerCase());
  list.unshift(filePath);
  store.set({ recent: list.slice(0, MAX_RECENT) });
  buildMenu();
}

// ---------- 目录扫描 ----------
async function buildTree(dir, depth = 0, budget = { files: 0, dirs: 0 }) {
  const node = { name: path.basename(dir) || dir, path: dir, type: 'dir', children: [] };
  // 防止误开整个磁盘时扫描过久
  if (depth > 12 || budget.files > 8000 || ++budget.dirs > 5000) return node;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return node;
  }
  const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
  entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || collator.compare(a.name, b.name));
  for (const ent of entries) {
    if (ent.name.startsWith('.') || IGNORE_DIRS.has(ent.name)) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      const child = await buildTree(full, depth + 1, budget);
      if (child.children.length) node.children.push(child); // 不显示没有 Markdown 的空目录
    } else if (ent.isFile() && MD_EXTENSIONS.has(path.extname(ent.name).toLowerCase())) {
      budget.files++;
      node.children.push({ name: ent.name, path: full, type: 'file' });
    }
  }
  return node;
}

// ---------- 文件监视：磁盘上改动后自动刷新 ----------
function watchFile(filePath) {
  unwatch();
  watchedFile = filePath;
  const dir = path.dirname(filePath);
  const base = path.basename(filePath).toLowerCase();
  try {
    watcher = fs.watch(dir, { persistent: false }, (_event, filename) => {
      if (filename && String(filename).toLowerCase() !== base) return;
      clearTimeout(watchTimer);
      watchTimer = setTimeout(async () => {
        if (!watchedFile || !mainWindow) return;
        const doc = await loadDocument(watchedFile);
        if (doc.error || doc.hash === lastHash) return;
        lastHash = doc.hash;
        sendToRenderer('file:changed', doc);
      }, 300);
    });
    watcher.on('error', () => unwatch());
  } catch {
    watcher = null;
  }
}

function unwatch() {
  clearTimeout(watchTimer);
  if (watcher) {
    try {
      watcher.close();
    } catch {
      /* ignore */
    }
    watcher = null;
  }
  watchedFile = null;
}

// ---------- IPC ----------
ipcMain.handle('dialog:openFile', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: '打开 Markdown 文件',
    properties: ['openFile'],
    filters: [
      { name: 'Markdown 文件', extensions: ['md', 'markdown', 'mdown', 'mkd', 'txt'] },
      { name: '所有文件', extensions: ['*'] },
    ],
  });
  return res.canceled ? null : res.filePaths[0];
});

ipcMain.handle('dialog:openFolder', async () => {
  const res = await dialog.showOpenDialog(mainWindow, { title: '打开文件夹', properties: ['openDirectory'] });
  return res.canceled ? null : res.filePaths[0];
});

ipcMain.handle('file:open', async (_e, filePath) => {
  if (typeof filePath !== 'string') return { error: '无效路径' };
  const doc = await loadDocument(filePath);
  if (doc.error) return doc;
  lastHash = doc.hash;
  watchFile(filePath);
  addRecent(filePath);
  return doc;
});

ipcMain.handle('file:close', () => unwatch());

// ---------- 编辑模式 ----------
ipcMain.handle('file:source', async (_e, filePath) => {
  if (typeof filePath !== 'string') return { error: '无效路径' };
  try {
    const st = await fsp.stat(filePath);
    if (st.size > MAX_FILE_SIZE) return { error: '文件过大（超过 20MB），暂不支持编辑' };
    const { text, encoding } = decodeBuffer(await fsp.readFile(filePath));
    return { text, encoding, eol: text.includes('\r\n') ? '\r\n' : '\n' };
  } catch (e) {
    return { error: '读取失败：' + e.message };
  }
});

// 只允许保存当前打开的文档；尽量保持原编码与换行符（GBK 无法直接写回，转存为 UTF-8）
ipcMain.handle('file:save', async (_e, filePath, text, meta) => {
  if (typeof filePath !== 'string' || typeof text !== 'string') return { ok: false, error: '无效参数' };
  if (!watchedFile || watchedFile.toLowerCase() !== filePath.toLowerCase()) return { ok: false, error: '只能保存当前打开的文档' };
  const eol = meta && meta.eol === '\r\n' ? '\r\n' : '\n';
  const out = text.replace(/\r?\n/g, eol);
  let encoding = (meta && meta.encoding) || 'UTF-8';
  let buf;
  if (encoding === 'UTF-8 BOM') buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(out, 'utf8')]);
  else if (encoding === 'UTF-16 LE') buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(out, 'utf16le')]);
  else buf = Buffer.from(out, 'utf8');
  const converted = encoding === 'GBK';
  if (converted) encoding = 'UTF-8';
  try {
    lastHash = crypto.createHash('md5').update(buf).digest('hex'); // 避免自己的保存触发“外部修改”
    await fsp.writeFile(filePath, buf);
    return { ok: true, encoding, converted, size: buf.length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('md:render', (_e, text) => {
  if (typeof text !== 'string') return { html: '', toc: [], title: '', stats: countText('') };
  try {
    return { ...renderMarkdown(text), stats: countText(text) };
  } catch (e) {
    return { html: `<pre>${escapeHtml('渲染失败：' + e.message)}</pre>`, toc: [], title: '', stats: countText(text) };
  }
});

ipcMain.on('doc:dirty', (_e, dirty) => {
  docDirty = !!dirty;
});
ipcMain.handle('dialog:unsaved', (_e, name) => askUnsaved(name));
ipcMain.handle('window:close', () => {
  docDirty = false;
  if (mainWindow) mainWindow.close();
});

async function askUnsaved(name) {
  const res = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: APP_NAME,
    message: name ? `是否保存对“${name}”的修改？` : '是否保存修改？',
    detail: '如果不保存，你的修改将会丢失。',
    buttons: ['保存', '不保存', '取消'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  });
  return ['save', 'discard', 'cancel'][res.response] || 'cancel';
}

ipcMain.handle('dir:tree', async (_e, dir) => {
  if (typeof dir !== 'string') return { error: '无效路径' };
  try {
    const st = await fsp.stat(dir);
    if (!st.isDirectory()) return { error: '不是文件夹：' + dir };
  } catch {
    return { error: '文件夹不存在：' + dir };
  }
  const tree = await buildTree(dir);
  return { tree, baseUrl: dirToUrl(dir) };
});

ipcMain.handle('path:stat', async (_e, p) => {
  if (typeof p !== 'string') return { type: null };
  try {
    const st = await fsp.stat(p);
    return {
      type: st.isDirectory() ? 'dir' : st.isFile() ? 'file' : null,
      isMarkdown: MD_EXTENSIONS.has(path.extname(p).toLowerCase()),
    };
  } catch {
    return { type: null };
  }
});

ipcMain.handle('path:resolve', (_e, base, rel) => path.resolve(String(base), String(rel)));

ipcMain.handle('recent:get', () => store.get().recent || []);
ipcMain.handle('recent:remove', (_e, p) => {
  store.set({ recent: (store.get().recent || []).filter((x) => x !== p) });
  buildMenu();
  return store.get().recent;
});
ipcMain.handle('recent:clear', () => {
  store.set({ recent: [] });
  buildMenu();
  return [];
});

ipcMain.handle('settings:get', () => store.get());
ipcMain.handle('settings:set', (_e, patch) => {
  if (patch && typeof patch === 'object') store.set(patch);
  return store.get();
});

ipcMain.handle('theme:set', (_e, theme) => {
  if (!['system', 'light', 'dark'].includes(theme)) return;
  nativeTheme.themeSource = theme;
  store.set({ theme });
  buildMenu();
});

ipcMain.handle('shell:openExternal', (_e, url) => openExternalSafe(url));
ipcMain.handle('clipboard:writeText', (_e, text) => {
  if (typeof text !== 'string') return false;
  clipboard.writeText(text);
  return true;
});
ipcMain.handle('shell:showItemInFolder', (_e, p) => {
  if (typeof p === 'string') shell.showItemInFolder(p);
});
// 文档里链接到的非 Markdown 文件：可执行类文件只在资源管理器中定位，不直接运行
ipcMain.handle('shell:openPath', (_e, p) => {
  if (typeof p !== 'string') return '';
  if (EXEC_EXTENSIONS.has(path.extname(p).toLowerCase())) {
    shell.showItemInFolder(p);
    return '';
  }
  return shell.openPath(p);
});

ipcMain.handle('app:initialPath', () => {
  const p = pendingPath;
  pendingPath = null;
  return p ? describePath(p) : null;
});

ipcMain.handle('export:html', async (_e, payload) => {
  if (!payload || typeof payload.html !== 'string') return { ok: false };
  const res = await dialog.showSaveDialog(mainWindow, {
    title: '导出为 HTML',
    defaultPath: (payload.name || 'document') + '.html',
    filters: [{ name: 'HTML 文件', extensions: ['html'] }],
  });
  if (res.canceled || !res.filePath) return { ok: false };
  try {
    const css = fs.readFileSync(path.join(__dirname, 'content.css'), 'utf8');
    const title = escapeHtml(payload.title || payload.name || 'Markdown');
    const body = typeof payload.dir === 'string' ? await inlineImages(payload.html, payload.dir) : payload.html;
    const page =
      '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="UTF-8">\n' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
      `<title>${title}</title>\n<style>\n${css}\n` +
      'body{margin:0;padding:40px 24px;background:#fff}@media screen and (prefers-color-scheme:dark){body{background:#0d1117}}' +
      '.markdown-body{max-width:900px;margin:0 auto}\n</style>\n</head>\n<body>\n' +
      `<article class="markdown-body">\n${body}\n</article>\n</body>\n</html>\n`;
    await fsp.writeFile(res.filePath, page, 'utf8');
    return { ok: true, path: res.filePath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('export:pdf', async (_e, name) => {
  const res = await dialog.showSaveDialog(mainWindow, {
    title: '导出为 PDF',
    defaultPath: (name || 'document') + '.pdf',
    filters: [{ name: 'PDF 文件', extensions: ['pdf'] }],
  });
  if (res.canceled || !res.filePath) return { ok: false };
  try {
    const data = await mainWindow.webContents.printToPDF({ printBackground: true, pageSize: 'A4' });
    await fsp.writeFile(res.filePath, data);
    return { ok: true, path: res.filePath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// 工具栏上的“菜单”按钮：弹出完整的应用菜单（标题栏隐藏后菜单栏不再显示）
ipcMain.handle('menu:popup', (_e, x, y) => {
  const menu = Menu.getApplicationMenu();
  if (menu && mainWindow) menu.popup({ window: mainWindow, x: Math.round(Number(x) || 0), y: Math.round(Number(y) || 0) });
});

ipcMain.handle('print', () => {
  if (mainWindow) mainWindow.webContents.print({ printBackground: true }, () => {});
});

// ---------- 工具函数 ----------
// 导出 HTML 时把本地图片内嵌为 data URI，导出的文件放到哪里都能正常显示
async function inlineImages(html, dir) {
  const re = /(<img\b[^>]*?\bsrc\s*=\s*)(["'])(.*?)\2/gi;
  const jobs = [];
  html.replace(re, (m, pre, q, src) => {
    jobs.push(src);
    return m;
  });
  const cache = new Map();
  for (const src of new Set(jobs)) {
    const file = localImagePath(src, dir);
    const mime = file && IMAGE_MIME[path.extname(file).toLowerCase()];
    if (!mime) continue;
    try {
      const st = await fsp.stat(file);
      if (!st.isFile() || st.size > 10 * 1024 * 1024) continue;
      cache.set(src, `data:${mime};base64,${(await fsp.readFile(file)).toString('base64')}`);
    } catch {
      /* 图片不存在，保留原路径 */
    }
  }
  return html.replace(re, (m, pre, q, src) => (cache.has(src) ? `${pre}${q}${cache.get(src)}${q}` : m));
}

function localImagePath(src, dir) {
  const v = src.replace(/&amp;/g, '&').trim();
  if (!v || v.startsWith('#')) return null;
  try {
    if (/^file:/i.test(v)) return fileURLToPath(v);
    if (/^[a-zA-Z]:[\\/]/.test(v) || v.startsWith('\\\\')) return v;
    if (/^[a-zA-Z][\w+.-]*:/.test(v)) return null; // http(s)、data 等保持不变
    return path.resolve(dir, decodeURIComponent(v.split(/[?#]/)[0]));
  } catch {
    return null;
  }
}

function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function truncateMiddle(s, max) {
  if (s.length <= max) return s;
  const half = Math.floor((max - 1) / 2);
  return s.slice(0, half) + '…' + s.slice(s.length - half);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
