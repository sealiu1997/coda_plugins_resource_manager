# SVG 直接打开的对照（设计 27.8）

`a.svg` 内容：一个黄底绿圆、一行「静态文字：脚本未运行」，带一段脚本。脚本一旦执行，会把这行字改成「脚本运行了」，并请求 `svg-script-probe.png?from=a.svg`（该文件不存在，只看请求是否发出）。

黄底绿圆是脚本之外画出来的、脚本不会碰它，任何打开方式下都应能看见，作为判读的共用前提。那行文字是脚本要改的对象：脚本执行了会变成「脚本运行了」，所以文字只用来判读，不作前提。

## 约定：以 `test/fixtures/html` 为根

下面所有路径都以 `test/fixtures/html` 为工作目录根，`a.svg` 的相对路径是 `svg/a.svg`，请求路径是 `/svg/a.svg`。

## 1. 看回答头

用插件给出的地址 `coda-view://service/media/<口令>/svg/a.svg`；没有真机时，在本机用 `createMedia()` 起一个同样逻辑的服务，`grant` 的根目录取 `test/fixtures/html`，再：

```sh
curl -sI http://127.0.0.1:<端口>/<口令>/svg/a.svg | grep -iE '^(content-type|content-security-policy|x-content-type-options):'
```

应看到：

- `Content-Type: image/svg+xml`
- `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox`
- `X-Content-Type-Options: nosniff`

## 2. 脚本本身能跑（排除样例问题）

在 Mac 浏览器里直接用 `file://` 打开 `test/fixtures/html/svg/a.svg`：画面上的字应变成「脚本运行了」，开发者工具网络页能看到 `svg-script-probe.png` 的请求。看不到就是样例有问题，后面的结论都不成立。

## 3. 在 Coda 里直接打开（`coda.open`），和 `b.svg` 对照

先按文末做出 `b.svg`，两个都用「在 Coda 中打开」直接打开。两个画面都应能看到黄底绿圆（共用前提；看不见就是测试本身有问题），再按两份各自的文字判读：

- `b.svg` 的字变成「脚本运行了」、`a.svg` 没变：头起作用了，**通过**。
- `a.svg` 的字变成「脚本运行了」：**不通过**，不能按通过上线，CSP 这项记进 backlog。
- 两个都没变：先排除测试本身的问题，三项都成立才往下：
  - 两个 SVG 的黄底绿圆都看得见；
  - 两份回答的 MIME 和 CSP 只差预期那一处（见下文「对比」）；
  - 第 2 步里同一段脚本在浏览器里确实会改字（对 `b.svg` 也做一遍）。

  三项都成立，才记为「这条打开路径下两个都没观察到脚本执行」，**不推断**宿主的具体机制。头照加，前提是图片显示正常。

## 4. 作为图片

在 `test/fixtures/html/` 下新建两个文件（不进仓库），引用路径都相对这个文件所在的目录，也就是根：

`svg-img.md`：

```markdown
![svg 图片](svg/a.svg)
```

`svg-img.html`：

```html
<img src="svg/a.svg" alt="svg 图片">
```

在预览里分别打开它们，两种都应显示出黄底绿圆和静态文字（图片里脚本本来就不执行，所以文字是「静态文字：脚本未运行」）。图片显示不出来就不加 CSP，记进 backlog。

## 临时做不带 CSP 的 `b.svg`（不进仓库）

1. 在 `test/fixtures/html/svg/` 下 `cp a.svg b.svg`，让两个文件内容相同（脚本请求的探针里写的是 `from=a.svg`，不影响判读）；
2. 临时把 `lib/media.mjs` 里 `if (type === SVG_TYPE) res.setHeader(...)` 那一行改成 `if (type === SVG_TYPE && !path.endsWith('b.svg'))`，让 `b.svg` 不带 CSP；
3. 测完 `git checkout lib/media.mjs` 还原，删掉 `b.svg`。

### 对比

只比较 MIME 和 CSP，`ETag`、`Date` 等每次会变的头不比：

```sh
for f in a b; do echo "== $f.svg"; curl -sI http://127.0.0.1:<端口>/<口令>/svg/$f.svg | grep -iE '^(content-type|content-security-policy):'; done
```

两份应只差 `Content-Security-Policy` 一行（`a.svg` 有，`b.svg` 没有）。
