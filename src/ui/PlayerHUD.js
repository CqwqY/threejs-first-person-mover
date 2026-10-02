// 职责：顶部「校卡」。外层是蓝色卡套，套里是白卡：上方学校名、中间证件照位、下方账号信息
// （昵称/用户名/称号/皮肤/背包/编号），底部提供退出登录。收起时只露出小牌（昵称 + 状态点）。
// 视觉统一走 theme.js 的 Kenney 主题：蓝色卡套、主题变量配色，按钮/数字用主题类。
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

// 校卡的几何布局与展开/收起状态。theme.js 只提供可换肤的皮肤（面板/按钮/输入/数字），
// 不含定位与尺寸；而 .open/.hidden 由既有的类切换驱动，必须有对应规则，故保留这一份纯布局样式。
// 其中不再出现任何硬编码配色，颜色一律取自主题 CSS 变量。
function ensureCardLayout() {
  if (typeof document === 'undefined' || document.getElementById('idc-layout')) return;
  const st = document.createElement('style');
  st.id = 'idc-layout';
  st.textContent = `
    .idc {
      position: fixed; top: 14px; left: 50%; transform: translateX(-50%); z-index: 900;
      font-family: var(--kui-font); color: var(--kui-ink); user-select: none;
    }
    .idc-card, .idc-card * { box-sizing: border-box; }
    /* 外层蓝色卡套：卡本体是套里的白卡，展开时套子一起变大 */
    .idc-card {
      position: relative; width: 190px; height: 44px;
      background: linear-gradient(150deg, var(--kui-blue), var(--kui-blue-dark));
      border: 1px solid var(--kui-blue-deep); border-radius: var(--kui-radius);
      box-shadow: var(--kui-shadow); overflow: hidden; cursor: pointer;
      transition: width .22s cubic-bezier(.4,0,.2,1), height .22s cubic-bezier(.4,0,.2,1), border-radius .22s ease;
    }
    .idc.open .idc-card { width: 268px; height: 368px; border-radius: 16px; }

    .idc-mini {
      position: absolute; inset: 4px; border-radius: 9px; background: var(--kui-paper);
      display: flex; align-items: center; gap: 8px; padding: 0 10px;
      transition: opacity .16s ease;
    }
    .idc.open .idc-mini { opacity: 0; pointer-events: none; }
    .idc-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--kui-ink-soft); flex: 0 0 auto; }
    .idc-mini-name {
      font-size: 14px; font-weight: 600; color: var(--kui-ink); max-width: 100px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .idc-hint { margin-left: auto; font-size: 11px; color: var(--kui-ink); }

    .idc-full {
      position: absolute; inset: 6px; border-radius: 11px; background: var(--kui-paper);
      display: flex; flex-direction: column; padding: 10px 12px 12px;
      opacity: 0; pointer-events: none; transition: opacity .18s ease .06s;
    }
    .idc.open .idc-full { opacity: 1; pointer-events: auto; }

    /* 卡面顶部：学校名 */
    .idc-school {
      display: flex; align-items: center; justify-content: space-between;
      font-size: 13px; font-weight: 700; letter-spacing: 2px; color: var(--kui-ink);
      padding-bottom: 8px; border-bottom: 1px solid var(--kui-blue-soft);
    }
    .idc-school-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--kui-ink-soft); }

    /* 卡面中部：证件照位（暂无真实照片时显示昵称首字） */
    .idc-photo {
      margin: 12px auto 0; width: 88px; height: 96px; border-radius: 6px; flex: 0 0 auto;
      background: var(--kui-blue-soft); border: 1px solid var(--kui-blue-dark);
      display: flex; align-items: center; justify-content: center;
      font-size: 36px; font-weight: 700; color: var(--kui-ink);
    }
    .idc-name {
      margin-top: 9px; font-size: 15px; font-weight: 700; color: var(--kui-ink); max-width: 100%;
      text-align: center; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .idc-user { font-size: 11px; color: var(--kui-ink); margin-top: 2px; height: 14px; text-align: center; }

    /* 卡面下部：资料信息 */
    .idc-rows { width: 100%; margin-top: 10px; border-top: 1px solid var(--kui-blue-soft); padding-top: 5px; }
    .idc-row { display: flex; justify-content: space-between; align-items: center; font-size: 12px; padding: 3px 0; color: var(--kui-ink); }
    .idc-row b {
      color: var(--kui-ink); font-weight: 600; max-width: 156px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }

    /* 退出登录：外观交给主题的 .kui-btn--danger，这里只管占位与显隐 */
    .idc-quit { margin-top: auto; width: 100%; }
    .idc-quit.hidden { display: none; }
  `;
  document.head.appendChild(st);
}

// profile：登录资料（可为 null，如本地有 token 但服务端还没回执）
// hasToken：本地是否持有会话 token，决定「退出登录」是否可用
export function createPlayerHUD(profile, hasToken) {
  ensureTheme();
  ensureCardLayout();

  const root = document.createElement('div');
  root.className = 'idc';
  root.innerHTML = `
    <div class="idc-card" role="button" tabindex="0" aria-label="玩家校卡">
      <div class="idc-mini">
        <span class="idc-dot"></span>
        <span class="idc-mini-name"></span>
        <span class="idc-time kui-num"></span>
        <span class="idc-hint">校卡</span>
      </div>
      <div class="idc-full">
        <div class="idc-school"><span>花草中学</span><span class="idc-school-dot"></span></div>
        <div class="idc-photo"></div>
        <div class="idc-name"></div>
        <div class="idc-user"></div>
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
  const miniDot = root.querySelector('.idc-dot');
  const miniName = root.querySelector('.idc-mini-name');
  const topDot = root.querySelector('.idc-school-dot');
  const photo = root.querySelector('.idc-photo');
  const nameEl = root.querySelector('.idc-name');
  const userEl = root.querySelector('.idc-user');
  const quit = root.querySelector('.idc-quit');
  const miniTime = root.querySelector('.idc-time');
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
    miniDot.style.background = color;
    topDot.style.background = color;

    nameEl.textContent = name;
    userEl.textContent = p && p.username ? '@' + p.username : '';

    // 证件照位：暂时用名字首字代替照片（Array.from 处理多字节字符）
    const first = Array.from(name)[0] || '?';
    photo.textContent = first;
    photo.style.color = pickInk(color);

    cells.title.textContent = (p && p.title) || '—';
    cells.skin.textContent = (p && p.skin) || '默认';
    cells.bag.textContent = p && Array.isArray(p.bag) ? String(p.bag.length) : '0';
    cells.id.textContent = p && p.userId != null ? String(p.userId) : '—';

    quit.classList.toggle('hidden', !logged);
    if (!logged) root.classList.remove('open'); // 游客没有详情可看，保持收起
  }

  setProfile(profile);

  // 更新校卡上的世界时间（由 Game 按昼夜循环驱动）
  function setTime(text) {
    if (miniTime) miniTime.textContent = text;
    if (cells.time) cells.time.textContent = text;
  }

  return { root, setProfile, setTime };
}
