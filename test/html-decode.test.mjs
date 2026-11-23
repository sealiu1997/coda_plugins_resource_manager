// decodeHtmlBytes（view/html.mjs，设计第 27.2 节第 2 步）的字节级用例：纯函数，不需要 DOM。
import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeHtmlBytes } from '../view/html.mjs';

// 字符串按 latin1 逐字节写（标签和属性是 ASCII），数组原样追加。
const bytes = (...parts) => Buffer.concat(parts.map(part => (typeof part === 'string' ? Buffer.from(part, 'latin1') : Buffer.from(part))));
const utf8 = text => [...Buffer.from(text, 'utf8')];
const GBK_ZHONGWEN = [0xd6, 0xd0, 0xce, 0xc4]; // 中文
const SJIS_NIHONGO = [0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea]; // 日本語
const GB18030_PLANE2 = [0x95, 0x32, 0x82, 0x36]; // U+20000，只有 GB18030 有四字节写法
const FFFD = '�';

test('GBK、GB18030、Shift_JIS：按 meta 声明解码', () => {
  assert.equal(decodeHtmlBytes(bytes('<meta charset="gbk"><p>', GBK_ZHONGWEN)), '<meta charset="gbk"><p>中文');
  assert.equal(decodeHtmlBytes(bytes('<meta charset=GBK><p>', GBK_ZHONGWEN)), '<meta charset=GBK><p>中文', '不加引号、大写');
  assert.equal(decodeHtmlBytes(bytes('<meta charset="gb2312"><p>', GBK_ZHONGWEN)), '<meta charset="gb2312"><p>中文', 'gb2312 是 gbk 的别名');
  assert.equal(decodeHtmlBytes(bytes('<meta charset="gb18030"><p>', GBK_ZHONGWEN, GB18030_PLANE2)), '<meta charset="gb18030"><p>中文\u{20000}');
  assert.equal(decodeHtmlBytes(bytes('<meta http-equiv="Content-Type" content="text/html; charset=Shift_JIS"><p>', SJIS_NIHONGO)), '<meta http-equiv="Content-Type" content="text/html; charset=Shift_JIS"><p>日本語');
  assert.equal(decodeHtmlBytes(bytes('<meta charset="iso-8859-1"><p>', [0xe9])), '<meta charset="iso-8859-1"><p>é', 'iso-8859-1 按 windows-1252');
  assert.equal(decodeHtmlBytes(bytes('<meta charset="utf-8"><p>', utf8('中文'))), '<meta charset="utf-8"><p>中文');
});

test('属性值里的假 meta 不算；注释里的也不算；认得出的真 meta 在后面照样生效', () => {
  const body = utf8('中文');
  assert.equal(decodeHtmlBytes(bytes("<p title='<meta charset=gbk>'>", body)), "<p title='<meta charset=gbk>'>中文");
  assert.equal(decodeHtmlBytes(bytes('<p title="<meta charset=gbk>">', body)), '<p title="<meta charset=gbk>">中文');
  assert.equal(decodeHtmlBytes(bytes('<a title=">" href=x><p>', body)), '<a title=">" href=x><p>中文', '引号里的 > 不结束标签');
  assert.equal(decodeHtmlBytes(bytes('<!-- <meta charset=gbk> --><p>', body)), '<!-- <meta charset=gbk> --><p>中文');
  assert.equal(decodeHtmlBytes(bytes('<!----><p>', body)), '<!----><p>中文');
  assert.equal(decodeHtmlBytes(bytes("<p title='<meta charset=utf-8>'><meta charset=gbk>", GBK_ZHONGWEN)).endsWith('中文'), true, '假 meta 之后的真 meta');
  assert.equal(decodeHtmlBytes(bytes('<a title=">"><meta charset=gbk>', GBK_ZHONGWEN)).endsWith('中文'), true);
  assert.equal(decodeHtmlBytes(bytes('<!--><meta charset=gbk>', GBK_ZHONGWEN)).endsWith('中文'), true, '<!--> 本身是完整的注释');
  assert.equal(decodeHtmlBytes(bytes('<meta/charset=gbk>', GBK_ZHONGWEN)).endsWith('中文'), true, '/ 分隔属性');
  assert.equal(decodeHtmlBytes(bytes('<META HTTP-EQUIV="CONTENT-TYPE" CONTENT="TEXT/HTML; CHARSET=GBK">', GBK_ZHONGWEN)).endsWith('中文'), true, '大写');
  assert.equal(decodeHtmlBytes(bytes('<meta http-equiv=content-type content="text/html;charset = \'gbk\'">', GBK_ZHONGWEN)).endsWith('中文'), true, 'charset 后有空白、里面再套引号');
});

