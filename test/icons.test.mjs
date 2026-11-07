// 种类表：图标和属性页的种类文字查同一张。文件名优先于扩展名，都小写；目录、链接、其他按种类。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { KINDS, SHAPES, icon, iconFor, kindOf } from '../view/icons.mjs';

const label = name => kindOf({ kind: 'file', name }).label;

test('kindOf：每一项都是 { glyph, tone, label }，目录、链接、其他按 kind，不看名字', () => {
  for (const entry of [{ kind: 'dir', name: 'a.png' }, { kind: 'link', name: 'a.js' }, { kind: 'other', name: 'a.js' }, { kind: 'file', name: 'a.js' }]) {
    const kind = kindOf(entry);
    assert.deepEqual(Object.keys(kind).sort(), ['glyph', 'label', 'tone']);
    assert.ok(Object.values(kind).every(value => typeof value === 'string' && value !== ''));
  }
  assert.equal(kindOf({ kind: 'dir', name: 'src' }).label, '文件夹');
  assert.equal(kindOf({ kind: 'link', name: 'x' }).label, '链接');
  assert.equal(kindOf({ kind: 'other', name: 'x' }).label, '特殊文件');
});

test('文件名优先于扩展名：package.json 是包清单不是 JSON，锁文件、许可证、点开头的配置各有种类', () => {
  assert.equal(label('package.json'), '包清单');
  assert.equal(label('tsconfig.json'), 'JSON');
  assert.equal(label('package-lock.json'), '锁文件');
  assert.equal(label('pnpm-lock.yaml'), '锁文件');
  assert.equal(label('config.yaml'), 'YAML / TOML');
  assert.equal(label('LICENSE'), '许可证');
  assert.equal(label('LICENSE.md'), '许可证');
  assert.equal(label('README.md'), 'Markdown 文档');
  assert.equal(label('.gitignore'), 'Git 配置');
  assert.equal(label('.env'), '环境变量');
  assert.equal(label('.env.local'), '环境变量');
  assert.equal(label('Cargo.toml'), '包清单');
  assert.equal(label('Cargo.lock'), '锁文件');
});

test('大小写不影响：文件名和扩展名都按小写查', () => {
  assert.equal(label('PACKAGE.JSON'), '包清单');
  assert.equal(label('Main.TS'), 'TypeScript');
  assert.equal(label('LOGO.PNG'), '图片');
  assert.equal(label('Photo.JPEG'), '图片');
});

test('没有扩展名、点开头、以点结尾、多重扩展名', () => {
  assert.equal(label('Makefile'), '其他文件');
  assert.equal(label('.hidden'), '其他文件', '点开头的整个是名字，没有扩展名：.ts 不是 TypeScript');
  assert.equal(label('.ts'), '其他文件');
  assert.equal(label('trailing.'), '其他文件');
  assert.equal(label('archive.tar.gz'), '压缩包', '只看最后一段');
  assert.equal(label('notes'), '其他文件');
  assert.equal(label('.zshrc'), '其他文件');
});

test('约 30 种：语言、数据、媒体、文档、配置各有自己的种类', () => {
  const expected = {
    'a.md': 'Markdown 文档', 'a.txt': '文本', 'a.ts': 'TypeScript', 'a.tsx': 'TypeScript', 'a.js': 'JavaScript', 'a.mjs': 'JavaScript', 'a.py': 'Python', 'a.go': 'Go',
    'a.rs': 'Rust', 'a.swift': 'Swift', 'a.c': 'C / C++', 'a.hpp': 'C / C++', 'a.java': 'Java / Kotlin', 'a.kt': 'Java / Kotlin', 'a.rb': 'Ruby', 'a.json': 'JSON',
    'a.html': 'HTML / XML', 'a.xml': 'HTML / XML', 'a.css': 'CSS', 'a.toml': 'YAML / TOML', 'a.sh': 'Shell 脚本', 'a.png': '图片', 'a.svg': '图片', 'a.mp4': '视频',
    'a.mp3': '音频', 'a.pdf': 'PDF 文档', 'a.zip': '压缩包', 'a.csv': '表格', 'a.sqlite': '数据库', 'a.woff2': '字体', 'a.sql': '源代码', 'a.vue': '源代码',
  };
  for (const [name, text] of Object.entries(expected)) assert.equal(label(name), text, name);
  assert.ok(new Set(Object.values(expected)).size >= 24);
});

test('iconFor 就是种类表里的 glyph：和 kindOf 同一份，不会两边不一致', () => {
  for (const name of ['a.ts', 'a.png', 'a.md', 'package.json', '.gitignore', 'Makefile', 'LICENSE', 'a.zip']) {
    assert.equal(iconFor({ kind: 'file', name }), kindOf({ kind: 'file', name }).glyph, name);
  }
  assert.equal(iconFor({ kind: 'file', name: 'a.ts' }), 'ts');
  assert.equal(iconFor({ kind: 'file', name: 'a.png' }), 'image');
  assert.equal(iconFor({ kind: 'dir', name: 'a' }), 'folder');
});

// ---- 0.5.0 第 3 步：类型图标和配色 ----

