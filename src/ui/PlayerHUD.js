// 职责：左上角玩家信息 HUD：显示当前账号昵称（昵称优先，其次用户名，游客显示「游客」）并提供退出登录。
const TOKEN_KEY = 'fp_token';

// profile：登录资料（可为 null，表示尚未拿到，如本地有 token 但服务端还没回执）
// hasToken：本地是否持有会话 token（决定退出按钮是否可用、未拿到资料时显示「登录中」）
export function createPlayerHUD(profile, hasToken) {
  const root = document.createElement('div');
  root.style.cssText = [
    'position:fixed', 'top:14px', 'left:14px', 'z-index:900',
    'display:flex', 'align-items:center', 'gap:10px',
    'padding:8px 12px', 'border-radius:12px',
    'background:rgba(255,255,255,0.72)', 'backdrop-filter:blur(10px)',
    'border:1px solid rgba(255,255,255,0.6)',
    'box-shadow:0 6px 20px rgba(0,0,0,0.18)',
    'font-family:system-ui,sans-serif', 'font-size:14px', 'color:#1f2430',
    'user-select:none', 'pointer-events:auto',
  ].join(';');

  // 昵称颜色指示点
  const dot = document.createElement('span');
  dot.style.cssText = 'width:10px;height:10px;border-radius:50%;flex:0 0 auto;background:#8a94a6;box-shadow:0 0 0 2px rgba(255,255,255,0.7);';

  const nameEl = document.createElement('span');
  nameEl.style.cssText = 'font-weight:600;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';

  const quit = document.createElement('button');
  quit.textContent = '退出';
  quit.style.cssText = [
    'padding:4px 10px', 'border:1px solid #d5dae3', 'border-radius:8px',
    'background:rgba(255,255,255,0.9)', 'color:#5a6472',
    'font-size:12px', 'cursor:pointer', 'outline:none',
  ].join(';');
  quit.addEventListener('click', () => {
    localStorage.removeItem(TOKEN_KEY); // 清除会话，下次进入重新登录
    location.reload();
  });

  root.append(dot, nameEl, quit);
  document.body.appendChild(root);

  let logged = !!hasToken;

  // p：登录资料；tokenPresent：是否仍持有有效会话（令牌失效时传 false 退回游客态）
  function setProfile(p, tokenPresent = logged) {
    logged = !!tokenPresent;
    if (p) {
      // 显示名：昵称优先，其次用户名
      nameEl.textContent = p.nickname || p.username || '玩家';
      nameEl.style.color = p.nicknameColor || '#1f2430';
      dot.style.background = p.nicknameColor || '#8a94a6';
    } else if (logged) {
      // 本地有 token 但服务端还没回执
      nameEl.textContent = '登录中…';
      nameEl.style.color = '#1f2430';
      dot.style.background = '#8a94a6';
    } else {
      nameEl.textContent = '游客';
      nameEl.style.color = '#1f2430';
      dot.style.background = '#8a94a6';
    }
    quit.style.display = logged ? '' : 'none'; // 游客无可退出
  }

  setProfile(profile);

  return { root, setProfile };
}