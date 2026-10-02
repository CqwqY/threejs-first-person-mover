// 自检：场地边界（空气墙）—— 编辑器「边界」模式 + 游戏运行时应用。
// 跑法：node boundary-check.mjs
//
// 为什么这么测：这一轮的坑都在「编辑器里看着对、进游戏差一截」和「非法数据把玩家夹飞」上，
// 所以核心是 ① 纯逻辑（边界数据/几何）逐条验 ② 用真的 PlayerPhysics 跑一遍夹取 ③
// 断言两端确实共用同一份几何、且编辑器保存 / 游戏读取这条链路是接上的。
import { readFileSync } from 'node:fs';

let fails = 0;
const ok = (cond, msg) => { if (!cond) { fails++; console.log('  FAIL ' + msg); } else { console.log('  ok   ' + msg); } };
const eq = (a, b, msg) => ok(a === b, msg + '（实际 ' + JSON.stringify(a) + '）');
const near = (a, b, eps, msg) => ok(Math.abs(a - b) <= eps, msg + '（实际 ' + a + '，期望 ' + b + '±' + eps + '）');

const { Config } = await import('./src/config.js');
const B = await import('./src/world/Boundary.js');
const { PlayerPhysics } = await import('./src/player/PlayerPhysics.js');

const gameSrc = readFileSync('./src/core/Game.js', 'utf8');
const physSrc = readFileSync('./src/player/PlayerPhysics.js', 'utf8');
const editorSrc = readFileSync('./src/editor/EditorApp.js', 'utf8');
const htmlSrc = readFileSync('./editor.html', 'utf8');
const wallsSrc = readFileSync('./src/world/Walls.js', 'utf8');

// ---------------------------------------------------------------------------
// 1. 默认值 & 归一化健壮性
// ---------------------------------------------------------------------------
console.log('== 1. 默认值与归一化（外部数据一律先过 normalize）==');
const d = B.defaultBoundary();
eq(d.maxX - d.minX, Config.GROUND_WIDTH, '默认边界宽 = GROUND_WIDTH');
eq(d.maxZ - d.minZ, Config.GROUND_DEPTH, '默认边界深 = GROUND_DEPTH');
eq(d.minX, -Config.GROUND_WIDTH / 2, '默认边界以原点为中心（x）');
eq(d.showWalls, false, '默认不画实墙（保持「看不见但挡人」的空气墙行为）');
eq(B.normalizeBoundary(d).showWalls, false, 'normalize(默认值) 幂等');

eq(B.normalizeBoundary(null), null, 'null → null（调用方保持默认，行为与改动前一致）');
eq(B.normalizeBoundary(undefined), null, 'undefined → null');
eq(B.normalizeBoundary('50'), null, '字符串 → null');
eq(B.normalizeBoundary(42), null, '数字 → null');
eq(B.normalizeBoundary([]), null, '数组 → null（不是合法边界对象）');

const filled = B.normalizeBoundary({});
eq(filled.minX, d.minX, '{} → 缺的字段补默认');
eq(filled.maxZ, d.maxZ, '{} → 缺的字段补默认（z）');

const swapped = B.normalizeBoundary({ minX: 30, maxX: -30, minZ: 10, maxZ: -10 });
eq(swapped.minX, -30, '写反的 minX/maxX 自动交换');
eq(swapped.maxZ, 10, '写反的 minZ/maxZ 自动交换');

const str = B.normalizeBoundary({ minX: '-25', maxX: '25', minZ: '0', maxZ: '8' });
eq(str.minX, -25, '数字字符串能解析（表单/JSON 常见）');

const bad = B.normalizeBoundary({ minX: NaN, maxX: 'abc', minZ: Infinity, maxZ: -Infinity });
ok(Number.isFinite(bad.minX) && Number.isFinite(bad.maxZ), 'NaN / Infinity / 非数字 → 全部回落到默认值');

const tiny = B.normalizeBoundary({ minX: 5, maxX: 5, minZ: 5, maxZ: 5 });
near(tiny.maxX - tiny.minX, B.BOUNDARY_MIN_SPAN, 1e-9, '跨度为 0 → 撑到最小跨度（不然玩家会被夹成一个点）');
near(tiny.maxZ - tiny.minZ, B.BOUNDARY_MIN_SPAN, 1e-9, '跨度为 0 → 撑到最小跨度（z）');

