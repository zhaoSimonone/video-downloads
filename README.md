# ClipDock

一个本地运行的抖音 / 微信视频号视频下载工作台，桌面端优先。

## 启动

```bash
npm start
```

浏览器打开 <http://localhost:3457>。

## macOS 应用

可以将 ClipDock 打包为一个原生 macOS 应用。应用会在自己的窗口中打开工作台，并自动托管 ClipDock 服务；如果微信视频号桌面代理尚未运行，也会尝试一并启动。

```bash
zsh scripts/build-mac-app.sh
open dist/ClipDock.app
```

应用运行日志和可写配置位于 `~/Library/Application Support/ClipDock/`。首次启动微信视频号代理时，macOS 可能要求允许安装本地 HTTPS 根证书和设置系统代理；这是微信 PC 页面捕获视频所必需的系统权限。应用关闭时只会停止由它自己启动的进程，不会停止你已经手动运行的代理。

如果曾经直接关闭终端或强制退出，系统代理可能来不及自动恢复，表现为代理关闭后无法联网。此时先重新运行一次代理并使用 `Ctrl+C` 正常退出；也可以执行下面的恢复脚本。它只会关闭明确指向 `127.0.0.1:2023` 的代理，不会修改其他代理配置：

```bash
zsh scripts/restore-network-proxy.sh
```

当前构建面向 Apple Silicon。由于 Node.js 由本机环境提供，应用会依次查找 nvm、Homebrew 和系统 Node；请先安装 Node.js 20+。

## 当前能力

- 识别抖音、微信视频号和未知来源链接
- 对平台分享页明确提示需要登录态或可访问的媒体直链
- 对 `mp4` / `mov` / `webm` 等媒体直链执行本地代理下载
- 可选连接 `wx_channels_download` 本机代理，处理微信视频号分享链接
- 下载记录保存在浏览器 `localStorage` 中
- 阻止本地网络地址，避免把下载接口作为 SSRF 代理

平台分享页的解析受登录态、签名 URL 和平台策略影响。请仅下载自己拥有或获得授权使用的内容。

## 微信视频号桌面代理

微信视频号分享链接不是媒体文件地址。要解析这类链接，需要在同一台电脑上运行你提供的 [`wx_channels_download`](https://github.com/ltaoo/wx_channels_download) 桌面程序，让它负责微信 PC 会话、页面注入、媒体捕获和解密；ClipDock 只负责界面和任务回传。

1. 按上游项目说明安装并启动桌面代理。默认 API 地址是 `http://127.0.0.1:2022`（`2023` 是 HTTPS 代理端口，不是 API 端口）。
2. 保持微信 PC 端的视频号页面处于登录状态，并按上游项目说明等待页面与代理建立连接。
3. 使用环境变量启动 ClipDock：

```bash
WX_CHANNELS_AGENT_ORIGIN=http://127.0.0.1:2022 npm start
```

配置代理后，微信视频号分享链接会先创建解析任务，完成后再由本机代理创建下载任务并把生成文件回传给 ClipDock。未配置代理时，分享链接仍会被识别，但不会被当作 MP4 直链处理。

`wx_channels_download` 当前使用 Commons Clause 许可，禁止未经许可将其功能作为收费产品或服务出售。若计划对外分发或商业化，需要先获得作者授权；不要把 Cookie、Token 或代理接口暴露到公网。

## 历史小程序目录

仓库仍保留 `miniprogram/` 作为历史样例，但当前主链路是桌面端。小程序不能绕过微信视频号的扫码登录、签名 URL 或内容权限。
