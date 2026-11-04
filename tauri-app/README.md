# kb-deskpet Tauri A方案

最小可用桌面壳，后端零改动，复用现有 FastAPI。

## 架构
- 后端：你现有的 docker-compose (postgres/api/worker/embed) 跑在 192.168.1.234:9527
- 前端：Tauri 2 + Vite，窗口加载 src/index.html
- 通信：HTTP + SSE，和浏览器版完全一致

## 快速开始
```bash
cd tauri-app
npm install
# 确保后端已起
make -C .. up  # 或者 docker compose up -d
npm run tauri dev
```

首次运行会创建本地store `kb-deskpet.json`，记住 apiBase 和 token。

## 配置
在界面顶部输入：
- API地址：http://192.168.1.234:9527 或 http://localhost:9527
- Token：make seed 打印的

点 记住 会落盘到 Tauri store（不在localStorage）。

## 已处理的关键点
- CORS：tauri.conf.json 里 http 插件 scope 已放开 192.168.1.234:9527
- 拖拽：Tauri 默认启用 fileDrop，页面已处理 drag事件
- SSE：直接 fetch + ReadableStream，和原 index.html 一致
- 存储：@tauri-apps/plugin-store 持久化，替代 localStorage

## 下一步 B方案
- 加托盘图标 + 退出
- 全局快捷键 Alt+K 划词搜索
- 悬浮球窗口

见 docs/11 里 P1-10。