test('只有 content 没有 http-equiv、或 http-equiv 不是 content-type 的 meta 不算；同一个属性只认第一次', () => {
  const body = utf8('中文');
  assert.equal(decodeHtmlBytes(bytes('<meta content="text/html; charset=gbk"><p>', body)).endsWith('中文'), true);
  assert.equal(decodeHtmlBytes(bytes('<meta http-equiv="refresh" content="text/html; charset=gbk"><p>', body)).endsWith('中文'), true);
  assert.equal(decodeHtmlBytes(bytes('<meta charset=gbk charset=utf-8>', GBK_ZHONGWEN)).endsWith('中文'), true, '第一个 charset 生效');
  assert.equal(decodeHtmlBytes(bytes('<meta charset=utf-8 charset=gbk>', body)).endsWith('中文'), true);
  assert.equal(decodeHtmlBytes(bytes('<meta charset=gbk', GBK_ZHONGWEN)).includes('中文'), false, '标签没写完（数据到头）不算');
  assert.equal(decodeHtmlBytes(bytes('<meta charset="gbk><p>', GBK_ZHONGWEN)).includes('中文'), false, '引号没闭合');
});

test('utf-16、ucs-2、unicode（以及 utf-16le、utf-16be）的声明回退为 UTF-8', () => {
  for (const label of ['utf-16', 'ucs-2', 'unicode', 'utf-16le', 'utf-16be', 'UTF-16', 'csunicode', 'iso-10646-ucs-2']) {
    assert.equal(decodeHtmlBytes(bytes(`<meta charset="${label}"><p>`, utf8('中文'))), `<meta charset="${label}"><p>中文`, label);
  }
});

test('BOM 优先：有 UTF-8 BOM 就按 UTF-8（BOM 不进文本），不看后面的 meta', () => {
  const text = decodeHtmlBytes(bytes([0xef, 0xbb, 0xbf], '<meta charset="gbk"><p>', utf8('中文')));
  assert.equal(text, '<meta charset="gbk"><p>中文');
  assert.equal(decodeHtmlBytes(bytes([0xef, 0xbb, 0xbf], utf8('中'))), '中');
});

test('截断落在多字节字符中间：只丢末尾没写完的字节；不截断时没写完的字节照标准变成 U+FFFD', () => {
  const full = bytes('<p>', utf8('中文'));
  for (const cut of [1, 2]) {
    const part = full.subarray(0, full.length - cut);
    assert.equal(decodeHtmlBytes(part, true), '<p>中', `UTF-8 少 ${cut} 个字节`);
    assert.equal(decodeHtmlBytes(part, false), `<p>中${FFFD}`, '没截断就是文件本来的样子');
  }
  assert.equal(decodeHtmlBytes(full, true), '<p>中文', '没截在字符中间');
  const gbk = bytes('<meta charset=gbk>', GBK_ZHONGWEN.slice(0, 3));
  assert.equal(decodeHtmlBytes(gbk, true), '<meta charset=gbk>中', 'GBK 的半个字');
  const sjis = bytes('<meta charset=shift_jis>', SJIS_NIHONGO.slice(0, 3));
  assert.equal(decodeHtmlBytes(sjis, true), '<meta charset=shift_jis>日');
});

test('文件里本来就有的 U+FFFD 要保留：截断时不删末尾的 �，中间的也不动', () => {
  const kept = bytes('<p>', utf8(`a${FFFD}b${FFFD}`));
  assert.equal(decodeHtmlBytes(kept, true), `<p>a${FFFD}b${FFFD}`, '末尾本来就是 �，截断也不能删');
  assert.equal(decodeHtmlBytes(kept, false), `<p>a${FFFD}b${FFFD}`);
  assert.equal(decodeHtmlBytes(bytes('<p>', utf8(`${FFFD}中文`)).subarray(0, -1), true), `<p>${FFFD}中`, '文件里的 � 保留，末尾半个字丢掉');
  assert.equal(decodeHtmlBytes(bytes('<p>', [0xff, 0x61]), true), `<p>${FFFD}a`, '中间的非法字节照标准变成 �');
});

test('只有 XML 声明时按 UTF-8（不采用标准里退到 XML 声明的那一条）', () => {
  assert.equal(decodeHtmlBytes(bytes('<?xml version="1.0" encoding="gbk"?><p>', utf8('中文'))), '<?xml version="1.0" encoding="gbk"?><p>中文');
  assert.equal(decodeHtmlBytes(bytes('<?xml version="1.0" encoding="gbk"?><p>', GBK_ZHONGWEN)).includes('中文'), false, 'GBK 字节也只按 UTF-8，不会被 XML 声明救回来');
});

