// 职责：统计「还有多少资源在加载」，供进游戏前的加载动画判断「模型是否都到位了」。
//
// 为什么不用 THREE.DefaultLoadingManager：它只有在**已经开始加载**之后才有意义，
// 而加载屏要在 Game 构造之前就挂上；另外项目里还有 fetch（远端场景）这类不属于
// three 加载器的异步步骤。这里自己数，语义最清楚：
//   track(promise) —— 登记一个加载任务，完成时自动销账（成功失败都算完成，失败会走占位兜底）
//   stats()        —— { pending, total }
//   whenIdle()     —— 等到「当前没有未完成的任务」为止（调用时已经空闲就立刻 resolve）
//
// 注意：调用方还要处理「一个任务都还没登记」的空窗（见 main.js 的静默等待窗口），
// 否则会在第一批 GLB 请求发出之前就判定「全部加载完了」。

let pending = 0;
let total = 0;
const waiters = [];

function flush() {
  if (pending > 0) return;
  const ws = waiters;
  waiters.length = 0;
  for (const resolve of ws) resolve();
}

// 登记一个加载任务。返回原 promise，方便链式使用。
export function track(promise) {
  pending++;
  total++;
  const done = () => {
    pending = Math.max(0, pending - 1);
    flush();
  };
  if (promise && typeof promise.then === 'function') promise.then(done, done);
  else done(); // 传进来的不是 promise（防御）：立刻销账，别让计数永久卡住
  return promise;
}

export function stats() {
  return { pending, total };
}

// 等到没有未完成的任务。调用时已经空闲 → 立即 resolve。
export function whenIdle() {
  if (pending === 0) return Promise.resolve();
  return new Promise((resolve) => { waiters.push(resolve); });
}
