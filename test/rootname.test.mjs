// 根目录名的写法和三步省略（设计第 19 节）：纯函数，量宽度的函数由测试注入（一个字算 1）。
import assert from 'node:assert/strict';
import test from 'node:test';
import { fitRootLabel, rootLabel, tagOf } from '../view/rootname.mjs';

const UUID = 'c0377d40-2fa7-42a0-94ab-49a31b2215c3';
const root = (project = 'ActaView', path = `/work/${UUID}`) => ({ state: 'ready', path, project });
const chars = text => [...text].length;
const fit = (r, width) => fitRootLabel(r, width, chars);

test('写法：worktree 是「项目名-wt-编号」，UUID 目录名取前 4 位，不是 UUID 取整个目录名；没有项目名是文件夹名', () => {
  assert.equal(rootLabel(root()), 'ActaView-wt-c037');
  assert.equal(rootLabel(root('ActaView', '/work/feature-login')), 'ActaView-wt-feature-login');
  assert.equal(rootLabel(root('ActaView', `/work/${UUID.toUpperCase()}`)), 'ActaView-wt-C037', 'UUID 大小写不限');
  assert.equal(rootLabel(root(null)), UUID, '反查失败：同现在');
  assert.equal(rootLabel({ state: 'ready', path: '/work/project', project: null }), 'project');
  assert.equal(rootLabel({ state: 'ready', path: '/', project: null }), '/', '根就是 /');
  assert.equal(tagOf('c0377d40-2fa7-42a0-94ab-49a31b2215c'), 'c0377d40-2fa7-42a0-94ab-49a31b2215c', '少一位不是 UUID');
});

test('省略第 1 步：放得下就完整，正好等于宽度也算放得下', () => {
  assert.deepEqual(fit(root(), 100), { text: 'ActaView-wt-c037', step: 1 });
  assert.deepEqual(fit(root(), 16), { text: 'ActaView-wt-c037', step: 1 });
});

test('省略第 2 步：项目名从中间省略（首尾保留），一个字一个字缩，至少留 2 个字，-wt-编号不动', () => {
  const widths = { 15: 'Act…iew-wt-c037', 14: 'Act…ew-wt-c037', 13: 'Ac…ew-wt-c037', 12: 'Ac…w-wt-c037', 11: 'A…w-wt-c037' };
  for (const [width, text] of Object.entries(widths)) assert.deepEqual(fit(root(), Number(width)), { text, step: 2 }, `宽 ${width}`);
  // 最后一档就是项目名只剩 2 个字（A 和 a… 各一个）。
  assert.ok(fit(root(), 11).text.endsWith('-wt-c037'));
});

test('省略第 3 步：项目名只剩 2 个字也放不下，整段从尾部省略；-wt-编号 在这一步才开始被吃', () => {
  assert.deepEqual(fit(root(), 10), { text: 'A…w-wt-c0…', step: 3 });
  assert.deepEqual(fit(root(), 8), { text: 'A…w-wt-…', step: 3 });
  assert.deepEqual(fit(root(), 4), { text: 'A…w…', step: 3 });
  assert.deepEqual(fit(root(), 3), { text: 'A…', step: 3 }, '宽 3：放不下 A…w…，退到 A…');
  assert.deepEqual(fit(root(), 2), { text: 'A…', step: 3 }, '截在项目名中间的省略号上，不叠第二个省略号');
  assert.deepEqual(fit(root(), 0), { text: 'A…', step: 3 }, '再窄也至少一个字加省略号，不空');
});

test('编号在第 3 步之前一直完整：从宽到窄逐档，只要还没到第 3 步，结果都以 -wt-c037 结尾', () => {
  let last = 1;
  for (let width = 40; width >= 0; width--) {
    const { text, step } = fit(root(), width);
    assert.ok(step >= last, `宽 ${width}：步骤只往后走`);
    last = step;
    if (step < 3) assert.ok(text.endsWith('-wt-c037'), `宽 ${width}：${text}`);
    else assert.ok(text.endsWith('…'), `宽 ${width}：第 3 步以省略号结尾`);
    assert.ok(step === 3 || chars(text) <= width, `宽 ${width}：放下了`);
  }
  assert.equal(last, 3);
});

test('项目名本来就短（不超过 2 个字）：没有第 2 步，直接到第 3 步', () => {
  assert.deepEqual(fit(root('ab'), 14), { text: 'ab-wt-c037', step: 1 }, '放得下');
  assert.deepEqual(fit(root('ab'), 9), { text: 'ab-wt-c0…', step: 3 });
  assert.deepEqual(fit(root('abc'), 10), { text: 'a…c-wt-c0…', step: 3 }, '3 个字的项目名缩成 a…c 一样长，没有省下什么：直接到第 3 步');
});

test('没有项目名的普通目录不在这里省略（step 0，交给 CSS）：宽度多窄文字都不变', () => {
  assert.deepEqual(fit(root(null), 3), { text: UUID, step: 0 });
  assert.deepEqual(fit({ state: 'ready', path: '/a/project', project: null }, 1), { text: 'project', step: 0 });
});

test('量宽度的函数按注入的算：中日文字宽 2 时同一段话更早进入第 2、3 步', () => {
  const wide = text => [...text].reduce((sum, ch) => sum + (ch.charCodeAt(0) > 255 ? 2 : 1), 0);
  const r = root('资源管理器项目');
  assert.equal(fitRootLabel(r, 30, wide).step, 1);
  assert.equal(fitRootLabel(r, 20, wide).step, 2);
  assert.equal(fitRootLabel(r, 9, wide).step, 3);
});
