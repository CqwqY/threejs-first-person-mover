// 职责：统计「还有多少资源在加载」，供进游戏前的加载动画判断「模型是否都到位了」。
//
// 为什么不用 THREE.DefaultLoadingManager：它只有在**已经开始加载**之后才有意义，
// 而加载屏要在 Game 构造之前就挂上；另外项目里还有 fetch（远端场景）这类不属于
// three 加载器的异步步骤。这里自己数，语义最清楚：
//   track(promise) —— 登记一个加载任务，完成时自动销账（成功失败都算完成，失败会走占位兜底）
//   stats()        —— { pending, total }
//   whenIdle()     —— 等到「当前没有未完成的任务」为止（调用时已经空闲就立刻 resolve）
//
// ⚠⚠ 「pending === 0」不代表「都到位了」——本项目加载是**分批发起**的：
//   先场景模型，玩家模型要等 WebSocket 的 welcome 到了才发起（可能晚好几秒）。
//   所以调用方不能一看到 0 就放行，必须要求**连续稳定一段时间**（见下方 quietFor）。
//   这正是「手机有些模型没下下来就放行了」的根因。
//
// 注意：调用方还要处理「一个任务都还没登记」的空窗（见 main.js 的静默等待窗口），
// 否则会在第一批 GLB 请求发出之前就判定「全部加载完了」。

let pending = 0;
let total = 0;
const waiters = [];

// 最近一次「有任务在跑」或「计数发生变化」的时间戳（毫秒）。
// 用于判断「已空闲多久」——只有空闲超过 quietMs 才算真的加载完。
let lastActivityAt = (typeof performance !== 'undefined' ? performance.now() : Date.now());

function now() {
  return (typeof performance !== 'undefined' ? performance.now() : Date.now());
}

function flush() {
  if (pending > 0) return;
  // ⚠ 必须先**拷贝**再清空：`const ws = waiters` 拿到的是同一个数组的引用，
  //   紧接着 `waiters.length = 0` 会把 ws 也清空，下面的 for 就遍历了个空数组 ——
  //   结果是「pending 归零了但等的人一个都没被唤醒」（whenIdle 永不 resolve）。
  const ws = waiters.slice();
  waiters.length = 0;
  for (const resolve of ws) resolve();
}

// 登记一个加载任务。返回原 promise，方便链式使用。
export function track(promise) {
  pending++;
  total++;
  lastActivityAt = now();
  const done = () => {
    pending = Math.max(0, pending - 1);
    lastActivityAt = now(); // 销账也算一次活动：紧接着可能又发起下一批
    flush();
  };
  if (promise && typeof promise.then === 'function') promise.then(done, done);
  else done(); // 传进来的不是 promise（防御）：立刻销账，别让计数永久卡住
  return promise;
}

export function stats() {
  return { pending, total };
}

// 当前是否「已空闲 quietMs 毫秒（且此刻没有任务在跑）」。
// 加载是分批的：某一瞬间 pending===0 很常见（上一批刚完、下一批还没发起），
// 必须等安静够久才能认定「真的加载完了」。
export function quietFor(quietMs) {
  if (pending > 0) return false;
  return (now() - lastActivityAt) >= quietMs;
}

// 等到没有未完成的任务。调用时已经空闲 → 立即 resolve。
export function whenIdle() {
  if (pending === 0) return Promise.resolve();
  return new Promise((resolve) => { waiters.push(resolve); });
}
