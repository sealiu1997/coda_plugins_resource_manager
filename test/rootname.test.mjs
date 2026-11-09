// 根目录名的写法和四步省略（设计第 19.6 节）：纯函数，量宽度的函数由测试注入（默认一个字算 1，不分项目名和后缀）。
import assert from 'node:assert/strict';
import test from 'node:test';
import { fitRootLabel, glyphs, rootLabel, tagOf } from '../view/rootname.mjs';

const UUID = 'c0377d40-2fa7-42a0-94ab-49a31b2215c3';
const root = (project = 'ActaView', path = `/work/${UUID}`) => ({ state: 'ready', path, project });
const chars = text => [...text].length;
const fit = (r, width, measure = chars) => fitRootLabel(r, width, measure);
const brief = ({ name, tag, step }) => ({ name, tag, step });

test('写法：worktree 是「项目名 worktree-编号」，中间是空格，UUID 目录名取前 4 位，不是 UUID 取整个目录名；没有项目名是文件夹名', () => {
  assert.equal(rootLabel(root()), 'ActaView worktree-c037');
  assert.equal(rootLabel(root('ActaView', '/work/feature-login')), 'ActaView worktree-feature-login');
  assert.equal(rootLabel(root('ActaView', `/work/${UUID.toUpperCase()}`)), 'ActaView worktree-C037', 'UUID 大小写不限');
  assert.equal(rootLabel(root(null)), UUID, '反查失败：同现在');
  assert.equal(rootLabel({ state: 'ready', path: '/work/project', project: null }), 'project');
  assert.equal(rootLabel({ state: 'ready', path: '/', project: null }), '/', '根就是 /');
  assert.equal(tagOf('c0377d40-2fa7-42a0-94ab-49a31b2215c'), 'c0377d40-2fa7-42a0-94ab-49a31b2215c', '少一位不是 UUID');
});

test('第 1 步卡在 90%：完整写法恰好是宽度的 90% 是第 1 步，略超就是第 2 步', () => {
  const acta = root('Acta'); // 完整 `Acta worktree-c037` 共 18 个字
  assert.deepEqual(brief(fit(acta, 20)), { name: 'Acta', tag: ' worktree-c037', step: 1 }, '18 / 20 = 90%');
  assert.deepEqual(brief(fit(acta, 100)), { name: 'Acta', tag: ' worktree-c037', step: 1 });
  assert.deepEqual(brief(fit(acta, 19.99)), { name: 'Acta', tag: ' wt-c037', step: 2 }, '略超 90%：后缀缩成 wt');
  assert.equal(fit(acta, 19.99).text, 'Acta wt-c037');
});

test('第 2 步：后缀缩成 wt-编号，整行放得下（100%）就停，不靠 90%', () => {
  assert.deepEqual(brief(fit(root(), 24.5)), { name: 'ActaView', tag: ' worktree-c037', step: 1 });
  assert.deepEqual(brief(fit(root(), 24.4)), { name: 'ActaView', tag: ' wt-c037', step: 2 }, '22 > 90%');
  assert.deepEqual(brief(fit(root(), 16)), { name: 'ActaView', tag: ' wt-c037', step: 2 }, '短写法 16 个字，正好 100%');
});

test('第 3 步：项目名从中间省略（首尾保留），一个字一个字缩，至少留 2 个字，wt-编号不动', () => {
  const widths = { 15.99: 'Act…iew', 14.99: 'Act…ew', 13.99: 'Ac…ew', 12.99: 'Ac…w', 11: 'A…w' };
  for (const [width, name] of Object.entries(widths)) assert.deepEqual(brief(fit(root(), Number(width))), { name, tag: ' wt-c037', step: 3 }, `宽 ${width}`);
});

