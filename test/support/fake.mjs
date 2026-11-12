// 测试用的假 coda 和假 view：形状照插件宿主给的 coda 对象，api、watch 可控。
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as tick } from 'node:timers/promises';
import { MESSAGE_LIMIT, messageSize } from '../../view/protocol.mjs';

// 临时目录（已取 realpath），测试结束用 cleanup 删掉。
export async function tempDir(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'resource-manager-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

export function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

// 按时间算超时：高负载下事件循环慢，按次数会过早放弃；等到了立即返回。
export const WAIT_MS = 30_000;
export async function waitFor(predicate, what = '条件') {
  const deadline = Date.now() + WAIT_MS;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`等待超时：${what}`);
    await tick();
  }
}

// 让已经在途的 fs 操作和微任务都走完（用于「没有发出」类断言之前）。
export async function flush() {
  for (let i = 0; i < 30; i++) await tick();
}

export const checkoutOf = (path, state = 'ready', kind = 'worktree') => ({ checkout: { kind, state, path } });

// threads[id] 可以是对象、返回对象或 Promise 的函数、或 Error。
export function fakeCoda(threads = {}) {
  const views = new Map(), watchers = new Set(), api = [], services = new Map();
  const fake = {
    threads, api, views, services, disposed: 0,
    coda: {
      views: { register: (id, provider) => views.set(id, provider) },
      services: { register: async (name, handler) => { services.set(name, handler); } }, // 流式服务；测旧宿主时 delete fake.coda.services
      async api(path) {
        api.push(path);
        const value = threads[decodeURIComponent(path.replace(/^threads\//, ''))];
        if (typeof value === 'function') return value();
        if (value instanceof Error) throw value;
        return value;
      },
      async watch(name, fn) {
        if (name !== 'threads') throw new Error('不认识的集合');
        watchers.add(fn);
        return { dispose: () => { watchers.delete(fn); fake.disposed++; } };
      },
    },
    // 集合事件：turn 是进行中那一轮的 ID 或 null。
    emit: (id, turn, type = 'MODIFIED') => { for (const fn of watchers) fn({ type, id, object: { id, turn } }); },
    queried: id => api.filter(path => path === `threads/${id}`).length,
    // options.view 是视图 ID（files 或 file），options.args 是打开它带的参数。
    open(session, options) { return openView(this, session, options); },
  };
  return fake;
}

function openView(fake, session, { view: viewId = 'files', args = null } = {}) {
  const handlers = {}, posted = [], dropped = [], listeners = [];
  const view = {
    id: 'instance', view: viewId, context: { session, args },
    postMessage(message) {
      // 同宿主：序列化后超过 128 KiB 的被丢弃。
      if (messageSize(message) > MESSAGE_LIMIT) return dropped.push(message);
      posted.push(JSON.parse(JSON.stringify(message)));
      for (const fn of listeners) fn(posted.at(-1));
    },
    onMessage: fn => { handlers.message = fn; },
    onContext: fn => { handlers.context = fn; },
    onClose: fn => { handlers.close = fn; },
  };
  fake.views.get(viewId).open(view);
  const of = type => posted.filter(message => message.type === type);
  return {
    posted, dropped, of, listen: fn => listeners.push(fn),
    send: message => handlers.message(message),
    switchTo: (next, nextArgs = null) => handlers.context({ session: next, args: nextArgs }),
    close: () => handlers.close(),
    // 取第一条带这个请求号的回答。
    answer: async requestId => {
      await waitFor(() => posted.some(m => m.requestId === requestId), `回答 ${requestId}`);
      return posted.find(m => m.requestId === requestId);
    },
    lastRoot: () => of('root').at(-1),
  };
}

// 启用假计时器，并记下还没触发、没取消的计时器：断言「没有残留的轮询」要看它。
export function trackTimers(t) {
  const real = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const mocked = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  const pending = new Set();
  globalThis.setTimeout = (fn, ms, ...args) => {
    const handle = mocked.setTimeout(() => { pending.delete(handle); fn(...args); }, ms);
    pending.add(handle);
    return handle;
  };
  globalThis.clearTimeout = handle => { pending.delete(handle); mocked.clearTimeout(handle); };
  t.after(() => Object.assign(globalThis, real));
  return pending;
}