const huge = B.normalizeBoundary({ minX: -1e9, maxX: 1e9, minZ: -1e9, maxZ: 1e9 });
eq(huge.minX, -B.BOUNDARY_MAX_ABS, '超大坐标夹到 ±BOUNDARY_MAX_ABS');
eq(huge.maxX, B.BOUNDARY_MAX_ABS, '超大坐标夹到 ±BOUNDARY_MAX_ABS');

const wh = B.normalizeBoundary({ wallHeight: 0 });
near(wh.wallHeight, 0.2, 1e-9, '墙高下限 0.2（0 会变成看不见的墙）');
eq(B.normalizeBoundary({ wallHeight: 1e9 }).wallHeight, 100, '墙高上限 100');
eq(B.normalizeBoundary({ showWalls: 'yes' }).showWalls, false, 'showWalls 只认严格 true（避免 "false" 被当成真）');

// ---------------------------------------------------------------------------
// 2. 四面墙几何：贴着四边、厚度正确、角上不留缝
// ---------------------------------------------------------------------------
console.log('== 2. 边界墙几何（编辑器预览与游戏实墙共用）==');
const asym = { minX: -10, maxX: 50, minZ: -80, maxZ: 20, showWalls: true, wallHeight: 4 };
const specs = B.boundaryWallSpecs(asym, 0.5);
eq(specs.length, 4, '四面墙');
eq(specs.map((s) => s.side).sort().join(','), '+x,+z,-x,-z', '四个方向齐全');

// 位置：墙中心正好落在边界线上；厚度沿法线
for (const s of specs) {
  if (s.side === '+x') { eq(s.cx, asym.maxX, '+x 墙中心在 maxX 上'); near(s.hx * 2, 0.5, 1e-9, '+x 墙厚 = 给定厚度'); }
  if (s.side === '-x') { eq(s.cx, asym.minX, '-x 墙中心在 minX 上'); near(s.hx * 2, 0.5, 1e-9, '-x 墙厚 = 给定厚度'); }
  if (s.side === '+z') { eq(s.cz, asym.maxZ, '+z 墙中心在 maxZ 上'); near(s.hz * 2, 0.5, 1e-9, '+z 墙厚 = 给定厚度'); }
  if (s.side === '-z') { eq(s.cz, asym.minZ, '-z 墙中心在 minZ 上'); near(s.hz * 2, 0.5, 1e-9, '-z 墙厚 = 给定厚度'); }
}
// 覆盖：±x 墙的 z 范围必须盖住 [minZ, maxZ]，否则角上有缝（玩家能从缝里走出去）
const px = specs.find((s) => s.side === '+x');
ok(px.cz - px.hz <= asym.minZ + 1e-9 && px.cz + px.hz >= asym.maxZ - 1e-9, '+x 墙沿 z 覆盖整条边（角上不留缝）');
const pz = specs.find((s) => s.side === '+z');
ok(pz.cx - pz.hx <= asym.minX + 1e-9 && pz.cx + pz.hx >= asym.maxX - 1e-9, '+z 墙沿 x 覆盖整条边（角上不留缝）');
ok(specs.every((s) => s.rotY === 0), '四面板都是轴对齐（不靠旋转，读起来直观）');
eq(B.boundaryWallSpecs(null).length, 0, 'null 边界 → 不给墙（不会崩）');
eq(B.boundarySpan(asym).w, 60, 'boundarySpan 宽');
eq(B.boundarySpan(asym).d, 100, 'boundarySpan 深');

