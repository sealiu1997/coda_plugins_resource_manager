// 预览里的代码上色：认得出语言才上色，超过上限、没能高亮、认不出各自的元信息；刷新；选中文字加到聊天；图片和二进制不受影响。
// 真实的 file-app.mjs、preview.mjs 和 highlight.js，配假 DOM 和脚本化的假宿主。
import assert from 'node:assert/strict';
import test from 'node:test';
import { hljs, HIGHLIGHT_LIMIT, LINE_LIMIT } from '../view/highlight.mjs';
import { TEXT_LIMIT } from '../view/protocol.mjs';
import { flush } from './support/fake.mjs';
import { start } from './support/filepage.mjs';
import { fakeSelection } from './support/selection.mjs';

const meta = page => page.preview.find(node => node.classList.contains('pmeta'))[0];
const code = page => page.preview.find(node => node.classList.contains('code'))[0];
const body = page => page.preview.find(node => node.classList.contains('pbody'))[0];
const text = page => page.preview.find(node => node.classList.contains('text'))[0];
const classesIn = page => new Set(text(page).find(node => node.tagName === 'SPAN').flatMap(node => node.className.split(' ')));
const SOURCE = 'const a = `x${1}`;\nlet b = "y"; // z\n';
// 恰好 bytes 个字节的 JS 注释：一行 100 字节、每行一个 span，没有长行。
const comment = bytes => { const row = `//${'a'.repeat(97)}\n`; return (row.repeat(Math.ceil(bytes / 100))).slice(0, bytes); };
// 恰好 bytes 个字节的单行 JS 注释。
const oneLine = bytes => `//${'a'.repeat(bytes - 2)}`;

test('认得出的语言上色：出 span，文字拼起来等于原文，行号照旧', async t => {
  const { page } = await start(t, { path: 'src/app.js', files: { 'src/app.js': { text: SOURCE } } });
  for (const name of ['hljs-keyword', 'hljs-string', 'hljs-subst', 'hljs-comment']) assert.ok(classesIn(page).has(name), name);
  assert.equal(text(page).textContent, SOURCE);
  assert.equal(page.preview.find(node => node.classList.contains('gutter'))[0].textContent, '1\n2');
  assert.equal(meta(page).textContent, 'src · 2 行 · 37 B', '上色不加说明');
});

test('认不出的语言：纯文本，一个文本节点，不加说明', async t => {
  const { page } = await start(t, { path: 'notes.txt', files: { 'notes.txt': { text: SOURCE } } });
  assert.equal(text(page).find(node => node.tagName === 'SPAN').length, 0);
  assert.equal(text(page).textContent, SOURCE);
  assert.equal(meta(page).textContent, '2 行 · 37 B');
});

test('上限：前一字节和恰好上限上色，后一字节显示纯文本并注明「不高亮」', async t => {
  for (const [bytes, colored] of [[HIGHLIGHT_LIMIT - 1, true], [HIGHLIGHT_LIMIT, true], [HIGHLIGHT_LIMIT + 1, false]]) {
    const { page } = await start(t, { path: 'big.js', files: { 'big.js': { text: comment(bytes) } } });
    assert.equal(text(page).find(node => node.tagName === 'SPAN').length > 0, colored, `${bytes} 字节`);
    assert.equal(text(page).textContent, comment(bytes));
    assert.equal(meta(page).textContent.endsWith(' · 不高亮'), !colored, meta(page).textContent);
  }
});

test('上限按字节算，不按字符：多字节字符的文件字符数少、字节数超过上限就不高亮', async t => {
  const body3 = `//${'你'.repeat(Math.ceil(HIGHLIGHT_LIMIT / 3))}`; // 字符数不到上限，字节数超过
  assert.ok(body3.length < HIGHLIGHT_LIMIT && Buffer.byteLength(body3) > HIGHLIGHT_LIMIT);
  const { page } = await start(t, { path: 'zh.js', files: { 'zh.js': { text: body3 } } });
  assert.equal(text(page).find(node => node.tagName === 'SPAN').length, 0);
  assert.ok(meta(page).textContent.endsWith('不高亮'));
});

test('超过 1 MiB 只读前 1 MiB：说明合成「只显示前 1.0 MiB，不高亮」', async t => {
  const { page } = await start(t, { path: 'huge.js', files: { 'huge.js': { text: oneLine(TEXT_LIMIT), size: 2 * TEXT_LIMIT } } });
  assert.equal(meta(page).textContent, '1 行 · 2.0 MiB · 只显示前 1.0 MiB，不高亮');
  assert.equal(text(page).find(node => node.tagName === 'SPAN').length, 0);
  const plain = await start(t, { path: 'huge.txt', files: { 'huge.txt': { text: oneLine(TEXT_LIMIT), size: 2 * TEXT_LIMIT } } });
  assert.equal(meta(plain.page).textContent, '1 行 · 2.0 MiB · 只显示前 1.0 MiB', '认不出语言的截断文件不加「不高亮」');
});

