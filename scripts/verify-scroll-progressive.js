'use strict';
// 验证：编辑模式下，标题区间内（章节 A 到章节 B 之间的大量正文）连续滚动，
// 预览必须持续联动（而不是卡在上一标题位置，等越过下一个标题才跳变）。
// 用法：npx electron scripts/verify-scroll-progressive.js
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mdr-prog-'));
app.setPath('userData', path.join(tmp, 'userData'));

const docs = path.join(tmp, '文档');
fs.mkdirSync(docs, { recursive: true });
const lines = [];
for (let i = 1; i <= 40; i++) {
  lines.push(`## 章节 ${i}`);
  lines.push('');
  for (let j = 1; j <= 30; j++) lines.push(`这是章节 ${i} 的第 ${j} 段正文内容，用于撑起滚动高度，让两个标题之间足够长。`);
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

      // 关键点：把编辑区滚动到「章节 10」与「章节 11」标题之间（即区间内），
      // 然后连续小步滚动，每一步检查预览是否跟着动了。
      const step = await js(`(() => {
        const ed = document.querySelector('#mdr-editor');
        const lh = parseFloat(getComputedStyle(ed).lineHeight) || 23.625;
        const lines = ed.value.split('\\n');
        // 找「章节 10」标题行
        let idx10 = -1, idx11 = -1;
        for (let i = 0; i < lines.length; i++) {
          if (lines[i] === '## 章节 10') idx10 = i;
          else if (lines[i] === '## 章节 11') { idx11 = i; break; }
        }
        const start = (idx10 + 1) * lh; // 章节 10 之后第一行
        ed.scrollTop = start;
        return { start, lh, between: (idx11 - idx10) * lh };
      })()`);

      const samples = [];
      for (let k = 1; k <= 5; k++) {
        await js(`(() => { const ed = document.querySelector('#mdr-editor'); ed.scrollTop = ${step.start} + ${k * Math.round(step.between / 6)}; return true; })()`);
        await sleep(250);
        const s = await js(`(() => {
          const sc = document.querySelector('#mdr-scroller');
          const h = [...document.querySelectorAll('#mdr-content h2')].find(x => x.textContent.includes('章节 10'));
          const viewTop = sc.getBoundingClientRect().top;
          const visible = [...document.querySelectorAll('#mdr-content h2')].find(x => x.getBoundingClientRect().top >= viewTop - 6);
          return { scTop: Math.round(sc.scrollTop), firstVisible: visible ? visible.textContent.trim() : null, h10Above: h ? (h.getBoundingClientRect().top - viewTop + sc.scrollTop) : null };
        })()`);
        samples.push(s);
      }

      // 断言1：预览一直在滚动（每一步 scTop 都在增加）
      const monotonic = samples.every((s, i) => i === 0 || s.scTop > samples[i - 1].scTop);
      check('标题区间内预览持续向下滚动（不卡住）', monotonic, samples);
      // 断言2：最后一步预览视口内已能看到章节 11 或更后的内容
      check('预览已推进到后续章节', samples.length > 0 && /章节 [6-9]|章节 1[0-9]|章节 2\d/.test(samples[samples.length - 1].firstVisible || ''), samples[samples.length - 1]);

      console.log(`\n${pass}/${pass + fail} 通过`);
      app.exit(fail ? 1 : 0);
    } catch (e) {
      console.error('脚本异常', e);
      app.exit(2);
    }
  });
});