test('声明成 x-user-defined 时按 UTF-8（不换成 windows-1252），后面的声明也不再看', () => {
  assert.equal(decodeHtmlBytes(bytes('<meta charset="x-user-defined"><p>', utf8('中文'))), '<meta charset="x-user-defined"><p>中文');
  assert.equal(decodeHtmlBytes(bytes('<meta charset="x-user-defined"><meta charset="gbk"><p>', utf8('中文'))), '<meta charset="x-user-defined"><meta charset="gbk"><p>中文');
  assert.equal(decodeHtmlBytes(bytes('<meta charset="x-user-defined"><p>', [0xe9])), `<meta charset="x-user-defined"><p>${FFFD}`, '不是 windows-1252 的 é');
});

test('先出现一个认不出的声明、后面跟着一个有效声明时，按后面那个', () => {
  assert.equal(decodeHtmlBytes(bytes('<meta charset="bogus"><meta charset="gbk"><p>', GBK_ZHONGWEN)), '<meta charset="bogus"><meta charset="gbk"><p>中文');
  assert.equal(decodeHtmlBytes(bytes('<meta charset=""><meta charset="gbk"><p>', GBK_ZHONGWEN)).endsWith('中文'), true, '空标签也认不出');
  assert.equal(decodeHtmlBytes(bytes('<meta http-equiv="content-type" content="text/html; charset=bogus"><meta charset="gbk"><p>', GBK_ZHONGWEN)).endsWith('中文'), true, 'content 里认不出');
  assert.equal(decodeHtmlBytes(bytes('<meta charset="utf-7"><meta charset="shift_jis"><p>', SJIS_NIHONGO)).endsWith('日本語'), true, 'utf-7 不在标准的标签表里');
  assert.equal(decodeHtmlBytes(bytes('<meta charset="bogus" content="x"><meta charset=gbk>', GBK_ZHONGWEN)).endsWith('中文'), true);
});

test('先出现 iso-2022-kr（含带首尾空白、大写的 " ISO-2022-KR "）、后面跟着 gbk 时，按 UTF-8，不再往后找', () => {
  const trailing = bytes('<meta charset="iso-2022-kr"><meta charset="gbk"><p>', GBK_ZHONGWEN);
  assert.equal(decodeHtmlBytes(trailing), new TextDecoder('utf-8').decode(trailing));
  assert.equal(decodeHtmlBytes(trailing).includes('中文'), false);
  for (const label of ['iso-2022-kr', ' ISO-2022-KR ', '\tIso-2022-Kr\n', 'hz-gb-2312', 'csiso2022kr', 'iso-2022-cn', 'iso-2022-cn-ext', 'replacement', 'REPLACEMENT']) {
    const input = bytes(`<meta charset="${label}"><meta charset="gbk"><p>`, utf8('中文'));
    assert.equal(decodeHtmlBytes(input), new TextDecoder('utf-8').decode(input), JSON.stringify(label));
    assert.equal(decodeHtmlBytes(input).endsWith('中文'), true, JSON.stringify(label));
  }
  const viaContent = bytes('<meta http-equiv="content-type" content="text/html; charset= iso-2022-kr "><meta charset="gbk">', GBK_ZHONGWEN);
  assert.equal(decodeHtmlBytes(viaContent).includes('中文'), false, 'content 里写的 replacement 标签也一样');
  const noPragma = bytes('<meta content="text/html; charset=iso-2022-kr"><meta charset="gbk">', GBK_ZHONGWEN);
  assert.equal(decodeHtmlBytes(noPragma).endsWith('中文'), true, '没有 http-equiv 的 content 不算声明，所以不会停');
});

test('没有声明按 UTF-8；只扫前 1024 字节（跨过 1024 的声明不算，在 1024 以内的算）', () => {
  assert.equal(decodeHtmlBytes(bytes('<p>', utf8('中文'))), '<p>中文');
  assert.equal(decodeHtmlBytes(bytes('')), '');
  const filler = n => ' '.repeat(n);
  const meta = '<meta charset=gbk>';
  const inside = bytes(filler(1024 - meta.length), meta, GBK_ZHONGWEN);
  assert.equal(decodeHtmlBytes(inside).endsWith('中文'), true, '声明的最后一个字节是第 1024 个字节');
  const outside = bytes(filler(1024 - meta.length + 1), meta, GBK_ZHONGWEN);
  assert.equal(decodeHtmlBytes(outside).includes('中文'), false, '声明挪后一个字节就不算');
  const cutAttr = bytes(filler(1024 - '<meta charset=gb'.length), '<meta charset=gbk>', GBK_ZHONGWEN);
  assert.equal(decodeHtmlBytes(cutAttr).includes('中文'), false, '属性值被 1024 切断，不算');
});
