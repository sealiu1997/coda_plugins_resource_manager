// 生成真机验收用的大样例（不提交进仓库）：node test/fixtures/html/generate.mjs
// 输出到 test/fixtures/html/generated/（已在 .gitignore 里），每次运行先清空再生成，最后打印每个文件的大小和源节点数。
// 图片用小的编码器现写（PNG、GIF），内容是容易压缩的条纹和渐变：文件小，但声明的像素尺寸和解码后的内存大，正是要测的。
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

// ---- 编码器 ----

const chunk = (type, data) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
};

// 8 位灰度 PNG；pixel(x, y) 返回 0–255。按行生成，不整张放进内存。
export function grayPng(width, height, pixel) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 0; // 灰度
  const deflate = zlib.createDeflate({ level: 6 });
  const parts = [];
  deflate.on('data', part => parts.push(part));
  const row = Buffer.alloc(width + 1); // 第一个字节是滤波类型 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) row[x + 1] = pixel(x, y);
    deflate.write(row);
  }
  deflate.end();
  return new Promise(resolve => deflate.on('end', () => resolve(Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', Buffer.concat(parts)), chunk('IEND', Buffer.alloc(0))]))));
}

// 8 位 RGB PNG，用于小图。
export function rgbPng(width, height, pixel) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) raw.set(pixel(x, y), y * (width * 3 + 1) + 1 + x * 3);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// GIF 的 LZW（最小码长 8，256 色调色板）。
function lzw(indices) {
  const out = [];
  let bits = 0, nbits = 0;
  const emit = (code, width) => {
    bits |= code << nbits;
    nbits += width;
    while (nbits >= 8) { out.push(bits & 255); bits >>>= 8; nbits -= 8; }
  };
  const CLEAR = 256, END = 257;
  let table = new Map(), next = 258, width = 9;
  emit(CLEAR, width);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const key = prefix * 256 + indices[i];
    const hit = table.get(key);
    if (hit !== undefined) { prefix = hit; continue; }
    emit(prefix, width);
    table.set(key, next++);
    if (next > (1 << width) && width < 12) width++;
    if (next >= 4095) { emit(CLEAR, width); table = new Map(); next = 258; width = 9; }
    prefix = indices[i];
  }
  emit(prefix, width);
  emit(END, width);
  if (nbits > 0) out.push(bits & 255);
  return Buffer.from(out);
}

const subBlocks = data => {
  const parts = [];
  for (let i = 0; i < data.length; i += 255) parts.push(Buffer.from([Math.min(255, data.length - i)]), data.subarray(i, i + 255));
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
};

// 多帧 GIF：每帧是调色板下标的一维数组，永远循环，每帧 delay 厘秒。调色板：灰度 256 级。
export function animatedGif(width, height, frames, delay = 10) {
  const palette = Buffer.alloc(768);
  for (let i = 0; i < 256; i++) palette.fill(i, i * 3, i * 3 + 3);
  const screen = Buffer.alloc(7);
  screen.writeUInt16LE(width, 0);
  screen.writeUInt16LE(height, 2);
  screen[4] = 0xf7; // 全局调色板、256 色
  const parts = [Buffer.from('GIF89a'), screen, palette, Buffer.from([0x21, 0xff, 0x0b, ...Buffer.from('NETSCAPE2.0'), 3, 1, 0, 0, 0])];
  for (const frame of frames) {
    const control = Buffer.from([0x21, 0xf9, 4, 0, delay & 255, delay >> 8, 0, 0]);
    const descriptor = Buffer.alloc(10);
    descriptor[0] = 0x2c;
    descriptor.writeUInt16LE(width, 5);
    descriptor.writeUInt16LE(height, 7);
    parts.push(control, descriptor, Buffer.from([8]), subBlocks(lzw(frame)));
  }
  parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
}

// 一帧：竖条纹，随 phase 横向移动。
export const stripeFrame = (width, height, phase, period = 32) => {
  const frame = Buffer.alloc(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) frame[y * width + x] = ((x + phase) % period) * (255 / (period - 1)) | 0;
  return frame;
};

// ---- 页面 ----

const page = (title, body, head = '') => `<!doctype html>\n<html lang="zh-CN">\n<head><meta charset="utf-8"><title>${title}</title>${head}</head>\n<body>\n${body}\n</body>\n</html>\n`;
const SENTENCES = ['资源管理器把工作目录里的文件按类型预览。', 'HTML 在页内显示为简化的富文本，不执行脚本。', '这一段文字只是用来撑大文件，查找时可以搜「长文本样例」。', '表格、代码块和列表都按预览里的样式显示。', '带有 <b>强调</b> 和 <em>斜体</em> 的句子也要正确排版。'];
const prose = n => SENTENCES[n % SENTENCES.length].replace(/<[^>]+>/g, '') + `（第 ${n} 句）`;

