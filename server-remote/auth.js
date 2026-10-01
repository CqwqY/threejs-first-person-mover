// 账号系统：注册/登录/资料 + 预留的称号/皮肤/背包存储。
// 存储：SQLite（better-sqlite3），库文件由 initAuth(dbPath) 指定，位于 data/ 内。
// 密码：node:crypto 的 scrypt 加盐哈希；会话：随机 token + 过期时间。
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';

const SESSION_TTL_MS = 30 * 24 * 3600 * 1000; // token 有效期 30 天
const SCRYPT_LEN = 64;

// 读取请求体（上限 256KB），返回字符串；超限抛错
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > limit) { req.destroy(); reject(new Error('body too large')); }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function sendJSON(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, SCRYPT_LEN).toString('hex');
}

function newToken() {
  return crypto.randomBytes(24).toString('hex');
}

// 用户对外公开资料（供名牌/榜单用），不含敏感字段
function publicProfile(p, user) {
  return {
    username: user.username,
    nickname: p.nickname || '',
    nicknameColor: p.nickname_color || '#ffffff',
    title: p.title || '',
    skin: p.skin || '',
  };
}

export function initAuth(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true }); // 保证 db 所在目录存在
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      pass_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS profiles(
      user_id INTEGER PRIMARY KEY,
      nickname TEXT NOT NULL DEFAULT '',
      nickname_color TEXT NOT NULL DEFAULT '#ffffff',
      title TEXT NOT NULL DEFAULT '',
      skin TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS owned_skins(
      user_id INTEGER NOT NULL,
      skin_key TEXT NOT NULL,
      PRIMARY KEY(user_id, skin_key)
    );
    CREATE TABLE IF NOT EXISTS bag_items(
      user_id INTEGER NOT NULL,
      item_key TEXT NOT NULL,
      qty INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY(user_id, item_key)
    );
    CREATE TABLE IF NOT EXISTS sessions(
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
  `);

  const stmts = {
    userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    insertUser: db.prepare('INSERT INTO users(username, pass_hash, salt, created_at) VALUES (?, ?, ?, ?)'),
    insertProfile: db.prepare('INSERT INTO profiles(user_id) VALUES (?)'),
    profile: db.prepare('SELECT * FROM profiles WHERE user_id = ?'),
    updateProfile: db.prepare('UPDATE profiles SET nickname = ?, nickname_color = ?, title = ?, skin = ? WHERE user_id = ?'),
    insertSession: db.prepare('INSERT INTO sessions(token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'),
    sessionByToken: db.prepare('SELECT * FROM sessions WHERE token = ?'),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
    clearExpired: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),
    skins: db.prepare('SELECT skin_key FROM owned_skins WHERE user_id = ? ORDER BY skin_key'),
    items: db.prepare('SELECT item_key, qty FROM bag_items WHERE user_id = ? ORDER BY item_key'),
  };

  // 需要登录的请求：从 Authorization: Bearer <token> 取 token，解析出用户
  function userFromAuth(req) {
    stmts.clearExpired.run();
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
    if (!token) return null;
    const row = stmts.sessionByToken.get(token);
    if (!row) return null;
    if (row.expires_at < Date.now()) { stmts.deleteSession.run(token); return null; }
    return stmts.userById.get(row.user_id);
  }

  function createSession(userId) {
    const token = newToken();
    const now = Date.now();
    stmts.insertSession.run(token, userId, now, now + SESSION_TTL_MS);
    return token;
  }

  // 返回单用户完整档案（含预留给皮肤/背包的列表）
  function fullProfile(user) {
    const p = stmts.profile.get(user.id) || {};
    return {
      ...publicProfile(p, user),
      userId: user.id,
      ownedSkins: stmts.skins.all(user.id).map((r) => r.skin_key),
      bag: stmts.items.all(user.id).map((r) => ({ key: r.item_key, qty: r.qty })),
    };
  }

  function register(username, password, nickname) {
    const name = (username || '').trim();
    const pass = (password || '').trim();
    if (name.length < 3 || name.length > 20) return { ok: false, error: '用户名需 3~20 位' };
    if (pass.length < 6) return { ok: false, error: '密码至少 6 位' };
    if (stmts.userByName.get(name)) return { ok: false, error: '用户名已被占用' };

    const salt = crypto.randomBytes(16).toString('hex');
    const hash = hashPassword(pass, salt);
    const now = Date.now();
    const info = stmts.insertUser.run(name, hash, salt, now);
    const userId = info.lastInsertRowid;
    stmts.insertProfile.run(userId); // 建立默认资料

    const user = { id: userId, username: name };
    const token = createSession(userId);
    return { ok: true, token, profile: fullProfile(user) };
  }

  function login(username, password) {
    const name = (username || '').trim();
    const pass = (password || '').trim();
    const row = stmts.userByName.get(name);
    if (!row) return { ok: false, error: '用户名或密码错误' };
    const hash = hashPassword(pass, row.salt);
    if (hash !== row.pass_hash) return { ok: false, error: '用户名或密码错误' };

    const token = createSession(row.id);
    return { ok: true, token, profile: fullProfile(row) };
  }

  // 返回 auth 处理结果；若本次请求不属于账号接口则返回 null（由 index.js 继续走路由）
  async function handleRequest(req, res, url) {
    const p = url.pathname;

    if (req.method === 'POST' && (p === '/api/register' || p === '/api/login')) {
      let body;
      try { body = JSON.parse((await readBody(req, 256 * 1024)) || '{}'); }
      catch { return sendJSON(res, 400, { ok: false, error: 'invalid body' }), true; }
      const out = p === '/api/register'
        ? register(body.username, body.password, body.nickname)
        : login(body.username, body.password);
      sendJSON(res, out.ok ? 200 : 401, out);
      return true;
    }

    if (p === '/api/profile') {
      const user = userFromAuth(req);
      if (!user) return sendJSON(res, 401, { ok: false, error: '未登录或已过期' }), true;

      if (req.method === 'GET') {
        sendJSON(res, 200, { ok: true, profile: fullProfile(user) });
        return true;
      }
      if (req.method === 'POST') {
        let body;
        try { body = JSON.parse((await readBody(req, 256 * 1024)) || '{}'); }
        catch { return sendJSON(res, 400, { ok: false, error: 'invalid body' }), true; }
        const cur = stmts.profile.get(user.id) || { nickname: '', nickname_color: '#ffffff', title: '', skin: '' };
        const nickname = typeof body.nickname === 'string' ? body.nickname.slice(0, 16) : cur.nickname;
        const color = typeof body.nicknameColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(body.nicknameColor)
          ? body.nicknameColor : cur.nickname_color;
        // 称号/皮肤仅预留：暂允许提交，便于未来扩展；背包后面另有接口
        const title = typeof body.title === 'string' ? body.title.slice(0, 16) : cur.title;
        const skin = typeof body.skin === 'string' ? body.skin.slice(0, 32) : cur.skin;
        stmts.updateProfile.run(nickname, color, title, skin, user.id);
        sendJSON(res, 200, { ok: true, profile: fullProfile(user) });
        return true;
      }
    }

    if (req.method === 'POST' && p === '/api/logout') {
      const h = req.headers.authorization || '';
      const token = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
      stmts.deleteSession.run(token);
      sendJSON(res, 200, { ok: true });
      return true;
    }

    return null; // 非账号接口
  }

  // 依 token 解析用户公开资料（供 WS 登录后挂身份 / 名牌展示）
  function getPublicByToken(tok) {
    if (!tok) return null;
    const user = userFromAuth({ headers: { authorization: 'Bearer ' + tok } });
    if (!user) return null;
    const p = stmts.profile.get(user.id) || {};
    return publicProfile(p, user);
  }

  return { handleRequest, getPublicByToken };
}