test('没能高亮（库抛错）：纯文本，元信息注明；后面的文件照常上色', async t => {
  const { page, host } = await start(t, { path: 'a.js', files: { 'a.js': { text: SOURCE }, 'b.js': { text: SOURCE } } });
  t.mock.method(hljs, 'highlight', () => { throw new Error('库坏了'); });
  host.files['a.js'] = { text: `${SOURCE}// 变了\n`, mtimeMs: 2 };
  host.changed();
  await flush();
  assert.equal(text(page).find(node => node.tagName === 'SPAN').length, 0);
  assert.equal(text(page).textContent, `${SOURCE}// 变了\n`);
  assert.equal(meta(page).textContent, '3 行 · 47 B · 没能高亮');
  t.mock.restoreAll();
  host.files['a.js'] = { text: SOURCE, mtimeMs: 3 };
  host.changed();
  await flush();
  assert.ok(classesIn(page).has('hljs-keyword'));
  assert.equal(meta(page).textContent, '2 行 · 37 B');
});

test('没能高亮（库吞掉内部错误、输出格式不对）也退回纯文本', async t => {
  for (const result of [{ value: 'x', errorRaised: new Error('boom') }, { value: '<b>x</b>' }]) {
    t.mock.method(hljs, 'highlight', () => result);
    const again = await start(t, { path: 'b.js', files: { 'b.js': { text: 'x' } } });
    assert.equal(meta(again.page).textContent, '1 行 · 1 B · 没能高亮');
    assert.equal(text(again.page).textContent, 'x');
    t.mock.restoreAll();
  }
});

test('刷新：没变不重画；变了重新上色，滚动位置保留', async t => {
  const { page, host } = await start(t, { path: 'a.js', files: { 'a.js': { text: SOURCE } } });
  const before = code(page);
  body(page).scrollTop = 77;
  body(page).scrollLeft = 5;
  host.changed();
  await flush();
  assert.equal(code(page), before, '没变：同一个节点');
  host.files['a.js'] = { text: `${SOURCE}return 1;\n`, mtimeMs: 2 };
  host.changed();
  await flush();
  assert.notEqual(code(page), before);
  assert.equal(text(page).textContent, `${SOURCE}return 1;\n`);
  assert.ok(classesIn(page).has('hljs-keyword'));
  assert.deepEqual([body(page).scrollTop, body(page).scrollLeft], [77, 5]);
});

test('图片和二进制不受影响：即使名字是代码文件', async t => {
  const binary = await start(t, { path: 'x.js', files: { 'x.js': { kind: 'binary', size: 2048 } } });
  assert.match(binary.page.preview.textContent, /二进制文件，不预览/);
  assert.equal(binary.page.preview.find(node => node.tagName === 'SPAN' && node.className.startsWith('hljs')).length, 0);
  assert.equal(meta(binary.page).textContent, '2.0 KiB');
  const image = await start(t, { path: 'logo.png', files: { 'logo.png': { kind: 'image', text: 'png', size: 3 } } });
  assert.equal(meta(image.page).textContent, '3 B');
  assert.equal(image.page.preview.find(node => node.tagName === 'IMG').length, 1);
  assert.match(image.page.preview.find(node => node.tagName === 'IMG')[0].src, /^coda-view:\/\/service\/media\/tok\/logo\.png/, '图片走流式服务');
});

// ---- 上色后选中文字加到聊天（Mac 窗口）----

async function selecting(t, path, source) {
  const ctx = await start(t, { path, platform: 'mac', files: { [path]: { text: source } } });
  const el = text(ctx.page);
  const sel = fakeSelection(t, code(ctx.page));
  const adds = () => ctx.host.sent.filter(message => message.type === 'add_text').map(({ text: body, block }) => ({ text: body, block }));
  const choose = label => ctx.page.menu.find(node => node.tagName === 'BUTTON').find(node => node.textContent === label).dispatch('click');
  const pick = (from, to) => {
    sel.select(el, from, to);
    let taken = false;
    el.dispatch('contextmenu', { clientX: 8, clientY: 9, preventDefault() { taken = true; } });
    return taken;
  };
  return { ...ctx, el, pick, adds, choose };
}

test('上色后选中：起点和终点在不同 token、嵌套 span 里、跨行、从行号列拖进来、结尾在下一行行首，内容和行号都对', async t => {
  const { pick, adds, choose } = await selecting(t, 'a.js', SOURCE);
  assert.ok(SOURCE.startsWith('const a = `x${1}`;\n'));
  const cases = [
    { from: 3, to: 14, content: SOURCE.slice(3, 14), position: 'a.js:1', note: '起点在 const、终点在模板字符串里' },
    { from: 14, to: 15, content: SOURCE.slice(14, 15), position: 'a.js:1', note: '${ 里嵌套 span 的内部' },
    { from: 4, to: 28, content: SOURCE.slice(4, 28), position: 'a.js:1-2', note: '跨行' },
    { from: -3, to: 5, content: SOURCE.slice(0, 5), position: 'a.js:1', note: '从行号列拖进来' },
    { from: 0, to: SOURCE.indexOf('\n') + 1, content: 'const a = `x${1}`;\n', position: 'a.js:1', note: '结尾在下一行行首' },
  ];
  for (const { from, to, content, position, note } of cases) {
    assert.equal(pick(from, to), true, note);
    choose('添加到聊天（内容）');
    assert.equal(pick(from, to), true, note);
    choose('添加到聊天（位置）');
    await flush();
    assert.deepEqual(adds().slice(-2), [{ text: content, block: true }, { text: position, block: false }], note);
  }
});