const css = readFileSync(new URL('../view/style.css', import.meta.url), 'utf8');
// 选择器是 selector 的所有规则的内容（:root 有两条：主题变量和色调）。
const block = selector => [...css.matchAll(new RegExp(`^${selector.replace('.', '\\.')} \\{([^}]*)\\}`, 'gm'))].map(match => match[1]).join('\n');
const tonesIn = text => [...text.matchAll(/--tone-([a-z]+):/g)].map(match => match[1]);
const kinds = Object.values(KINDS);
// 有色调的种类：accent 用强调色（文件夹），muted 不上色（链接、特殊文件），其余各有一个 --tone-*。
const palette = [...new Set(kinds.map(kind => kind.tone))].filter(tone => tone !== 'accent' && tone !== 'muted').sort();

// 最小的假 SVG 元素：记下属性、子元素和文字。
function withSvg(t) {
  globalThis.document = { createElementNS: (ns, tag) => ({ ns, tag, attrs: {}, kids: [], text: undefined, setAttribute(k, v) { this.attrs[k] = v; }, append(...n) { this.kids.push(...n); },
    set textContent(value) { this.text = value; } }) };
  t.after(() => { delete globalThis.document; });
}

test('每个种类的 glyph 都有形状，造得出图标；表里没有写却画了的形状也没有', t => {
  withSvg(t);
  for (const [id, kind] of Object.entries(KINDS)) {
    assert.ok(Object.hasOwn(SHAPES, kind.glyph), `${id} 的 glyph「${kind.glyph}」画不出来`);
    const svg = icon(kind.glyph, 22);
    assert.ok(svg.kids.length > 0, kind.glyph);
    assert.ok(svg.kids.every(node => ['path', 'rect', 'circle', 'ellipse', 'text'].includes(node.tag)), kind.glyph);
  }
  const used = new Set(kinds.map(kind => kind.glyph));
  const tools = new Set(['chevron', 'warning', 'back', 'check', 'ellipsis', 'refresh', 'copy', 'window', 'turn', 'search', 'clear']);
  assert.deepEqual(Object.keys(SHAPES).filter(name => !used.has(name) && !tools.has(name)), [], '形状表里有种类表用不到的种类图标');
});

test('一个 glyph 只有一种色调：色调跟着图标走，预览头部和属性页只传图标名也有颜色', t => {
  withSvg(t);
  const tones = new Map();
  for (const { glyph, tone } of kinds) assert.equal(tones.set(glyph, tones.get(glyph) ?? tone).get(glyph), tone, `${glyph} 在两个种类里色调不同`);
  for (const { glyph, tone } of kinds) assert.equal(icon(glyph).attrs.class, tone === 'muted' ? undefined : `tone-${tone}`, glyph);
});

test('每个色调在浅色和深色两组里都有定义，也都有对应的 .tone-* 规则', () => {
  assert.deepEqual(tonesIn(block(':root')).sort(), palette);
  assert.deepEqual(tonesIn(block(':root.coda-dark')).sort(), palette);
  for (const tone of [...palette, 'accent']) assert.match(css, new RegExp(`\\.tone-${tone} \\{ color: var\\(--(tone-${tone}|coda-accent)`), tone);
  assert.ok(palette.length >= 8, '至少八种色调');
});

test('链接和特殊文件不上色：不带色调类，在目录树里跟随 .row.dead 的三级文字色', () => {
  assert.equal(kindOf({ kind: 'link', name: 'x' }).tone, 'muted');
  assert.equal(kindOf({ kind: 'other', name: 'x' }).tone, 'muted');
  assert.match(css, /\.row\.dead \.name, \.row\.dead \.ico \{ color: var\(--coda-tertiary/);
});

test('text 图标：语言类是淡底加字母，字母放在 text 元素里，不指定字体（跟页面）', t => {
  withSvg(t);
  const svg = icon('ts', 22);
  const [back, letters] = svg.kids;
  assert.deepEqual([back.tag, back.attrs.fill, back.attrs.stroke, back.attrs.opacity], ['rect', 'currentColor', 'none', 0.16]);
  assert.equal(letters.tag, 'text');
  assert.equal(letters.text, 'TS');
  assert.equal(letters.attrs['text-anchor'], 'middle');
  assert.equal(letters.attrs['font-family'], undefined);
  assert.equal(icon('font').kids[0].text, 'Aa');
  assert.equal(icon('doc').kids.filter(node => node.tag === 'text').length, 0, '没有文字的图标不带 text');
  assert.equal(JSON.stringify(Object.values(SHAPES)).includes('.500'), false, '数字里没有多余的零');
});

test('带字母的图标只有语言类、Markdown、PDF 和字体（C 只有一个字母，PDF 三个），别的种类不画字', () => {
  const badged = Object.entries(SHAPES).filter(([, { shapes }]) => shapes.some(([tag]) => tag === 'text')).map(([name]) => name).sort();
  assert.deepEqual(badged, ['c', 'font', 'go', 'java', 'js', 'md', 'pdf', 'py', 'rs', 'ruby', 'swift', 'ts']);
});
