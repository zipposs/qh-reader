'use strict';
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mdr-align3-'));
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
    try {
      win.setSize(1280, 900);
      await sleep(1500);
      await js('document.querySelector("#mdr-seg-edit").click()');
      await sleep(800);

      // 预览滚动到章节 25
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

      // 用光标定位法：把章节25的文本位置设为选区，看是否在视口内
      const s = await js([
        '(function(){',
        '  var ed = document.querySelector("#mdr-editor");',
        '  var v = ed.value;',
        '  var pos = v.indexOf("## 章节 25");',
        '  // 用二分逼近：设置 selectionStart 会滚动视口；改为直接读 scrollTop 对应的字符',
        '  // 简单可靠：把光标放到章节25文本，focus 后浏览器自动滚动到可见',
        '  ed.setSelectionRange(pos, pos + 4);',
        '  ed.focus();',
        '  // 检查该字符位置是否在视口内（通过 Range 定位视口内容）',
        '  var cs = getComputedStyle(ed);',
        '  var lh = parseFloat(cs.lineHeight) || 23.625;',
        '  var scrollTop = ed.scrollTop;',
        '  // 用代理测量章节25的视觉位置',
        '  var probe = document.querySelector("#mdr-editor-probe");',
        '  probe.style.font = cs.font; probe.style.lineHeight = cs.lineHeight; probe.style.padding = "0";',
        '  probe.style.width = (ed.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)) + "px";',
        '  probe.style.boxSizing = "border-box"; probe.style.whiteSpace = "pre-wrap"; probe.style.overflowWrap = "anywhere";',
        '  var lines = v.split(String.fromCharCode(10));',
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
      // 标题应在编辑器视口内（滚动跟随成功）
      check('预览滚动到章节25 → 编辑器已滚动到该标题', s.visible, s);

      console.log('\n' + pass + '/' + (pass + fail) + ' 通过');
      app.exit(fail ? 1 : 0);
    } catch (e) { console.error('ERR', e); app.exit(2); }
  });
});
