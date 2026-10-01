// 职责：进游戏前的登录/注册弹窗。返回 Promise<{token, profile}>。
// token：会话令牌（游客为空串）；profile：登录/注册成功返回的用户资料（含昵称/颜色/称号/皮肤/背包预留位）。
import { Config } from '../config.js';

// 由 WS 中继地址推导同源 HTTP 地址（wss: -> https:, ws: -> http:），用于账号接口
function httpBase() {
  return Config.RELAY_URL.startsWith('wss') ? 'https://' + Config.RELAY_URL.slice(6) : 'http://' + Config.RELAY_URL.slice(5);
}

let base = null;
function apiBase() {
  if (!base) base = httpBase();
  return base;
}

async function api(method, path, body, token) {
  const res = await fetch(apiBase() + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

// 显示登录/注册弹窗；用户完成一次交互后 resolve
function showModal(done) {
  const root = document.createElement('div');
  root.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(20,24,32,0.45);backdrop-filter:blur(6px);';
  root.innerHTML = `
    <div class="auth-card" style="width:340px;background:rgba(255,255,255,0.82);backdrop-filter:blur(12px);border:1px solid rgba(255,255,255,0.6);border-radius:16px;padding:24px;box-shadow:0 12px 40px rgba(0,0,0,0.25);color:#1f2430;font-family:system-ui,sans-serif;">
      <div style="font-size:20px;font-weight:700;margin-bottom:18px;">账号登录</div>
      <input id="au-name" placeholder="用户名" style="width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #d5dae3;border-radius:8px;margin-bottom:10px;font-size:14px;outline:none;" />
      <input id="au-nick" placeholder="昵称（注册时可起，可留空）" style="width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #d5dae3;border-radius:8px;margin-bottom:10px;font-size:14px;outline:none;display:none;" />
      <input id="au-pass" type="password" placeholder="密码" style="width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #d5dae3;border-radius:8px;margin-bottom:10px;font-size:14px;outline:none;" />
      <div id="au-err" style="color:#d33;font-size:13px;margin-bottom:10px;min-height:18px;"></div>
      <button id="au-submit" style="width:100%;padding:11px;border:none;border-radius:8px;background:#5b7cfa;color:#fff;font-size:15px;font-weight:600;cursor:pointer;">登 录</button>
      <div style="display:flex;justify-content:space-between;margin-top:12px;font-size:13px;">
        <a id="au-toggle" href="javascript:void(0)" style="color:#5b7cfa;text-decoration:none;">没有账号？去注册</a>
        <a id="au-skip" href="javascript:void(0)" style="color:#888;text-decoration:none;">游客进入</a>
      </div>
    </div>`;

  document.body.appendChild(root);

  let mode = 'login'; // 'login' | 'register'
  const name = root.querySelector('#au-name');
  const nick = root.querySelector('#au-nick');
  const pass = root.querySelector('#au-pass');
  const err = root.querySelector('#au-err');
  const submit = root.querySelector('#au-submit');
  const toggle = root.querySelector('#au-toggle');
  const skip = root.querySelector('#au-skip');

  function setMode(m) {
    mode = m;
    nick.style.display = m === 'register' ? '' : 'none';
    submit.textContent = m === 'register' ? '注 册' : '登 录';
    toggle.textContent = m === 'register' ? '已有账号？去登录' : '没有账号？去注册';
    err.textContent = '';
  }

  toggle.addEventListener('click', () => setMode(mode === 'login' ? 'register' : 'login'));

  async function submitForm() {
    err.textContent = '';
    const body = { username: name.value.trim(), password: pass.value };
    const path = mode === 'register' ? '/api/register' : '/api/login';
    if (mode === 'register') body.nickname = nick.value.trim();
    submit.disabled = true;
    try {
      const out = await api('POST', path, body);
      if (!out.ok) { err.textContent = out.error || '操作失败'; return; }
      localStorage.setItem('fp_token', out.token);
      finish(out.token, out.profile);
    } catch (e) {
      err.textContent = '网络错误，请检查后端是否在线';
    } finally {
      submit.disabled = false;
    }
  }

  function finish(token, profile) {
    root.remove();
    done({ token, profile });
  }

  submit.addEventListener('click', submitForm);
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitForm(); });
  pass.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitForm(); });
  skip.addEventListener('click', () => finish('', null));
  name.focus();
}

// 进入游戏前的登录流程：已保存 token 则校验并直接进入；否则弹窗登录/注册/游客
export async function ensureAuth() {
  const saved = localStorage.getItem('fp_token');
  if (saved) {
    try {
      // 用 token 拉一次资料：拿到昵称/颜色后直接进入，HUD 不必干等 WS 回执
      const out = await api('GET', '/api/profile', null, saved);
      if (out && out.ok && out.profile) return { token: saved, profile: out.profile };
      if (out && out.ok === false) {
        // 服务端明确判定失效：清掉本地会话，走登录流程
        localStorage.removeItem('fp_token');
      } else {
        return { token: saved, profile: null }; // 返回体异常，保守放行
      }
    } catch {
      // 网络不通：仍带 token 进入（WS 侧会再校验），HUD 暂显「登录中」
      return { token: saved, profile: null };
    }
  }
  return new Promise((resolve) => showModal(resolve));
}