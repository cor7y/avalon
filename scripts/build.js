#!/usr/bin/env node
/*
 * 把 index.html 及其 CSS/JS 内联成一个独立的 HTML 文件，方便单文件分发。
 * 用法：node scripts/build.js [输出路径] [--fragment]
 *   --fragment  去掉 <html>/<head>/<body> 外壳，输出可嵌入其他页面骨架的片段
 */
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const args = process.argv.slice(2);
const fragment = args.includes('--fragment');
const out = path.resolve(args.find((a) => !a.startsWith('--')) || path.join(root, 'dist', 'avalon.html'));
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let html = read('index.html');
html = html.replace(/<link rel="stylesheet" href="(css\/[^"]+)">/g, (_, p) => `<style>\n${read(p)}</style>`);
html = html.replace(/<script src="(js\/[^"]+)"><\/script>/g, (_, p) => {
  const code = read(p);
  if (code.includes('</script')) throw new Error(`${p} 中包含 </script，无法内联`);
  return `<script>\n${code}</script>`;
});

if (fragment) {
  html = html
    .replace(/<!doctype html>\s*/i, '')
    .replace(/<\/?html[^>]*>\s*/gi, '')
    .replace(/<\/?head>\s*/gi, '')
    .replace(/<\/?body>\s*/gi, '')
    .replace(/<meta charset[^>]*>\s*/i, '')
    .replace(/<meta name="viewport"[^>]*>\s*/i, '');
}

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);
console.log(`已生成 ${path.relative(process.cwd(), out)}（${(html.length / 1024).toFixed(1)} KB）`);
