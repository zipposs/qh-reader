'use strict';
// 复现/验证：编辑模式下连续向下滚动（滚轮）时，右侧预览是否跟随。
// 用法：npx electron scripts/verify-scroll-wheel.js
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mdr-wheel-'));
app.setPath('userData', path.join(tmp, 'userData'));

const docs = path.join(tmp, '文档');
fs.mkdirSync(docs, { recursive: true });
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
  win.webContents.once('did-finish-load', async () => {
    const js = (code) => win.webContents.executeJavaScript(code);
    try {
      win.setSize(1280, 900);
      await sleep(1500);
      await js(`document.querySelector('#mdr-seg-edit').click()`);
      await sleep(600);

      // 初始状态
      const init = await js(`({ edTop: document.querySelector('#mdr-editor').scrollTop, scTop: document.querySelector('#mdr-scroller').scrollTop })`);
      check('初始编辑区在顶部', init.edTop === 0, init);

      // 在编辑器上向下滚动（模拟滚轮）
      const edRect = await js(`(() => { const r = document.querySelector('#mdr-editor').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
      for (let i = 0; i < 6; i++) {
        win.webContents.sendInputEvent({ type: 'mouseWheel', x: edRect.x, y: edRect.y, deltaX: 0, deltaY: -400, canScroll: true });
        await sleep(80);
      }
      await sleep(400);
      const s1 = await js(`(() => {
        const ed = document.querySelector('#mdr-editor');
        const sc = document.querySelector('#mdr-scroller');
        return { edTop: Math.round(ed.scrollTop), scTop: Math.round(sc.scrollTop) };
      })()`);
      check('编辑器向下滚动后预览也向下滚动', s1.scTop > 300, s1);

      // 在预览上向下滚动（模拟滚轮）
      const scRect = await js(`(() => { const r = document.querySelector('#mdr-scroller').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
      for (let i = 0; i < 6; i++) {
        win.webContents.sendInputEvent({ type: 'mouseWheel', x: scRect.x, y: scRect.y, deltaX: 0, deltaY: -400, canScroll: true });
        await sleep(80);
      }
      await sleep(400);
      const s2 = await js(`(() => {
        const ed = document.querySelector('#mdr-editor');
        const sc = document.querySelector('#mdr-scroller');
        return { edTop: Math.round(ed.scrollTop), scTop: Math.round(sc.scrollTop) };
      })()`);
      check('预览向下滚动后编辑器也向下滚动', s2.edTop > s1.edTop, s2);

      console.log(`\n${pass}/${pass + fail} 通过`);
      app.exit(fail ? 1 : 0);
    } catch (e) {
      console.error('脚本异常', e);
      app.exit(2);
    }
  });
});
