'use strict';
// 渲染进程：文档显示、文件树、大纲、查找、导航历史、拖放、导出
(() => {
  const api = window.api;
  const $ = (sel) => document.querySelector(sel);

  const els = {
    body: document.body,
    content: $('#mdr-content'),
    scroller: $('#mdr-scroller'),
    sidebar: $('#mdr-sidebar'),
    resizer: $('#mdr-sidebar-resizer'),
    folderName: $('#mdr-folder-name'),
    tree: $('#mdr-tree'),
    treeEmpty: $('#mdr-tree-empty'),
    treeFilter: $('#mdr-tree-filter'),
    toc: $('#mdr-toc'),
    tocEmpty: $('#mdr-toc-empty'),
    docTitle: $('#mdr-doc-title'),
    btnBack: $('#mdr-btn-back'),
    btnForward: $('#mdr-btn-forward'),
    btnZoom: $('#mdr-btn-zoom'),
    btnTheme: $('#mdr-btn-theme'),
    findBar: $('#mdr-find-bar'),
    findInput: $('#mdr-find-input'),
    findCount: $('#mdr-find-count'),
    recentList: $('#mdr-recent-list'),
    dropOverlay: $('#mdr-drop-overlay'),
    selCopy: $('#mdr-sel-copy'),
    contentWrap: $('#mdr-content-wrap'),
    editor: $('#mdr-editor'),
    editorPane: $('#mdr-editor-pane'),
    mdHelp: $('#mdr-md-help'),
    mdHelpToggle: $('#mdr-md-help-toggle'),
    mdHelpBody: $('#mdr-md-help-body'),
    mdHelpGrid: $('#mdr-md-help-grid'),
    btnSave: $('#mdr-btn-save'),
    segRead: $('#mdr-seg-read'),
    segEdit: $('#mdr-seg-edit'),
    modal: $('#mdr-modal'),
    toast: $('#mdr-toast'),
    stPath: $('#mdr-st-path'),
    stEncoding: $('#mdr-st-encoding'),
    stWords: $('#mdr-st-words'),
    stLines: $('#mdr-st-lines'),
    stTime: $('#mdr-st-time'),
    stSize: $('#mdr-st-size'),
  };

  const APP_NAME = 'QH阅读';
  const THEMES = ['system', 'light', 'dark'];
  const THEME_LABEL = { system: '跟随系统', light: '浅色', dark: '深色' };
  const ZOOM_MIN = 0.5;
  const ZOOM_MAX = 2.5;
  const MAX_FIND_HITS = 5000;

  const state = {
    settings: {},
    doc: null, // 当前文档（主进程 loadDocument 的返回值）
    folder: null, // { root, tree, files }
    expanded: new Set(), // 文件树中展开的目录（小写路径）
    history: [], // [{ path, scrollTop }]
    historyIndex: -1,
    headings: [], // [{ el, link }]
    find: { hits: [], index: -1 },
    edit: { on: false, dirty: false, saved: '', meta: null }, // 编辑模式：saved 为最后一次保存的源码
  };

  // ---------- 工具函数 ----------
  const lower = (p) => String(p).toLowerCase();
  const samePath = (a, b) => !!a && !!b && lower(a) === lower(b);
  const baseName = (p) => String(p).split(/[\\/]/).pop();
  const dirName = (p) => {
    const s = String(p).replace(/[\\/]+$/, '');
    const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
    return i > 0 ? s.slice(0, i) : s;
  };
  const stripExt = (name) => name.replace(/\.[^.]+$/, '');

  function isUnder(file, root) {
    const r = lower(root).replace(/[\\/]+$/, '');
    const f = lower(file);
    return f.startsWith(r + '\\') || f.startsWith(r + '/');
  }

  function slugify(text) {
    return String(text)
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '')
      .replace(/\s+/g, '-');
  }

  function formatSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  function debounce(fn, ms) {
    let t = null;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  let toastTimer = null;
  function toast(msg, isError = false, ms = 2400) {
    els.toast.textContent = msg;
    els.toast.className = isError ? 'error' : '';
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (els.toast.hidden = true), isError ? Math.max(ms, 4000) : ms);
  }

  const ICONS = {
    twisty: '<svg class="twisty" viewBox="0 0 16 16"><path d="m6 4 4 4-4 4"/></svg>',
    folder: '<svg class="ficon" viewBox="0 0 16 16"><path d="M1.5 4a1 1 0 0 1 1-1h3.5l1.5 1.5h6a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z"/></svg>',
    file: '<svg class="ficon" viewBox="0 0 16 16"><path d="M4.5 1.5h4.5l3.5 3.5v8.5a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1z"/><path d="M9 1.5V5h3.5M5.5 8.5h5M5.5 11h3.5"/></svg>',
    close: '<svg viewBox="0 0 16 16"><path d="m4 4 8 8M12 4l-8 8"/></svg>',
  };
  function icon(name) {
    const t = document.createElement('template');
    t.innerHTML = ICONS[name];
    return t.content.firstChild;
  }

  // ---------- Markdown 内容处理 ----------
  const BLOCKED_TAGS = 'script, iframe, frame, frameset, object, embed, applet, base, meta, link, style, form, noscript';
  const URL_ATTRS = new Set(['href', 'src', 'xlink:href', 'action', 'formaction', 'poster', 'background', 'srcset']);

  // 去掉脚本与事件属性（CSP 已禁止脚本执行，这里再做一层清理，并防止内容里的样式影响界面）
  function sanitize(root) {
    root.querySelectorAll(BLOCKED_TAGS).forEach((n) => n.remove());
    for (const el of root.querySelectorAll('*')) {
      for (const attr of [...el.attributes]) {
        const name = attr.name.toLowerCase();
        if (name.startsWith('on')) el.removeAttribute(attr.name);
        else if (URL_ATTRS.has(name) && /^\s*(javascript|vbscript|data:text\/html)/i.test(attr.value)) el.removeAttribute(attr.name);
      }
    }
  }

  // 把相对路径 / Windows 路径转换为绝对 URL；页面内锚点返回 null
  function toAbsUrl(raw, baseUrl) {
    const v = String(raw || '').trim();
    if (!v || v.startsWith('#')) return null;
    if (/^[a-zA-Z]:[\\/]/.test(v)) return 'file:///' + encodeURI(v.replace(/\\/g, '/'));
    if (/^\\\\/.test(v)) return 'file:' + encodeURI(v.replace(/\\/g, '/'));
    if (/^[a-zA-Z][\w+.-]*:/.test(v)) return v;
    try {
      return new URL(v.replace(/\\/g, '/'), baseUrl).href;
    } catch {
      return null;
    }
  }

  function fileUrlToPath(url) {
    let p = decodeURIComponent(url.pathname);
    if (url.host) return '\\\\' + url.host + p.replace(/\//g, '\\');
    if (/^\/[a-zA-Z]:/.test(p)) return p.slice(1).replace(/\//g, '\\');
    return p;
  }

  function fixResources(root, baseUrl) {
    const targets = [
      ['img', 'src'],
      ['source', 'src'],
      ['video', 'src'],
      ['video', 'poster'],
      ['audio', 'src'],
      ['track', 'src'],
    ];
    for (const [tag, attr] of targets) {
      for (const el of root.querySelectorAll(`${tag}[${attr}]`)) {
        const abs = toAbsUrl(el.getAttribute(attr), baseUrl);
        if (abs) el.setAttribute(attr, abs);
      }
    }
    for (const img of root.querySelectorAll('img')) {
      img.loading = 'lazy';
      img.decoding = 'async';
    }
  }

  function decorate(root) {
    for (const table of root.querySelectorAll('table')) {
      if (table.parentElement && table.parentElement.classList.contains('table-wrap')) continue;
      const wrap = document.createElement('div');
      wrap.className = 'table-wrap';
      table.replaceWith(wrap);
      wrap.append(table);
    }
    for (const pre of root.querySelectorAll('pre')) {
      if (!pre.querySelector('code')) continue;
      const tools = document.createElement('div');
      tools.className = 'code-tools';
      const lang = pre.dataset.lang;
      if (lang) {
        const span = document.createElement('span');
        span.className = 'code-lang';
        span.textContent = lang;
        tools.append(span);
      }
      const btn = document.createElement('button');
      btn.className = 'code-copy';
      btn.type = 'button';
      btn.textContent = '复制';
      tools.append(btn);
      pre.append(tools);
    }
  }

  function findAnchor(id) {
    if (!id) return null;
    const q = (sel) => els.content.querySelector(sel);
    const esc = CSS.escape(id);
    return q(`[id="${esc}"]`) || q(`a[name="${esc}"]`) || q(`[id="${CSS.escape(slugify(id))}"]`);
  }

  function scrollToElement(el, flash = true) {
    for (let d = el.closest('details'); d; d = d.parentElement && d.parentElement.closest('details')) d.open = true;
    const top = el.getBoundingClientRect().top - els.scroller.getBoundingClientRect().top + els.scroller.scrollTop - 12;
    els.scroller.scrollTop = Math.max(0, top);
    updateActiveToc();
    if (flash) {
      el.classList.remove('anchor-flash');
      void el.offsetWidth;
      el.classList.add('anchor-flash');
    }
  }

  function scrollToAnchor(id) {
    const el = findAnchor(id);
    if (el) scrollToElement(el);
    else if (id) toast('找不到锚点：#' + id);
  }

  // ---------- 文档显示 ----------
  function setEmpty(empty) {
    els.body.classList.toggle('empty', empty);
  }

  function showDocument(doc, { scrollTop = 0, anchor = null } = {}) {
    state.doc = doc;
    renderHtml(doc.html, doc.baseUrl);
    setEmpty(false);
    els.segRead.disabled = els.segEdit.disabled = false;

    updateTitle();
    renderToc(doc.toc);
    renderStatus(doc);
    markActiveInTree();

    if (anchor) scrollToAnchor(anchor);
    else els.scroller.scrollTop = scrollTop || 0;
    if (!els.findBar.hidden && els.findInput.value) runFind(false);
    updateActiveToc();
  }

  // 把 HTML 放进正文区（阅读模式与编辑模式的预览共用）
  function renderHtml(html, baseUrl) {
    hideSelCopy();
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    sanitize(tpl.content);
    fixResources(tpl.content, baseUrl);
    decorate(tpl.content);
    els.content.replaceChildren(tpl.content);
    state.find.hits = [];
    state.find.index = -1;
  }

  function updateTitle() {
    const doc = state.doc;
    if (!doc) {
      document.title = APP_NAME;
      els.docTitle.textContent = '';
      els.docTitle.title = '';
      return;
    }
    const mark = state.edit.dirty ? '● ' : '';
    document.title = `${mark}${doc.name} - ${APP_NAME}`;
    els.docTitle.textContent = mark + (doc.title && doc.title !== stripExt(doc.name) ? `${doc.title}  ·  ${doc.name}` : doc.name);
    els.docTitle.title = doc.path;
  }

  function clearDocument() {
    state.doc = null;
    hideSelCopy();
    els.content.replaceChildren();
    state.headings = [];
    state.find.hits = [];
    closeFind();
    setEmpty(true);
    els.segRead.disabled = els.segEdit.disabled = true;
    updateTitle();
    renderToc([]);
    renderStatus(null);
    markActiveInTree();
    api.closeFile();
    renderRecent();
  }

  async function closeDocument() {
    if (!state.doc || !(await confirmLeave())) return;
    setEditingUi(false);
    clearDocument();
  }

  function renderStatus(doc) {
    if (!doc) {
      els.stPath.textContent = '';
      for (const k of ['stEncoding', 'stWords', 'stLines', 'stTime', 'stSize']) els[k].textContent = '';
      return;
    }
    const s = doc.stats;
    els.stPath.textContent = doc.path;
    els.stEncoding.textContent = doc.encoding;
    els.stWords.textContent = `${s.words.toLocaleString()} 字`;
    els.stWords.title = `${s.chars.toLocaleString()} 个字符（不含空白）`;
    els.stLines.textContent = `${s.lines.toLocaleString()} 行`;
    els.stTime.textContent = `约 ${Math.max(1, Math.round(s.words / 350))} 分钟读完`;
    els.stSize.textContent = formatSize(s.size);
    els.stSize.title = '修改时间：' + new Date(s.mtime).toLocaleString('zh-CN');
  }

  // ---------- 编辑模式 ----------
  function setDirty(dirty) {
    if (state.edit.dirty === dirty) return;
    state.edit.dirty = dirty;
    api.setDirty(dirty);
    els.btnSave.disabled = !dirty;
    updateTitle();
  }

  function setEditingUi(on) {
    state.edit.on = on;
    els.body.classList.toggle('editing', on);
    els.segRead.classList.toggle('on', !on);
    els.segEdit.classList.toggle('on', on);
    els.segRead.setAttribute('aria-pressed', String(!on));
    els.segEdit.setAttribute('aria-pressed', String(on));
    if (!on) {
      setDirty(false);
      els.editor.value = '';
    }
  }

  // 从磁盘读取源码放进编辑器（换行统一为 \n，保存时再还原）
  async function loadSource() {
    const src = await api.getSource(state.doc.path);
    if (!src || src.error) {
      toast((src && src.error) || '读取源码失败', true);
      return false;
    }
    const text = src.text.replace(/\r\n?/g, '\n');
    state.edit.saved = text;
    state.edit.meta = { encoding: src.encoding, eol: src.eol };
    els.editor.value = text;
    setDirty(false);
    return true;
  }

  // 编辑区精确测量：用代理 div 逐行实测每个源码行的真实渲染高度（含自动折行）。
  // 代理 div 与 textarea 同宽同样式，display 不可见但参与布局（visibility:hidden），
  // 每个源码行独立换行，折行不依赖前后行，因此单行测量结果与整段一致。
  // 累加得到每个标题行的精确视觉位置，替代原先“逻辑行号 × 行高”的估算。
  const probe = document.createElement('div');
  probe.id = 'mdr-editor-probe';
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText =
    'position:absolute;visibility:hidden;pointer-events:none;left:-99999px;top:0;white-space:pre-wrap;overflow-wrap:anywhere;tab-size:2;';
  document.body.appendChild(probe);

  function syncProbeStyle() {
    const cs = getComputedStyle(els.editor);
    probe.style.font = cs.font;
    probe.style.lineHeight = cs.lineHeight;
    probe.style.letterSpacing = cs.letterSpacing;
    probe.style.wordBreak = cs.wordBreak;
    probe.style.padding = '0'; // 关键：逐行累加时不能重复计入 textarea 的 padding
    probe.style.width = (els.editor.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0)) + 'px';
    probe.style.boxSizing = 'border-box';
  }

  // 源码每行的视觉高度（近似，供无代理时兜底）
  const lineHeight = () => {
    const fs = parseFloat(getComputedStyle(els.editor).fontSize) || 13.5;
    const lh = getComputedStyle(els.editor).lineHeight;
    return lh === 'normal' ? fs * 1.75 : parseFloat(lh) || fs * 1.75;
  };

  // 累计行高缓存：cum[i] = 第 i+1 行（1-based）的视觉顶部位置
  let lineHeightsCache = null; // { text, width, cum, k }
  function buildLineHeights() {
    syncProbeStyle();
    const text = els.editor.value;
    const lines = text.split('\n');
    const lh = lineHeight();
    const cum = new Array(lines.length + 1);
    cum[0] = 0;
    for (let i = 0; i < lines.length; i++) {
      probe.textContent = lines[i] + '\n';
      const h = probe.getBoundingClientRect().height;
      cum[i + 1] = cum[i] + (h > 1 ? h : lh); // 空行兜底为单行高
    }
    // 校准系数：probe 内容总高 vs textarea 真实 scrollHeight（textarea scrollHeight 含 padding）
    const cs = getComputedStyle(els.editor);
    const padTop = parseFloat(cs.paddingTop) || 0;
    const padBottom = parseFloat(cs.paddingBottom) || 0;
    const totalContent = cum[cum.length - 1] || 1;
    const realContent = Math.max(1, els.editor.scrollHeight - padTop - padBottom);
    const k = realContent / totalContent;
    lineHeightsCache = { text, width: els.editor.clientWidth, cum, k };
  }
  function ensureLineHeights() {
    if (
      !lineHeightsCache ||
      lineHeightsCache.text !== els.editor.value ||
      lineHeightsCache.width !== els.editor.clientWidth
    ) {
      // 超大文档（>5 万行）放弃精确测量，避免卡顿，退回估算
      if (els.editor.value.split('\n').length > 50000) {
        lineHeightsCache = { text: els.editor.value, width: els.editor.clientWidth, cum: null, k: 1 };
      } else {
        buildLineHeights();
      }
    }
    return lineHeightsCache.cum;
  }

  // 源码行号（1-based）在编辑区中的视觉纵向位置（px），实测为主，估算兜底
  const lineVisualTop = (n) => {
    const cache = lineHeightsCache;
    const cum = ensureLineHeights();
    if (!cum) return (n - 1) * lineHeight();
    const k = (cache && cache.k) || 1;
    if (n < 1) return 0;
    if (n >= cum.length) return (cum[cum.length - 1]) * k;
    return cum[n - 1] * k;
  };

  // 标题索引缓存：value 变化时失效
  let headingCache = null;
  function sourceHeadingIndex() {
    if (headingCache && headingCache.text === els.editor.value) return headingCache.items;
    const lines = els.editor.value.split('\n');
    const used = new Map();
    const items = [];
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^[ \t]{0,3}(#{1,6})[ \t]+(.+?)\s*#*\s*$/);
      if (!m) continue;
      const slug = slugifyText(m[2].trim());
      if (!slug) continue;
      let id;
      if (used.has(slug)) {
        used.set(slug, used.get(slug) + 1);
        id = slug + '-' + used.get(slug);
      } else {
        used.set(slug, 0);
        id = slug;
      }
      items.push({ lineNo: i + 1, id });
    }
    headingCache = { text: els.editor.value, items };
    return items;
  }

  const slugifyText = (text) =>
    text
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '')
      .replace(/\s+/g, '-');

  // 标题锚点在预览中的绝对纵向位置（相对文档，px）
  const anchorAbsTop = (id) => {
    const el = document.getElementById(id);
    if (!el) return -1;
    return el.getBoundingClientRect().top - els.scroller.getBoundingClientRect().top + els.scroller.scrollTop;
  };

  // id -> 预览 DOM 中实际存在的锚点（不存在返回 null）
  function resolveAnchor(id) {
    return document.getElementById(id) ? id : null;
  }

  // 预览：把锚点滚动到 rel（0=顶部，1=底部）位置
  function scrollPreviewToAnchor(id, rel = 0) {
    if (!id) return;
    const el = document.getElementById(id);
    if (!el) return;
    const pos = el.getBoundingClientRect().top - els.scroller.getBoundingClientRect().top + els.scroller.scrollTop;
    const max = els.scroller.scrollHeight - els.scroller.clientHeight;
    els.scroller.scrollTop = Math.max(0, Math.min(max, pos - rel * els.scroller.clientHeight));
  }

  // 按标题区间线性插值做双向同步：
  // 源码中相邻两个标题（编辑器侧）与它们对应的锚点（预览侧）构成一对区间，
  // 编辑器在 A→B 间滚动时，预览按同一比例在 A→B 锚点间滚动——标题处精确对齐，标题间持续联动。
  // ratio 用“可视窗口内已完成的比例”，避免把超出窗口的偏移算进去。
  function syncEditorToPreview() {
    const idx = sourceHeadingIndex();
    if (!idx.length) return syncEditorToPreviewRatio();
    const editorTop = els.editor.scrollTop;
    const editorClient = els.editor.clientHeight;
    // 编辑器视口内的第一个可见标题：视觉顶 ≥ scrollTop（允许一点容差），否则用其后一个
    let i = 0;
    while (i < idx.length && lineVisualTop(idx[i].lineNo) < editorTop) i++;
    if (i === idx.length) i = idx.length - 1; // 视口在最后一个标题之后：用最后一个
    const prev = i > 0 ? idx[i - 1] : null;
    const next = idx[i];

    const prevTop = prev ? lineVisualTop(prev.lineNo) : 0;
    const nextTop = lineVisualTop(next.lineNo);

    let rel;
    if (!prev) {
      // 第一个标题之前：按标题到视口顶的相对比例（从 0 到 1 过渡）
      rel = Math.max(0, Math.min(1, (editorTop - prevTop) / editorClient));
    } else {
      const span = nextTop - prevTop;
      rel = span > 0 ? Math.max(0, Math.min(1, (editorTop - prevTop) / span)) : 0;
    }

    // 预览侧：把下一个标题锚点滚到 rel 对应的位置（prev 锚点在 rel=0 处，next 锚点在 rel=1 处）
    if (!prev) {
      const id = resolveAnchor(next.id);
      if (id) scrollPreviewToAnchor(id, rel);
      return;
    }
    const prevId = resolveAnchor(prev.id);
    const nextId = resolveAnchor(next.id);
    if (!prevId || !nextId) return;
    const aTop = anchorAbsTop(prevId);
    const bTop = anchorAbsTop(nextId);
    if (aTop < 0 || bTop < 0) return;
    const span = bTop - aTop;
    const target = span > 0 ? aTop + rel * span : aTop;
    const max = els.scroller.scrollHeight - els.scroller.clientHeight;
    els.scroller.scrollTop = Math.max(0, Math.min(max, target));
  }

  // 预览滚动 -> 同步编辑器（同样的区间插值，方向相反）
  function syncPreviewToEditor() {
    const idx = sourceHeadingIndex();
    if (!idx.length) return syncPreviewToEditorRatio();
    const scrollerTop = els.scroller.scrollTop;
    const scrollerClient = els.scroller.clientHeight;
    // 预览视口内第一个可见锚点
    let i = 0;
    while (i < idx.length) {
      const t = anchorAbsTop(idx[i].id);
      if (t >= scrollerTop) break;
      i++;
    }
    if (i === idx.length) i = idx.length - 1;
    const prev = i > 0 ? idx[i - 1] : null;
    const next = idx[i];

    let rel;
    if (!prev) {
      const top = anchorAbsTop(next.id);
      const span = Math.max(1, scrollerClient);
      rel = top >= 0 ? Math.max(0, Math.min(1, (scrollerTop - 0) / span)) : 0;
    } else {
      const aTop = anchorAbsTop(prev.id);
      const bTop = anchorAbsTop(next.id);
      if (aTop < 0 || bTop < 0) return;
      const span = bTop - aTop;
      rel = span > 0 ? Math.max(0, Math.min(1, (scrollerTop - aTop) / span)) : 0;
    }

    // 编辑器侧：把 next 标题行滚到 rel 对应的位置
    const prevTop = prev ? lineVisualTop(prev.lineNo) : 0;
    const nextTop = lineVisualTop(next.lineNo);
    if (!prev) {
      scrollEditorToLine(next.lineNo, Math.max(0, Math.min(1, rel)));
    } else {
      const span = nextTop - prevTop;
      const target = span > 0 ? prevTop + rel * span : prevTop;
      const max = els.editor.scrollHeight - els.editor.clientHeight;
      els.editor.scrollTop = Math.max(0, Math.min(max, target));
    }
  }

  // 无标题可参考时的比例同步（仅同步非零方向，避免抖动）
  function syncEditorToPreviewRatio() {
    if (els.editor.scrollHeight > els.editor.clientHeight && els.scroller.scrollHeight > els.scroller.clientHeight) {
      els.scroller.scrollTop =
        (els.editor.scrollTop / (els.editor.scrollHeight - els.editor.clientHeight)) *
        (els.scroller.scrollHeight - els.scroller.clientHeight);
    }
  }

  function syncPreviewToEditorRatio() {
    if (els.scroller.scrollHeight > els.scroller.clientHeight) {
      const ratio = els.scroller.scrollTop / (els.scroller.scrollHeight - els.scroller.clientHeight);
      const n = Math.round(ratio * (els.editor.value.split('\n').length || 1));
      scrollEditorToLine(Math.max(1, n));
    }
  }

  // 进入/退出编辑模式时以阅读模式位置为基准做一次左右对齐
  function alignEditorToPreview() {
    syncPreviewToEditor();
  }

  async function enterEditMode() {
    if (!state.doc) return toast('请先打开一个文档');
    if (state.edit.on) return;
    if (!(await loadSource())) return;
    setEditingUi(true);
    els.editor.setSelectionRange(0, 0);
    els.editor.focus({ preventScroll: true });
    alignEditorToPreview();
    updateActiveToc();
  }

  async function exitEditMode() {
    if (!state.edit.on) return true;
    if (!(await confirmLeave())) return false;
    const ratio = els.editor.scrollHeight > els.editor.clientHeight
      ? els.editor.scrollTop / (els.editor.scrollHeight - els.editor.clientHeight) : 0;
    setEditingUi(false);
    // 以磁盘上的内容为准重新显示（放弃的修改不会残留在预览里）
    const doc = await api.openFile(state.doc.path);
    if (doc && !doc.error) showDocument(doc);
    if (els.scroller.scrollHeight > els.scroller.clientHeight) {
      els.scroller.scrollTop = ratio * (els.scroller.scrollHeight - els.scroller.clientHeight);
    }
    updateActiveToc();
    els.scroller.focus({ preventScroll: true });
    return true;
  }

  // 有未保存的修改时询问；返回 true 表示可以继续（已保存或放弃修改）
  async function confirmLeave() {
    if (!state.edit.on || !state.edit.dirty) return true;
    const choice = await api.confirmUnsaved(state.doc.name);
    if (choice === 'save') return saveDocument();
    if (choice === 'discard') {
      els.editor.value = state.edit.saved;
      setDirty(false);
      return true;
    }
    return false;
  }

  async function saveDocument() {
    if (!state.doc) return false;
    if (!state.edit.on) {
      toast('阅读模式下无需保存，按 Ctrl+/ 进入编辑模式');
      return false;
    }
    const text = els.editor.value;
    const res = await api.saveFile(state.doc.path, text, state.edit.meta);
    if (!res || !res.ok) {
      toast('保存失败：' + ((res && res.error) || '未知错误'), true);
      return false;
    }
    state.edit.saved = text;
    state.edit.meta.encoding = res.encoding;
    state.doc.encoding = res.encoding;
    state.doc.stats = { ...state.doc.stats, size: res.size, mtime: Date.now() };
    renderStatus(state.doc);
    setDirty(els.editor.value !== text);
    toast(res.converted ? '已保存（原文件是 GBK 编码，已转存为 UTF-8）' : '已保存', false, res.converted ? 4000 : 1200);
    return true;
  }

  // 编辑时实时刷新右侧预览
  const updatePreview = debounce(async () => {
    if (!state.edit.on || !state.doc) return;
    const docPath = state.doc.path;
    const r = await api.renderMarkdown(els.editor.value);
    if (!state.edit.on || !state.doc || state.doc.path !== docPath) return;
    Object.assign(state.doc, {
      html: r.html,
      toc: r.toc,
      title: r.title || stripExt(state.doc.name),
      stats: { ...state.doc.stats, ...r.stats },
    });
    renderHtml(r.html, state.doc.baseUrl);
    renderToc(r.toc);
    updateTitle();
    renderStatus(state.doc);
    syncEditorToPreview();
    if (!els.findBar.hidden && els.findInput.value) runFind(false);
    updateActiveToc();
  }, 200);

  // Tab / Shift+Tab 缩进（支持多行）
  function indentLines(outdent) {
    const ed = els.editor;
    const v = ed.value;
    const s = ed.selectionStart;
    const en = ed.selectionEnd;
    const multi = v.slice(s, en).includes('\n');
    if (!multi && !outdent) return document.execCommand('insertText', false, '  ');
    const start = v.lastIndexOf('\n', s - 1) + 1;
    let end = v.indexOf('\n', en > s ? en - 1 : en);
    if (end < 0) end = v.length;
    const block = v.slice(start, end);
    const out = block
      .split('\n')
      .map((l) => (outdent ? l.replace(/^( {1,2}|\t)/, '') : '  ' + l))
      .join('\n');
    if (out === block) return;
    ed.setSelectionRange(start, end);
    document.execCommand('insertText', false, out);
    if (multi) ed.setSelectionRange(start, start + out.length);
    else {
      const pos = Math.max(start, s - (block.length - out.length));
      ed.setSelectionRange(pos, pos);
    }
  }

  // 回车时自动延续列表（- / * / + / 1. / - [ ]）；空列表项再按回车则结束列表
  function continueList(e) {
    const ed = els.editor;
    const pos = ed.selectionStart;
    if (pos !== ed.selectionEnd) return;
    const v = ed.value;
    const lineStart = v.lastIndexOf('\n', pos - 1) + 1;
    const line = v.slice(lineStart, pos);
    const m = line.match(/^(\s*)(?:([-*+])|(\d+)([.)]))(\s+)(\[[ xX]\]\s+)?/);
    if (!m) return;
    e.preventDefault();
    if (line === m[0]) {
      ed.setSelectionRange(lineStart, pos);
      document.execCommand('delete');
      return;
    }
    const bullet = m[2] || `${Number(m[3]) + 1}${m[4]}`;
    document.execCommand('insertText', false, '\n' + m[1] + bullet + m[5] + (m[6] ? '[ ] ' : ''));
  }

  // ---------- Markdown 语法速查 ----------
  const MD_HELP_ITEMS = [
    { name: '标题', syntax: '## 二级标题', insert: '## 标题' },
    { name: '加粗', syntax: '**加粗**', insert: '**加粗**' },
    { name: '斜体', syntax: '*斜体*', insert: '*斜体*' },
    { name: '删除线', syntax: '~~删除线~~', insert: '~~删除线~~' },
    { name: '行内代码', syntax: '`code`', insert: '`code`' },
    { name: '代码块', syntax: '```js ... ```', insert: '```js\n\n```' },
    { name: '引用', syntax: '> 引用', insert: '> 引用' },
    { name: '无序列表', syntax: '- 项目', insert: '- 项目' },
    { name: '有序列表', syntax: '1. 项目', insert: '1. 项目' },
    { name: '任务列表', syntax: '- [ ] 待办', insert: '- [ ] 待办' },
    { name: '链接', syntax: '[文字](https://…)', insert: '[文字](https://)' },
    { name: '图片', syntax: '![alt](img.png)', insert: '![alt](img.png)' },
    { name: '表格', syntax: '| 列1 | 列2 |', insert: '| 列1 | 列2 |\n| --- | --- |\n| 内容 | 内容 |' },
    { name: '分割线', syntax: '---', insert: '\n---\n' },
    { name: '折叠', syntax: '<details>…', insert: '<details><summary>标题</summary>\n\n内容\n\n</details>' },
  ];

  function buildMdHelp() {
    const grid = els.mdHelpGrid;
    if (!grid || grid.childElementCount) return;
    for (const item of MD_HELP_ITEMS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'md-help-item';
      btn.title = '点击插入到光标处';
      const name = document.createElement('span');
      name.className = 'mdh-name';
      name.textContent = item.name;
      const syntax = document.createElement('span');
      syntax.className = 'mdh-syntax';
      syntax.textContent = item.syntax;
      btn.append(name, syntax);
      btn.addEventListener('click', () => insertMdHelp(item.insert));
      grid.appendChild(btn);
    }
  }

  function insertMdHelp(text) {
    if (!state.edit.on) {
      toast('请先进入编辑模式', true);
      return;
    }
    els.editor.focus({ preventScroll: true });
    document.execCommand('insertText', false, text);
    els.editor.dispatchEvent(new Event('input', { bubbles: true }));
    els.editor.dispatchEvent(new Event('scroll', { bubbles: true }));
  }

  function toggleMdHelp(open) {
    const target = open == null ? els.mdHelp.dataset.open !== '1' : !!open;
    els.mdHelp.dataset.open = target ? '1' : '0';
    els.mdHelpBody.hidden = !target;
    els.mdHelpToggle.setAttribute('aria-expanded', String(target));
  }

  const editorFocused = () => state.edit.on && document.activeElement === els.editor;

  // ---------- 打开文件 / 文件夹 ----------
  async function openDocument(filePath, { push = true, scrollTop = 0, anchor = null, confirmed = false } = {}) {
    if (!confirmed && !(await confirmLeave())) return false;
    const doc = await api.openFile(filePath);
    if (!doc || doc.error) {
      toast((doc && doc.error) || '打开失败', true);
      return false;
    }
    if (push) pushHistory(doc.path);
    showDocument(doc, { scrollTop, anchor });
    if (state.edit.on) {
      if (await loadSource()) {
        els.editor.setSelectionRange(0, 0);
        els.editor.scrollTop = 0;
        els.editor.focus({ preventScroll: true });
      } else {
        setEditingUi(false);
      }
    } else {
      els.scroller.focus({ preventScroll: true });
    }
    if (!state.folder || !isUnder(doc.path, state.folder.root)) {
      await openFolder(doc.dir, { silent: true, autoOpen: false });
    } else {
      revealInTree(doc.path);
    }
    renderRecent();
    return true;
  }

  async function openFolder(dir, { silent = false, autoOpen = true, keepExpanded = false } = {}) {
    const res = await api.readTree(dir);
    if (!res || res.error) {
      if (!silent) toast((res && res.error) || '无法打开文件夹', true);
      return false;
    }
    const files = [];
    (function walk(node, rel) {
      for (const c of node.children) {
        const r = rel ? rel + '/' + c.name : c.name;
        if (c.type === 'dir') walk(c, r);
        else files.push({ name: c.name, path: c.path, rel: r });
      }
    })(res.tree, '');
    state.folder = { root: dir, tree: res.tree, files };
    if (!keepExpanded) state.expanded = new Set();
    els.folderName.textContent = res.tree.name;
    els.folderName.title = dir;
    els.sidebar.classList.add('has-folder');
    els.treeEmpty.hidden = true;
    api.setSettings({ lastFolder: dir });

    if (state.doc && isUnder(state.doc.path, dir)) revealInTree(state.doc.path);
    else renderTree();

    if (!silent) setSidebarVisible(true);
    if (autoOpen && !state.doc) {
      const readme = res.tree.children.find((c) => c.type === 'file' && /^(readme|index)\.(md|markdown)$/i.test(c.name));
      if (readme) await openDocument(readme.path);
      else if (!files.length) toast('这个文件夹里没有 Markdown 文件');
    }
    return true;
  }

  function closeFolder() {
    state.folder = null;
    state.expanded = new Set();
    els.tree.replaceChildren();
    els.treeFilter.value = '';
    els.folderName.textContent = '未打开文件夹';
    els.folderName.title = '';
    els.sidebar.classList.remove('has-folder');
    els.treeEmpty.hidden = false;
    api.setSettings({ lastFolder: null });
  }

  async function openPathString(p) {
    const st = await api.statPath(p);
    if (st.type === 'dir') return openFolder(p);
    if (st.type === 'file') return openDocument(p);
    const list = await api.removeRecent(p);
    renderRecent(list);
    toast('文件不存在，已从最近打开中移除：' + p, true);
    return false;
  }

  async function openPathInfo(info) {
    if (!info) return;
    if (info.type === 'dir') await openFolder(info.path);
    else await openDocument(info.path);
  }

  async function chooseFile() {
    const p = await api.openFileDialog();
    if (p) await openDocument(p);
  }

  async function chooseFolder() {
    const p = await api.openFolderDialog();
    if (p) await openFolder(p);
  }

  // ---------- 导航历史 ----------
  function saveScroll() {
    const cur = state.history[state.historyIndex];
    if (cur && state.doc && samePath(cur.path, state.doc.path)) cur.scrollTop = els.scroller.scrollTop;
  }

  function pushHistory(p) {
    saveScroll();
    const cur = state.history[state.historyIndex];
    if (cur && samePath(cur.path, p)) return;
    state.history = state.history.slice(0, state.historyIndex + 1);
    state.history.push({ path: p, scrollTop: 0 });
    if (state.history.length > 100) state.history.shift();
    state.historyIndex = state.history.length - 1;
    updateNavButtons();
  }

  async function go(delta) {
    const i = state.historyIndex + delta;
    if (i < 0 || i >= state.history.length) return;
    if (!(await confirmLeave())) return;
    saveScroll();
    state.historyIndex = i;
    updateNavButtons();
    const entry = state.history[i];
    await openDocument(entry.path, { push: false, scrollTop: entry.scrollTop, confirmed: true });
  }

  function updateNavButtons() {
    els.btnBack.disabled = state.historyIndex <= 0;
    els.btnForward.disabled = state.historyIndex >= state.history.length - 1;
  }

  // ---------- 文件树 ----------
  function makeRow(node, depth, hint) {
    const row = document.createElement('div');
    row.className = 'tree-row ' + node.type;
    row.style.paddingLeft = 8 + depth * 14 + 'px';
    row.dataset.path = node.path;
    row.dataset.type = node.type;
    row.title = node.path;
    if (node.type === 'dir') {
      if (state.expanded.has(lower(node.path))) row.classList.add('open');
      row.append(icon('twisty'), icon('folder'));
    } else {
      const spacer = document.createElement('span');
      spacer.style.width = '14px';
      spacer.style.flex = 'none';
      row.append(spacer, icon('file'));
    }
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = node.name;
    row.append(name);
    if (hint) {
      const h = document.createElement('span');
      h.className = 'hint';
      h.textContent = hint;
      row.append(h);
    }
    return row;
  }

  function buildList(nodes, depth) {
    const ul = document.createElement('ul');
    for (const node of nodes) {
      const li = document.createElement('li');
      li.append(makeRow(node, depth));
      if (node.type === 'dir' && state.expanded.has(lower(node.path))) li.append(buildList(node.children, depth + 1));
      ul.append(li);
    }
    return ul;
  }

  function renderTree() {
    if (!state.folder) return;
    const top = els.tree.scrollTop;
    const q = els.treeFilter.value.trim().toLowerCase();
    els.tree.replaceChildren();
    if (!state.folder.files.length) {
      const p = document.createElement('div');
      p.className = 'side-empty';
      p.textContent = '此文件夹中没有 Markdown 文件';
      els.tree.append(p);
      return;
    }
    if (q) {
      const ul = document.createElement('ul');
      const hits = state.folder.files.filter((f) => f.rel.toLowerCase().includes(q)).slice(0, 500);
      for (const f of hits) {
        const li = document.createElement('li');
        const d = f.rel.includes('/') ? f.rel.slice(0, f.rel.lastIndexOf('/')) : '';
        li.append(makeRow({ type: 'file', name: f.name, path: f.path }, 0, d));
        ul.append(li);
      }
      if (!hits.length) {
        const p = document.createElement('div');
        p.className = 'side-empty';
        p.textContent = '没有匹配的文件';
        els.tree.append(p);
      }
      els.tree.append(ul);
    } else {
      els.tree.append(buildList(state.folder.tree.children, 0));
    }
    markActiveInTree();
    els.tree.scrollTop = top;
  }

  function markActiveInTree() {
    for (const row of els.tree.querySelectorAll('.tree-row.active')) row.classList.remove('active');
    if (!state.doc) return;
    for (const row of els.tree.querySelectorAll('.tree-row.file')) {
      if (samePath(row.dataset.path, state.doc.path)) {
        row.classList.add('active');
        return row;
      }
    }
    return null;
  }

  function revealInTree(filePath) {
    if (!state.folder) return;
    const root = lower(state.folder.root).replace(/[\\/]+$/, '');
    for (let d = dirName(filePath); lower(d).length > root.length && isUnder(d, state.folder.root); d = dirName(d)) {
      state.expanded.add(lower(d));
    }
    renderTree();
    const row = markActiveInTree();
    if (row) row.scrollIntoView({ block: 'nearest' });
  }

  // ---------- 大纲 ----------
  function renderToc(toc) {
    els.toc.replaceChildren();
    state.headings = [];
    activeLink = null;
    els.tocEmpty.hidden = toc.length > 0 || !state.doc;
    if (!toc.length) return;
    const min = Math.min(...toc.map((t) => t.level));
    const frag = document.createDocumentFragment();
    for (const t of toc) {
      const a = document.createElement('a');
      a.href = '#' + t.id;
      a.dataset.id = t.id;
      a.textContent = t.text || '（无标题）';
      a.title = t.text;
      a.className = 'l' + (t.level - min + 1);
      a.style.paddingLeft = 8 + (t.level - min) * 14 + 'px';
      frag.append(a);
      const el = els.content.querySelector(`[id="${CSS.escape(t.id)}"]`);
      if (el) state.headings.push({ el, link: a });
    }
    els.toc.append(frag);
  }

  let activeLink = null;
  function updateActiveToc() {
    if (!state.headings.length) return;
    const limit = els.scroller.getBoundingClientRect().top + 40;
    let current = state.headings[0];
    for (const h of state.headings) {
      if (h.el.getBoundingClientRect().top <= limit) current = h;
      else break;
    }
    // 滚到底部时，高亮最后一个可见标题
    const sc = els.scroller;
    if (sc.scrollTop > 0 && sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2) {
      const bottom = sc.getBoundingClientRect().bottom;
      for (const h of state.headings) if (h.el.getBoundingClientRect().top < bottom) current = h;
    }
    if (current.link === activeLink) return;
    if (activeLink) activeLink.classList.remove('active');
    activeLink = current.link;
    activeLink.classList.add('active');
    const box = els.toc.getBoundingClientRect();
    const r = activeLink.getBoundingClientRect();
    if (r.top < box.top || r.bottom > box.bottom) activeLink.scrollIntoView({ block: 'nearest' });
  }

  // ---------- 查找 ----------
  function openFind() {
    if (!state.doc) return;
    els.findBar.hidden = false;
    els.findInput.focus();
    els.findInput.select();
    if (els.findInput.value) runFind(true);
  }

  function closeFind() {
    if (els.findBar.hidden) return;
    els.findBar.hidden = true;
    clearFindMarks();
    updateFindCount();
    els.scroller.focus({ preventScroll: true });
  }

  function clearFindMarks() {
    const parents = new Set();
    for (const m of els.content.querySelectorAll('mark.find-hit')) {
      parents.add(m.parentNode);
      m.replaceWith(...m.childNodes);
    }
    parents.forEach((p) => p.normalize());
    state.find.hits = [];
    state.find.index = -1;
  }

  function runFind(scroll = true) {
    clearFindMarks();
    const query = els.findInput.value;
    if (!query) return updateFindCount();
    const needle = query.toLowerCase();
    const nodes = [];
    const walker = document.createTreeWalker(els.content, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const p = n.parentElement;
        if (!p || p.closest('.code-tools')) return NodeFilter.FILTER_REJECT;
        return n.nodeValue.toLowerCase().includes(needle) || n.nodeValue.includes(query)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      },
    });
    while (walker.nextNode()) nodes.push(walker.currentNode);

    const hits = [];
    for (const node of nodes) {
      if (hits.length >= MAX_FIND_HITS) break;
      const text = node.nodeValue;
      // 大小写转换改变长度时（极少数字符），退回区分大小写匹配
      const lowered = text.toLowerCase();
      const [hay, pin] = lowered.length === text.length ? [lowered, needle] : [text, query];
      const positions = [];
      for (let i = hay.indexOf(pin); i !== -1; i = hay.indexOf(pin, i + pin.length)) positions.push(i);
      const marks = [];
      for (let k = positions.length - 1; k >= 0; k--) {
        const match = node.splitText(positions[k]);
        match.splitText(pin.length);
        const mark = document.createElement('mark');
        mark.className = 'find-hit';
        match.replaceWith(mark);
        mark.append(match);
        marks.unshift(mark);
      }
      hits.push(...marks);
    }
    state.find.hits = hits.slice(0, MAX_FIND_HITS);
    if (!state.find.hits.length) return updateFindCount();
    // 从当前视口位置开始找第一个结果
    const viewTop = els.scroller.getBoundingClientRect().top;
    let idx = state.find.hits.findIndex((h) => h.getBoundingClientRect().top >= viewTop);
    if (idx < 0) idx = 0;
    setFindIndex(idx, scroll);
  }

  function setFindIndex(i, scroll = true) {
    const hits = state.find.hits;
    if (!hits.length) return updateFindCount();
    const prev = hits[state.find.index];
    if (prev) prev.classList.remove('current');
    state.find.index = (i + hits.length) % hits.length;
    const cur = hits[state.find.index];
    cur.classList.add('current');
    if (scroll) {
      for (let d = cur.closest('details'); d; d = d.parentElement && d.parentElement.closest('details')) d.open = true;
      cur.scrollIntoView({ block: 'center', inline: 'nearest' });
    }
    updateFindCount();
  }

  function updateFindCount() {
    const n = state.find.hits.length;
    els.findCount.textContent = n ? `${state.find.index + 1}/${n}${n >= MAX_FIND_HITS ? '+' : ''}` : '0/0';
    els.findBar.classList.toggle('no-match', !!els.findInput.value && !n);
  }

  // ---------- 布局 / 缩放 / 主题 ----------
  function setSidebarVisible(v) {
    els.body.classList.toggle('no-sidebar', !v);
    if (state.settings.sidebarVisible !== v) {
      state.settings.sidebarVisible = v;
      api.setSettings({ sidebarVisible: v });
    }
  }

  function setOutlineVisible(v) {
    els.body.classList.toggle('no-outline', !v);
    state.settings.outlineVisible = v;
    api.setSettings({ outlineVisible: v });
    if (v && window.innerWidth < 1000) toast('窗口较窄时大纲会自动隐藏，放大窗口即可显示');
  }

  function setSidebarWidth(w, save) {
    w = Math.round(Math.min(600, Math.max(180, w)));
    document.documentElement.style.setProperty('--sidebar-width', w + 'px');
    if (save) {
      state.settings.sidebarWidth = w;
      api.setSettings({ sidebarWidth: w });
    }
  }

  function setZoom(z) {
    z = Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z)) * 10) / 10;
    document.documentElement.style.setProperty('--zoom', String(z));
    els.btnZoom.textContent = Math.round(z * 100) + '%';
    if (state.settings.zoom !== z) {
      state.settings.zoom = z;
      api.setSettings({ zoom: z });
    }
  }

  function setTheme(theme) {
    if (!THEMES.includes(theme)) return;
    state.settings.theme = theme;
    api.setTheme(theme);
    updateThemeButton();
  }

  function updateThemeButton() {
    const t = state.settings.theme || 'system';
    els.btnTheme.title = `主题：${THEME_LABEL[t]}（点击切换）`;
    els.btnTheme.classList.toggle('on', t !== 'system');
  }

  // ---------- 最近打开 ----------
  async function renderRecent(list) {
    if (!Array.isArray(list)) list = await api.getRecent();
    els.recentList.replaceChildren();
    if (!list.length) {
      const li = document.createElement('li');
      li.className = 'r-empty';
      li.textContent = '暂无记录';
      els.recentList.append(li);
      return;
    }
    for (const p of list.slice(0, 10)) {
      const li = document.createElement('li');
      li.title = p;
      li.dataset.path = p;
      const name = document.createElement('span');
      name.className = 'r-name';
      name.textContent = baseName(p);
      const dir = document.createElement('span');
      dir.className = 'r-dir';
      dir.textContent = dirName(p);
      const rm = document.createElement('button');
      rm.className = 'icon-btn';
      rm.title = '从列表中移除';
      rm.dataset.remove = p;
      rm.append(icon('close'));
      li.append(name, dir, rm);
      els.recentList.append(li);
    }
  }

  // ---------- 导出 ----------
  async function exportHtml() {
    if (!state.doc) return toast('请先打开一个文档');
    const d = state.doc;
    const res = await api.exportHtml({ html: d.html, name: stripExt(d.name), title: d.title, dir: d.dir });
    if (res && res.ok) toast('已导出：' + res.path);
    else if (res && res.error) toast('导出失败：' + res.error, true);
  }

  async function exportPdf() {
    if (!state.doc) return toast('请先打开一个文档');
    toast('正在生成 PDF…', false, 10000);
    const res = await api.exportPdf(stripExt(state.doc.name));
    if (res && res.ok) toast('已导出：' + res.path);
    else if (res && res.error) toast('导出失败：' + res.error, true);
    else els.toast.hidden = true;
  }

  // ---------- 链接点击 ----------
  async function handleLink(a) {
    const href = (a.getAttribute('href') || '').trim();
    if (!href) return;
    if (href.startsWith('#')) {
      let id = href.slice(1);
      try {
        id = decodeURIComponent(id);
      } catch {
        /* 保持原样 */
      }
      return scrollToAnchor(id);
    }
    if (/^(https?|mailto):/i.test(href)) return api.openExternal(href);
    const abs = state.doc && toAbsUrl(href, state.doc.baseUrl);
    let url;
    try {
      url = new URL(abs);
    } catch {
      return toast('无法打开链接：' + href, true);
    }
    if (url.protocol !== 'file:') return toast('不支持的链接：' + href, true);
    let anchor = url.hash ? url.hash.slice(1) : '';
    try {
      anchor = decodeURIComponent(anchor);
    } catch {
      /* 保持原样 */
    }
    const target = fileUrlToPath(url);
    if (samePath(target, state.doc.path)) return anchor ? scrollToAnchor(anchor) : undefined;
    const st = await api.statPath(target);
    if (!st.type) return toast('找不到文件：' + target, true);
    if (st.type === 'dir') return openFolder(target);
    if (st.isMarkdown) return openDocument(target, { anchor });
    const err = await api.openPath(target);
    if (err) toast('无法打开：' + err, true);
  }

  // 通过主进程写剪贴板：窗口未聚焦时也能可靠复制
  async function copyText(text) {
    try {
      return await api.copyText(text);
    } catch {
      return false;
    }
  }

  // ---------- 选中文字后的快捷复制 ----------
  function selectedContentText() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return '';
    const range = sel.getRangeAt(0);
    if (!els.content.contains(range.commonAncestorContainer)) return '';
    return sel.toString();
  }

  function hideSelCopy() {
    els.selCopy.hidden = true;
  }

  function updateSelCopy() {
    const text = selectedContentText();
    if (!text.trim()) return hideSelCopy();
    const sel = window.getSelection();
    const rects = [...sel.getRangeAt(0).getClientRects()].filter((r) => r.width || r.height);
    if (!rects.length) return hideSelCopy();
    // 默认放在选区末尾的下方；贴近底部时改放到选区开头的上方
    const wrap = els.contentWrap.getBoundingClientRect();
    const btn = els.selCopy;
    btn.hidden = false;
    const bw = btn.offsetWidth;
    const bh = btn.offsetHeight;
    const last = rects[rects.length - 1];
    let top = last.bottom - wrap.top + 6;
    let left = last.right - wrap.left - bw / 2;
    if (top + bh > wrap.height - 8) {
      const first = rects[0];
      top = first.top - wrap.top - bh - 6;
      left = first.left - wrap.left;
    }
    btn.style.top = Math.max(4, Math.min(top, wrap.height - bh - 4)) + 'px';
    btn.style.left = Math.max(4, Math.min(left, wrap.width - bw - 16)) + 'px';
  }

  async function copySelection() {
    const text = selectedContentText();
    if (!text) return;
    const ok = await copyText(text);
    hideSelCopy();
    toast(ok ? `已复制 ${text.length.toLocaleString()} 个字符` : '复制失败', !ok, 1500);
  }

  // ---------- 动作分发（菜单 / 工具栏按钮） ----------
  const actions = {
    'open-file': chooseFile,
    'open-folder': chooseFolder,
    'open-path': (p) => typeof p === 'string' && openPathString(p),
    reload: async () => {
      if (!state.doc || !(await confirmLeave())) return;
      saveScroll();
      return openDocument(state.doc.path, { push: false, scrollTop: els.scroller.scrollTop, confirmed: true });
    },
    save: saveDocument,
    'toggle-edit': () => (state.edit.on ? exitEditMode() : enterEditMode()),
    'mode-read': exitEditMode,
    'mode-edit': enterEditMode,
    'app-menu': () => {
      const r = document.querySelector('[data-action="app-menu"]').getBoundingClientRect();
      api.popupMenu(Math.round(r.left), Math.round(r.bottom + 4));
    },
    reveal: () => {
      if (state.doc) api.showInFolder(state.doc.path);
      else if (state.folder) api.openPath(state.folder.root);
    },
    close: closeDocument,
    'export-html': exportHtml,
    'export-pdf': exportPdf,
    print: () => (state.doc ? api.print() : toast('请先打开一个文档')),
    'toggle-sidebar': () => setSidebarVisible(els.body.classList.contains('no-sidebar')),
    'toggle-outline': () => setOutlineVisible(els.body.classList.contains('no-outline')),
    find: openFind,
    'zoom-in': () => setZoom((state.settings.zoom || 1) + 0.1),
    'zoom-out': () => setZoom((state.settings.zoom || 1) - 0.1),
    'zoom-reset': () => setZoom(1),
    theme: setTheme,
    'cycle-theme': () => setTheme(THEMES[(THEMES.indexOf(state.settings.theme || 'system') + 1) % THEMES.length]),
    back: () => go(-1),
    forward: () => go(1),
    'scroll-top': () => {
      if (!editorFocused()) return (els.scroller.scrollTop = 0);
      els.editor.setSelectionRange(0, 0);
      els.editor.scrollTop = 0;
    },
    'scroll-bottom': () => {
      if (!editorFocused()) return (els.scroller.scrollTop = els.scroller.scrollHeight);
      const n = els.editor.value.length;
      els.editor.setSelectionRange(n, n);
      els.editor.scrollTop = els.editor.scrollHeight;
    },
    shortcuts: () => (els.modal.hidden = false),
    'close-modal': () => (els.modal.hidden = true),
    'refresh-tree': () => state.folder && openFolder(state.folder.root, { autoOpen: false, keepExpanded: true }),
    'close-folder': closeFolder,
    'clear-recent': async () => renderRecent(await api.clearRecent()),
  };

  function runAction(name, arg) {
    const fn = actions[name];
    if (!fn) return;
    Promise.resolve()
      .then(() => fn(arg))
      .catch((e) => toast('操作失败：' + (e && e.message ? e.message : e), true));
  }

  // ---------- 事件绑定 ----------
  function bindEvents() {
    api.onMenu(runAction);
    api.onOpenPath(openPathInfo);
    api.onRecentChanged(() => renderRecent());
    api.onFileChanged(async (doc) => {
      if (!state.doc || !samePath(doc.path, state.doc.path)) return;
      if (state.edit.on) {
        if (state.edit.dirty) return toast('文件已在外部被修改。现在保存会覆盖外部的修改', true);
        const { selectionStart: a, selectionEnd: b, scrollTop } = els.editor;
        showDocument(doc, { scrollTop: els.scroller.scrollTop });
        if (await loadSource()) {
          const n = els.editor.value.length;
          els.editor.setSelectionRange(Math.min(a, n), Math.min(b, n));
          els.editor.scrollTop = scrollTop;
        }
        return toast('文件已在外部更新，已重新载入', false, 1500);
      }
      showDocument(doc, { scrollTop: els.scroller.scrollTop });
      toast('文件已在磁盘上更新，已自动刷新', false, 1500);
    });
    api.onSaveThenClose(async () => {
      if (await saveDocument()) api.closeWindow();
    });

    // 编辑器
    els.editor.addEventListener('input', () => {
      setDirty(els.editor.value !== state.edit.saved);
      updatePreview();
    });
    els.editor.addEventListener('keydown', (e) => {
      if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        indentLines(e.shiftKey);
      } else if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.isComposing) {
        continueList(e);
      }
    });
    let syncLock = 0;
    const withLock = (fn) => {
      if (syncLock) return;
      syncLock = 1;
      try { fn(); } finally { syncLock = 0; }
    };
    els.editor.addEventListener('scroll', () => {
      if (!state.edit.on) return;
      withLock(() => syncEditorToPreview());
    });
    els.scroller.addEventListener('scroll', () => {
      if (!state.edit.on) return;
      withLock(() => syncPreviewToEditor());
    });

    els.mdHelpToggle.addEventListener('click', () => toggleMdHelp());
    buildMdHelp();

    document.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (btn && !btn.disabled) {
        e.preventDefault();
        runAction(btn.dataset.action);
      }
    });

    // 正文：链接、代码复制
    els.content.addEventListener('click', async (e) => {
      const copy = e.target.closest('.code-copy');
      if (copy) {
        const code = copy.closest('pre').querySelector('code');
        const ok = await copyText(code ? code.textContent : '');
        copy.textContent = ok ? '已复制' : '复制失败';
        setTimeout(() => (copy.textContent = '复制'), 1500);
        return;
      }
      const a = e.target.closest('a[href]');
      if (!a) return;
      e.preventDefault();
      handleLink(a).catch((err) => toast('打开链接失败：' + err.message, true));
    });
    els.content.addEventListener('auxclick', (e) => {
      if (e.target.closest('a[href]')) e.preventDefault();
    });

    // 选中文字后显示快捷复制按钮
    const selCopyLater = () => setTimeout(updateSelCopy, 0);
    els.scroller.addEventListener('mouseup', (e) => e.button === 0 && selCopyLater());
    els.scroller.addEventListener('keyup', (e) => (e.shiftKey || e.key === 'a') && selCopyLater());
    els.scroller.addEventListener('mousedown', (e) => e.button === 0 && hideSelCopy());
    els.scroller.addEventListener('scroll', hideSelCopy, { passive: true });
    document.addEventListener('selectionchange', () => {
      if (!els.selCopy.hidden && !selectedContentText().trim()) hideSelCopy();
    });
    // 按下按钮时不让选区丢失
    els.selCopy.addEventListener('mousedown', (e) => e.preventDefault());
    els.selCopy.addEventListener('click', copySelection);

    // 滚动：同步大纲高亮
    let ticking = false;
    els.scroller.addEventListener('scroll', () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        updateActiveToc();
      });
    });
    // Ctrl + 滚轮缩放
    const wheelZoom = (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setZoom((state.settings.zoom || 1) + (e.deltaY < 0 ? 0.1 : -0.1));
    };
    els.scroller.addEventListener('wheel', wheelZoom, { passive: false });
    els.editor.addEventListener('wheel', wheelZoom, { passive: false });

    // 大纲点击
    els.toc.addEventListener('click', (e) => {
      const a = e.target.closest('a[data-id]');
      if (!a) return;
      e.preventDefault();
      scrollToAnchor(a.dataset.id);
    });

    // 文件树
    els.tree.addEventListener('click', (e) => {
      const row = e.target.closest('.tree-row');
      if (!row) return;
      if (row.dataset.type === 'dir') {
        const key = lower(row.dataset.path);
        if (state.expanded.has(key)) state.expanded.delete(key);
        else state.expanded.add(key);
        renderTree();
      } else if (!state.doc || !samePath(row.dataset.path, state.doc.path)) {
        openDocument(row.dataset.path);
      }
    });
    els.treeFilter.addEventListener('input', debounce(renderTree, 120));
    els.treeFilter.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        els.treeFilter.value = '';
        renderTree();
      } else if (e.key === 'Enter') {
        const first = els.tree.querySelector('.tree-row.file');
        if (first) openDocument(first.dataset.path);
      }
    });

    // 最近打开
    els.recentList.addEventListener('click', async (e) => {
      const rm = e.target.closest('[data-remove]');
      if (rm) {
        e.stopPropagation();
        renderRecent(await api.removeRecent(rm.dataset.remove));
        return;
      }
      const li = e.target.closest('li[data-path]');
      if (li) openPathString(li.dataset.path);
    });

    // 状态栏路径：在资源管理器中显示
    els.stPath.addEventListener('click', () => state.doc && api.showInFolder(state.doc.path));

    // 查找栏
    const findDebounced = debounce(() => runFind(true), 150);
    els.findInput.addEventListener('input', findDebounced);
    els.findInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (!state.find.hits.length) runFind(true);
        else setFindIndex(state.find.index + (e.shiftKey ? -1 : 1));
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeFind();
      }
    });
    $('#mdr-find-next').addEventListener('click', () => setFindIndex(state.find.index + 1));
    $('#mdr-find-prev').addEventListener('click', () => setFindIndex(state.find.index - 1));
    $('#mdr-find-close').addEventListener('click', closeFind);

    // 全局按键
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        hideSelCopy();
        if (!els.modal.hidden) els.modal.hidden = true;
        else closeFind();
      } else if (e.key === 'F3') {
        e.preventDefault();
        if (els.findBar.hidden) openFind();
        else setFindIndex(state.find.index + (e.shiftKey ? -1 : 1));
      }
    });
    els.modal.addEventListener('click', (e) => {
      if (e.target === els.modal) els.modal.hidden = true;
    });

    // 鼠标侧键：后退 / 前进
    window.addEventListener('mouseup', (e) => {
      if (e.button === 3) {
        e.preventDefault();
        go(-1);
      } else if (e.button === 4) {
        e.preventDefault();
        go(1);
      }
    });

    // 侧栏宽度拖动
    els.resizer.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const left = els.sidebar.getBoundingClientRect().left;
      els.body.classList.add('resizing');
      const move = (ev) => setSidebarWidth(ev.clientX - left, false);
      const up = (ev) => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        els.body.classList.remove('resizing');
        setSidebarWidth(ev.clientX - left, true);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
    els.resizer.addEventListener('dblclick', () => setSidebarWidth(260, true));

    // 拖放文件 / 文件夹
    let dragDepth = 0;
    const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    window.addEventListener('dragenter', (e) => {
      e.preventDefault();
      if (!hasFiles(e)) return;
      dragDepth++;
      els.dropOverlay.hidden = false;
    });
    window.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = hasFiles(e) ? 'copy' : 'none';
    });
    window.addEventListener('dragleave', () => {
      if (dragDepth > 0 && --dragDepth === 0) els.dropOverlay.hidden = true;
    });
    window.addEventListener('drop', async (e) => {
      e.preventDefault();
      dragDepth = 0;
      els.dropOverlay.hidden = true;
      const file = e.dataTransfer && e.dataTransfer.files[0];
      if (!file) return;
      const p = api.getPathForFile(file);
      if (!p) return;
      const st = await api.statPath(p);
      if (st.type === 'dir') openFolder(p);
      else if (st.type === 'file') openDocument(p);
    });
  }

  // ---------- 启动 ----------
  async function init() {
    state.settings = (await api.getSettings()) || {};
    const s = state.settings;
    els.body.classList.toggle('no-sidebar', s.sidebarVisible === false);
    els.body.classList.toggle('no-outline', s.outlineVisible === false);
    setSidebarWidth(s.sidebarWidth || 260, false);
    setZoom(s.zoom || 1);
    updateThemeButton();
    updateNavButtons();
    renderToc([]);
    bindEvents();
    renderRecent();

    const initial = await api.getInitialPath();
    const lastFolder = s.lastFolder;
    if (lastFolder && !(initial && initial.type === 'dir') && (!initial || isUnder(initial.path, lastFolder))) {
      const ok = await openFolder(lastFolder, { silent: true, autoOpen: false });
      if (!ok) api.setSettings({ lastFolder: null });
    }
    if (initial) await openPathInfo(initial);
  }

  init().catch((e) => toast('初始化失败：' + e.message, true));
})();