test('第 4 步：项目名只剩 2 个字也放不下，整段从尾部省略；wt-编号 在这一步才开始被吃', () => {
  assert.deepEqual(brief(fit(root(), 10)), { name: 'A…w', tag: ' wt-c0…', step: 4 });
  assert.deepEqual(brief(fit(root(), 7)), { name: 'A…w', tag: ' wt…', step: 4 });
  assert.deepEqual(brief(fit(root(), 5)), { name: 'A…w…', tag: '', step: 4 }, '空格后面不跟省略号');
  assert.deepEqual(brief(fit(root(), 4)), { name: 'A…w…', tag: '', step: 4 });
  assert.deepEqual(brief(fit(root(), 3)), { name: 'A…', tag: '', step: 4 }, '放不下 A…w…，退到 A…');
  assert.deepEqual(brief(fit(root(), 2)), { name: 'A…', tag: '', step: 4 }, '截在项目名中间的省略号上，不叠第二个省略号');
  assert.deepEqual(brief(fit(root(), 0)), { name: 'A…', tag: '', step: 4 }, '再窄也至少一个字加省略号，不空');
});

test('wt-编号在第 4 步之前一直完整：从宽到窄逐档，步骤只往后走，前三步的后缀都是完整的编号', () => {
  let last = 1;
  for (let width = 60; width >= 0; width -= 0.5) {
    const out = fit(root(), width);
    assert.ok(out.step >= last, `宽 ${width}：步骤只往后走`);
    last = out.step;
    if (out.step === 1) assert.equal(out.tag, ' worktree-c037');
    else if (out.step < 4) assert.equal(out.tag, ' wt-c037', `宽 ${width}：${out.text}`);
    else assert.ok(out.text.endsWith('…'), `宽 ${width}：第 4 步以省略号结尾`);
    assert.ok(out.step === 4 || chars(out.text) <= width + 1e-9, `宽 ${width}：放下了`);
    assert.equal(out.text, out.name + out.tag);
  }
  assert.equal(last, 4);
});

test('两段各按各的字体量：后缀的字比项目名窄时，同一个宽度能放下的步骤更靠前', () => {
  const roles = (text, role) => chars(text) * (role === 'tag' ? 0.5 : 1); // 后缀小一号：一个字只有项目名的一半宽
  const seen = [];
  const measure = (text, role) => { seen.push(role); return roles(text, role); };
  // 完整：8 + 14 × 0.5 = 15，在 17 里是 88%：第 1 步；不分字体（都按 1）要 22，只能到第 2 步（短写法 16）。
  assert.equal(fit(root(), 17, measure).step, 1);
  assert.ok(seen.includes('name') && seen.includes('tag'), '两个 role 都量过');
  assert.equal(fit(root(), 17, chars).step, 2, '对照：不分字体');
  assert.equal(fit(root(), 16.6, roles).step, 2, '15 > 90% × 16.6 = 14.94');
  assert.equal(fit(root(), 12, roles).step, 2, '短写法 8 + 8 × 0.5 = 12，正好 100%');
  assert.equal(fit(root(), 15, chars).step, 3, '对照：不分字体时 15 要把项目名省略');
});

test('项目名本来就短（不超过 2 个字）：没有第 3 步，放不下的直接到第 4 步', () => {
  assert.equal(fit(root('ab'), 20).step, 1);
  assert.deepEqual(brief(fit(root('ab'), 10)), { name: 'ab', tag: ' wt-c037', step: 2 });
  assert.deepEqual(brief(fit(root('ab'), 9)), { name: 'ab', tag: ' wt-c0…', step: 4 });
  assert.deepEqual(brief(fit(root('abc'), 10)), { name: 'a…c', tag: ' wt-c0…', step: 4 }, '3 个字的项目名缩成 a…c 一样长，没有省下什么');
});

test('没有项目名的普通目录不在这里省略（step 0，交给 CSS）：宽度多窄文字都不变，只有一段', () => {
  assert.deepEqual(brief(fit(root(null), 3)), { name: UUID, tag: '', step: 0 });
  assert.deepEqual(brief(fit({ state: 'ready', path: '/a/project', project: null }, 1)), { name: 'project', tag: '', step: 0 });
});

