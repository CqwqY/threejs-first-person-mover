// 职责：学生「校卡」——把 AI 的性格/心情/当前目标/关系/近期记忆摆给玩家看（只读）。
// 数据来自服务端 GET /api/npc/card?id=<学生id>（见 server-remote/npcworld.js 的 card()）。
import { ensureTheme } from './theme.js';

function moodWord(v) { return v > 0.65 ? '心情不错' : v < 0.35 ? '有点低落' : '心情一般'; }
function energyWord(v) { return v > 0.65 ? '挺有精神' : v < 0.35 ? '没什么力气' : '精力一般'; }
function bar(v, color) {
  const p = Math.max(0, Math.min(1, Number(v) || 0)) * 100;
  return '<span style="display:inline-block;width:74px;height:8px;border-radius:4px;background:var(--kui-blue-soft);vertical-align:middle;overflow:hidden;">' +
    '<span style="display:block;height:100%;width:' + p.toFixed(0) + '%;background:' + color + ';"></span></span>';
}
const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

export function createNpcCard() {
  ensureTheme();
  const root = document.createElement('div');
  root.className = 'npc-card hidden';
  Object.assign(root.style, {
    position: 'fixed', inset: '0', zIndex: '9600', display: 'none',
    alignItems: 'center', justifyContent: 'center', background: 'rgba(6,12,20,.45)',
    fontFamily: 'var(--kui-font)', fontSize: '13px', lineHeight: '1.6',
  });
  root.innerHTML = `
    <div style="width:min(520px,92vw);max-height:84vh;overflow:auto;background:var(--kui-paper);
        border:2px solid var(--kui-blue-dark);border-radius:14px;box-shadow:0 16px 48px rgba(0,0,0,.5);">
      <div style="display:flex;align-items:center;gap:10px;padding:12px 14px 8px;border-bottom:2px solid var(--kui-blue-soft);">
        <span class="badge" style="flex:none;width:44px;height:56px;border-radius:8px;background:linear-gradient(160deg,var(--kui-blue),var(--kui-blue-dark));display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:18px;"></span>
        <div style="min-width:0;">
          <div class="card-name kui-title" style="font-size:16px;">同学</div>
          <div class="card-sub" style="color:var(--kui-ink-soft);font-size:12px;"></div>
        </div>
        <span class="close kui-iconbtn" style="margin-left:auto;flex:none;">×</span>
      </div>
      <div class="card-body" style="padding:12px 14px 16px;"></div>
    </div>`;
  document.body.appendChild(root);

  const nameEl = root.querySelector('.card-name');
  const subEl = root.querySelector('.card-sub');
  const badgeEl = root.querySelector('.badge');
  const bodyEl = root.querySelector('.card-body');

  function section(title, html) {
    return '<div style="margin-top:10px;"><div style="font-weight:700;color:var(--kui-blue-dark);margin-bottom:4px;">' + title + '</div>' + html + '</div>';
  }

  function show(card) {
    if (!card) { bodyEl.innerHTML = '<div style="color:var(--kui-ink-soft);">拿不到这张校卡（服务端没这个学生？）</div>'; nameEl.textContent = '同学'; subEl.textContent = ''; return; }
    nameEl.textContent = card.name || '同学';
    subEl.textContent = [card.cls, card.sex === 'f' ? '女生' : '男生', card.place].filter(Boolean).join(' · ');
    badgeEl.textContent = String(card.name || '?').slice(0, 1);

    const html = [];
    if (card.persona) html.push(section('性格', '<div>' + esc(card.persona) + '</div>'));

    const m = card.mood || {};
    html.push(section('此刻心情',
      '<div>' + moodWord(m.valence) + '、' + energyWord(m.energy) + '</div>' +
      '<div style="margin-top:3px;">愉快 ' + bar(m.valence, 'var(--kui-ok)') + '　精力 ' + bar(m.energy, 'var(--kui-blue)') + '　专注 ' + bar(m.focus, 'var(--kui-warn, #e0a63a)') + '</div>'));

    if (card.quest) {
      html.push(section('正在办的委托', '<div>去找 <b>' + esc(card.quest.targetName) + '</b> 问「' + esc(card.quest.question) + '」（' + esc(card.quest.stage) + '）</div>'));
    } else if (card.goal) {
      const g = card.goal;
      html.push(section('现在想做什么', '<div>' + esc(g.text || g.type || '—') + (g.activity ? '　<span style="color:var(--kui-ink-soft);">' + esc(g.activity) + '</span>' : '') + '</div>'));
    } else {
      html.push(section('现在想做什么', '<div style="color:var(--kui-ink-soft);">暂时没主意（发呆中）</div>'));
    }

    if (Array.isArray(card.rel) && card.rel.length) {
      html.push(section('关系', card.rel.map((r) => '<div>' + esc(r.who) + '　' + (r.trust > 0 ? '<span style="color:var(--kui-ok);">亲近 +' + r.trust.toFixed(2) + '</span>' : '<span style="color:var(--kui-danger, #d9534f);">反感 ' + r.trust.toFixed(2) + '</span>') + '</div>').join('')));
    }

    if (Array.isArray(card.mem) && card.mem.length) {
      html.push(section('近期记忆', card.mem.map((x) => '<div style="color:var(--kui-ink-soft);">· ' + esc(x.text) + '</div>').join('')));
    }
    bodyEl.innerHTML = html.join('');
  }

  function open() { root.classList.remove('hidden'); root.style.display = 'flex'; }
  function close() { root.classList.add('hidden'); root.style.display = 'none'; }
  root.querySelector('.close').addEventListener('click', close);
  // 点背景关闭
  root.addEventListener('click', (e) => { if (e.target === root) close(); });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && root.style.display !== 'none') close(); });

  return { root, show, open, close, isOpen: () => root.style.display !== 'none' };
}