// ---------------------------------------------------------------------------
// 3. 夹取：四边独立、带半径、退化情形
// ---------------------------------------------------------------------------
console.log('== 3. clampToBoundary ==');
const bc = { minX: -10, maxX: 50, minZ: -80, maxZ: 20 };
const st = { x: 999, z: 999 };
B.clampToBoundary(st, bc, 0.4);
near(st.x, 49.6, 1e-9, '顶到 +x 时停在 maxX - r（而不是 maxX）');
near(st.z, 19.6, 1e-9, '顶到 +z 时停在 maxZ - r');
st.x = -999; st.z = -999;
B.clampToBoundary(st, bc, 0.4);
near(st.x, -9.6, 1e-9, '顶到 -x 时停在 minX + r');
near(st.z, -79.6, 1e-9, '顶到 -z 时停在 minZ + r');
st.x = 20; st.z = -30;
B.clampToBoundary(st, bc, 0.4);
eq(st.x, 20, '边界内的坐标不动（x）');
eq(st.z, -30, '边界内的坐标不动（z）');
const narrow = { minX: -1, maxX: 1, minZ: -1, maxZ: 1 };
const st2 = { x: 999, z: -999 };
B.clampToBoundary(st2, narrow, 5);
eq(st2.x, 0, '边界比玩家直径还窄 → 居中（不会 min+r > max-r 抖动）');
eq(st2.z, 0, '边界比玩家直径还窄 → 居中（z）');
eq(B.clampToBoundary(st2, null, 0.4), undefined, 'null 边界直接返回（不抛错）');

// ---------------------------------------------------------------------------
// 4. 驱动真 PlayerPhysics：边界真的挡人吗
// ---------------------------------------------------------------------------
console.log('== 4. 真 PlayerPhysics 的边界夹取 ==');
const noInput = {
  forwarded: () => false, backwarded: () => false,
  strafeLeft: () => false, strafeRight: () => false,
  sprinting: () => false, joyX: 0, joyY: 0, joyMagnitude: () => 0,
  isDown: () => false, consumeJump: () => false,
};
const R = Config.PLAYER_RADIUS;

// 用 velocityHold 每帧强推，方向任意，避免依赖输入的坐标系约定。
// 帧数要够：60m/s × 帧数/60 必须明显超过要跨越的距离，否则根本没走到边界上（第一次就踩了这个坑）。
function push(bound, vx, vz, frames = 400) {
  const phys = new PlayerPhysics();
  phys.bound = bound;
  const state = { id: 'local', x: 0, y: Config.PLAYER_HEIGHT, z: 0, onGround: true };
  const dt = 1 / 60;
  for (let i = 0; i < frames; i++) {
    phys.velocityHold = { x: vx, y: 0, z: vz, t: 1 };
    phys.update(dt, noInput, 0, state, []);
  }
  return state;
}

// 没设 bound → 用 Config 的居中矩形（= 改动前的行为）
const legacy = push(null, 60, 0);
near(legacy.x, Config.GROUND_WIDTH / 2 - R, 0.05, '未设边界时停在 Config 的 ±GROUND_WIDTH/2（旧行为不变）');

const b1 = B.normalizeBoundary({ minX: -100, maxX: 20, minZ: -300, maxZ: 300 });
const s1 = push(b1, 60, 0);
near(s1.x, 20 - R, 0.05, '设了边界（maxX=20）后停在 20-r');
const s2 = push(b1, -60, 0);
near(s2.x, -100 + R, 0.05, '反方向顶到 minX=-100 时停在 minX+r');
const s3 = push(b1, 0, -60);
near(s3.z, -300 + R, 0.05, 'z 方向同样被夹住（minZ）');

// 缩得很小的边界：玩家会被夹在场地里，且不会抖动/NaN
const small = B.normalizeBoundary({ minX: 10, maxX: 30, minZ: 10, maxZ: 30 });
const s4 = push(small, 60, 60);
ok(Number.isFinite(s4.x) && Number.isFinite(s4.z), '小边界下坐标仍是有限值');
near(s4.x, 30 - R, 0.05, '小边界同样夹得住（x）');
near(s4.z, 30 - R, 0.05, '小边界同样夹得住（z）');

ok(/this\.bound = null;/.test(physSrc), 'PlayerPhysics 默认 bound = null（不注入就走旧路径）');
ok(/clampToBoundary\(state, this\.bound, rScale\)/.test(physSrc), '物理层用共享的 clampToBoundary');

// ---------------------------------------------------------------------------
// 5. 存档往返 & 两端接线（静态断言）
// ---------------------------------------------------------------------------
console.log('== 5. 存档往返与两端接线 ==');
const round = B.normalizeBoundary(JSON.parse(JSON.stringify(asym)));
eq(JSON.stringify(round), JSON.stringify(asym), '边界经 JSON 往返后完全不变（写盘/读盘不会漂）');
eq(B.normalizeBoundary(undefined), null, '旧存档（没有 boundary 字段）→ null，两端都退回默认');

