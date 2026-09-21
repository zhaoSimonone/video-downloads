# ClipDock

一个本地运行的抖音 / 微信视频号 / Instagram / TikTok 视频下载工作台，桌面端优先。

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

发布包使用 Developer ID 签名，并支持 DMG、ZIP 和 Apple 公证：

```bash
bash scripts/package_dmg.sh
xcrun notarytool submit dist/ClipDock.dmg --keychain-profile "TactNotary" --wait
xcrun stapler staple dist/ClipDock.dmg
xcrun stapler staple dist/ClipDock.app
CLIPDOCK_SKIP_APP_BUILD=1 bash scripts/package_zip.sh
```

`package_dmg.sh` 会生成签名的 `dist/ClipDock.dmg`，`package_zip.sh` 会生成 `dist/ClipDock.zip`。默认版本为 `1.0.1 (build 2)`，可通过 `CLIPDOCK_VERSION` 和 `CLIPDOCK_BUILD` 覆盖。若只做本地 ad-hoc 测试，可设置 `CLIPDOCK_ALLOW_ADHOC=1`，该模式不适合对外分发。

应用运行日志和可写配置位于 `~/Library/Application Support/ClipDock/`。首次启动微信视频号代理时，macOS 可能要求允许安装本地 HTTPS 根证书和设置系统代理；这是微信 PC 页面捕获视频所必需的系统权限。应用关闭时只会停止由它自己启动的进程，不会停止你已经手动运行的代理。

应用内下载文件由 macOS 原生下载组件保存到 `~/Downloads/`，同名文件会自动追加编号。

## 下载记录与自动化

每次下载开始时，ClipDock 会创建一条待完成记录；只有 macOS 确认文件已经写入下载目录后，才会补全为 `completed`。记录以 JSON 保存在本机：

```text
~/Library/Application Support/ClipDock/download-records.json
```

每条完成记录包含 `platform`、`title`、`sourceUrl`（原始分享链接）、`resolvedUrl`、`quality`、`filePath`（实际落盘路径）、`fileName`、`fileSizeBytes` 和 `completedAt`。这份文件适合供后续批量上传脚本读取；应用内“下载记录”页面可直接在 Finder 中打开 JSON 文件或定位单个视频。

当 ClipDock 正在运行时，也可通过本机接口读取完成记录：

```bash
curl http://127.0.0.1:3457/api/download-records
```

需要同时查看待完成或失败项时使用 `?status=all`。清空应用内记录只会清空 JSON 数据，不会删除已下载的视频文件。

如果曾经直接关闭终端或强制退出，系统代理可能来不及自动恢复，表现为代理关闭后无法联网。此时先重新运行一次代理并使用 `Ctrl+C` 正常退出；也可以执行下面的恢复脚本。它只会关闭明确指向 `127.0.0.1:2023` 的代理，不会修改其他代理配置：

```bash
zsh scripts/restore-network-proxy.sh
```

当前构建面向 Apple Silicon。由于 Node.js 由本机环境提供，应用会依次查找 nvm、Homebrew 和系统 Node；请先安装 Node.js 20+。

## 当前能力

- 识别抖音、微信视频号、Instagram Reel 和 TikTok 链接
- 对平台分享页明确提示需要登录态或可访问的媒体直链
- 对 `mp4` / `mov` / `webm` 等媒体直链执行本地代理下载
- 可选连接 `wx_channels_download` 本机代理，处理微信视频号分享链接
- Instagram Reel 支持通过独立 Chrome 登录会话捕获播放时产生的媒体请求
- TikTok 视频支持通过独立 Chrome 登录会话捕获播放时产生的媒体请求
- Instagram 捕获的视频会自动转换为 QuickTime 兼容的 H.264/AAC MP4，并保存为 `instagram-reel-compatible.mp4`
- 下载记录以结构化 JSON 保存在本机，并在文件实际写入完成后更新实际路径和大小
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

## Instagram 捕获

粘贴 Instagram Reel、帖子或视频链接并提取信息后，点击“打开并捕获”。ClipDock 会启动一个本地 Chrome 登录档案（首次使用需要在该窗口中登录 Instagram），打开链接并等待视频播放。请播放一次视频，捕获到 MP4 媒体请求后即可下载。媒体地址通常是短时有效的签名 URL，因此应在捕获后立即下载；当前版本不处理需要分段合并的 HLS/DASH 资源。

Instagram 当前常返回 VP9 fragmented MP4，且可能把音频作为独立媒体轨道提供。这类文件虽然是合法 MP4，但 QuickTime 可能无法打开，或只显示画面没有声音。ClipDock 下载时会在临时目录中收集目标视频及其音频轨道，使用本机 `ffmpeg` 合并并转为 H.264/AAC MP4，再交给 macOS 保存。应用会自动查找 `FFMPEG_PATH`、Homebrew 常见路径和 `PATH` 中的 `ffmpeg`；若未找到，请执行 `brew install ffmpeg` 后重试。临时源文件会在响应完成后删除。

Chrome 调试接口仅监听 `127.0.0.1`，捕获逻辑只保留 User-Agent、Referer 等必要请求头，不读取或保存 Cookie。请仅处理自己拥有或获授权使用的内容。

## TikTok 捕获

粘贴 TikTok 视频链接并提取信息后，点击“打开并捕获”。ClipDock 会在本地 Chrome 登录档案中打开链接，等待目标视频播放产生 TikTok CDN 媒体请求。播放一次目标视频后即可下载；视频通常已包含声音，下载接口会保留原始音视频轨道。TikTok 的签名媒体地址有效期较短，请在捕获后立即下载。若页面要求登录或出现地区限制，请先在打开的 Chrome 窗口中完成登录并确认视频可以正常播放。

## 历史小程序目录

仓库仍保留 `miniprogram/` 作为历史样例，但当前主链路是桌面端。小程序不能绕过微信视频号的扫码登录、签名 URL 或内容权限。
