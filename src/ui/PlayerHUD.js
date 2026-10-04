// 职责：顶部「校卡」。收起态只保留头像、昵称、状态点，减少屏幕占用；
// 展开态用 Kenney 面板展示完整资料，并提供退出登录。
import { ensureTheme } from './theme.js';

const TOKEN_KEY = 'fp_token';

// 昵称色过浅时（如淡黄）印在浅色照片位上会看不清，退回深灰
function pickInk(hex) {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex || '');
  if (!m) return '#1f2430';
  const n = parseInt(m[1], 16);
  const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.72 ? '#1f2430' : hex;
}

function ensureCardLayout() {
  if (typeof document === 'undefined' || document.getElementById('idc-layout')) return;
  const st = document.createElement('style');
  st.id = 'idc-layout';
  st.textContent = `
    .idc {
      position: fixed; z-index: 900; user-select: none;
      left: calc(env(safe-area-inset-left, 0px) + 12px);
      top: calc(env(safe-area-inset-top, 0px) + 12px);
      font-family: var(--kui-font); color: var(--kui-ink);
    }
    .idc-card, .idc-card * { box-sizing: border-box; }

    /* 收起态：胶囊小牌，只放头像+昵称+状态点 */
    .idc-card {
      position: relative; width: auto; height: 40px;
      display: flex; align-items: center; gap: 8px;
      padding: 4px 12px 4px 4px;
      background: rgba(255, 255, 255, .94);
      border: 2px solid var(--kui-blue-dark);
      border-radius: 999px;
      box-shadow: var(--kui-shadow);
      cursor: pointer; overflow: hidden;
      transition: transform .12s ease, box-shadow .12s ease;
    }
    .idc-card:active { transform: scale(.97); }

    .idc-avatar {
      width: 30px; height: 30px; border-radius: 50%;
      background: var(--kui-blue-soft); border: 2px solid var(--kui-blue);
      display: flex; align-items: center; justify-content: center;
      font-size: 14px; font-weight: 700; color: var(--kui-ink);
      flex: 0 0 auto;
    }
    .idc-mini-name {
      font-size: 13px; font-weight: 700; max-width: 110px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .idc-dot {
      width: 7px; height: 7px; border-radius: 50%; background: var(--kui-ink-soft);
      flex: 0 0 auto; margin-left: auto;
    }

    /* 展开态：Kenney 面板 */
    .idc-full {
      position: fixed; left: 12px; top: 62px; z-index: 910;
      width: 240px; display: none;
    }
    .idc.open .idc-full { display: block; }

    .idc-full .kui-panel__body { padding: 10px 12px; }
    .idc-head {
      display: flex; align-items: center; gap: 10px;
      padding-bottom: 8px; border-bottom: 2px solid var(--kui-blue-dark);
      margin-bottom: 8px;
    }
    .idc-photo {
      width: 56px; height: 56px; border-radius: 8px;
      background: var(--kui-blue-soft); border: 2px solid var(--kui-blue);
      display: flex; align-items: center; justify-content: center;
      font-size: 24px; font-weight: 700;
    }
    .idc-meta { flex: 1; min-width: 0; }
    .idc-name { font-size: 14px; font-weight: 700; }
    .idc-user { font-size: 11px; color: var(--kui-ink-soft); }
    .idc-rows { display: flex; flex-direction: column; gap: 4px; }
    .idc-row {
      display: flex; justify-content: space-between; align-items: center;
      font-size: 12px; color: var(--kui-ink-soft);
    }
    .idc-row b { color: var(--kui-ink); font-weight: 700; }
    .idc-quit { margin-top: 10px; width: 100%; }
    .idc-quit.hidden { display: none; }
  `;
  document.head.appendChild(st);
}

// profile：登录资料（可为 null）
// hasToken：本地是否持有会话 token
export function createPlayerHUD(profile, hasToken) {
  ensureTheme();
  ensureCardLayout();

  const root = document.createElement('div');
  root.className = 'idc';
  root.innerHTML = `
    <div class="idc-card" role="button" tabindex="0" aria-label="玩家校卡">
      <div class="idc-avatar"></div>
      <span class="idc-mini-name"></span>
      <span class="idc-dot"></span>
    </div>
    <div class="idc-full kui-panel">
      <div class="kui-panel__body">
        <div class="idc-head">
          <div class="idc-photo"></div>
          <div class="idc-meta">
            <div class="idc-name"></div>
            <div class="idc-user"></div>
          </div>
        </div>
        <div class="idc-rows">
          <div class="idc-row"><span>时间</span><b data-k="time" class="kui-num"></b></div>
          <div class="idc-row"><span>称号</span><b data-k="title"></b></div>
          <div class="idc-row"><span>皮肤</span><b data-k="skin"></b></div>
          <div class="idc-row"><span>背包</span><b data-k="bag" class="kui-num"></b></div>
          <div class="idc-row"><span>编号</span><b data-k="id" class="kui-num"></b></div>
        </div>
        <button class="idc-quit kui-btn kui-btn--danger" type="button">退出登录</button>
      </div>
    </div>`;
  document.body.appendChild(root);

  const card = root.querySelector('.idc-card');
  const avatar = root.querySelector('.idc-avatar');
  const miniName = root.querySelector('.idc-mini-name');
  const miniDot = root.querySelector('.idc-dot');
  const photo = root.querySelector('.idc-photo');
  const nameEl = root.querySelector('.idc-name');
  const userEl = root.querySelector('.idc-user');
  const quit = root.querySelector('.idc-quit');
  const cells = {};
  for (const b of root.querySelectorAll('.idc-row b')) cells[b.dataset.k] = b;

  const toggle = () => root.classList.toggle('open');
  card.addEventListener('click', toggle);
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
  });
  quit.addEventListener('click', (e) => {
    e.stopPropagation();
    localStorage.removeItem(TOKEN_KEY);
    location.reload();
  });

  let logged = !!hasToken;

  function setProfile(p, tokenPresent = logged) {
    logged = !!tokenPresent;
    const name = p ? (p.nickname || p.username || '玩家') : (logged ? '登录中…' : '游客');
    const color = (p && p.nicknameColor) || '#8a94a6';

    miniName.textContent = name;
    miniDot.style.background = color;

    nameEl.textContent = name;
    userEl.textContent = p && p.username ? '@' + p.username : '';

    const first = Array.from(name)[0] || '?';
    avatar.textContent = first;
    photo.textContent = first;
    photo.style.color = pickInk(color);

    cells.title.textContent = (p && p.title) || '—';
    cells.skin.textContent = (p && p.skin) || '默认';
    cells.bag.textContent = p && Array.isArray(p.bag) ? String(p.bag.length) : '0';
    cells.id.textContent = p && p.userId != null ? String(p.userId) : '—';

    quit.classList.toggle('hidden', !logged);
    if (!logged) root.classList.remove('open');
  }

  setProfile(profile);

  function setTime(text) {
    if (cells.time) cells.time.textContent = text;
  }

  return { root, setProfile, setTime };
}
