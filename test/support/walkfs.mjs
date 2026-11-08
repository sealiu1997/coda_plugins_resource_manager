// 走树和搜索的假文件系统：目录内容由 spec 给，读取可以按路径扣住（gate）、让它失败，并记下次数。
// spec：键是相对根目录的目录路径（'' 是根目录），值是条目列表：'名字/' 是目录，'名字' 是文件，
// { name, kind: 'link', to } 是符号链接（to 是目标的绝对路径，缺省是失效的链接）。根目录是 /r。
// 返回 { root, fs, listing, counts, gates, fail, order }：
// gates.lstat / gates.readdir / gates.realpath 是 Map<绝对路径, deferred>，有的路径先扣住，测试自己 resolve；
// fail.readdir / fail.lstat 是 Set<绝对路径>，读这些路径抛 EACCES；order.readdir 记 readdir 的顺序（绝对路径）。
import { setImmediate as tick } from 'node:timers/promises';
import { createListing } from '../../lib/tree.mjs';

export const ROOT = '/r';

const nameOf = entry => (typeof entry === 'string' ? entry.replace(/\/$/, '') : entry.name);
const kindOf = entry => (typeof entry === 'string' ? (entry.endsWith('/') ? 'dir' : 'file') : entry.kind);
const denied = () => Object.assign(new Error('denied'), { code: 'EACCES' });
const missing = () => Object.assign(new Error('missing'), { code: 'ENOENT' });

export function fakeTree(spec, { limit } = {}) {
  const counts = { readdir: 0, lstat: 0, realpath: 0, stat: 0 };
  const gates = { lstat: new Map(), readdir: new Map(), realpath: new Map() };
  const fail = { readdir: new Set(), lstat: new Set() };
  const order = { readdir: [], lstat: [] };
  const relOf = path => (path === ROOT ? '' : path.slice(ROOT.length + 1));
  const find = path => {
    const rel = relOf(path), at = rel.lastIndexOf('/');
    const parent = spec[at < 0 ? '' : rel.slice(0, at)], name = rel.slice(at + 1);
    return rel === '' ? 'root' : parent?.find(entry => nameOf(entry) === name);
  };
  const stats = kind => ({
    isDirectory: () => kind === 'dir', isFile: () => kind === 'file', isSymbolicLink: () => kind === 'link',
    size: 1, mtimeMs: 1, birthtimeMs: 1, mode: 0o644,
  });
  const gated = async (name, path) => { counts[name]++; await tick(); await gates[name].get(path)?.promise; };
  const fs = {
    async lstat(path) {
      order.lstat.push(path);
      await gated('lstat', path);
      if (fail.lstat.has(path)) throw denied();
      const entry = find(path);
      if (entry === undefined) throw missing();
      return stats(entry === 'root' ? 'dir' : kindOf(entry));
    },
    async readdir(path) {
      order.readdir.push(path);
      await gated('readdir', path);
      if (fail.readdir.has(path)) throw denied();
      const list = spec[relOf(path)];
      if (!list) throw missing();
      return list.map(nameOf);
    },
    async realpath(path) {
      await gated('realpath', path);
      const entry = find(path);
      if (entry === undefined) throw missing();
      if (entry !== 'root' && kindOf(entry) === 'link') { if (!entry.to) throw missing(); return entry.to; }
      return path;
    },
    stat: async () => { throw missing(); },
  };
  return { root: ROOT, fs, listing: createListing({ fs, ...(limit ? { limit } : {}) }), counts, gates, fail, order, resolve: async root => root };
}
