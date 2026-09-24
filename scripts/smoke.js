'use strict';
// 冒烟测试：用临时数据目录启动应用，打开示例文档，检查界面状态并截图。
// 用法：npx electron scripts/smoke.js   （结果输出到控制台，截图保存在临时目录）
const { app, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mdr-smoke-'));
app.setPath('userData', path.join(tmp, 'userData'));

// ---------- 示例文档 ----------
const docs = path.join(tmp, '文档');
fs.mkdirSync(path.join(docs, '子目录'), { recursive: true });
fs.mkdirSync(path.join(docs, 'img'), { recursive: true });
fs.copyFileSync(path.join(__dirname, '..', 'assets', 'icon.png'), path.join(docs, 'img', '图标.png'));
const main = path.join(docs, '说明.md');
fs.writeFileSync(
  main,
  `---
title: 冒烟测试文档
author: 测试
---

# 冒烟测试

这是一段**中文**正文，包含 \`行内代码\`、[外部链接](https://example.com) 和 [第二篇的第二节](子目录/第二篇.md#第二节)。

## 表格

| 名称 | 数量 | 说明 |
| --- | ---: | --- |
| 苹果 | 3 | 红色 |
| 香蕉 | 12 | 黄色 |

## 代码

\`\`\`js
function hello(name) {
  // 注释
  return \`你好，\${name}\`;
}
\`\`\`

## 任务列表

- [x] 已完成
- [ ] 未完成

## 图片

![图标](img/图标.png)

## Content

同名 id 不应影响界面布局。

<details><summary>折叠内容</summary>

里面有一个关键词：苹果

</details>

<script>document.title = 'XSS-script'</script>
<img src="nope.png" onerror="document.title='XSS-onerror'">

## 重复标题
## 重复标题

${'段落填充。'.repeat(40)}

${Array.from({ length: 30 }, (_, i) => `### 小节 ${i + 1}\n\n${'内容 '.repeat(30)}\n`).join('\n')}
`,
);
fs.writeFileSync(path.join(docs, '子目录', '第二篇.md'), `# 第二篇\n\n## 第一节\n\n${'文字。'.repeat(300)}\n\n## 第二节\n\n到达这里。\n`);
fs.writeFileSync(path.join(docs, 'README.md'), '# README\n\n首页\n');

process.argv.push(main);
require('../src/main.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 轮询直到条件成立（窗口在后台时计时器会被节流，固定等待不可靠）
async function until(fn, ms = 3000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (await fn()) return true;
  return fn();
}
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

app.on('browser-window-created', (_e, win) => {
  const errors = [];
  win.webContents.on('console-message', (e, level, message) => {
    const msg = e && e.message !== undefined ? e.message : message;
    const lvl = e && e.level !== undefined ? e.level : level;
    if (lvl === 'error' || lvl === 'warning' || lvl >= 2) errors.push(msg);
  });
  win.webContents.once('did-finish-load', async () => {
    const js = (code) => win.webContents.executeJavaScript(code);
    const shot = async (name) => {
      const img = await win.webContents.capturePage();
      const file = path.join(tmp, name + '.png');
      fs.writeFileSync(file, img.toPNG());
      console.log('截图：' + file);
    };
    try {
      win.setSize(1280, 820);
      await sleep(1500);

      const s = await js(`(() => {
        const c = document.querySelector('#mdr-content');
        const img = c.querySelector('img[alt="图标"]');
        return {
          title: document.title,
          empty: document.body.classList.contains('empty'),
          toc: document.querySelectorAll('#mdr-toc a').length,
          treeFiles: document.querySelectorAll('#mdr-tree .tree-row').length,
          activeRow: (document.querySelector('#mdr-tree .tree-row.active') || {}).textContent,
          tables: c.querySelectorAll('.table-wrap > table:not(.front-matter table)').length,
          copyBtns: c.querySelectorAll('.code-copy').length,
          hl: c.querySelectorAll('.hljs-keyword').length,
          tasks: c.querySelectorAll('.task-list-item-checkbox').length,
          imgOk: !!img && img.complete && img.naturalWidth > 0,
          imgSrc: img && img.src,
          scripts: c.querySelectorAll('script').length,
          onerror: c.querySelectorAll('[onerror]').length,
          contentId: !!c.querySelector('[id="content"]'),
          contentWidth: c.getBoundingClientRect().width,
          front: !!c.querySelector('details.front-matter'),
          docTitle: document.querySelector('#mdr-doc-title').textContent,
          status: document.querySelector('#mdr-statusbar').textContent.replace(/\\s+/g, ' ').trim(),
          dupIds: [...c.querySelectorAll('h2')].map(h => h.id).filter(id => id.startsWith('重复标题')),
        };
      })()`);
      check('窗口标题', s.title === '说明.md - QH阅读', s.title);
      check('显示文档（非欢迎页）', !s.empty);
      check('大纲条目', s.toc >= 35, String(s.toc));
      check('文件树列出 2 个文件 + 1 个子目录', s.treeFiles === 3, String(s.treeFiles));
      check('文件树高亮当前文件', s.activeRow === '说明.md', s.activeRow);
      check('表格包装', s.tables === 1);
      check('代码复制按钮', s.copyBtns === 1);
      check('代码高亮', s.hl > 0, String(s.hl));
      check('任务列表复选框', s.tasks === 2);
      check('相对路径图片加载（中文文件名）', s.imgOk, s.imgSrc);
      check('script 被移除', s.scripts === 0);
      check('事件属性被移除', s.onerror === 0 && !s.title.includes('XSS'));
      check('标题 id=content 不影响布局', s.contentId && s.contentWidth > 600, String(s.contentWidth));
      check('front matter', s.front);
      check('工具栏显示 front matter 标题', s.docTitle.includes('冒烟测试文档'), s.docTitle);
      check('状态栏统计', /字/.test(s.status) && /行/.test(s.status) && /UTF-8/.test(s.status), s.status);
      check('重复标题 id 去重', s.dupIds.length === 2 && s.dupIds[0] !== s.dupIds[1], s.dupIds.join(','));
      await shot('1-文档-浅色');

      // 菜单快捷键在隐藏菜单栏后仍然有效
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'F1' });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'F1' });
      const keyOk = await until(() => js(`!document.querySelector('#mdr-modal').hidden`));
      check('快捷键 F1 打开快捷键说明', keyOk);
      await shot('0-快捷键');
      await js(`document.querySelector('#mdr-modal').hidden = true`);
      const pad = await js(`getComputedStyle(document.querySelector('.tb-main')).paddingRight`);
      check('工具栏为窗口按钮留出空间', parseFloat(pad) > 100, pad);

      // 查找
      const f = await js(`(async () => {
        document.querySelector('[data-action="find"]').click();
        const input = document.querySelector('#mdr-find-input');
        input.value = '苹果';
        input.dispatchEvent(new Event('input'));
        await new Promise(r => setTimeout(r, 400));
        return { count: document.querySelector('#mdr-find-count').textContent, hits: document.querySelectorAll('mark.find-hit').length };
      })()`);
      check('文内查找', f.hits === 2 && /\/2$/.test(f.count), JSON.stringify(f));
      await shot('2-查找');
      const f2 = await js(`(async () => {
        document.querySelector('#mdr-find-close').click();
        return { marks: document.querySelectorAll('mark.find-hit').length, text: document.querySelector('#mdr-content').textContent.includes('苹果') };
      })()`);
      check('关闭查找后清除高亮并还原文本', f2.marks === 0 && f2.text);

      // 选中文字 → 快捷复制按钮
      clipboard.writeText('');
      const sc = await js(`(async () => {
        const code = document.querySelector('#mdr-content pre code');
        const range = document.createRange();
        range.selectNodeContents(code);
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        document.querySelector('#mdr-scroller').dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
        await new Promise(r => setTimeout(r, 100));
        const btn = document.querySelector('#mdr-sel-copy');
        return { visible: !btn.hidden, top: btn.style.top, left: btn.style.left };
      })()`);
      check('选中文字后出现复制按钮', sc.visible && !!sc.top, JSON.stringify(sc));
      await shot('2b-选中复制');
      await js(`document.querySelector('#mdr-sel-copy').click()`);
      await until(() => clipboard.readText() !== '');
      const copied = clipboard.readText();
      check('点击按钮复制选中内容', copied.includes('function hello(name)') && !copied.includes('复制'), JSON.stringify(copied.slice(0, 40)));
      const hiddenAfter = await js(`document.querySelector('#mdr-sel-copy').hidden`);
      check('复制后按钮隐藏', hiddenAfter);

      // Ctrl+C
      clipboard.writeText('');
      await js(`(() => {
        const p = [...document.querySelectorAll('#mdr-content p')].find(p => p.textContent.startsWith('这是一段'));
        const range = document.createRange();
        range.selectNodeContents(p);
        getSelection().removeAllRanges();
        getSelection().addRange(range);
      })()`);
      win.webContents.copy();
      await until(() => clipboard.readText() !== '');
      check('复制（编辑菜单 / Ctrl+C）', clipboard.readText().startsWith('这是一段中文正文'), JSON.stringify(clipboard.readText().slice(0, 20)));
      await js(`getSelection().removeAllRanges()`);

      // 大纲点击滚动
      const t = await js(`(async () => {
        const a = [...document.querySelectorAll('#mdr-toc a')].find(a => a.textContent === '小节 20');
        a.click();
        await new Promise(r => setTimeout(r, 200));
        return { top: document.querySelector('#mdr-scroller').scrollTop, active: (document.querySelector('#mdr-toc a.active') || {}).textContent };
      })()`);
      check('大纲跳转并高亮', t.top > 500 && t.active === '小节 20', JSON.stringify(t));

      // 跨文件链接 + 锚点，然后后退
      const l = await js(`(async () => {
        const a = [...document.querySelectorAll('#mdr-content a')].find(a => a.textContent === '第二篇的第二节');
        a.click();
        await new Promise(r => setTimeout(r, 800));
        const r1 = { title: document.title, top: document.querySelector('#mdr-scroller').scrollTop, back: !document.querySelector('#mdr-btn-back').disabled };
        document.querySelector('#mdr-btn-back').click();
        await new Promise(r => setTimeout(r, 800));
        r1.afterBack = document.title;
        r1.restoredTop = document.querySelector('#mdr-scroller').scrollTop;
        return r1;
      })()`);
      check('相对链接打开另一篇', l.title === '第二篇.md - QH阅读', l.title);
      check('链接锚点定位', l.top > 100, String(l.top));
      check('后退回到原文档并恢复位置', l.afterBack === '说明.md - QH阅读' && l.restoredTop > 500, JSON.stringify(l));

      // 文件改动自动刷新
      fs.appendFileSync(main, '\n\n## 新增的章节\n');
      await sleep(1500);
      const w = await js(`[...document.querySelectorAll('#mdr-toc a')].some(a => a.textContent === '新增的章节')`);
      check('磁盘改动后自动刷新', w);

      // 缩放
      const z = await js(`(async () => {
        document.querySelector('[data-action="zoom-in"]').click();
        document.querySelector('[data-action="zoom-in"]').click();
        await new Promise(r => setTimeout(r, 100));
        const v = { btn: document.querySelector('#mdr-btn-zoom').textContent, fs: getComputedStyle(document.querySelector('#mdr-content')).fontSize };
        document.querySelector('[data-action="zoom-reset"]').click();
        return v;
      })()`);
      check('缩放', z.btn === '120%' && z.fs === '19.2px', JSON.stringify(z));

      // 编辑模式
      const e1 = await js(`(async () => {
        document.querySelector('#mdr-seg-edit').click();
        await new Promise(r => setTimeout(r, 400));
        const ed = document.querySelector('#mdr-editor');
        return {
          editing: document.body.classList.contains('editing'),
          hasSrc: ed.value.includes('# 冒烟测试'),
          label: document.querySelector('#mdr-seg-edit').classList.contains('on') ? '编辑' : '阅读',
          saveShown: getComputedStyle(document.querySelector('#mdr-btn-save')).display !== 'none',
          focused: document.activeElement === ed,
        };
      })()`);
      check('进入编辑模式并载入源码', e1.editing && e1.hasSrc && e1.label === '编辑' && e1.saveShown && e1.focused, JSON.stringify(e1));
      const e2 = await js(`(async () => {
        const ed = document.querySelector('#mdr-editor');
        ed.setSelectionRange(ed.value.length, ed.value.length);
        document.execCommand('insertText', false, '\\n\\n## 编辑新增标题\\n\\n- 第一项');
        ed.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        const hasHeading = () => [...document.querySelectorAll('#mdr-toc a')].some(a => a.textContent === '编辑新增标题');
        for (let i = 0; i < 30 && !hasHeading(); i++) await new Promise(r => setTimeout(r, 100));
        return {
          title: document.title,
          saveEnabled: !document.querySelector('#mdr-btn-save').disabled,
          preview: [...document.querySelectorAll('#mdr-toc a')].some(a => a.textContent === '编辑新增标题'),
          tail: ed.value.slice(-10),
        };
      })()`);
      check('编辑后右侧实时预览', e2.preview);
      check('未保存标记', e2.title.startsWith('● ') && e2.saveEnabled, e2.title);
      check('回车自动延续列表', e2.tail.endsWith('- 第一项\n- '), JSON.stringify(e2.tail));
      await shot('5-编辑模式');
      win.webContents.send('menu:action', 'save');
      await sleep(800);
      const disk = fs.readFileSync(main, 'utf8');
      check('Ctrl+S 保存到磁盘', disk.includes('## 编辑新增标题\n\n- 第一项\n- '));
      const e3 = await js(`({ title: document.title, saveEnabled: !document.querySelector('#mdr-btn-save').disabled })`);
      check('保存后清除未保存标记', !e3.title.startsWith('●') && !e3.saveEnabled, JSON.stringify(e3));
      await js(`document.querySelector('#mdr-seg-read').click()`);
      await sleep(700);
      const e4 = await js(`({ editing: document.body.classList.contains('editing'), toc: [...document.querySelectorAll('#mdr-toc a')].some(a => a.textContent === '编辑新增标题') })`);
      check('切回阅读模式并显示保存后的内容', !e4.editing && e4.toc, JSON.stringify(e4));

      // 保存时保持 UTF-8 BOM 与 CRLF 换行
      const crlf = path.join(docs, 'crlf.md');
      fs.writeFileSync(crlf, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# 标题\r\n\r\n第一行\r\n', 'utf8')]));
      win.webContents.send('menu:action', 'open-path', crlf);
      await sleep(700);
      win.webContents.send('menu:action', 'toggle-edit');
      await sleep(500);
      await js(`(() => { const ed = document.querySelector('#mdr-editor'); ed.setSelectionRange(ed.value.length, ed.value.length); document.execCommand('insertText', false, '第二行\\n'); })()`);
      win.webContents.send('menu:action', 'save');
      await sleep(700);
      const raw = fs.readFileSync(crlf);
      check('保存保持 BOM 与 CRLF', raw[0] === 0xef && raw.toString('utf8', 3) === '# 标题\r\n\r\n第一行\r\n第二行\r\n', JSON.stringify(raw.toString('utf8', 3)));
      win.webContents.send('menu:action', 'toggle-edit');
      await sleep(500);
      win.webContents.send('menu:action', 'back');
      await sleep(700);

      // 深色主题
      await js(`document.querySelector('#mdr-scroller').scrollTop = 0; window.__t = 0`);
      await js(`(async () => { for (let i = 0; i < 2; i++) document.querySelector('[data-action="cycle-theme"]').click(); })()`);
      await sleep(600);
      const bg = await js(`getComputedStyle(document.body).backgroundColor`);
      check('深色主题', bg === 'rgb(30, 30, 30)', bg);
      await shot('3-文档-深色');

      // 导出 PDF（直接调用 printToPDF，验证打印样式可用）
      const pdf = await win.webContents.printToPDF({ printBackground: true, pageSize: 'A4' });
      fs.writeFileSync(path.join(tmp, 'export.pdf'), pdf);
      check('生成 PDF', pdf.length > 10000, `${pdf.length} 字节`);

      // 关闭文档 → 欢迎页
      await js(`(async () => { document.querySelector('[data-action="cycle-theme"]').click(); })()`);
      await sleep(400);
      const c = await js(`(async () => {
        document.querySelector('#mdr-content').dispatchEvent(new Event('noop'));
        return true;
      })()`);
      win.webContents.send('menu:action', 'close');
      await sleep(500);
      const wl = await js(`({ empty: document.body.classList.contains('empty'), recent: document.querySelectorAll('#mdr-recent-list li[data-path]').length, title: document.title })`);
      check('关闭文档显示欢迎页与最近打开', c && wl.empty && wl.recent >= 2 && wl.title === 'QH阅读', JSON.stringify(wl));
      await shot('4-欢迎页');

      check('无控制台错误', errors.length === 0, errors.join(' | '));
    } catch (e) {
      check('测试脚本异常', false, e.stack);
    }
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - failed}/${results.length} 通过；临时目录：${tmp}`);
    app.exit(failed ? 1 : 0);
  });
});
