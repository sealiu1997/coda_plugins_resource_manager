// view/vendor/three（原样复制的 three.js，脚本 scripts/vendor-three.mjs，第 21.2 节）：每个文件在 Node 里都能导入，导入关系里没有裸的 'three' 和 .js 后缀。
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(import.meta.url), '..', '..', 'view', 'vendor', 'three');
const url = file => new URL(`file://${join(root, file)}`).href;

test('three.module.mjs 和各个 loader、控制器都能在 Node 里导入', async () => {
  const three = await import(url('build/three.module.mjs'));
  assert.equal(three.REVISION, '187');
  assert.equal(typeof three.WebGLRenderer, 'function');
  const expected = {
    'jsm/loaders/GLTFLoader.mjs': 'GLTFLoader', 'jsm/loaders/STLLoader.mjs': 'STLLoader', 'jsm/loaders/OBJLoader.mjs': 'OBJLoader',
    'jsm/loaders/MTLLoader.mjs': 'MTLLoader', 'jsm/loaders/PLYLoader.mjs': 'PLYLoader', 'jsm/loaders/3MFLoader.mjs': 'ThreeMFLoader',
    'jsm/controls/OrbitControls.mjs': 'OrbitControls', 'jsm/environments/RoomEnvironment.mjs': 'RoomEnvironment', 'jsm/utils/BufferGeometryUtils.mjs': 'mergeGeometries', 'jsm/utils/SkeletonUtils.mjs': 'clone',
    'jsm/libs/fflate.module.mjs': 'unzipSync',
  };
  for (const [file, name] of Object.entries(expected)) assert.equal(typeof (await import(url(file)))[name], 'function', `${file} 导出 ${name}`);
});

test('文件之间的导入全是相对路径、后缀 .mjs；放着 LICENSE', async () => {
  const files = [];
  for (const dir of await readdir(root, { recursive: true })) if (dir.endsWith('.mjs')) files.push(dir);
  assert.equal(files.length, 13, 'build 两个、jsm 十一个');
  for (const file of files) {
    const source = await readFile(join(root, file), 'utf8');
    for (const [, spec] of source.matchAll(/(?:^|\n)(?:import|export)\b[^\n]*?\bfrom '([^']+)'|\n\} from '([^']+)'/g)) {
      assert.ok(spec === undefined || spec.startsWith('.') && spec.endsWith('.mjs'), `${file}: ${spec}`);
    }
  }
  assert.match(await readFile(join(root, 'LICENSE'), 'utf8'), /The MIT License/);
});
