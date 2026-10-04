// 职责：账号相关的 HTTP 接口（登录/资料/背包云存档）。
// 地址由 WS 中继地址推导同源 HTTP（wss→https、ws→http），与 AuthUI 用同一套推导。
//
// 约定：**任何失败都返回 null，不抛异常**（网络不通、老服务端没有该接口、返回体不是 JSON）。
// 调用方据此静默降级到纯本地存档，绝不能因为同步失败影响玩。
import { Config } from '../config.js';

let base = null;
function apiBase() {
  if (!base) {
    base = Config.RELAY_URL.startsWith('wss')
      ? 'https://' + Config.RELAY_URL.slice(6)
      : 'http://' + Config.RELAY_URL.slice(5);
  }
  return base;
}

// method/path/body/token → 解析后的 JSON，或 null（失败）
export async function accountApi(method, path, body, token) {
  // 超时兜底：后端不可达时请求会一直挂着，不加限制会拖住调用方
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 5000);
  try {
    const res = await fetch(apiBase() + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ac.signal,
    });
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
