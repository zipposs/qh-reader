'use strict';
// 预加载脚本：把主进程能力以受限 API 的形式暴露给页面（contextIsolation + sandbox）
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // 对话框
  openFileDialog: () => ipcRenderer.invoke('dialog:openFile'),
  openFolderDialog: () => ipcRenderer.invoke('dialog:openFolder'),
  // 文件 / 目录
  openFile: (filePath) => ipcRenderer.invoke('file:open', filePath),
  closeFile: () => ipcRenderer.invoke('file:close'),
  // 编辑模式
  getSource: (filePath) => ipcRenderer.invoke('file:source', filePath),
  saveFile: (filePath, text, meta) => ipcRenderer.invoke('file:save', filePath, text, meta),
  renderMarkdown: (text) => ipcRenderer.invoke('md:render', text),
  setDirty: (dirty) => ipcRenderer.send('doc:dirty', dirty),
  confirmUnsaved: (name) => ipcRenderer.invoke('dialog:unsaved', name),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  onSaveThenClose: (cb) => ipcRenderer.on('app:saveThenClose', () => cb()),
  readTree: (dir) => ipcRenderer.invoke('dir:tree', dir),
  statPath: (p) => ipcRenderer.invoke('path:stat', p),
  resolvePath: (base, rel) => ipcRenderer.invoke('path:resolve', base, rel),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  getInitialPath: () => ipcRenderer.invoke('app:initialPath'),
  // 最近打开 / 设置
  getRecent: () => ipcRenderer.invoke('recent:get'),
  removeRecent: (p) => ipcRenderer.invoke('recent:remove', p),
  clearRecent: () => ipcRenderer.invoke('recent:clear'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  setTheme: (theme) => ipcRenderer.invoke('theme:set', theme),
  // 系统
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  copyText: (text) => ipcRenderer.invoke('clipboard:writeText', text),
  showInFolder: (p) => ipcRenderer.invoke('shell:showItemInFolder', p),
  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
  // 导出
  exportHtml: (payload) => ipcRenderer.invoke('export:html', payload),
  exportPdf: (name) => ipcRenderer.invoke('export:pdf', name),
  print: () => ipcRenderer.invoke('print'),
  popupMenu: (x, y) => ipcRenderer.invoke('menu:popup', x, y),
  // 主进程 → 页面 的事件
  onMenu: (cb) => ipcRenderer.on('menu:action', (_e, action, arg) => cb(action, arg)),
  onFileChanged: (cb) => ipcRenderer.on('file:changed', (_e, doc) => cb(doc)),
  onOpenPath: (cb) => ipcRenderer.on('app:openPath', (_e, info) => cb(info)),
  onRecentChanged: (cb) => ipcRenderer.on('recent:changed', () => cb()),
});