// ---- 行太长不高亮（LINE_LIMIT，按 UTF-16 长度，\n 分行，\r 留在行里） ----
const noteOf = page => meta(page).textContent;
const spans = page => text(page).find(node => node.tagName === 'SPAN').length;
const open = (t, name, body, extra = {}) => start(t, { path: name, files: { [name]: { text: body, ...extra } } });

test('行长：LINE_LIMIT 前一个、恰好上色，后一个字符显示纯文本并注明「行太长，不高亮」', async t => {
  assert.equal(LINE_LIMIT, 5000);
  for (const [chars, colored] of [[LINE_LIMIT - 1, true], [LINE_LIMIT, true], [LINE_LIMIT + 1, false]]) {
    const body = oneLine(chars);
    const { page } = await open(t, 'one.js', body);
    assert.equal(spans(page) > 0, colored, `${chars} 字符`);
    assert.equal(text(page).textContent, body);
    assert.ok(noteOf(page).endsWith(' · 行太长，不高亮') === !colored, noteOf(page));
    if (colored) assert.ok(!noteOf(page).includes('不高亮'));
  }
});

test('行长：只有 \r\n 的行，\r 算在行里（正文 LINE_LIMIT 个字符 + \r 即超限）', async t => {
  const rows = n => `//${'a'.repeat(n - 2)}\r\n//b\r\n`;
  const fine = await open(t, 'crlf.js', rows(LINE_LIMIT - 1)); // 加上 \r 恰好 LINE_LIMIT
  assert.ok(spans(fine.page) > 0 && !noteOf(fine.page).includes('不高亮'), noteOf(fine.page));
  const over = await open(t, 'crlf2.js', rows(LINE_LIMIT)); // 加上 \r 是 LINE_LIMIT + 1
  assert.equal(spans(over.page), 0);
  assert.ok(noteOf(over.page).endsWith('行太长，不高亮'), noteOf(over.page));
  const many = await open(t, 'many.js', '//短\r\n'.repeat(3000)); // 总长远超，但每行都短
  assert.ok(spans(many.page) > 0, '多行总长超过 LINE_LIMIT 不算长行');
});

test('行长：长行在中间、在末尾（末尾没有换行）都不高亮；长行之外的短行不影响', async t => {
  const long = oneLine(LINE_LIMIT + 1);
  for (const body of [`//a\n${long}\n//b\n`, `//a\n//b\n${long}`, `${long}\n//a`]) {
    const { page } = await open(t, 'mid.js', body);
    assert.equal(spans(page), 0);
    assert.equal(text(page).textContent, body);
    assert.ok(noteOf(page).endsWith(' · 行太长，不高亮'), noteOf(page));
  }
  const tail = await open(t, 'tail.js', `//a\n${oneLine(LINE_LIMIT)}`); // 末尾行恰好 LINE_LIMIT
  assert.ok(spans(tail.page) > 0);
});

test('行长：按 UTF-16 长度，不按字节也不按码点', async t => {
  const cjk = await open(t, 'zh.js', `//${'你'.repeat(LINE_LIMIT - 2)}`); // 字节远超 LINE_LIMIT，字符数恰好
  assert.ok(spans(cjk.page) > 0, noteOf(cjk.page));
  const emoji = await open(t, 'emoji.js', `//${'😀'.repeat(LINE_LIMIT / 2)}`); // 码点 2501，UTF-16 长度 5002
  assert.equal(spans(emoji.page), 0);
  assert.ok(noteOf(emoji.page).endsWith('行太长，不高亮'), noteOf(emoji.page));
});

test('行长：超过大小上限又有长行时只写「不高亮」；认不出语言的长行不加说明', async t => {
  const { page } = await open(t, 'both.js', oneLine(HIGHLIGHT_LIMIT + 1));
  assert.ok(noteOf(page).endsWith(' · 不高亮') && !noteOf(page).includes('行太长'), noteOf(page));
  const plain = await open(t, 'long.txt', oneLine(LINE_LIMIT + 1));
  assert.ok(!noteOf(plain.page).includes('不高亮'), noteOf(plain.page));
  const trunc = await open(t, 'huge.js', oneLine(TEXT_LIMIT), { size: 2 * TEXT_LIMIT });
  assert.ok(noteOf(trunc.page).endsWith('只显示前 1.0 MiB，不高亮'), noteOf(trunc.page));
});
