// 职责：发布面板（广播器 / 公告栏共用）——一段输入 + 可选的历史列表。
// open({ title, placeholder, posts, onSubmit })：posts 非空时先显示历史（公告栏用）。
import { ensureTheme } from './theme.js';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

export function createAnnouncePanel() {
  ensureTheme();
  const root = document.createElement('div');
  root.className = 'announce-panel hidden';
  Object.assign(root.style, {
    position: 'fixed', inset: '0', zIndex: '9600', display: 'none',
    alignItems: 'center', justifyContent: 'center', background: 'rgba(6,12,20,.45)',
    fontFamily: 'var(--kui-font)', fontSize: '13px', lineHeight: '1.6',
  });
  root.innerHTML = `
    <div style="width:min(460px,92vw);max-height:84vh;overflow:auto;background:var(--kui-paper);
        border:2px solid var(--kui-blue-dark);border-radius:14px;box-shadow:0 16px 48px rgba(0,0,0,.5);">
      <div style="display:flex;align-items:center;gap:8px;padding:12px 14px 8px;border-bottom:2px solid var(--kui-blue-soft);">
        <span class="kui-title ap-title">发布</span>
        <span class="close kui-iconbtn" style="margin-left:auto;">×</span>
      </div>
      <div class="ap-posts" style="display:none;padding:10px 14px;">
        <div style="font-weight:700;color:var(--kui-blue-dark);margin-bottom:4px;">已有公告</div>
        <div class="ap-list" style="max-height:180px;overflow:auto;color:var(--kui-ink-soft);"></div>
      </div>
      <div style="padding:10px 14px 16px;">
        <textarea class="kui-input ap-text" rows="3" style="width:100%;resize:vertical;"></textarea>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px;">
          <button type="button" class="kui-btn ap-cancel">取消</button>
          <button type="button" class="kui-btn kui-btn--primary ap-send">发布</button>
        </div>
        <div class="ap-err" style="color:var(--kui-danger,#d9534f);min-height:16px;margin-top:4px;"></div>
      </div>
    </div>`;
  document.body.appendChild(root);

  const titleEl = root.querySelector('.ap-title');
  const postsWrap = root.querySelector('.ap-posts');
  const listEl = root.querySelector('.ap-list');
  const textEl = root.querySelector('.ap-text');
  const errEl = root.querySelector('.ap-err');
  let onSubmit = null;

  function open(opts) {
    const o = opts || {};
    titleEl.textContent = String(o.title || '发布');
    textEl.value = '';
    textEl.placeholder = String(o.placeholder || '说点什么…');
    errEl.textContent = '';
    const posts = Array.isArray(o.posts) ? o.posts : null;
    if (posts && posts.length) {
      postsWrap.style.display = '';
      listEl.innerHTML = posts.slice(-8).map((p) => '<div>· ' + esc(p.text) + '<span style="opacity:.6;">　— ' + esc(p.from || '') + '</span></div>').join('');
    } else { postsWrap.style.display = 'none'; listEl.innerHTML = ''; }
    onSubmit = typeof o.onSubmit === 'function' ? o.onSubmit : null;
    root.classList.remove('hidden');
    root.style.display = 'flex';
    setTimeout(() => textEl.focus(), 0);
  }
  function close() { root.classList.add('hidden'); root.style.display = 'none'; }

  async function submit() {
    const text = textEl.value.trim();
    if (!text) { errEl.textContent = '不能为空'; return; }
    if (!onSubmit) { close(); return; }
    errEl.textContent = '发布中…';
    try {
      const r = await onSubmit(text);
      if (r && r.ok === false) { errEl.textContent = String(r.reason || '发布失败'); return; }
      close();
    } catch (e) { errEl.textContent = '发布失败（网络？）'; }
  }

  root.querySelector('.close').addEventListener('click', close);
  root.querySelector('.ap-cancel').addEventListener('click', close);
  root.querySelector('.ap-send').addEventListener('click', submit);
  root.addEventListener('click', (e) => { if (e.target === root) close(); });
  textEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); } });

  return { root, open, close, isOpen: () => root.style.display !== 'none' };
}
