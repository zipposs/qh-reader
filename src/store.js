'use strict';
// 设置持久化：保存在用户数据目录下的 settings.json
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  theme: 'system',
  zoom: 1,
  sidebarVisible: true,
  outlineVisible: true,
  sidebarWidth: 260,
  recent: [],
  lastFolder: null,
  window: null,
};

let cache = null;
let timer = null;

function filePath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function load() {
  if (cache) return cache;
  try {
    cache = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(filePath(), 'utf8')) };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

function flush() {
  clearTimeout(timer);
  timer = null;
  if (!cache) return;
  try {
    fs.mkdirSync(path.dirname(filePath()), { recursive: true });
    fs.writeFileSync(filePath(), JSON.stringify(cache, null, 2), 'utf8');
  } catch (e) {
    console.error('保存设置失败:', e.message);
  }
}

function get() {
  return load();
}

function set(patch) {
  Object.assign(load(), patch);
  clearTimeout(timer);
  timer = setTimeout(flush, 200);
  return cache;
}

module.exports = { get, set, flush };
