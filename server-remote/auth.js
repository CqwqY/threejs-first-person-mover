// 账号系统：注册/登录/资料 + 预留的称号/皮肤/背包存储。
// 存储：SQLite（better-sqlite3），库文件由 initAuth(dbPath) 指定，位于 data/ 内。
// 密码：node:crypto 的 scrypt 加盐哈希；会话：随机 token（库内只存其 SHA-256，泄库也无法直接复用）。
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';

const SESSION_TTL_MS = 30 * 24 * 3600 * 1000; // token 有效期 30 天
const SCRYPT_LEN = 64;
const MAX_SESSIONS_PER_USER = 10;             // 单账号保留的会话上限，超出踢掉最旧的
const MIN_USERNAME_LEN = 3;
const MAX_USERNAME_LEN = 20;
const MIN_PASSWORD_LEN = 8;
const MAX_PASSWORD_LEN = 128;

// 登录失败限流（进程内存，重启清空）：窗口内失败次数超限即拒绝
const RL_WINDOW_MS = 10 * 60 * 1000;
const RL_MAX_PER_IP = 30;
const RL_MAX_PER_USER = 10;
// 注册限流：防批量注册占库
const RL_MAX_REGISTER_PER_IP = 10;

// 常见弱密码黑名单（不求完整字典，只挡最典型的）
const WEAK_PASSWORDS = new Set([
  '12345678', '123456789', '1234567890', 'password', 'password123', 'qwertyui',
  '11111111', '00000000', 'abc123456', 'iloveyou', 'admin123', 'letmein1',
]);

// 读取请求体（上限 limit 字节），返回字符串；超限直接断开
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

// 统一响应出口：连接可能已被断开（如超大体被 destroy），写入失败不能让进程崩
function sendJSON(res, code, obj) {
  try {
    if (res.writableEnded) return;
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  } catch { /* 连接已断开，忽略 */ }
}

// 只接受字符串：对象/数组/数字等一律按空串处理，避免 .trim() 之类抛错拖垮进程
function str(v, max) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

// 去控制字符与双向文本覆盖符后裁剪，避免昵称污染显示
function cleanText(s, max) {
  return str(s, max)
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e]/g, '')
    .trim();
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, SCRYPT_LEN).toString('hex');
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

// 密码强度：长度 + 至少两类字符 + 不在弱密码表；返回错误文案或 null
function passwordProblem(pass) {
  if (pass.length < MIN_PASSWORD_LEN) return `密码至少 ${MIN_PASSWORD_LEN} 位`;
  if (WEAK_PASSWORDS.has(pass.toLowerCase())) return '密码过于简单';
  const kinds = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((re) => re.test(pass)).length;
  if (kinds < 2) return '密码需包含字母、数字、符号中的至少两类';
  return null;
}

