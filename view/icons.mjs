// 图标：页面里自己画的 SVG，形状近似 SF Symbol，不打包 Apple 的符号，也不用任何第三方素材。颜色都是 currentColor，由 CSS 定：
// 种类图标带 tone-* 类（颜色见 style.css 的 --tone-*），没有色调的（工具条、菜单的图标）跟随所在位置的文字色。
import { invert, lookupByName } from './lookup.mjs';
import { EntryKind } from './protocol.mjs';

const SVG_NS = 'http://www.w3.org/2000/svg';

// 描边图标的 24×24 画法；folder 是填充的，单独标。形状 [标签, 属性, 文字?]：个别形状用自己的 fill、stroke、opacity 盖过根上的，文字放第三项。
const PAGE = [['path', { d: 'M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z' }], ['path', { d: 'M14 3v5h5' }]];
const FILLED = { fill: 'currentColor', stroke: 'none' };
// 语言类：淡底加字母，不是任何语言的徽标；字母用 text，字体跟页面。
const badge = (letters, size = 10.5) => [
  ['rect', { x: 2, y: 3, width: 20, height: 18, rx: 4.5, ...FILLED, opacity: 0.16 }],
  ['text', { x: 12, y: Number((12 + size * 0.36).toFixed(2)), 'text-anchor': 'middle', 'font-size': size, 'font-weight': 700, ...FILLED }, letters],
];
const SHAPES = {
  folder: { fill: true, shapes: [['path', { d: 'M3 7.2C3 5.98 3.98 5 5.2 5h4.05c.6 0 1.17.24 1.59.66L12 6.8h6.8C20.02 6.8 21 7.78 21 9v8.8c0 1.22-.98 2.2-2.2 2.2H5.2C3.98 20 3 19.02 3 17.8V7.2z' }]] },
  doc: { shapes: PAGE },
  text: { shapes: [...PAGE, ['path', { d: 'M9 13h6M9 17h4' }]] },
  code: { shapes: [...PAGE, ['path', { d: 'M10.5 12.5 8.5 15l2 2.5M13.5 12.5l2 2.5-2 2.5' }]] },
  ts: { shapes: badge('TS') },
  js: { shapes: badge('JS') },
  py: { shapes: badge('Py') },
  go: { shapes: badge('Go') },
  rs: { shapes: badge('Rs') },
  swift: { shapes: badge('Sw') },
  c: { shapes: badge('C', 12) },
  java: { shapes: badge('Jv') },
  ruby: { shapes: badge('Rb') },
  md: { shapes: badge('MD', 9.5) },
  pdf: { shapes: badge('PDF', 8) },
  json: { shapes: [['path', { d: 'M9 4C6.5 4 7 7 7 9c0 2-1 3-2.5 3C6 12 7 13 7 15c0 2-.5 5 2 5M15 4c2.5 0 2 3 2 5 0 2 1 3 2.5 3-1.5 0-2.5 1-2.5 3 0 2 .5 5-2 5' }]] },
  html: { shapes: [['path', { d: 'M8.5 7 3.5 12l5 5M15.5 7l5 5-5 5' }]] },
  css: { shapes: [['path', { d: 'M9.5 4 8 20M16 4l-1.5 16M5 9h15M4 15h15' }]] },
  config: { shapes: [['path', { d: 'M4 7h9M17 7h3M4 17h3M11 17h9' }], ['circle', { cx: 15, cy: 7, r: 2.3 }], ['circle', { cx: 9, cy: 17, r: 2.3 }]] },
  shell: { shapes: [['rect', { x: 3, y: 4, width: 18, height: 16, rx: 3.5 }], ['path', { d: 'm7 9.5 3 2.5-3 2.5M12.5 15.5H17' }]] },
  image: { shapes: [['rect', { x: 3, y: 4, width: 18, height: 16, rx: 3 }], ['circle', { cx: 8.7, cy: 9.5, r: 1.6, ...FILLED }], ['path', { d: 'm4 17.5 4.5-4.5 3.5 3.5 3-3 5 5' }]] },
  video: { shapes: [['rect', { x: 3, y: 5, width: 18, height: 14, rx: 3 }], ['path', { d: 'M10 9v6l5-3z', ...FILLED }]] },
  audio: { shapes: [['path', { d: 'M9 18V6l10-2v12' }], ['circle', { cx: 6.5, cy: 18, r: 2.5 }], ['circle', { cx: 16.5, cy: 16, r: 2.5 }]] },
  archive: { shapes: [...PAGE, ['path', { d: 'M10 3h2v2h-2zM12 5h2v2h-2zM10 7h2v2h-2zM12 9h2v2h-2z', ...FILLED }], ['rect', { x: 10, y: 12, width: 4, height: 5, rx: 1, 'stroke-width': 1.5 }]] },
  sheet: { shapes: [['rect', { x: 3, y: 4, width: 18, height: 16, rx: 3 }], ['path', { d: 'M3 10h18M3 15h18M10 10v10' }]] },
  database: { shapes: [['ellipse', { cx: 12, cy: 6, rx: 8, ry: 3 }], ['path', { d: 'M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3' }]] },
  font: { shapes: [['text', { x: 12, y: 17.5, 'text-anchor': 'middle', 'font-size': 16, 'font-weight': 600, ...FILLED }, 'Aa']] },
  lock: { shapes: [['rect', { x: 5, y: 10.5, width: 14, height: 10, rx: 2.5 }], ['path', { d: 'M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5' }]] },
  git: { shapes: [['circle', { cx: 7, cy: 6, r: 2.2 }], ['circle', { cx: 7, cy: 18, r: 2.2 }], ['circle', { cx: 17, cy: 8, r: 2.2 }], ['path', { d: 'M7 8.2v7.6M17 10.2c0 3-3 3.8-10 5' }]] },
  env: { shapes: [['circle', { cx: 8, cy: 12, r: 4 }], ['path', { d: 'M12 12h9M18 12v3.5M21 12v2.5' }]] },
  manifest: { shapes: [['path', { d: 'M12 3 4 7.5v9L12 21l8-4.5v-9L12 3zM4 7.5 12 12l8-4.5M12 12v9' }]] },
  license: { shapes: [...PAGE, ['circle', { cx: 11.5, cy: 13.5, r: 2.5, 'stroke-width': 1.5 }], ['path', { d: 'm10 15.5-1 3.5 2.5-1 2.5 1-1-3.5', 'stroke-width': 1.5 }]] },
  link: { shapes: [['path', { d: 'M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1' }], ['path', { d: 'M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1' }]] },
  other: { shapes: [...PAGE, ['path', { d: 'M9.5 14.5h5' }]] },
  chevron: { shapes: [['path', { d: 'm9 5 7 7-7 7' }]] },
  warning: { shapes: [['path', { d: 'M12 4 2.8 19.5h18.4L12 4z' }], ['path', { d: 'M12 10v4.5M12 17.2v.1' }]] },
  back: { shapes: [['path', { d: 'm15 5-7 7 7 7' }]] },
  check: { shapes: [['path', { d: 'm5 12.5 4.5 4.5L19 7.5' }]] },
  ellipsis: { fill: true, shapes: [['circle', { cx: 5.5, cy: 12, r: 1.7 }], ['circle', { cx: 12, cy: 12, r: 1.7 }], ['circle', { cx: 18.5, cy: 12, r: 1.7 }]] },
  refresh: { shapes: [['path', { d: 'M19 12a7 7 0 1 1-2.05-4.95' }], ['path', { d: 'M19 4.5v3.8h-3.8' }]] },
  copy: { shapes: [['rect', { x: 8.5, y: 8.5, width: 11, height: 11, rx: 2.2 }], ['path', { d: 'M15.5 8.5V6.7a2.2 2.2 0 0 0-2.2-2.2H6.7a2.2 2.2 0 0 0-2.2 2.2v6.6a2.2 2.2 0 0 0 2.2 2.2h1.8' }]] },
  window: { shapes: [['rect', { x: 3.5, y: 5, width: 17, height: 14, rx: 2.5 }], ['path', { d: 'M3.5 9.5h17' }]] },
  search: { shapes: [['circle', { cx: 10.5, cy: 10.5, r: 6 }], ['path', { d: 'm15 15 5.5 5.5' }]] },
  clear: { shapes: [['circle', { cx: 12, cy: 12, r: 8.5 }], ['path', { d: 'm9 9 6 6M15 9l-6 6' }]] },
  turn: { shapes: [['path', { d: 'M5 18v-4a4 4 0 0 1 4-4h10' }], ['path', { d: 'm15 6 4 4-4 4' }]] },
};

