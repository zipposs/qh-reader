'use strict';
// Markdown 渲染：markdown-it + highlight.js，附带标题锚点 / 目录、任务列表、front matter
const MarkdownIt = require('markdown-it');
const hljs = require('highlight.js');

const MD_EXTENSIONS = new Set(['.md', '.markdown', '.mdown', '.mkd', '.mdtxt', '.mdtext', '.txt']);

const md = new MarkdownIt({
  html: true,
  linkify: true,
  breaks: false,
  typographer: false,
  highlight(code, lang) {
    const language = (lang || '').trim().split(/\s+/)[0].toLowerCase();
    let inner = '';
    let cls = '';
    if (language && hljs.getLanguage(language)) {
      try {
        inner = hljs.highlight(code, { language, ignoreIllegals: true }).value;
        cls = ' language-' + md.utils.escapeHtml(language);
      } catch {
        inner = '';
      }
    }
    if (!inner) inner = md.utils.escapeHtml(code);
    return `<pre class="hljs" data-lang="${md.utils.escapeHtml(language)}"><code class="hljs${cls}">${inner}</code></pre>`;
  },
});

// 任务列表：- [ ] / - [x]
md.core.ruler.push('task_lists', (state) => {
  const tokens = state.tokens;
  for (let i = 2; i < tokens.length; i++) {
    const inline = tokens[i];
    if (inline.type !== 'inline' || !inline.children || !inline.children.length) continue;
    if (tokens[i - 1].type !== 'paragraph_open' || tokens[i - 2].type !== 'list_item_open') continue;
    const first = inline.children[0];
    if (first.type !== 'text') continue;
    const m = first.content.match(/^\[([ xX])\](?:\s+|$)/);
    if (!m) continue;
    first.content = first.content.slice(m[0].length);
    const checked = m[1] !== ' ';
    const box = new state.Token('html_inline', '', 0);
    box.content = `<input class="task-list-item-checkbox" type="checkbox" disabled${checked ? ' checked' : ''}> `;
    inline.children.unshift(box);
    const li = tokens[i - 2];
    li.attrJoin('class', 'task-list-item');
    for (let j = i - 3; j >= 0; j--) {
      const t = tokens[j];
      if ((t.type === 'bullet_list_open' || t.type === 'ordered_list_open') && t.level === li.level - 1) {
        if (!(t.attrGet('class') || '').includes('contains-task-list')) t.attrJoin('class', 'contains-task-list');
        break;
      }
    }
  }
});

// 标题锚点 + 目录
function slugify(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '')
    .replace(/\s+/g, '-');
}

md.core.ruler.push('heading_anchors', (state) => {
  const toc = (state.env.toc = []);
  const used = new Map();
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== 'heading_open') continue;
    const inline = tokens[i + 1];
    const text = (inline && inline.children ? inline.children : [])
      .filter((c) => c.type === 'text' || c.type === 'code_inline')
      .map((c) => c.content)
      .join('')
      .trim();
    let slug = slugify(text) || 'heading';
    if (used.has(slug)) {
      const n = used.get(slug) + 1;
      used.set(slug, n);
      slug = `${slug}-${n}`;
    } else {
      used.set(slug, 0);
    }
    t.attrSet('id', slug);
    toc.push({ level: Number(t.tag.slice(1)), text, id: slug });
  }
});

// front matter（--- 开头的 YAML 元数据）
function splitFrontMatter(text) {
  const m = text.match(/^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!m) return { body: text, meta: null };
  const meta = [];
  for (const line of m[1].split(/\r?\n/)) {
    const mm = line.match(/^([\w一-鿿-]+)\s*:\s*(.*)$/);
    if (mm) meta.push([mm[1], mm[2].trim().replace(/^(["'])(.*)\1$/, '$2')]);
  }
  return { body: text.slice(m[0].length), meta };
}

function renderMeta(meta) {
  const rows = meta
    .map(([k, v]) => `<tr><th>${md.utils.escapeHtml(k)}</th><td>${md.utils.escapeHtml(v)}</td></tr>`)
    .join('');
  return `<details class="front-matter"><summary>文档属性</summary><table>${rows}</table></details>\n`;
}

function renderMarkdown(text) {
  const { body, meta } = splitFrontMatter(text);
  const env = {};
  let html = md.render(body, env);
  let title = '';
  if (meta && meta.length) {
    html = renderMeta(meta) + html;
    const t = meta.find(([k]) => k.toLowerCase() === 'title');
    if (t) title = t[1];
  }
  return { html, toc: env.toc || [], title };
}

module.exports = { renderMarkdown, MD_EXTENSIONS, slugify };