// 真实客户端 IP：经 Cloudflare 隧道时 remoteAddress 恒为隧道本机，必须读 cf-connecting-ip
function clientIp(req) {
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf) return cf.trim();
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff) return xff.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
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
    -- 背包的「修订号」：每次写入 +1，用于多端同步时判断谁更新（后写的赢）
    CREATE TABLE IF NOT EXISTS bag_meta(
      user_id INTEGER PRIMARY KEY,
      rev INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
    -- 账号通用存档（学币 / 已购道具 / 兑换码 / 技能槽 / 性别）：整包 JSON + 修订号，多端后写覆盖
    CREATE TABLE IF NOT EXISTS user_state(
      user_id INTEGER PRIMARY KEY,
      data TEXT NOT NULL DEFAULT '{}',
      rev INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
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
    // 单账号会话数封顶：删掉除最新 N 条以外的旧会话
    trimSessions: db.prepare(`DELETE FROM sessions WHERE user_id = ? AND token NOT IN (
      SELECT token FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?
    )`),
    skins: db.prepare('SELECT skin_key FROM owned_skins WHERE user_id = ? ORDER BY skin_key'),
    items: db.prepare('SELECT item_key, qty FROM bag_items WHERE user_id = ? ORDER BY item_key'),
    // 背包读写（/api/bag）：整包替换 + 修订号
    clearBag: db.prepare('DELETE FROM bag_items WHERE user_id = ?'),
    upsertItem: db.prepare(`INSERT INTO bag_items(user_id, item_key, qty) VALUES (?, ?, ?)
      ON CONFLICT(user_id, item_key) DO UPDATE SET qty = excluded.qty`),
    bagMeta: db.prepare('SELECT rev FROM bag_meta WHERE user_id = ?'),
    setBagMeta: db.prepare(`INSERT INTO bag_meta(user_id, rev, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET rev = excluded.rev, updated_at = excluded.updated_at`),
    // 通用存档读写（/api/state）
    getState: db.prepare('SELECT data, rev FROM user_state WHERE user_id = ?'),
    setState: db.prepare(`INSERT INTO user_state(user_id, data, rev, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, rev = excluded.rev, updated_at = excluded.updated_at`),
  };

  const bagOf = (userId) => {
    const out = {};
    for (const r of stmts.items.all(userId)) out[r.item_key] = r.qty;
    return out;
  };

  // 一次写完「清空 + 逐条写入」，中途出错不会留下半份背包
  const replaceBag = db.transaction((userId, bag) => {
    stmts.clearBag.run(userId);
    for (const k of Object.keys(bag)) stmts.upsertItem.run(userId, k, bag[k]);
  });

  // 用户不存在时也跑一次等开销的 scrypt，消除「响应快=用户不存在」的计时侧信道
  const DUMMY_SALT = crypto.randomBytes(16).toString('hex');
  const DUMMY_HASH = hashPassword('__dummy_password__', DUMMY_SALT);

  // ---- 失败计数桶（进程内存）----
  const buckets = new Map(); // key -> 时间戳数组

  function prune(key) {
    const now = Date.now();
    const arr = (buckets.get(key) || []).filter((t) => now - t < RL_WINDOW_MS);
    buckets.set(key, arr);
    return arr;
  }

  function peekCount(key) {
    return prune(key).length;
  }

  function pushCount(key) {
    const arr = prune(key);
    arr.push(Date.now());
    if (buckets.size > 20000) {
      for (const [k, v] of buckets) if (!v.length) buckets.delete(k); // 防内存无限增长
    }
    return arr.length;
  }

  // 需要登录的请求：从 Authorization: Bearer <token> 取 token，解析出用户
  function userFromAuth(req) {
    stmts.clearExpired.run(Date.now()); // 清理过期会话
    const h = req.headers.authorization || '';
    const token = typeof h === 'string' && h.startsWith('Bearer ') ? h.slice(7).trim() : '';
    if (!token) return null;
    const row = stmts.sessionByToken.get(sha256(token)); // 库内只存 token 的哈希
    if (!row) return null;
    if (row.expires_at < Date.now()) { stmts.deleteSession.run(row.token); return null; }
    return stmts.userById.get(row.user_id);
  }

  function createSession(userId) {
    const token = newToken();
    const now = Date.now();
    stmts.insertSession.run(sha256(token), userId, now, now + SESSION_TTL_MS);
    stmts.trimSessions.run(userId, userId, MAX_SESSIONS_PER_USER);
    return token; // 明文 token 只回给客户端，不入库
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

  function register(username, password) {
    const name = str(username, 40).trim();
    if (name.length < MIN_USERNAME_LEN || name.length > MAX_USERNAME_LEN) {
      return { ok: false, error: `用户名需 ${MIN_USERNAME_LEN}~${MAX_USERNAME_LEN} 位` };
    }
    if (!/^[A-Za-z0-9_\u4e00-\u9fa5.-]+$/.test(name)) {
      return { ok: false, error: '用户名只能包含中英文、数字、下划线、点或短横' };
    }
    const pass = str(password, MAX_PASSWORD_LEN).trim();
    const pwErr = passwordProblem(pass);
    if (pwErr) return { ok: false, error: pwErr };
    if (stmts.userByName.get(name)) return { ok: false, error: '用户名已被占用' };

    const salt = crypto.randomBytes(16).toString('hex');
    const hash = hashPassword(pass, salt);
    let info;
    try {
      info = stmts.insertUser.run(name, hash, salt, Date.now());
    } catch {
      return { ok: false, error: '用户名已被占用' }; // 并发注册由 UNIQUE 约束兜底
    }
    const userId = info.lastInsertRowid;
    stmts.insertProfile.run(userId); // 建立默认资料

    const user = { id: userId, username: name };
    const token = createSession(userId);
    return { ok: true, token, profile: fullProfile(user) };
  }

  function login(username, password) {
    const name = str(username, 40).trim();
    const pass = str(password, MAX_PASSWORD_LEN).trim();
    const row = name ? stmts.userByName.get(name) : null;

    // 不存在也走同一次哈希：耗时一致，无法据此枚举用户
    const salt = row ? row.salt : DUMMY_SALT;
    const expected = row ? row.pass_hash : DUMMY_HASH;
    const actual = hashPassword(pass, salt);
    const same = crypto.timingSafeEqual(
      Buffer.from(actual, 'hex'),
      Buffer.from(expected, 'hex') // 两者同为 64 字节，长度固定，timingSafeEqual 不会抛错
    );
    if (!row || !same) return { ok: false, error: '用户名或密码错误' };

    const token = createSession(row.id);
    return { ok: true, token, profile: fullProfile(row) };
  }

  // 登录/注册/资料/登出；非账号接口返回 null 交回上层路由
  async function route(req, res, url) {
    const p = url.pathname;
    const ip = clientIp(req);

    if (req.method === 'POST' && (p === '/api/register' || p === '/api/login')) {
      let body;
      try { body = JSON.parse((await readBody(req, 256 * 1024)) || '{}'); }
      catch { sendJSON(res, 400, { ok: false, error: 'invalid body' }); return true; }
      if (!body || typeof body !== 'object' || Array.isArray(body)) body = {};
      const name = str(body.username, 40).trim();

      if (p === '/api/register') {
        if (pushCount('reg:' + ip) > RL_MAX_REGISTER_PER_IP) {
          sendJSON(res, 429, { ok: false, error: '注册过于频繁，请稍后再试' });
          return true;
        }
      } else if (peekCount('ip:' + ip) >= RL_MAX_PER_IP || (name && peekCount('u:' + name) >= RL_MAX_PER_USER)) {
        sendJSON(res, 429, { ok: false, error: '尝试过于频繁，请稍后再试' });
        return true;
      }

      const out = p === '/api/register'
        ? register(body.username, body.password)
        : login(body.username, body.password);

      // 登录失败才计数（成功不计，避免正常用户被自己的成功登录拖累）
      if (!out.ok && p === '/api/login') { pushCount('ip:' + ip); pushCount('u:' + name); }
      sendJSON(res, out.ok ? 200 : 401, out);
      return true;
    }

    if (p === '/api/profile') {
      const user = userFromAuth(req);
      if (!user) { sendJSON(res, 401, { ok: false, error: '未登录或已过期' }); return true; }

      if (req.method === 'GET') {
        sendJSON(res, 200, { ok: true, profile: fullProfile(user) });
        return true;
      }
      if (req.method === 'POST') {
        let body;
        try { body = JSON.parse((await readBody(req, 256 * 1024)) || '{}'); }
        catch { sendJSON(res, 400, { ok: false, error: 'invalid body' }); return true; }
        if (!body || typeof body !== 'object' || Array.isArray(body)) body = {};

        const cur = stmts.profile.get(user.id) || { nickname: '', nickname_color: '#ffffff', title: '', skin: '' };
        const nickname = body.nickname === undefined ? cur.nickname : cleanText(body.nickname, 16);
        const color = typeof body.nicknameColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(body.nicknameColor)
          ? body.nicknameColor : cur.nickname_color;

        // 皮肤只能设置为「已拥有」的，防止越权白嫖（拥有关系写入 owned_skins）
        const skin = body.skin === undefined ? cur.skin : str(body.skin, 32);
        if (skin && !stmts.skins.all(user.id).some((r) => r.skin_key === skin)) {
          sendJSON(res, 403, { ok: false, error: '未拥有该皮肤' });
          return true;
        }
        // 称号同样属预留字段，暂为纯展示文本（已去控制字符并限长）
        const title = body.title === undefined ? cur.title : cleanText(body.title, 16);

        stmts.updateProfile.run(nickname, color, title, skin, user.id);
        sendJSON(res, 200, { ok: true, profile: fullProfile(user) });
        return true;
      }
    }

    // 背包云存档：GET 拉取、POST 整包覆盖。
    // 同步策略是「按修订号后写覆盖」：客户端带自己的 rev 上来，比服务端旧就拒绝并回传服务端那份，
    // 客户端据以覆盖本地 —— 这样两台设备交替玩不会互相丢东西，也不会出现「丢了又回来」。
    if (p === '/api/bag') {
      const user = userFromAuth(req);
      if (!user) { sendJSON(res, 401, { ok: false, error: '未登录或已过期' }); return true; }

      if (req.method === 'GET') {
        const m = stmts.bagMeta.get(user.id) || { rev: 0 };
        sendJSON(res, 200, { ok: true, bag: bagOf(user.id), rev: m.rev });
        return true;
      }
      if (req.method === 'POST') {
        let body;
        try { body = JSON.parse((await readBody(req, 256 * 1024)) || '{}'); }
        catch { sendJSON(res, 400, { ok: false, error: 'invalid body' }); return true; }
        if (!body || typeof body !== 'object' || Array.isArray(body)) body = {};

        const m = stmts.bagMeta.get(user.id) || { rev: 0 };
        const givenRev = Number.isFinite(body.rev) ? Math.max(0, Math.floor(body.rev)) : 0;
        if (givenRev < m.rev) {
          // 客户端这份更旧：把服务端的回给它，让它覆盖本地（多端冲突时以服务端为准）
          sendJSON(res, 200, { ok: false, error: 'stale', bag: bagOf(user.id), rev: m.rev });
          return true;
        }

        // 逐条校验：物品名限长、去控制字符；数量必须是 1..99999 的整数；条数封顶 200
        const src = (body.bag && typeof body.bag === 'object' && !Array.isArray(body.bag)) ? body.bag : {};
        const bag = {};
        let n = 0;
        for (const k of Object.keys(src)) {
          if (n >= 200) break;
          const key = cleanText(k, 32);
          if (!key) continue;
          const q = Math.floor(Number(src[k]));
          if (!Number.isFinite(q) || q < 1) continue;
          bag[key] = Math.min(99999, q);
          n++;
        }

        const rev = Math.max(m.rev, givenRev) + 1;
        replaceBag(user.id, bag);
        stmts.setBagMeta.run(user.id, rev, Date.now());
        sendJSON(res, 200, { ok: true, rev, count: n });
        return true;
      }
      sendJSON(res, 405, { ok: false, error: 'method not allowed' });
      return true;
    }

    // 账号通用存档（学币 / 已购道具 / 兑换码 / 技能槽 / 性别）：GET 拉取、POST 整包覆盖。
    // 策略与 /api/bag 完全一致：按修订号后写覆盖；只放行白名单字段并逐项钳制。
    if (p === '/api/state') {
      const user = userFromAuth(req);
      if (!user) { sendJSON(res, 401, { ok: false, error: '未登录或已过期' }); return true; }

      if (req.method === 'GET') {
        const row = stmts.getState.get(user.id);
        let data = {};
        if (row && row.data) { try { data = JSON.parse(row.data) || {}; } catch { data = {}; } }
        sendJSON(res, 200, { ok: true, data, rev: row ? row.rev : 0 });
        return true;
      }
      if (req.method === 'POST') {
        let body;
        try { body = JSON.parse((await readBody(req, 128 * 1024)) || '{}'); }
        catch { sendJSON(res, 400, { ok: false, error: 'invalid body' }); return true; }
        if (!body || typeof body !== 'object' || Array.isArray(body)) body = {};

        const row = stmts.getState.get(user.id) || { rev: 0 };
        const givenRev = Number.isFinite(body.rev) ? Math.max(0, Math.floor(body.rev)) : 0;
        if (givenRev < row.rev) {
          let srv = {};
          if (row.data) { try { srv = JSON.parse(row.data) || {}; } catch { srv = {}; } }
          sendJSON(res, 200, { ok: false, error: 'stale', data: srv, rev: row.rev });
          return true;
        }

        // 只放行已知字段并逐项钳制，避免脏数据 / 超大对象
        const src = (body.data && typeof body.data === 'object' && !Array.isArray(body.data)) ? body.data : {};
        const strArr = (v, max) => Array.isArray(v)
          ? v.filter((x) => typeof x === 'string').map((x) => cleanText(x, 32)).filter(Boolean).slice(0, max)
          : [];
        const coins = Math.max(0, Math.min(1000000000, Math.floor(Number(src.coins)) || 0));
        const skillMap = {};
        if (src.skillMap && typeof src.skillMap === 'object' && !Array.isArray(src.skillMap)) {
          for (const k of Object.keys(src.skillMap)) {
            const idx = Number(k);
            if (!Number.isInteger(idx) || idx < 0 || idx > 15) continue;
            const nm = cleanText(src.skillMap[k], 32);
            if (nm) skillMap[String(idx)] = nm;
          }
        }
        const gender = src.gender === 'girl' ? 'girl' : 'boy';
        const data = { coins, owned: strArr(src.owned, 200), redeemed: strArr(src.redeemed, 200), skillMap, gender };

        const rev = Math.max(row.rev, givenRev) + 1;
        stmts.setState.run(user.id, JSON.stringify(data), rev, Date.now());
        sendJSON(res, 200, { ok: true, rev });
        return true;
      }
      sendJSON(res, 405, { ok: false, error: 'method not allowed' });
      return true;
    }

    if (req.method === 'POST' && p === '/api/logout') {
      const h = req.headers.authorization || '';
      const token = typeof h === 'string' && h.startsWith('Bearer ') ? h.slice(7).trim() : '';
      if (token) stmts.deleteSession.run(sha256(token));
      sendJSON(res, 200, { ok: true });
      return true;
    }

    return null; // 非账号接口
  }

  // 统一兜底：任何异常都转成 500，绝不让异步拒绝冒泡成未捕获异常（那会杀掉整个进程）
  async function handleRequest(req, res, url) {
    try {
      return await route(req, res, url);
    } catch (e) {
      console.warn('[auth] 请求处理异常:', e);
      sendJSON(res, 500, { ok: false, error: '服务器内部错误' });
      return true;
    }
  }

  // 依 token 解析用户公开资料（供 WS 登录后挂身份 / 名牌展示）
  function getPublicByToken(tok) {
    const t = str(tok, 128).trim();
    if (!t) return null;
    const user = userFromAuth({ headers: { authorization: 'Bearer ' + t } });
    if (!user) return null;
    const p = stmts.profile.get(user.id) || {};
    return publicProfile(p, user);
  }

  return { handleRequest, getPublicByToken };
}