// 种类表：种类文字（属性页）和图标（目录树、预览头部）查同一张，不另写一份。
// glyph 是上面 SHAPES 里的图标名，每种一个图标；tone 是色调名，颜色在 style.css 的 --tone-*：accent 是强调色（文件夹），muted 不上色（链接、特殊文件不能打开，跟随三级文字色）。
const KINDS = {
  dir: { glyph: 'folder', tone: 'accent', label: '文件夹' },
  link: { glyph: 'link', tone: 'muted', label: '链接' },
  other: { glyph: 'other', tone: 'muted', label: '特殊文件' },
  file: { glyph: 'doc', tone: 'gray', label: '其他文件' },
  text: { glyph: 'text', tone: 'gray', label: '文本' },
  markdown: { glyph: 'md', tone: 'blue', label: 'Markdown 文档' },
  typescript: { glyph: 'ts', tone: 'blue', label: 'TypeScript' },
  javascript: { glyph: 'js', tone: 'yellow', label: 'JavaScript' },
  python: { glyph: 'py', tone: 'green', label: 'Python' },
  go: { glyph: 'go', tone: 'teal', label: 'Go' },
  rust: { glyph: 'rs', tone: 'orange', label: 'Rust' },
  swift: { glyph: 'swift', tone: 'orange', label: 'Swift' },
  c: { glyph: 'c', tone: 'blue', label: 'C / C++' },
  java: { glyph: 'java', tone: 'red', label: 'Java / Kotlin' },
  ruby: { glyph: 'ruby', tone: 'red', label: 'Ruby' },
  code: { glyph: 'code', tone: 'gray', label: '源代码' },
  json: { glyph: 'json', tone: 'yellow', label: 'JSON' },
  html: { glyph: 'html', tone: 'orange', label: 'HTML / XML' },
  css: { glyph: 'css', tone: 'purple', label: 'CSS' },
  yaml: { glyph: 'config', tone: 'pink', label: 'YAML / TOML' },
  shell: { glyph: 'shell', tone: 'green', label: 'Shell 脚本' },
  image: { glyph: 'image', tone: 'purple', label: '图片' },
  video: { glyph: 'video', tone: 'pink', label: '视频' },
  audio: { glyph: 'audio', tone: 'pink', label: '音频' },
  pdf: { glyph: 'pdf', tone: 'red', label: 'PDF 文档' },
  archive: { glyph: 'archive', tone: 'orange', label: '压缩包' },
  sheet: { glyph: 'sheet', tone: 'green', label: '表格' },
  database: { glyph: 'database', tone: 'teal', label: '数据库' },
  font: { glyph: 'font', tone: 'gray', label: '字体' },
  lock: { glyph: 'lock', tone: 'gray', label: '锁文件' },
  git: { glyph: 'git', tone: 'orange', label: 'Git 配置' },
  env: { glyph: 'env', tone: 'yellow', label: '环境变量' },
  manifest: { glyph: 'manifest', tone: 'green', label: '包清单' },
  license: { glyph: 'license', tone: 'gray', label: '许可证' },
};

