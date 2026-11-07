// locate.mjs 单独测：身份、用户接管、定位轮次的作废，和找到时的动作顺序（页面里别的机制也会作废它，这里只留 locator 自己的这一层）。
import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocator } from '../view/locate.mjs';
import { deferred, flush } from './support/fake.mjs';

function setup() {
  const gate = deferred(), log = [], state = { id: 'a', taken: 0 };
  const model = {
    view: 'list', expanded: new Set(), dirs: new Map([['', { entries: [{ name: 'f' }], next: 'c' }]]),
    whenLoaded: async () => 'ok', toggle() {},
    fetchNext: async () => { await gate.promise; model.dirs.get('').entries.push({ name: 'target' }); return 'ok'; },
  };
  const ops = { begin: () => log.push('begin'), render: () => log.push('render'), select: p => log.push(`select ${p}`), center: p => log.push(`center ${p}`), openFolder: () => log.push('open'), notify: text => log.push(text) };
  const locator = createLocator({ model, identity: () => state.id, takeover: () => state.taken, ops });
  return { gate, log, state, locator };
}

test('找到：render、select、center 依次做一次', async () => {
  const { gate, log, locator } = setup();
  const done = locator.show('target');
  gate.resolve();
  assert.equal(await done, 'found');
  assert.deepEqual(log, ['begin', 'render', 'select target', 'center target']);
});

test('身份变了、用户接管计数变了、又发起一次定位、cancel：都作废，不选中', async () => {
  for (const [act, selects] of [[s => { s.state.id = 'b'; }, 0], [s => { s.state.taken++; }, 0], [s => { s.locator.show('target'); }, 1], [s => s.locator.cancel(), 0]]) {
    const s = setup(), done = s.locator.show('target');
    await flush();
    act(s);
    s.gate.resolve();
    assert.equal(await done, 'void');
    await flush();
    assert.equal(s.log.filter(line => line.startsWith('select target')).length, selects, s.log.join()); // 又发起的新定位自己会选中一次
  }
});

test('找到之后完成：之后再 cancel、身份变化都没有额外动作', async () => {
  const { gate, log, state, locator } = setup();
  const done = locator.show('target');
  gate.resolve();
  await done;
  state.id = 'b';
  locator.cancel();
  assert.deepEqual(log, ['begin', 'render', 'select target', 'center target']);
});
