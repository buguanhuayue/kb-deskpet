# kb-deskpet 桌宠（Tauri 2）

桌宠端：一个透明置顶的宠物窗口 + 一个问答面板窗口，后端复用现有 FastAPI。

## 结构

- 窗口：`pet`（200×200 透明置顶，只做桌宠本体）、`panel`（760×720，问答面板，默认隐藏）
- 前端：Tauri 2 + Vite，两个入口 `src/pet.html`、`src/panel.html`
- 通信：HTTP + SSE，与浏览器版同接口；窗口控制走 Rust command（`show_panel` / `move_window` / `app_quit` 等）

## 目录约定（重要，别踩）

Vite 的 `root` 是 `src`，`publicDir` 默认就是 `src/public`，两条路径的生效方式不一样：

| 放哪 | 怎么被引用 | 构建后 |
|---|---|---|
| `src/*.html`、`src/css/*.css` | `href="css/pet.css"` 相对路径 | 被 vite 处理并加哈希 |
| `src/public/js/*.js`、`src/public/assets/**` | `/js/pet.js`、`/assets/...` 绝对路径 | 原样拷到 dist |

**每种文件只保留一份。** 早期 `src/js` 与 `src/public/js`、`src/css` 与 `src/public/css` 各有一份，
实际生效的只有一半，改错副本不报错也不生效（v0.8.7 的事故就是在这种结构上排查变慢的）。
现在约定：页面和样式在 `src/`，脚本和图片在 `src/public/`。

## 改完必须跑

```bash
npm run check   # 语法自检：任意一个脚本 SyntaxError 直接失败
npm run build   # build 前会自动跑 check
npm run tauri dev
```

`check` 已经接进 CI（`.github/workflows/build-tauri.yml`），语法错不会再有安装包发出去。

## 上传链路

- 真实上传在 Rust 侧（`src-tauri/src/upload.rs`）：读盘 → multipart 上传 → 轮询解析状态，
  全程不发 JS 请求；队列只有一份，桌宠与面板共用。
- 契约（192.168.1.234 实测）：`POST /api/v1/knowledge-bases/{kb}/knowledge/file`，
  multipart 字段 `file`，需 `Authorization: Bearer` + `X-Tenant-ID`。
  成功 200，重复文件 **409** + `code=duplicate_file`（面板显示「已存在」而不是失败）。
- 解析状态：`pending → processing → finalizing → completed`，md 实测 4 秒完成。
  超时（5 分钟）不判失败，只提示「解析时间较长」。
- 令牌：`POST /api/v1/auth/refresh`，请求体 `{"refreshToken": ...}`，返回扁平
  `{"success":true,"access_token","refresh_token"}`；刷新令牌一次性，用后即换。
  刷新成功会通过 `auth:updated` 回写 localStorage；刷新失败发 `auth:expired`，面板退回登录页。
- 单文件上限 50MB（与服务端 `MAX_FILE_SIZE_MB` 一致），本地先拦；拖文件夹会递归展开（最多 500 个）。
- 「选文件 / 选文件夹」走系统对话框（`tauri-plugin-dialog` 的 `pick_paths` 命令）：
  WKWebView 的 `<input type="file">` 只能拿到 `File.name`（`File.path` 是 Electron 的扩展），
  拿不到绝对路径，`describe_paths` 会把每一项判成「读不到」，存入按钮永远是灰的。
  原生拖放（`tauri://drag-drop`）与对话框拿到的是同一形态的真实路径，共用同一条下游链路。
- 「写一段文字」走 `POST /api/v1/knowledge-bases/{kb}/knowledge/manual`（实测 200，
  不强制 `X-Tenant-ID`，租户由 JWT 决定）。

## 已知限制

- 上传进度只有阶段（上传中/解析中），没有百分比：reqwest 用整块 body 发送，拿不到细粒度进度。
- 「解析超时」的条目会在队列里保留错误提示，但后端可能仍在处理，最终以网页端为准。

## 已知实现细节

- 拖动：`pointermove` 里按 `screenX/screenY` 增量调 `move_window`，Rust 侧乘 `scale_factor`
  换成物理像素——Retina / 125% 缩放下不乘就会「只走一半」。
- 点击与拖动分流：只有 `pointerdown → pointerup` 无位移才打开面板；拖拽收尾浏览器补发的
  `click` 不再触发面板。
- 形象：`rig/idle-base2.png` 是「眼睛已填平、头顶书和右手卷轴已挖空」的底图，眼睛/肢体由
  `pet.js` 叠独立图层，脚本挂掉时会看到一只没眼睛的宠物——这本身就是脚本没跑起来的信号。
- 拖文件入库：HTML5 drop 与 Tauri 原生 `tauri://drag-drop` 两条链路都接了。
