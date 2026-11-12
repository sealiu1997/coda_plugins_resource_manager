// 目录树和菜单里的文字格式：大小、修改日期。纯函数，不依赖运行环境的语言设置；now 由调用方给。
import { EntryKind, SortKey } from './protocol.mjs';

export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let value = bytes / 1024, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

const two = n => String(n).padStart(2, '0');

// 音视频时长：3:07，不到一小时不写小时。
export function formatDuration(seconds) {
  const total = Math.round(seconds), hours = Math.floor(total / 3600), minutes = Math.floor(total % 3600 / 60);
  return hours > 0 ? `${hours}:${two(minutes)}:${two(total % 60)}` : `${minutes}:${two(total % 60)}`;
}

// 相对格式，按本地时间：今天 14:05，今年 11月4日，往年 2025年3月。
export function formatDate(ms, now) {
  const date = new Date(ms), current = new Date(now);
  if (date.getFullYear() !== current.getFullYear()) return `${date.getFullYear()}年${date.getMonth() + 1}月`;
  if (date.getMonth() !== current.getMonth() || date.getDate() !== current.getDate()) return `${date.getMonth() + 1}月${date.getDate()}日`;
  return `${two(date.getHours())}:${two(date.getMinutes())}`;
}

// 完整的修改时间：2025-03-04 14:05:09。
export function formatFullDate(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

const MISSING = '—';
const isDir = entry => entry.kind === EntryKind.DIR;
// 条目的大小和日期：文件读不到的部分是 —；文件夹不显示大小，读不到修改时间也不显示 —，返回空串。
export const sizeText = entry => (isDir(entry) ? '' : Number.isInteger(entry.size) ? formatSize(entry.size) : MISSING);
export const dateText = (entry, now) => (Number.isInteger(entry.mtimeMs) ? formatDate(entry.mtimeMs, now) : isDir(entry) ? '' : MISSING);
const joined = parts => parts.filter(Boolean).join(' · ');
// iPhone 第二行：日期 · 大小；文件夹只有日期。
export const subText = (entry, now) => joined([dateText(entry, now), sizeText(entry)]);
// 菜单信息行和 Mac 的 title：大小 · 完整修改时间；文件夹只有完整修改时间。没有内容时是空串。
export const infoText = entry => joined([sizeText(entry), Number.isInteger(entry.mtimeMs) ? formatFullDate(entry.mtimeMs) : isDir(entry) ? '' : MISSING]);

const NAMES = { [SortKey.NAME]: '名称', [SortKey.KIND]: '种类', [SortKey.DATE]: '日期', [SortKey.SIZE]: '大小' };
export const sortName = key => NAMES[key];

// ---- 属性页 ----
// 千分位：1204 → 1,204。
export const thousands = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
// 项数：整万的写成 20 万项，别的千分位 1,204 项。
export const countText = n => (n >= 10000 && n % 10000 === 0 ? `${n / 10000} 万项` : `${thousands(n)} 项`);
// 文件大小：2.5 KiB（2,560 字节）；不到 1 KiB 只写字节数。
export const fileSizeText = bytes => (bytes < 1024 ? `${bytes} 字节` : `${formatSize(bytes)}（${thousands(bytes)} 字节）`);

// 文件夹大小，{ size, items, complete, unreadable } 是 dir_size 的回答。
// 统计完：3.2 GiB（1,204 项）；有读不到的：至少 3.2 GiB（3 项读不到）；没统计完：超过 3.2 GiB（已统计 20 万项）；
// 一项都没读到就到时间（目录正忙）：不写「超过 0 B」。
export function dirSizeText({ size, items, complete, unreadable = 0 }) {
  if (!complete && items === 0) return '目录正忙，没统计完';
  const bytes = formatSize(size);
  if (!complete) return `超过 ${bytes}（${[`已统计 ${countText(items)}`, unreadable > 0 ? `${unreadable} 项读不到` : ''].filter(Boolean).join('，')}）`;
  return unreadable > 0 ? `至少 ${bytes}（${unreadable} 项读不到）` : `${bytes}（${countText(items)}）`;
}

// 权限：rw-r--r--；setuid、setgid、sticky 照 ls 的写法。
export function modeText(mode) {
  const chars = Array.from('rwxrwxrwx', (char, i) => (mode & (0o400 >> i) ? char : '-'));
  for (const [bit, at, on] of [[0o4000, 2, 's'], [0o2000, 5, 's'], [0o1000, 8, 't']]) {
    if (mode & bit) chars[at] = chars[at] === 'x' ? on : on.toUpperCase();
  }
  return chars.join('');
}
