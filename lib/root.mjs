// 从会话取根目录。这是唯一读取 `threads/<id>` 返回结构（checkout）的地方，它不是文档写明的契约。
import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { RootState } from '../view/protocol.mjs';

export const NO_ROOT = Object.freeze({ state: RootState.NONE, path: null, project: null });

// project 不是根目录的身份（保存、恢复、换根都只看路径），但变了页面要重画标题，所以算进来。
export const sameRoot = (a, b) => a?.state === b?.state && a?.path === b?.path && (a?.project ?? null) === (b?.project ?? null);

// worktree 的项目名：原仓库的文件夹名。Coda 的 worktree 目录以 UUID 命名，只看目录名认不出项目。
// worktree 根目录的 .git 是一个文件，写着 `gitdir: <主仓库的 .git>/worktrees/<名字>`；那个目录里的 commondir（相对它自己）指向主仓库的 git 目录。
// 只读这两个文件，不调 git。主仓库的 git 目录叫 .git 时取上一级的文件夹名，是裸仓库（foo.git）时去掉 .git 后缀。
// 这两个文件的内容来自工作目录，不可信：项目名最后进标题，所以只能是一个真实存在的目录的名字，不能是别的文件里的文字。
//   - 两个文件都只读普通文件（O_NOFOLLOW：是符号链接就不读；O_NONBLOCK：FIFO 不会卡住打开），最多 META_LIMIT 字节，句柄一定关闭；
//   - .git 和 commondir 都是单行；
//   - gitdir 指的目录（取 realpath）必须存在、是目录，且上一级叫 worktrees，主仓库的 git 目录就是再上一级；
//   - commondir 指的目录（取 realpath）必须就是那个主仓库的 git 目录，不能指到别处。
// 任何一步读不到、不符都是 null（页面退回显示文件夹名），不抛。
const META_LIMIT = 4096; // 一行路径，几 KB 足够
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

async function readMeta(path) {
  let handle;
  try {
    handle = await open(path, OPEN_FLAGS);
    const info = await handle.stat();
    if (!info.isFile() || info.size > META_LIMIT) return null;
    const buffer = Buffer.alloc(META_LIMIT + 1);
    const { bytesRead } = await handle.read(buffer, 0, META_LIMIT + 1, 0);
    return bytesRead > META_LIMIT ? null : buffer.toString('utf8', 0, bytesRead);
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

// 单行文本：去掉结尾的一个换行，里面还有换行或 NUL 就不是。
const oneLine = text => {
  if (text === null) return null;
  const line = text.replace(/\r?\n$/, '');
  return /[\r\n\0]/.test(line) ? null : line;
};

const isDirectory = async path => (await stat(path)).isDirectory();

export async function projectOf(root) {
  try {
    const pointer = /^gitdir:[ \t]*(.+?)[ \t]*$/.exec(oneLine(await readMeta(resolve(root, '.git'))) ?? '');
    if (!pointer) return null;
    const admin = await realpath(resolve(root, pointer[1]));
    if (!(await isDirectory(admin)) || basename(dirname(admin)) !== 'worktrees') return null;
    const main = dirname(dirname(admin));
    const common = oneLine(await readMeta(resolve(admin, 'commondir')))?.trim();
    if (!common || (await realpath(resolve(admin, common))) !== main || !(await isDirectory(main))) return null;
    const name = basename(main) === '.git' ? basename(dirname(main)) : basename(main).replace(/\.git$/, '');
    return name && !/\p{Cc}/u.test(name) ? name : null;
  } catch {
    return null;
  }
}

// checkout.state 是 preparing、ready、failed。failed 没有可看的目录，按 none；
// ready 但目录已不在（归档后工作树被回收）是 gone。
// 查询失败（接口出错、读目录权限）直接抛出，由调用方保留上一次的结果。
export async function queryRoot(coda, session) {
  if (!session) return NO_ROOT;
  const thread = await coda.api(`threads/${encodeURIComponent(session)}`);
  const checkout = thread?.checkout;
  if (!checkout || typeof checkout !== 'object') return NO_ROOT;
  if (checkout.state === 'preparing') return { state: RootState.PREPARING, path: null, project: null };
  if (checkout.state !== 'ready' || typeof checkout.path !== 'string' || !checkout.path) return NO_ROOT;
  try {
    const real = await realpath(checkout.path);
    if ((await stat(real)).isDirectory()) return { state: RootState.READY, path: real, project: checkout.kind === 'worktree' ? await projectOf(real) : null };
  } catch (error) {
    if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
  }
  return { state: RootState.GONE, path: checkout.path, project: null };
}
