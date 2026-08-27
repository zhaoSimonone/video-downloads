#!/bin/zsh
set -euo pipefail

# Only disable the proxy created by wx_channels_download. A different host or
# port is left untouched so this cannot silently remove the user's own proxy.
proxy_host="127.0.0.1"
proxy_port="2023"

services=()
while IFS= read -r service; do
  [[ -z "$service" || "$service" == "*" ]] && continue
  services+=("$service")
done < <(networksetup -listallnetworkservices | tail -n +2)

restored=0
for service in "${services[@]}"; do
  web_state="$(networksetup -getwebproxy "$service" 2>/dev/null || true)"
  secure_state="$(networksetup -getsecurewebproxy "$service" 2>/dev/null || true)"
  if [[ "$web_state" == *"Enabled: Yes"* && "$web_state" == *"Server: $proxy_host"* && "$web_state" == *"Port: $proxy_port"* ]]; then
    networksetup -setwebproxystate "$service" off
    restored=1
  fi
  if [[ "$secure_state" == *"Enabled: Yes"* && "$secure_state" == *"Server: $proxy_host"* && "$secure_state" == *"Port: $proxy_port"* ]]; then
    networksetup -setsecurewebproxystate "$service" off
    restored=1
  fi
done

if (( restored )); then
  echo "已关闭由 wx_channels_download 设置的本地代理（127.0.0.1:2023）。"
else
  echo "没有发现指向 127.0.0.1:2023 的系统代理，未修改网络设置。"
fi
