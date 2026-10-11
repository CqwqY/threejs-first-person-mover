// 职责：发布面板（广播器 / 公告栏共用）——一段输入 + 可选的历史列表。
// open({ title, placeholder, posts, onSubmit, onDelete })：posts 非空时先显示历史（公告栏用）。
// 传了 onDelete 时每条历史右侧出现撤回按钮（撤回后**服务端会把它从 AI 的视野里删掉**）。
import { ensureTheme } from './theme.js';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

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
  let onDelete = null;

  // 渲染历史列表（每条：正文 + 发布人 + 撤回按钮）
  function renderList(posts) {
    const list = Array.isArray(posts) ? posts : [];
    if (!list.length) { postsWrap.style.display = 'none'; listEl.innerHTML = ''; return; }
    postsWrap.style.display = '';
    listEl.innerHTML = list.slice(-8).map((p) => {
      const id = esc(p && p.id);
      return '<div style="display:flex;gap:6px;align-items:flex-start;">'
        + '<span style="flex:1;">· ' + esc(p && p.text) + '<span style="opacity:.6;">　— ' + esc((p && p.from) || '') + '</span></span>'
        + (onDelete ? '<span class="ap-del" data-id="' + id + '" title="撤回这条公告" '
          + 'style="cursor:pointer;color:var(--kui-danger,#d9534f);opacity:.75;padding:0 4px;">撤回</span>' : '')
        + '</div>';
    }).join('');
  }

  function open(opts) {
    const o = opts || {};
    titleEl.textContent = String(o.title || '发布');
    textEl.value = '';
    textEl.placeholder = String(o.placeholder || '说点什么…');
    errEl.textContent = '';
    onDelete = typeof o.onDelete === 'function' ? o.onDelete : null;
    renderList(o.posts);
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

  // 撤回：点列表里的"撤回" → 回调服务端删除 → 用返回的最新列表刷新
  async function del(id) {
    if (!onDelete || !id) return;
    errEl.textContent = '撤回中…';
    try {
      const r = await onDelete(id);
      if (r && r.ok === false) { errEl.textContent = String(r.reason || '撤回失败'); return; }
      errEl.textContent = '';
      renderList(r && r.posts);
    } catch (e) { errEl.textContent = '撤回失败（网络？）'; }
  }

  root.querySelector('.close').addEventListener('click', close);
  root.querySelector('.ap-cancel').addEventListener('click', close);
  root.querySelector('.ap-send').addEventListener('click', submit);
  listEl.addEventListener('click', (e) => {
    const t = e.target && e.target.closest ? e.target.closest('.ap-del') : null;
    if (t) del(t.getAttribute('data-id'));
  });
  root.addEventListener('click', (e) => { if (e.target === root) close(); });
  textEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); } });

  return { root, open, close, isOpen: () => root.style.display !== 'none' };
}
