'use strict';
// 验证：编辑模式下左右滚动按大纲标题精确对齐（含超长行自动折行场景）。
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mdr-align-'));
app.setPath('userData', path.join(tmp, 'userData'));
const docs = path.join(tmp, '文档');
fs.mkdirSync(docs, { recursive: true });
const lines = [];
for (let i = 1; i <= 30; i++) {
  lines.push('## 章节 ' + i);
  lines.push('');
  lines.push('这一行非常非常长，' + '很长很长很长的内容'.repeat(40) + '（章节 ' + i + ' 的折行长行，用来撑起视觉高度）。');
  for (let j = 1; j <= 6; j++) lines.push('这是章节 ' + i + ' 的第 ' + j + ' 段正文。');
  lines.push('');
}
const main = path.join(docs, '长文.md');
fs.writeFileSync(main, lines.join('\n'), 'utf8');
process.argv.push(main);
require('../src/main.js');
let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  — ' + JSON.stringify(detail) : ''));
  ok ? pass++ : fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.on('browser-window-created', (_e, win) => {
  win.webContents.once('did-finish-load', async () => {
    const js = (code) => win.webContents.executeJavaScript(code);
    const setupProbe = [
      '(function(){',
      '  var ed = document.querySelector("#mdr-editor");',
      '  var probe = document.querySelector("#mdr-editor-probe");',
      '  var cs = getComputedStyle(ed);',
      '  probe.style.font = cs.font; probe.style.lineHeight = cs.lineHeight;',
      '  probe.style.padding = "0";',
      '  probe.style.width = (ed.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)) + "px";',
      '  probe.style.boxSizing = "border-box";',
      '  probe.style.whiteSpace = "pre-wrap"; probe.style.overflowWrap = "anywhere";',
      '  return ed.clientWidth;',
      '})()'
    ].join('\n');
    try {
      win.setSize(1280, 900);
      await sleep(1500);
      await js('document.querySelector("#mdr-seg-edit").click()');
      await sleep(800);
      await js(setupProbe);

      // 方向1：编辑器滚动到「章节 15」标题，预览应对准章节 15（±1）
      const r1 = await js([
        '(function(){',
        '  var ed = document.querySelector("#mdr-editor");',
        '  var probe = document.querySelector("#mdr-editor-probe");',
        '  var lines = ed.value.split(String.fromCharCode(10));',
        '  var idx = -1;',
        '  for (var i = 0; i < lines.length; i++) if (lines[i] === "## 章节 15") { idx = i; break; }',
        '  probe.textContent = lines.slice(0, idx).join(String.fromCharCode(10)) + String.fromCharCode(10);',
        '  var target = Math.round(probe.getBoundingClientRect().height);',
        '  ed.scrollTop = target;',
        '  ed.dispatchEvent(new Event("scroll", { bubbles: true }));',
        '  return { target: target, edTop: Math.round(ed.scrollTop) };',
        '})()'
      ].join('\n'));
      await sleep(600);
      const s1 = await js([
        '(function(){',
        '  var sc = document.querySelector("#mdr-scroller");',
        '  var viewTop = sc.getBoundingClientRect().top;',
        '  var heads = document.querySelectorAll("#mdr-content h2");',
        '  var visible = null;',
        '  for (var k = 0; k < heads.length; k++) { if (heads[k].getBoundingClientRect().top >= viewTop - 25) { visible = heads[k]; break; } }',
        '  return { scTop: Math.round(sc.scrollTop), firstVisible: visible ? visible.textContent.trim() : null };',
        '})()'
      ].join('\n'));
      const m1 = s1.firstVisible ? s1.firstVisible.match(/(\d+)/) : null;
      check('编辑器滚动到章节15 → 预览对准15', m1 ? Math.abs(+m1[1] - 15) <= 1 : false, { ...r1, ...s1 });

      // 方向2：编辑器滚动到「章节 5」，预览应回退到章节 5
      const r2 = await js([
        '(function(){',
        '  var ed = document.querySelector("#mdr-editor");',
        '  var probe = document.querySelector("#mdr-editor-probe");',
        '  var lines = ed.value.split(String.fromCharCode(10));',
        '  var idx = -1;',
        '  for (var i = 0; i < lines.length; i++) if (lines[i] === "## 章节 5") { idx = i; break; }',
        '  probe.textContent = lines.slice(0, idx).join(String.fromCharCode(10)) + String.fromCharCode(10);',
        '  var target = Math.round(probe.getBoundingClientRect().height);',
        '  ed.scrollTop = target;',
        '  ed.dispatchEvent(new Event("scroll", { bubbles: true }));',
        '  return { target: target };',
        '})()'
      ].join('\n'));
      await sleep(600);
      const s2 = await js([
        '(function(){',
        '  var sc = document.querySelector("#mdr-scroller");',
        '  var viewTop = sc.getBoundingClientRect().top;',
        '  var heads = document.querySelectorAll("#mdr-content h2");',
        '  var visible = null;',
        '  for (var k = 0; k < heads.length; k++) { if (heads[k].getBoundingClientRect().top >= viewTop - 25) { visible = heads[k]; break; } }',
        '  return { firstVisible: visible ? visible.textContent.trim() : null };',
        '})()'
      ].join('\n'));
      const m2 = s2.firstVisible ? s2.firstVisible.match(/(\d+)/) : null;
      check('编辑器滚动到章节5 → 预览回退到5', m2 ? Math.abs(+m2[1] - 5) <= 1 : false, { ...r2, ...s2 });

      // 方向3：预览滚动到章节 25 → 编辑器跟随（用 probe 整段测量判断编辑器 scrollTop 落在哪章）
      await js([
        '(function(){',
        '  var sc = document.querySelector("#mdr-scroller");',
        '  var h = null;',
        '  var heads = document.querySelectorAll("#mdr-content h2");',
        '  for (var k = 0; k < heads.length; k++) if (heads[k].textContent.indexOf("章节 25") >= 0) { h = heads[k]; break; }',
        '  if (!h) return false;',
        '  h.scrollIntoView({ block: "start" });',
        '  sc.dispatchEvent(new Event("scroll", { bubbles: true }));',
        '  return true;',
        '})()'
      ].join('\n'));
      await sleep(600);
      const s3 = await js([
        '(function(){',
        '  var ed = document.querySelector("#mdr-editor");',
        '  var probe = document.querySelector("#mdr-editor-probe");',
        '  var cs = getComputedStyle(ed);',
        '  probe.style.font = cs.font; probe.style.lineHeight = cs.lineHeight; probe.style.padding = "0";',
        '  probe.style.width = (ed.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)) + "px";',
        '  probe.style.boxSizing = "border-box"; probe.style.whiteSpace = "pre-wrap"; probe.style.overflowWrap = "anywhere";',
        '  var lines = ed.value.split(String.fromCharCode(10));',
        '  var idx = -1;',
        '  for (var i = 0; i < lines.length; i++) if (lines[i] === "## 章节 25") { idx = i; break; }',
        '  probe.textContent = lines.slice(0, idx).join(String.fromCharCode(10)) + String.fromCharCode(10);',
        '  var titleTop = probe.getBoundingClientRect().height;',
        '  var titleBottom = titleTop + probe.getBoundingClientRect().height;',
        '  probe.textContent = "## 章节 25" + String.fromCharCode(10);',
        '  titleBottom = titleTop + probe.getBoundingClientRect().height;',
        '  return { scrollTop: Math.round(ed.scrollTop), titleTop: Math.round(titleTop), titleBottom: Math.round(titleBottom), visible: titleTop >= ed.scrollTop && titleTop <= ed.scrollTop + ed.clientHeight };',
        '})()'
      ].join('\n'));
      check('预览滚动到章节25 → 编辑器已滚动到该标题', s3.visible, s3);

      console.log('\n' + pass + '/' + (pass + fail) + ' 通过');
      app.exit(fail ? 1 : 0);
    } catch (e) { console.error('ERR', e); app.exit(2); }
  });
});
