// 职责：顶部「校卡」。收起时是一枚小牌（昵称 + 状态点），点击展开成竖版校卡，
// 展示账号详细信息（昵称/用户名/称号/皮肤/背包/编号），并在底部提供退出登录。
const TOKEN_KEY = 'fp_token';

let styleInjected = false;
function injectStyle() {
  if (styleInjected || typeof document === 'undefined') return;
  styleInjected = true;
  const style = document.createElement('style');
  style.textContent = `
    .idc {
      position: fixed; top: 14px; left: 50%; transform: translateX(-50%); z-index: 900;
      font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
      color: #1f2430; user-select: none;
    }
    .idc-card {
      position: relative; width: 156px; height: 42px;
      background: rgba(255,255,255,.74); backdrop-filter: blur(12px);
      border: 1px solid rgba(255,255,255,.68); border-radius: 13px;
      box-shadow: 0 6px 20px rgba(0,0,0,.16); overflow: hidden; cursor: pointer;
      transition: width .22s cubic-bezier(.4,0,.2,1), height .22s cubic-bezier(.4,0,.2,1), border-radius .22s ease;
    }
    .idc.open .idc-card { width: 216px; height: 310px; border-radius: 16px; }

    .idc-mini {
      position: absolute; inset: 0; display: flex; align-items: center; gap: 8px; padding: 0 12px;
      transition: opacity .16s ease;
    }
    .idc.open .idc-mini { opacity: 0; pointer-events: none; }
    .idc-dot { width: 9px; height: 9px; border-radius: 50%; background: #8a94a6; flex: 0 0 auto; }
    .idc-mini-name {
      font-size: 14px; font-weight: 600; max-width: 82px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .idc-hint { margin-left: auto; font-size: 11px; color: #97a0ad; }

    .idc-full {
      position: absolute; inset: 0; display: flex; flex-direction: column;
      opacity: 0; pointer-events: none; transition: opacity .18s ease .06s;
    }
    .idc.open .idc-full { opacity: 1; pointer-events: auto; }

    .idc-top {
      display: flex; align-items: center; justify-content: space-between;
      padding: 9px 12px; font-size: 11px; letter-spacing: 3px; color: #7c8695;
      border-bottom: 1px solid rgba(0,0,0,.06);
    }
    .idc-top-dot { width: 8px; height: 8px; border-radius: 50%; background: #8a94a6; }

    .idc-body { flex: 1; display: flex; flex-direction: column; align-items: center; padding: 14px 14px 12px; }
    .idc-avatar {
      width: 54px; height: 54px; border-radius: 50%; background: #cfd6e0; flex: 0 0 auto;
      display: flex; align-items: center; justify-content: center;
      font-size: 22px; font-weight: 700; color: #fff;
      box-shadow: 0 0 0 2px rgba(255,255,255,.85);
    }
    .idc-name {
      margin-top: 9px; font-size: 15px; font-weight: 700; max-width: 100%;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .idc-user { font-size: 11px; color: #8b95a3; margin-top: 2px; height: 14px; }

    .idc-rows { width: 100%; margin-top: 12px; border-top: 1px solid rgba(0,0,0,.06); padding-top: 8px; }
    .idc-row { display: flex; justify-content: space-between; align-items: center; font-size: 12px; padding: 3px 0; color: #8b95a3; }
    .idc-row b {
      color: #3a4250; font-weight: 600; max-width: 112px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }

    .idc-quit {
      margin-top: auto; width: 100%; padding: 7px 0; font-size: 12px;
      border: 1px solid #d5dae3; border-radius: 9px;
      background: rgba(255,255,255,.9); color: #5a6472; cursor: pointer;
      font-family: inherit;
    }
    .idc-quit:hover { background: #fff; color: #1f2430; }
    .idc-quit.hidden { display: none; }
  `;
  document.head.appendChild(style);
}

// 依据背景色亮度挑前景色，保证头像上的首字在深/浅昵称色上都清晰
function readableOn(hex) {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex || '');
  if (!m) return '#ffffff';
  const n = parseInt(m[1], 16);
  const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.62 ? '#1f2430' : '#ffffff';
}

// profile：登录资料（可为 null，如本地有 token 但服务端还没回执）
// hasToken：本地是否持有会话 token，决定「退出登录」是否可用
export function createPlayerHUD(profile, hasToken) {
  injectStyle();

  const root = document.createElement('div');
  root.className = 'idc';
  root.innerHTML = `
    <div class="idc-card" role="button" tabindex="0" aria-label="玩家校卡">
      <div class="idc-mini">
        <span class="idc-dot"></span>
        <span class="idc-mini-name"></span>
        <span class="idc-hint">校卡</span>
      </div>
      <div class="idc-full">
        <div class="idc-top"><span>校 卡</span><span class="idc-top-dot"></span></div>
        <div class="idc-body">
          <div class="idc-avatar"></div>
          <div class="idc-name"></div>
          <div class="idc-user"></div>
          <div class="idc-rows">
            <div class="idc-row"><span>称号</span><b data-k="title"></b></div>
            <div class="idc-row"><span>皮肤</span><b data-k="skin"></b></div>
            <div class="idc-row"><span>背包</span><b data-k="bag"></b></div>
            <div class="idc-row"><span>编号</span><b data-k="id"></b></div>
          </div>
          <button class="idc-quit" type="button">退出登录</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(root);

  const card = root.querySelector('.idc-card');
  const miniDot = root.querySelector('.idc-dot');
  const miniName = root.querySelector('.idc-mini-name');
  const topDot = root.querySelector('.idc-top-dot');
  const avatar = root.querySelector('.idc-avatar');
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
    e.stopPropagation(); // 别让点击冒泡成「收起校卡」
    localStorage.removeItem(TOKEN_KEY); // 清除会话，下次进入重新登录
    location.reload();
  });

  let logged = !!hasToken;

  // p：登录资料；tokenPresent：是否仍持有有效会话（令牌失效时传 false 退回游客态）
  function setProfile(p, tokenPresent = logged) {
    logged = !!tokenPresent;
    const name = p ? (p.nickname || p.username || '玩家') : (logged ? '登录中…' : '游客');
    const color = (p && p.nicknameColor) || '#8a94a6';

    miniName.textContent = name;
    miniName.style.color = color;
    miniDot.style.background = color;
    topDot.style.background = color;

    nameEl.textContent = name;
    nameEl.style.color = color;
    userEl.textContent = p && p.username ? '@' + p.username : '';

    // 头像：昵称色圆底 + 名字首字（Array.from 处理多字节字符）
    const first = Array.from(name)[0] || '?';
    avatar.textContent = first;
    avatar.style.background = color;
    avatar.style.color = readableOn(color);

    cells.title.textContent = (p && p.title) || '—';
    cells.skin.textContent = (p && p.skin) || '默认';
    cells.bag.textContent = p && Array.isArray(p.bag) ? String(p.bag.length) : '0';
    cells.id.textContent = p && p.userId != null ? String(p.userId) : '—';

    quit.classList.toggle('hidden', !logged);
    if (!logged) root.classList.remove('open'); // 游客没有详情可看，保持收起
  }

  setProfile(profile);

  return { root, setProfile };
}