// 文件名（小写）优先，再按扩展名（小写）；都不在表里的是「其他文件」。
const NAMES = {
  git: ['.gitignore', '.gitattributes', '.gitmodules', '.gitconfig', '.gitkeep', '.mailmap'],
  env: ['.env', '.envrc'],
  manifest: ['package.json', 'cargo.toml', 'go.mod', 'pyproject.toml', 'requirements.txt', 'gemfile', 'package.swift', 'pom.xml', 'build.gradle', 'composer.json', 'setup.py'],
  lock: ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'cargo.lock', 'gemfile.lock', 'poetry.lock', 'go.sum', 'composer.lock', 'bun.lockb', 'podfile.lock'],
  license: ['license', 'licence', 'copying', 'unlicense', 'license.md', 'license.txt', 'licence.md', 'licence.txt', 'copying.md', 'copying.txt'],
};
const EXTENSIONS = {
  text: ['txt', 'text', 'log', 'rtf'],
  markdown: ['md', 'markdown', 'mdx'],
  typescript: ['ts', 'tsx', 'mts', 'cts'],
  javascript: ['js', 'mjs', 'cjs', 'jsx'],
  python: ['py', 'pyw', 'pyi'],
  go: ['go'],
  rust: ['rs'],
  swift: ['swift'],
  c: ['c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh'],
  java: ['java', 'kt', 'kts'],
  ruby: ['rb', 'erb'],
  code: ['vue', 'scss', 'sass', 'less', 'cs', 'php', 'lua', 'sql', 'dart', 'scala', 'r', 'pl'],
  json: ['json', 'jsonc', 'json5'],
  html: ['html', 'htm', 'xml', 'xhtml', 'plist'],
  css: ['css'],
  yaml: ['yml', 'yaml', 'toml'],
  shell: ['sh', 'bash', 'zsh', 'fish'],
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'heic', 'avif', 'tif', 'tiff'],
  video: ['mp4', 'mov', 'm4v', 'avi', 'mkv', 'webm'],
  audio: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'aiff'],
  pdf: ['pdf'],
  archive: ['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar'],
  sheet: ['csv', 'tsv', 'xls', 'xlsx', 'numbers', 'ods'],
  database: ['db', 'sqlite', 'sqlite3'],
  font: ['ttf', 'otf', 'woff', 'woff2'],
};
const BY_NAME = invert(NAMES), BY_EXT = invert(EXTENSIONS);