// 正文型：一节一个标题，三段文字、一个列表、一张小表、一段代码，直到够大。
function bigProse(bytes) {
  const parts = [];
  let size = 0, n = 0;
  while (size < bytes) {
    const section = `<h2>第 ${n} 节</h2>\n<p>${Array.from({ length: 6 }, (_, i) => prose(n * 6 + i)).join('')}</p>\n<p>${Array.from({ length: 6 }, (_, i) => prose(n * 6 + i + 3)).join('')}<b>长文本样例</b></p>\n<ul><li>条目甲 ${n}</li><li>条目乙 ${n}</li><li>条目丙 ${n}</li></ul>\n<table><tr><th>列一</th><th>列二</th></tr><tr><td>${n}</td><td>数据 ${n}</td></tr></table>\n<pre><code class="language-js">const section = ${n};\nconsole.log(section);</code></pre>\n`;
    parts.push(section);
    size += Buffer.byteLength(section);
    n++;
  }
  return parts.join('');
}

// 节点密集型：很多个很短的列表项，源节点和输出节点都多。每项 li、b、两段文字，共约 4 个输出节点。
const bigNodes = items => `<ul>\n${Array.from({ length: items }, (_, i) => `<li><b>${i}</b> 项${i % 7}</li>`).join('\n')}\n</ul>`;

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, 'generated');

async function main() {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const files = [];
  const write = (name, content) => { writeFileSync(path.join(outDir, name), content); files.push([name, Buffer.byteLength(content)]); };
  const dataImage = (b64, alt) => `<img src="data:image/png;base64,${b64}" alt="${alt}">`;
  const gradient = (x, y) => (x + y) & 255;

  // 大小：0.5 MiB、1 MiB 正文型；节点密集型（约 5 万、约 9 万输出节点）；超过输出上限的。
  write('big-0.5mib.html', page('0.5 MiB 样例', bigProse(512 * 1024 - 2048)));
  write('big-1mib.html', page('1 MiB 样例', bigProse(1024 * 1024 - 8192)));
  write('big-nodes-50k.html', page('节点密集样例（约 5 万输出节点）', bigNodes(12_500)));
  write('big-nodes.html', page('节点密集样例（约 9 万输出节点）', bigNodes(22_000)));
  write('big-capped.html', page('超过输出上限的样例', bigNodes(30_000)));

  // 大的本地图：6000×4000 灰度（2400 万像素，手机照片的量级），文件很小，解码后约 96 MiB（RGBA）。
  write('large.png', await grayPng(6000, 4000, (x, y) => ((x >> 5) + (y >> 5)) & 1 ? 200 : 60));
  write('local-image-large.html', page('大的本地图', '<h1>大的本地图</h1>\n<p>下面是一张 6000×4000 的本地 PNG（文件很小，解码后很大）。</p>\n<img src="large.png" alt="6000×4000 的本地图">\n<p>图片之后的正文。</p>'));

  // 大尺寸 data: 图：恰在单张上限（1600 万像素）以内的、超过的；整页累计上限（6400 万）。
  const ok = (await grayPng(3900, 3900, gradient)).toString('base64'); // 1521 万像素
  const over = (await grayPng(4100, 4100, gradient)).toString('base64'); // 1681 万像素
  const nine = (await grayPng(3000, 3000, gradient)).toString('base64'); // 900 万像素
  write('data-image-large.html', page('大尺寸 data: 图', `<h1>大尺寸 data: 图</h1>\n<p>3900×3900（1521 万像素，未超过单张 1600 万像素的上限）应显示：</p>\n${dataImage(ok, '3900×3900')}\n<p>4100×4100（1681 万像素，超过）应是占位「[图片：4100×4100]」：</p>\n${dataImage(over, '4100×4100')}\n<p>图片之后的正文。</p>`));
  write('data-image-budget.html', page('data: 图的整页累计', `<h1>整页累计像素</h1>\n<p>8 张 3000×3000（各 900 万像素，累计上限 6400 万）：前 7 张应显示，第 8 张应是占位「[图片：第 8 张]」。</p>\n${Array.from({ length: 8 }, (_, i) => `<p>第 ${i + 1} 张</p>\n${dataImage(nine, `第 ${i + 1} 张`)}`).join('\n')}\n<p>全部图片之后的正文。</p>`));

  // 多帧动图：800×800、100 帧（解码后约 256 MiB），文件不大。
  write('anim-large.gif', animatedGif(800, 800, Array.from({ length: 100 }, (_, i) => stripeFrame(800, 800, i * 3)), 4));
  write('animated-gif-large.html', page('大的多帧动图', '<h1>大的多帧动图</h1>\n<p>800×800、100 帧的本地 GIF：</p>\n<img src="anim-large.gif" alt="800×800 的 100 帧动图">\n<p>动图之后的正文。</p>'));

  // 多图：250 张本地图，超过每页 200 张的上限，后面的 50 张应直接是占位。
  write('tiny.png', rgbPng(48, 48, (x, y) => [x * 5, y * 5, 128]));
  write('many-images.html', page('多图样例', `<h1>250 张本地图</h1>\n<p>每页最多显示 200 张（本地图和 data: 图合计），第 201～250 张应直接是占位。</p>\n${Array.from({ length: 250 }, (_, i) => `<figure><img src="tiny.png" alt="第 ${i + 1} 张"><figcaption>第 ${i + 1} 张</figcaption></figure>`).join('\n')}`));

  for (const [name, size] of files) console.log(`${name.padEnd(28)} ${(size / 1024).toFixed(1).padStart(10)} KiB`);
  console.log(`已生成到 ${path.relative(process.cwd(), outDir) || '.'}，共 ${files.length} 个文件`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
