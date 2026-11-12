// view/format.mjs：大小、相对日期、完整日期、排序名称。日期都用本地时间构造，和时区、语言设置无关。
import assert from 'node:assert/strict';
import test from 'node:test';
import { countText, dateText, dirSizeText, fileSizeText, formatDate, formatDuration, formatFullDate, formatSize, infoText, modeText, sizeText, sortName, subText, thousands } from '../view/format.mjs';

const at = (...parts) => new Date(...parts).getTime();

test('formatSize：字节、KiB、MiB、GiB，一位小数到 10 以下', () => {
  assert.deepEqual([0, 1023, 1024, 1536, 10 * 1024 * 1024, 3 * 1024 ** 3].map(formatSize), ['0 B', '1023 B', '1.0 KiB', '1.5 KiB', '10 MiB', '3.0 GiB']);
});

test('formatDate：今天 14:05，今年 11月4日，往年 2025年3月；以 now 为准', () => {
  const now = at(2026, 10, 5, 15, 30);
  assert.equal(formatDate(at(2026, 10, 5, 14, 5), now), '14:05');
  assert.equal(formatDate(at(2026, 10, 5, 0, 0), now), '00:00', '今天零点还是今天');
  assert.equal(formatDate(at(2026, 10, 4, 23, 59), now), '11月4日', '昨天');
  assert.equal(formatDate(at(2026, 0, 1, 9, 0), now), '1月1日', '今年');
  assert.equal(formatDate(at(2025, 11, 31, 23, 59), now), '2025年12月', '跨年');
  assert.equal(formatDate(at(2025, 2, 4, 10, 0), now), '2025年3月');
  assert.equal(formatDate(at(2026, 10, 5, 14, 5), at(2026, 10, 6, 0, 1)), '11月5日', 'now 过了午夜，同一时刻不再是今天');
  assert.equal(formatDate(at(2026, 4, 5, 14, 5), at(2026, 10, 5, 1, 0)), '5月5日', '月份不同，日子相同，不算今天');
});

test('formatFullDate：年-月-日 时:分:秒，补零', () => {
  assert.equal(formatFullDate(at(2025, 2, 4, 9, 5, 7)), '2025-03-04 09:05:07');
  assert.equal(formatFullDate(at(2026, 10, 15, 23, 59, 59)), '2026-11-15 23:59:59');
});

test('大小、日期、信息行：读不到的部分是 —，文件夹没有大小', () => {
  const now = at(2026, 10, 5, 15, 30);
  const file = { kind: 'file', size: 1536, mtimeMs: at(2026, 10, 5, 14, 5) };
  assert.equal(sizeText(file), '1.5 KiB');
  assert.equal(dateText(file, now), '14:05');
  assert.equal(infoText(file), '1.5 KiB · 2026-11-05 14:05:00');
  assert.equal(sizeText({ kind: 'dir', mtimeMs: file.mtimeMs }), '');
  assert.equal(sizeText({ kind: 'dir', size: 4096 }), '', '文件夹不显示大小');
  assert.equal(infoText({ kind: 'dir', size: 4096, mtimeMs: file.mtimeMs }), '2026-11-05 14:05:00', '文件夹只有完整修改时间');
  assert.equal(infoText({ kind: 'dir' }), '', '文件夹读不到修改时间：空，不是 —');
  assert.equal(dateText({ kind: 'dir' }, now), '');
  assert.equal(subText({ kind: 'dir', mtimeMs: file.mtimeMs }, now), '14:05');
  assert.equal(subText({ kind: 'dir' }, now), '');
  assert.equal(subText(file, now), '14:05 · 1.5 KiB');
  assert.equal(infoText({ kind: 'file' }), '— · —');
  assert.equal(dateText({ kind: 'file', size: 1 }, now), '—');
  assert.equal(sizeText({ kind: 'file', size: 0 }), '0 B', '0 字节是有大小的');
});

test('sortName：四种排序的菜单文字', () => {
  assert.deepEqual(['name', 'kind', 'date', 'size'].map(sortName), ['名称', '种类', '日期', '大小']);
});

test('thousands、countText：千分位；整万的项数写成 N 万项', () => {
  assert.deepEqual([0, 999, 1000, 1204, 1234567].map(thousands), ['0', '999', '1,000', '1,204', '1,234,567']);
  assert.deepEqual([0, 1, 1204, 9999, 10000, 45123, 200000, 210000].map(countText), ['0 项', '1 项', '1,204 项', '9,999 项', '1 万项', '45,123 项', '20 万项', '21 万项']);
});

test('fileSizeText：2.5 KiB（2,560 字节）；不到 1 KiB 只写字节数', () => {
  assert.equal(fileSizeText(2560), '2.5 KiB（2,560 字节）');
  assert.equal(fileSizeText(1024), '1.0 KiB（1,024 字节）');
  assert.equal(fileSizeText(1023), '1023 字节');
  assert.equal(fileSizeText(0), '0 字节');
  assert.equal(fileSizeText(3 * 1024 ** 3), '3.0 GiB（3,221,225,472 字节）');
});

test('dirSizeText：完整、读不到、没统计完、目录正忙', () => {
  const GiB = 1024 ** 3;
  assert.equal(dirSizeText({ size: 3.2 * GiB, items: 1204, complete: true, unreadable: 0 }), '3.2 GiB（1,204 项）');
  assert.equal(dirSizeText({ size: 0, items: 0, complete: true, unreadable: 0 }), '0 B（0 项）');
  assert.equal(dirSizeText({ size: 3.2 * GiB, items: 1204, complete: true, unreadable: 3 }), '至少 3.2 GiB（3 项读不到）');
  assert.equal(dirSizeText({ size: 3.2 * GiB, items: 200000, complete: false, unreadable: 0 }), '超过 3.2 GiB（已统计 20 万项）');
  assert.equal(dirSizeText({ size: 3.2 * GiB, items: 3000, complete: false, unreadable: 2 }), '超过 3.2 GiB（已统计 3,000 项，2 项读不到）');
  assert.equal(dirSizeText({ size: 0, items: 0, complete: false, unreadable: 0 }), '目录正忙，没统计完', '一项都没读到：不写「超过 0 B」');
  assert.equal(dirSizeText({ size: 0, items: 5, complete: false }), '超过 0 B（已统计 5 项）', '读到了项但都是空文件：照常写');
});

test('modeText：rwx 九位，setuid、setgid、sticky 照 ls', () => {
  assert.deepEqual([0o644, 0o755, 0o600, 0o777, 0o000].map(modeText), ['rw-r--r--', 'rwxr-xr-x', 'rw-------', 'rwxrwxrwx', '---------']);
  assert.deepEqual([0o4755, 0o4644, 0o2755, 0o2645, 0o1777, 0o1776].map(modeText), ['rwsr-xr-x', 'rwSr--r--', 'rwxr-sr-x', 'rw-r-Sr-x', 'rwxrwxrwt', 'rwxrwxrwT']);
});

test('formatDuration：不到一小时 m:ss，一小时以上 h:mm:ss，四舍五入到秒', () => {
  assert.deepEqual([0, 5, 59.6, 187.4, 3599, 3600, 3725].map(formatDuration), ['0:00', '0:05', '1:00', '3:07', '59:59', '1:00:00', '1:02:05']);
});