// 一个条目的种类：{ glyph, tone, label }。目录、链接、其他按种类；文件先按整个文件名，再按扩展名（点开头的名字没有扩展名）。
// 指向工作目录内的链接按目标的种类显示（条目自己的 kind 已经是目标的）。
export function kindOf({ kind, name }) {
  if (kind === EntryKind.DIR) return KINDS.dir;
  if (kind === EntryKind.LINK) return KINDS.link;
  if (kind === EntryKind.OTHER) return KINDS.other;
  return KINDS[lookupByName(name, BY_NAME, BY_EXT, lower => (lower.startsWith('.env.') ? 'env' : undefined)) ?? 'file'];
}

// 图标名：种类表里的 glyph。
export const iconFor = entry => kindOf(entry).glyph;

// 图标名到色调：从种类表来，一个图标只能有一种色调（icons.test 查）。没有色调（muted）和不在表里的图标（箭头、返回这些）不带类。
const TONE_OF = new Map(Object.values(KINDS).filter(({ tone }) => tone !== 'muted').map(({ glyph, tone }) => [glyph, tone]));

// 造一个 SVG 元素；size 是点数，CSS 可以按平台覆盖。种类图标带 tone-* 类，颜色由 CSS 定。
export function icon(name, size = 16) {
  const { fill = false, shapes } = SHAPES[name];
  const svg = document.createElementNS(SVG_NS, 'svg');
  const attrs = { width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': 'true', ...(fill
    ? { fill: 'currentColor' }
    : { fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }) };
  if (TONE_OF.has(name)) attrs.class = `tone-${TONE_OF.get(name)}`;
  for (const [key, value] of Object.entries(attrs)) svg.setAttribute(key, value);
  for (const [tag, shape, text] of shapes) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(shape)) node.setAttribute(key, value);
    if (text !== undefined) node.textContent = text;
    svg.append(node);
  }
  return svg;
}

// 给测试：两张表本身，不是复制。
export { KINDS, SHAPES };
