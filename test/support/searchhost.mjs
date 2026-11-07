// 搜索页面测试的辅助：起一个带搜索的页面（Mac 或 iPhone）、输入搜索词、回答 search 请求、读结果行和状态行。
// 请求由测试自己用 host.answer 回答（treehost 里 search 默认不回答）；防抖和计时用假时钟，tick 推进。
import { flush } from './fake.mjs';
import { startMac } from './finder.mjs';
import { openTree } from './treehost.mjs';

export const box = page => page.searchbar.find(node => node.tagName === 'INPUT')[0];
// 结果面板没有显示（内层不是搜索）时，里面留着的旧节点不算：它们看不见。
export const hitRows = page => (page.search.classList.contains('off') ? [] : page.search.find(node => node.classList.contains('row') && node.classList.contains('entry')));
export const hitNames = page => hitRows(page).map(node => node.find(child => child.classList.contains('name'))[0].textContent);
export const selectedHits = page => hitRows(page).filter(node => node.classList.contains('sel')).map(node => node.dataset.path);
export const statusLine = page => page.search.find(node => node.classList.contains('sstatus-text'))[0].textContent;
export const searchShown = page => !page.search.classList.contains('off') && !page.browse.classList.contains('off');
export const hitNamed = (page, path) => hitRows(page).find(node => node.dataset.path === path);

// 在输入框里输入（用户操作）：写 value，派发 input。
export function type(page, text) {
  const input = box(page);
  input.value = text;
  input.dispatch('input');
}

export const hit = (path, kind = 'file', extra = {}) => ({ path, kind, ...extra });
export const found = (results, extra = {}) => ({ results, stop: 'done', scanned: results.length, unreadable: 0, ...extra });

// 发出的 search 请求（等微任务把消息投出去）。
export const searches = async host => { await flush(); return host.sent.filter(message => message.type === 'search'); };
export const cancels = async host => { await flush(); return host.sent.filter(message => message.type === 'search_cancel'); };

// 输入词、等防抖、回答最后一个 search 请求；results 缺省时不回答（返回请求）。
export async function search(ctx, text, results = null, extra = {}) {
  type(ctx.page, text);
  ctx.tick(300);
  const requests = await searches(ctx.host), request = requests.at(-1);
  if (results !== null) { ctx.host.answer(request, found(results, extra)); await flush(); }
  return request;
}

export const LISTING = { '': ['dir/', 'a.txt', 'b.txt', { name: 'to', kind: 'link' }], dir: ['x.txt', 'y.txt', 'inner/'], 'dir/inner': ['deep.txt'] };

// Mac：搜索框在，页面起来后等一轮。
export const startSearch = (t, options = {}) => startMac(t, { listing: LISTING, ...options });
// iPhone：原生返回开着，声明的路径记在 host.calls.back。
export async function startPhone(t, { listing = LISTING, ...options } = {}) {
  const ctx = await openTree(t, { platform: 'ios', back: true, listing, ...options });
  ctx.host.session('s1', '/A');
  await flush();
  return ctx;
}
