// 职责：进游戏前的登录/注册弹窗。返回 Promise<{token, profile}>。
// token：会话令牌（游客为空串）；profile：登录/注册成功返回的用户资料（含昵称/颜色/称号/皮肤/背包预留位）。
import { Config } from '../config.js';
import { ensureTheme } from './theme.js';

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
  // 超时兜底：后端重启或不可达时请求会一直挂着，若不加限制则会拖住游戏启动（表现为白屏）
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
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

// 显示登录/注册弹窗；用户完成一次交互后 resolve
function showModal(done) {
  ensureTheme();

  const root = document.createElement('div');
  root.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(20,24,32,0.45);backdrop-filter:blur(6px);';
  root.innerHTML = `
    <div class="kui-panel" style="width:340px;">
      <div class="kui-panel__body">
        <div class="kui-title" style="margin-bottom:18px;">账号登录</div>
        <input id="au-name" class="kui-input" placeholder="用户名" style="margin-bottom:10px;" />
        <input id="au-nick" class="kui-input" placeholder="昵称（注册时可起，可留空）" style="margin-bottom:10px;display:none;" />
        <input id="au-pass" class="kui-input" type="password" placeholder="密码" style="margin-bottom:10px;" />
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;">
          <span style="color:var(--kui-ink-soft);font-size:13px;">角色</span>
          <div id="au-gender" style="display:flex;gap:8px;flex:1;">
            <button type="button" class="kui-btn kui-btn--ghost au-g" data-g="boy" style="flex:1;">男生</button>
            <button type="button" class="kui-btn kui-btn--ghost au-g" data-g="girl" style="flex:1;">女生</button>
          </div>
        </div>
        <div id="au-err" style="color:var(--kui-danger);font-size:13px;margin-bottom:10px;min-height:18px;"></div>
        <button id="au-submit" class="kui-btn kui-btn--primary" style="width:100%;">登 录</button>
        <div style="display:flex;justify-content:space-between;margin-top:12px;">
          <a id="au-toggle" class="kui-btn kui-btn--ghost" href="javascript:void(0)" style="display:inline-flex;align-items:center;justify-content:center;text-decoration:none;">没有账号？去注册</a>
          <a id="au-skip" class="kui-btn kui-btn--ghost" href="javascript:void(0)" style="display:inline-flex;align-items:center;justify-content:center;text-decoration:none;">游客进入</a>
        </div>
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

  // 角色性别选择（持久化到 localStorage，下次进入沿用；默认男生）
  let selectedGender = localStorage.getItem('fpm-gender') === 'girl' ? 'girl' : 'boy';
  const gBtns = [...root.querySelectorAll('.au-g')];
  const paintGender = () => gBtns.forEach((b) => b.classList.toggle('kui-btn--primary', b.dataset.g === selectedGender));
  gBtns.forEach((b) => b.addEventListener('click', () => {
    selectedGender = b.dataset.g;
    localStorage.setItem('fpm-gender', selectedGender);
    paintGender();
  }));
  paintGender();

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
    done({ token, profile, gender: selectedGender });
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
