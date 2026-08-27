// 开发阶段可使用 http://127.0.0.1:3457；上线后替换为已配置 request 合法域名的 HTTPS 地址。
const API_BASE_URL = "http://127.0.0.1:3457";

App({
  globalData: {
    apiBaseUrl: API_BASE_URL,
  },
});
