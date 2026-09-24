'use strict';
// 验证两个修复：
// 1) 编辑模式左右滚动对齐（按锚点/行号，而非纯比例）
// 2) Markdown 语法速查面板可展开、可点击插入
// 用法：npx electron scripts/verify-fixes.js
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mdr-verify-'));
app.setPath('userData', path.join(tmp, 'userData'));

const docs = path.join(tmp, '文档');
fs.mkdirSync(docs, { recursive: true });
// 长文档：多个标题，让滚动范围足够大
const lines = [];
for (let i = 1; i <= 60; i++) {
  lines.push(`## 章节 ${i}`);
  lines.push('');
  for (let j = 1; j <= 12; j++) lines.push(`这是章节 ${i} 的第 ${j} 段正文内容，用于撑起滚动高度。`);
  lines.push('');
}
const main = path.join(docs, '长文.md');
fs.writeFileSync(main, lines.join('\n'), 'utf8');

process.argv.push(main);
require('../src/main.js');

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + JSON.stringify(detail) : ''}`);
  ok ? pass++ : fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.on('browser-window-created', (_e, win) => {
  const errors = [];
  win.webContents.on('console-message', (e, level, message) => {
    const msg = e && e.message !== undefined ? e.message : message;
    const lvl = e && e.level !== undefined ? e.level : level;
    if (lvl === 'error' || lvl === 'warning' || lvl >= 2) errors.push(msg);
  });
  win.webContents.once('did-finish-load', async () => {
    const js = (code) => win.webContents.executeJavaScript(code);
    try {
      win.setSize(1280, 900);
      await sleep(1500);

      // 进入编辑模式
      await js(`document.querySelector('#mdr-seg-edit').click()`);
      await sleep(600);

      const s1 = await js(`({
        editing: document.body.classList.contains('editing'),
        helpItems: document.querySelectorAll('.md-help-item').length,
        helpHidden: document.querySelector('#mdr-md-help').hidden,
      })`);
      check('进入编辑模式', s1.editing, s1);
      check('语法速查已填充条目', s1.helpItems === 15, s1.helpItems);

      // 1) 滚动对齐：把编辑区滚动到「章节 30」标题行，预览应跟随到该标题
      await js(`(() => {
        const ed = document.querySelector('#mdr-editor');
        const v = ed.value;
        const lines = v.split('\\n');
        const lh = parseFloat(getComputedStyle(ed).lineHeight) || 23.625;
        // 找「## 章节 30」所在行索引
        let idx = -1;
        for (let i = 0; i < lines.length; i++) if (lines[i] === '## 章节 30') { idx = i; break; }
        ed.scrollTop = idx * lh; // 让该标题行位于视口顶部
        return { idx, target: idx * lh };
      })()`);
      await sleep(500);
      const s2 = await js(`(() => {
        const sc = document.querySelector('#mdr-scroller');
        const heads = [...document.querySelectorAll('#mdr-content h2')];
        const viewTop = sc.getBoundingClientRect().top;
        const visible = heads.find(h => h.getBoundingClientRect().top >= viewTop - 6);
        return { firstVisible: visible ? visible.textContent.trim() : null, scrollerTop: Math.round(sc.scrollTop) };
      })()`);
      check('编辑器滚动→预览跟随到对应标题', /章节 3\d/.test(s2.firstVisible || ''), s2);

      // 2) 预览滚动 → 编辑器跟随（滚动位置对应目标行）
      await js(`(() => {
        const sc = document.querySelector('#mdr-scroller');
        const h = [...document.querySelectorAll('#mdr-content h2')].find(x => x.textContent.includes('章节 45'));
        if (!h) return false;
        h.scrollIntoView({ block: 'start' });
        sc.dispatchEvent(new Event('scroll', { bubbles: true }));
        return true;
      })()`);
      await sleep(500);
      const s3 = await js(`(() => {
        const ed = document.querySelector('#mdr-editor');
        const lh = parseFloat(getComputedStyle(ed).lineHeight) || 23.625;
        const lines = ed.value.split('\\n');
        const firstLine = Math.floor(ed.scrollTop / lh) + 1;
        const lastLine = Math.floor((ed.scrollTop + ed.clientHeight) / lh) + 1;
        let found = '';
        for (let i = firstLine - 1; i < Math.min(lastLine, lines.length); i++) {
          if (lines[i].includes('章节 45')) { found = lines[i].trim(); break; }
        }
        return { firstLine, lastLine, found };
      })()`);
      check('预览滚动→编辑器滚动到对应行', /章节 4\d/.test(s3.found || ''), s3);

      // 3) 语法速查展开
      await js(`document.querySelector('#mdr-md-help-toggle').click()`);
      await sleep(150);
      const s4 = await js(`({ open: document.querySelector('#mdr-md-help').dataset.open, expanded: document.querySelector('#mdr-md-help-toggle').getAttribute('aria-expanded'), bodyHidden: document.querySelector('#mdr-md-help-body').hidden })`);
      check('点击速查栏展开', s4.open === '1' && s4.expanded === 'true' && s4.bodyHidden === false, s4);

      // 4) 点击条目插入光标处
      await js(`(() => { const ed = document.querySelector('#mdr-editor'); const pos = ed.value.length; ed.focus(); ed.setSelectionRange(pos, pos); return pos; })()`);
      await js(`(() => { const item = [...document.querySelectorAll('.md-help-item')].find(b => b.textContent.includes('加粗')); item.click(); return true; })()`);
      await sleep(250);
      const s5 = await js(`(() => { const ed = document.querySelector('#mdr-editor'); return { tail: ed.value.slice(-8), endsWith: ed.value.endsWith('**加粗**'), dirty: !document.querySelector('#mdr-btn-save').disabled }; })()`);
      check('点击条目插入语法并标记未保存', s5.endsWith && s5.dirty, s5);

      // 5) 再次点击收起
      await js(`document.querySelector('#mdr-md-help-toggle').click()`);
      await sleep(150);
      const s6 = await js(`({ open: document.querySelector('#mdr-md-help').dataset.open, bodyHidden: document.querySelector('#mdr-md-help-body').hidden })`);
      check('再次点击收起', s6.open === '0' && s6.bodyHidden === true, s6);

      check('无控制台错误', errors.length === 0, errors);
      console.log(`\n${pass}/${pass + fail} 通过`);
      app.exit(fail ? 1 : 0);
    } catch (e) {
      console.error('脚本异常', e);
      app.exit(2);
    }
  });
});
