// 树页的脚本化假模块：目录内容由 listing 给（键是目录路径，名字以 / 结尾的是目录），
// 条目也可以直接写成 { name, kind, link }；list 可以按路径让它失败（host.failing）；记下 coda.open（Mac 的「窗口」）、coda.copy 的调用。
// host.reads() 是发出的 read 请求；host.back(steps) 触发原生返回的事件（要 back: true）；previewName(page) 是预览头部的文件名。
// back：true 时 coda 有 back（原生返回），声明过的路径记在 calls.back；客户端的事件（back、toolbar……）记在 host.events，测试自己触发。
// host.requests(type) 等微任务把消息投出去，再取发出的这种请求；host.answer(请求, 回答内容) 按请求的类型回答，回答内容可以是 { error }。
import { ReplyOf } from '../../view/protocol.mjs';
import { loadApp } from './dom.mjs';
import { flush } from './fake.mjs';

export async function openTree(t, { platform = 'ios', listing = { '': ['a.txt', 'b.txt'] }, state, coda = {}, back = false, motion = null } = {}) {
  try { t.mock.timers.enable({ apis: ['setTimeout'] }); } catch { /* 同一个用例里的第二个页面（重建）：已经启用了 */ }
  const sent = [], calls = { open: [], copy: [], back: [] }, events = {};
  // missing：这些目录 list 回答 not_found；held：这些目录的 list 先扣住，测试自己用 host.answer 回答，扣住的请求在 host.heldLists 里。
  const host = { sent, calls, events, listing, failing: new Set(), files: {}, autoRead: false, failRead: null, holdReads: false, heldReads: [], missing: new Set(), held: new Set(), heldLists: [], generation: 0, openResult: undefined, lists: () => sent.filter(m => m.type === 'list') };
  let page;
  // read：默认不回答（测试自己用 host.answer）；host.autoRead 时自动回答，host.files 里有的路径给正文（默认 'x'），host.holdReads 时先扣住，用 host.release 回答。
  const answerRead = request => {
    if (request.generation !== host.generation) return;
    if (host.holdReads) return host.heldReads.push(request);
    if (host.failRead) return page.post({ type: 'chunk', generation: request.generation, requestId: request.requestId, error: host.failRead });
    const data = Buffer.from(host.files[request.path] ?? 'x');
    page.post({ type: 'chunk', generation: request.generation, requestId: request.requestId, data: data.toString('base64'), offset: 0, size: data.length, mtimeMs: 1, kind: 'text', eof: true });
  };
  const answer = request => {
    if (request.generation !== host.generation) return;
    const base = { generation: host.generation, requestId: request.requestId };
    if (host.held.has(request.path)) return host.heldLists.push(request);
    if (host.missing.has(request.path)) return page.post({ type: 'listed', ...base, error: { code: 'not_found', message: '文件夹不存在' } });
    if (host.failing.has(request.path)) return page.post({ type: 'listed', ...base, error: { code: 'io_error', message: '读不了这个目录' } });
    const entries = (host.listing[request.path] ?? []).map(name => typeof name === 'object' ? name : ({ name: name.replace(/\/$/, ''), kind: name.endsWith('/') ? 'dir' : 'file' }));
    page.post({ type: 'listed', ...base, entries, nextCursor: null });
  };
  page = await loadApp(t, {
    platform,
    postMessage: message => { sent.push(message); if (message.type === 'list') queueMicrotask(() => answer(message)); else if (message.type === 'read' && host.autoRead) queueMicrotask(() => answerRead(message)); },
    on: (name, fn) => { events[name] = fn; },
    ...(back ? { back: titles => calls.back.push(titles) } : {}),
    copy: text => calls.copy.push(text),
    getState: () => state,
    setState: () => {},
    open: args => { calls.open.push(args); return host.openResult?.(); },
    close: () => { calls.close = (calls.close ?? 0) + 1; },
    ...coda,
  }, { motion });
  host.session = (id = 's1', path = '/A') => { host.generation++; page.post({ type: 'session', generation: host.generation, session: id }); page.post({ type: 'root', generation: host.generation, state: 'ready', path }); };
  host.requests = async type => { await flush(); return sent.filter(m => m.type === type); };
  host.answer = (request, body) => page.post({ type: ReplyOf[request.type], generation: request.generation, requestId: request.requestId, ...body });
  host.changed = () => page.post({ type: 'changed', generation: host.generation });
  host.reads = () => sent.filter(m => m.type === 'read');
  host.release = request => { const hold = host.holdReads; host.holdReads = false; answerRead(request); host.holdReads = hold; };
  host.back = (steps = 1) => events.back({ steps });
  return { page, host, tick: ms => t.mock.timers.tick(ms) };
}

export const rowsOf = page => page.tree.find(node => node.classList.contains('row'));
export const rowNamed = (page, text) => rowsOf(page).find(node => node.textContent.includes(text));
export const previewName = page => page.preview.find(node => node.classList.contains('pname'))[0]?.textContent ?? null;
export const sectionOf = page => page.tree.find(node => node.classList.contains('section'))[0];