ok(/boundary: \{ \.\.\.state\.boundary \}/.test(editorSrc), '编辑器 serialize() 写出 boundary');
ok(/normalizeBoundary\(data && data\.boundary\)/.test(editorSrc), '编辑器 restore() 读回并归一化 boundary');
ok(/refreshBoundaryViz\(\)/.test(editorSrc), '编辑器有统一的边界可视化刷新');
ok(/boundaryWallSpecs\(defaultBoundary\(\), BOUNDARY_THICKNESS\)/.test(editorSrc), '编辑器预览墙用共享几何（不是自己写一遍）');
ok(/BOUNDARY_MIN_SPAN/.test(editorSrc), '编辑器拖拽时用同一个最小跨度');

// 拖拽：三种指针事件都接进边界处理，且 must 有 early-return（否则会同时触发「点选模型」）
ok(/state\.mode === 'bound'\) \{ onBoundaryDown\(e\); return; \}/.test(editorSrc), 'pointerdown 进入边界拖拽并提前返回');
ok(/state\.mode === 'bound'\) \{ onBoundaryMove\(e\); return; \}/.test(editorSrc), 'pointermove 走边界拖拽/悬停并提前返回');
ok(/if \(state\.mode === 'bound'\) onBoundaryUp\(\);/.test(editorSrc), 'pointerup 一定收尾（不会把视角控件卡在禁用）');
ok(/d\.side === '\+x'\) next\.maxX = Math\.max\(v, b\.minX \+ BOUNDARY_MIN_SPAN\)/.test(editorSrc), '拖 +x 板时保留最小跨度');
ok(/controls\.enabled = false; \/\/ 拖边界时别同时把视角也转了/.test(editorSrc), '拖边界时暂停视角旋转');
// 俯视全览时 300 多米宽的场地里，半米厚的墙在屏幕上不到 1 像素 —— 必须有加厚的隐形拾取条，否则点不中
ok(/const bPickers = boundaryWallSpecs/.test(editorSrc) && /raycaster\.intersectObjects\(bPickers, false\)/.test(editorSrc),
  '命中检测走加厚的隐形拾取条（bPlates 只负责显示）');

// 游戏端
ok(/_applyBoundary\(data\.boundary\)/.test(gameSrc), 'Game 拉到远程场景后应用 boundary');
ok(/this\.boundary = defaultBoundary\(\);/.test(gameSrc), 'Game 默认边界 = 地面范围（没保存过也不变）');
ok(/const active = this\._combat \? null : b;/.test(gameSrc), '对战模式里边界让位（竞技场自带一圈墙）');
ok(/_enterCombat[\s\S]{0,2000}?this\._syncBoundary\(\);/.test(gameSrc), '_enterCombat 里同步边界');
ok(/this\._combat = null;[\s\S]{0,200}?this\._syncBoundary\(\);/.test(gameSrc), '_exitCombat 里恢复边界');
ok(/const loX = this\._combat \? -H \+ R : b\.minX \+ R;/.test(gameSrc), '掉落物回弹用同一份边界（四边各自判定）');
ok(/this\.localPlayer\.physics\.bound = active;/.test(gameSrc), '边界写进 PlayerPhysics.bound');

// Walls.js 不能再用遗留的 GROUND_SIZE（那是 50×50，和 160×310 的地面不符）。
// 断言前先剥注释——注释里为了说明原因正好会提到它（这个坑上一轮踩过一次）。
const wallsCode = wallsSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
ok(!/Config\.GROUND_SIZE/.test(wallsCode), 'Walls.js 不再引用遗留的 GROUND_SIZE（注释里解释原因不算）');
ok(/boundaryWallSpecs\(b, BOUNDARY_THICKNESS\)/.test(wallsSrc), 'Walls.js 也用共享几何');

// editor.html 的入口与面板
ok(/id="tBound"/.test(htmlSrc), '工具栏有「边界」按钮');
for (const id of ['boundaryPanel', 'bMinX', 'bMaxX', 'bMinZ', 'bMaxZ', 'bHeight', 'bShow', 'bFocus', 'bFrame', 'bFit', 'bShrink']) {
  ok(htmlSrc.includes('id="' + id + '"'), '面板元素存在：' + id);
}

console.log(fails ? ('\nFAILED: ' + fails) : '\nALL PASS');
process.exit(fails ? 1 : 0);