test('量宽度的函数按注入的算：中日文字宽 2 时同一段话更早进入第 2、3、4 步', () => {
  const wide = text => [...text].reduce((sum, ch) => sum + (ch.charCodeAt(0) > 255 ? 2 : 1), 0);
  const r = root('资源管理器项目'); // 项目名 14，完整 14 + 14 = 28，短 14 + 8 = 22
  assert.equal(fit(r, 32, wide).step, 1);
  assert.equal(fit(r, 30, wide).step, 2);
  assert.equal(fit(r, 20, wide).step, 3);
  assert.equal(fit(r, 8, wide).step, 4);
});

// ---- 按字素簇切（评审意见：按 UTF-16 截取会切出孤立代理项）----

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const FAMILY = '👨‍👩‍👧';
const PROJECTS = ['🚀工具🚀', '𠮷野家𠮷', 'école', `${FAMILY}家族`, '🇨🇳旗🇯🇵'];

test('各种字符的项目名：从宽到窄每一档、每一段都没有孤立代理项（emoji、非 BMP 的汉字、组合字符、ZWJ 序列、旗帜）', () => {
  for (const project of PROJECTS) {
    for (let width = 40; width >= 0; width--) {
      const out = fit(root(project), width);
      for (const piece of [out.name, out.tag, out.text]) {
        assert.ok(!LONE_SURROGATE.test(piece), `${project} 宽 ${width}：孤立代理项 ${JSON.stringify(piece)}`);
        assert.ok(!/^[̀-ͯ‍]/.test(piece), `${project} 宽 ${width}：以组合字符或 ZWJ 开头 ${JSON.stringify(piece)}`);
      }
    }
  }
});

test('emoji：🚀工具🚀 第 3 步留 2 个字素是「🚀…🚀」；再窄进入第 4 步，也不切坏', () => {
  assert.deepEqual(brief(fit(root('🚀工具🚀'), 20)), { name: '🚀工具🚀', tag: ' worktree-c037', step: 1 });
  assert.deepEqual(brief(fit(root('🚀工具🚀'), 12)), { name: '🚀工具🚀', tag: ' wt-c037', step: 2 });
  assert.deepEqual(brief(fit(root('🚀工具🚀'), 11)), { name: '🚀…🚀', tag: ' wt-c037', step: 3 });
  assert.deepEqual(brief(fit(root('🚀工具🚀'), 10)), { name: '🚀…🚀', tag: ' wt-c0…', step: 4 });
});

test('非 BMP 的汉字：𠮷野家𠮷 留 2 个字素是「𠮷…𠮷」，不是半个字', () => {
  assert.deepEqual(brief(fit(root('𠮷野家𠮷'), 11)), { name: '𠮷…𠮷', tag: ' wt-c037', step: 3 });
});

test('组合字符：基字和它的组合记号一起留下或一起省略（e + U+0301 算一个字）', () => {
  const out = fit(root('école'), 12);
  assert.equal(out.step, 3);
  assert.equal(out.name, 'é…e');
});

test('ZWJ 序列和旗帜是一个字：整个留下（宽度按字素簇数）', () => {
  const clusters = text => glyphs(text).length;
  assert.equal(fitRootLabel(root(`${FAMILY}家族们`), 11, clusters).name, `${FAMILY}…们`, '家庭 emoji 整个留着');
  assert.equal(fitRootLabel(root('🇨🇳旗帜🇯🇵'), 11, clusters).name, '🇨🇳…🇯🇵', '旗帜（两个区域指示符）是一个字');
});

test('没有 Intl.Segmenter 时退回按码点：emoji 和非 BMP 汉字仍不切坏', async () => {
  const original = Intl.Segmenter;
  let module;
  try {
    Intl.Segmenter = undefined;
    module = await import(`../view/rootname.mjs?no-segmenter=${Date.now()}`);
  } finally {
    Intl.Segmenter = original;
  }
  assert.deepEqual(module.glyphs('a🚀𠮷'), ['a', '🚀', '𠮷']);
  assert.deepEqual(brief(module.fitRootLabel(root('🚀工具🚀'), 11, chars)), { name: '🚀…🚀', tag: ' wt-c037', step: 3 });
  for (let width = 20; width >= 0; width--) assert.ok(!LONE_SURROGATE.test(module.fitRootLabel(root('𠮷野家𠮷'), width, chars).text));
});
