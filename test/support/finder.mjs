// Mac 打开方式（第 15.10 节）的测试辅助：起一个 Mac 页面、浏览器顺序的点击、键盘事件、选中行。
import { flush } from './fake.mjs';
import { openTree, rowNamed } from './treehost.mjs';

export const LISTING = { '': ['dir/', 'a.txt', 'b.txt', { name: 'to', kind: 'link' }, { name: 'dev', kind: 'other' }], dir: ['x.txt', 'y.txt'] };

// saves：每次 setState 的值（深拷贝）。session 起来后等一轮，让初始的保存计时器先走完，之后的保存只来自测试里的动作。
export async function startMac(t, { listing = LISTING, platform = 'mac', coda = {}, state, settle = true, prepare, root = '/A', rootless = false, ...options } = {}) {
  const saves = [];
  const ctx = await openTree(t, { platform, listing, state, coda: { setState: value => saves.push(JSON.parse(JSON.stringify(value))), toolbar: () => {}, ...coda }, ...options });
  ctx.saves = saves;
  Object.assign(ctx.page.tree, { clientHeight: 24 * 5, clientWidth: 300 });
  Object.assign(gridBody(ctx.page), { clientHeight: 24 * 5, clientWidth: 300 }); // 300 宽、单元格 100：3 列
  prepare?.(ctx.host);
  if (rootless) { ctx.host.generation++; ctx.page.post({ type: 'session', generation: ctx.host.generation, session: 's1' }); } // 只有 session，root 还没来
  else ctx.host.session('s1', root);
  if (settle) await drain(ctx);
  return ctx;
}
// 内容都到了、保存计时器都走完。
export async function drain({ tick }) {
  await flush();
  tick(300);
  await flush();
  tick(300);
}

const nameOf = node => node.find(child => child.classList.contains('name'))[0].textContent;
export const selectedRows = page => page.tree.find(node => node.classList.contains('row') && node.classList.contains('sel')).map(nameOf);
export const selectedCells = page => page.grid.find(node => node.classList.contains('cell') && node.classList.contains('sel')).map(node => node.textContent);
export const savedOf = ({ saves }) => saves.at(-1)?.sessions.s1;

// 浏览器的一次鼠标单击：按下、松开、click，都发给同一个节点。Mac 在按下时选中（第 17.4 节），click 只管展开箭头、说明行这类仍在松开时执行的。
export function clickOn(node, extra = {}) {
  const init = { button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true, clientX: 50, clientY: 12, ...extra };
  node.dispatch('pointerdown', init);
  node.dispatch('pointerup', init);
  return node.dispatch('click', init);
}

// 浏览器的一次双击：两次 click（中间事件循环转一圈，微任务里的重画会跑），再 dblclick，都发给同一个节点；
// 每一步之后节点必须还在容器里，不然 dblclick 到不了容器。返回节点。
export async function doubleClick(container, node) {
  clickOn(node);
  await flush();
  if (!container.contains(node)) throw new Error('第一次 click 之后节点脱离了容器');
  clickOn(node);
  await flush();
  if (!container.contains(node)) throw new Error('第二次 click 之后节点脱离了容器');
  node.dispatch('dblclick');
  await flush();
  return node;
}

// 键盘：返回 { prevented }。target 是焦点所在的元素（事件从它冒泡）。
export function press(target, key, modifiers = {}) {
  let prevented = false;
  target.dispatch('keydown', { key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...modifiers, preventDefault() { prevented = true; } });
  return { get prevented() { return prevented; } };
}
export const cmd = { metaKey: true };

export { rowNamed };

// ---- 图标视图 ----
export const ROW = 24; // 假 DOM 量出的单元格高度；宽度 100，所以 300 宽是 3 列
export const GRID_LISTING = {
  '': ['dir/', 'f1.txt', 'f2.txt', 'f3.txt', 'f4.txt', 'f5.txt', { name: 'to', kind: 'link' }],
  dir: ['inner/', 'x.txt', 'y.txt'], 'dir/inner': ['z/', 'deep.txt'], 'dir/inner/z': ['q.txt'],
};
export const iconsState = (sessions = {}) => ({ v: 1, seq: 1, hidden: false, view: 'icons', sessions });
export const gridBody = page => page.grid.find(node => node.classList.contains('gbody'))[0];
export const cellNamed = (page, name) => page.grid.find(node => node.classList.contains('cell') && node.textContent === name)[0];
export const cellNames = page => page.grid.find(node => node.classList.contains('cell')).map(node => node.textContent);
export const gridHead = page => page.grid.find(node => node.classList.contains('ghead'))[0];

// 从图标视图开始的页面。
export const startGrid = (t, { listing = GRID_LISTING, state = iconsState(), ...options } = {}) => startMac(t, { listing, state, ...options });
