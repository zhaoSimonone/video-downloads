const app = getApp();

const PLATFORM_NAMES = { douyin: "抖音", channels: "微信视频号", unknown: "未知平台" };

Page({
  data: {
    platform: "douyin",
    url: "",
    hint: "例如：https://v.douyin.com/…",
    loading: false,
    downloading: false,
    result: null,
    qualities: ["原画 · MP4", "1080p · MP4", "720p · MP4"],
    qualityIndex: 0,
  },

  selectPlatform(event) {
    const platform = event.currentTarget.dataset.platform;
    this.setData({ platform, hint: platform === "channels" ? "例如：https://channels.weixin.qq.com/…" : "例如：https://v.douyin.com/…" });
  },

  handleInput(event) {
    this.setData({ url: event.detail.value });
  },

  clearUrl() {
    this.setData({ url: "", result: null });
  },

  useExample() {
    const url = "https://weixin.qq.com/sph/ApRH9VNkhv";
    this.setData({ platform: "channels", hint: "例如：https://channels.weixin.qq.com/…", url }, () => this.parse());
  },

  parse() {
    const url = String(this.data.url || "").trim();
    if (!url) return wx.showToast({ title: "请先粘贴视频链接", icon: "none" });
    this.setData({ loading: true });
    wx.request({
      url: `${app.globalData.apiBaseUrl}/api/parse`,
      method: "POST",
      header: { "content-type": "application/json" },
      data: { url },
      success: (res) => {
        if (res.statusCode >= 400 || !res.data?.ok) return wx.showToast({ title: res.data?.error || "解析失败", icon: "none" });
        this.setData({ result: { ...res.data, platformName: PLATFORM_NAMES[res.data.platform] || PLATFORM_NAMES.unknown } });
      },
      fail: () => wx.showToast({ title: "无法连接本地服务", icon: "none" }),
      complete: () => this.setData({ loading: false }),
    });
  },

  selectQuality(event) {
    this.setData({ qualityIndex: Number(event.detail.value) });
  },

  copySource() {
    const source = this.data.result?.pageSource || this.data.result?.source || this.data.url;
    wx.setClipboardData({ data: source, success: () => wx.showToast({ title: "原链接已复制", icon: "none" }) });
  },

  download() {
    const result = this.data.result;
    if (!result?.direct) return wx.showToast({ title: "请先提供 MP4 媒体直链", icon: "none" });
    this.setData({ downloading: true });
    wx.downloadFile({
      url: `${app.globalData.apiBaseUrl}/api/download?url=${encodeURIComponent(result.source)}`,
      success: (res) => {
        if (res.statusCode !== 200) return wx.showToast({ title: "下载失败，请检查媒体直链", icon: "none" });
        wx.saveVideoToPhotosAlbum({
          filePath: res.tempFilePath,
          success: () => wx.showToast({ title: "已保存到相册", icon: "success" }),
          fail: (error) => {
            if (String(error.errMsg || "").includes("auth deny")) wx.showModal({ title: "需要相册权限", content: "请在设置中允许 ClipDock 保存视频到相册。", showCancel: false });
            else wx.showToast({ title: "保存失败", icon: "none" });
          },
        });
      },
      fail: () => wx.showToast({ title: "下载失败，请检查网络", icon: "none" }),
      complete: () => this.setData({ downloading: false }),
    });
  },
});
