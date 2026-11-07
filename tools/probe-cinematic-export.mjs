// 影片导演 MP4 合成链自检：
//   1) 静态断言：合成器本地化（零 CDN 单点）、错误不吞、降级带原因、页面内预览接线、构建入口仍在；
//   2) 真跑：用极简 WebCodecs/DOM 桩跑完整 exportVideo 降级链，验证「编码失败 -> 帧序列 + reason」；
//   3) 真跑：从 main.js 源码抽出 even()，验证奇数分辨率被规范成偶数（H.264 硬要求）。
// 运行：node tools/probe-cinematic-export.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');

let pass = 0;
const fails = [];
const ok = (cond, msg) => { if (cond) pass++; else fails.push(msg); };
const eq = (a, b, msg) => ok(a === b, `${msg}（实得 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}）`);

const rec = read('src/cinematic/Recorder.js');
const main = read('src/cinematic/main.js');
const page = read('cinematic.html');
const pkg = read('package.json');
const vite = read('vite.config.js');
const ci = read('.github/workflows/deploy.yml');

console.log('[1] 本地化与 CDN 单点');
ok(/^import \{ Muxer, ArrayBufferTarget \} from 'mp4-muxer';/m.test(rec), '静态 import 本地 mp4-muxer');
ok(!/loadMp4Muxer/.test(rec), '已删除 CDN 动态加载合成器');
ok(!/mp4-muxer@[\d.]+\/\+esm/.test(rec), 'MP4 主路径不再引用 jsdelivr +esm');
ok(/FF_BASES\s*=\s*\[\s*'https:\/\/unpkg\.com/.test(rec), 'ffmpeg 兜底 CDN 以 unpkg 优先');
ok(/CORE_BASES/.test(rec) && /FF_BASES/.test(rec), 'ffmpeg 的 core 与 worker 都有多源');
ok(/crossOriginIsolated/.test(rec), 'ffmpeg 前置跨源隔离检查（Pages 上快速跳过，不白等 CDN）');
ok(/node_modules\/mp4-muxer|"mp4-muxer":/.test(read('package-lock.json')), 'lock 里已锁定本地依赖');
ok(/"mp4-muxer":\s*"\^?5\.1\.5"/.test(pkg), 'package.json 声明 mp4-muxer 5.1.5');
ok(/npm ci/.test(ci) && /node-version:\s*22/.test(ci), 'CI 用 npm ci + Node22（新依赖能装、Pages 不会静默不部署）');
ok(/cinematic:\s*path\.join\(root, 'cinematic\.html'\)/.test(vite), 'Vite 构建入口仍包含影片导演页');
ok(/src="\/src\/cinematic\/main\.js"/.test(page), 'HTML 入口脚本未被改动');

console.log('[2] 编码错误处理（渗透点：回调里 throw 不会冒泡）');
const iErrDecl = rec.indexOf('let encodeError = null;');
const iEncoder = rec.indexOf('new VideoEncoder(');
ok(iErrDecl >= 0 && iEncoder >= 0 && iErrDecl < iEncoder, 'encodeError 声明在 VideoEncoder 构造之前（无 TDZ）');
ok(!/error:\s*\(e\)\s*=>\s*\{\s*throw/.test(rec), 'encoder.error 回调不再直接 throw');
ok(/error:\s*\(e\)\s*=>\s*\{\s*encodeError\s*=/.test(rec), 'encoder.error 记录错误');
ok((rec.match(/if \(encodeError\) throw encodeError;/g) || []).length >= 2, '编码循环与 flush 后各检查一次错误');
ok(/try \{ encoder\.close\(\); \} catch/.test(rec), '编码器失败后关闭，避免复用坏实例');
ok(/第 \$\{i \+ 1\} 帧已失效/.test(rec), '已关闭的 VideoFrame 转 PNG 失败时给出明确提示，不静默吞');

console.log('[3] 降级与页面可见性');
ok(/res\.reason = reasons\.join\(' \/ '\)/.test(rec), '帧序列兜底带回 MP4 失败原因');
ok(/reasons\.push\('WebCodecs: '/.test(rec) && /reasons\.push\('ffmpeg: '/.test(rec), '两层失败都留下原因');
ok(/return \{ method: 'webcodecs', blob, name \}/.test(rec), '成功时回传 MP4 blob 供页面预览');
ok(/return \{ method: 'ffmpeg', blob, name \}/.test(rec), 'ffmpeg 兜底路径同样回传 blob，预览行为一致');
ok(/if \(res\.blob\) \{/.test(main), '页面按 blob 统一进预览，不漏掉 ffmpeg 路径');
ok(/MP4 合成失败，已改为导出帧序列/.test(main), '页面明说「没合成出视频」，不假装成功');
ok(/showVideoPreview\(res\.blob, res\.name\)/.test(main), '导出成功自动弹出成片预览');
ok(/URL\.revokeObjectURL\(previewUrl\)/.test(main), '换片时释放旧 blob URL');
ok(/btnCloseVideo\.addEventListener/.test(main), '预览层有关闭入口');
ok(/id="btnShowVideo"/.test(page) && /btnShowVideo\.addEventListener/.test(main), '关掉弹层后顶栏仍能找回成片');
ok(/playing\.catch/.test(main), 'play() 的 Promise rejection 被接住（自动播放拦截不再是未处理错误）');
ok(/alert\('导出失败：' \+ e\.message\);\s*restoreViewport\(\);/.test(main), '导出失败会回编辑态，不永久卡在渲染模式');
ok(/alert\('导出帧序列失败：' \+ e\.message\);\s*restoreViewport\(\);/.test(main), '帧序列导出失败同样回编辑态');
ok(/id="videoPanel"/.test(page) && /id="previewVideo"/.test(page) && /id="btnSaveVideo"/.test(page), '预览 DOM 齐全');
ok(/download="campus_tour\.mp4"/.test(page) && !/href="javascript:void\(0\)"/.test(page), '另存链接可用且无 javascript: 假链接');
ok(/零 CDN 依赖/.test(page), '页面提示已更新为本地合成');

console.log('[4] H.264 偶数尺寸');
const evenMatch = main.match(/const even = \(n\) => ([^;]+);/);
ok(!!evenMatch, '能抽出 even() 表达式');
if (evenMatch) {
  const even = new Function('n', `return ${evenMatch[1]};`);
  eq(even(1281), 1280, '奇数宽 1281 -> 1280');
  eq(even(1920), 1920, '偶数宽 1920 不变');
  eq(even(3), 2, '最小偶数下限');
  eq(even(1), 2, '异常小值被钳到 2');
}
ok(/renderer\.setSize\(outW, outH, false\)/.test(main) && /renderer\.setPixelRatio\(1\)/.test(main), '自适应档按物理像素渲染（画质不降）');

console.log('[5] 真跑导出降级链');
// ---- 极简浏览器桩 ----
globalThis.crossOriginIsolated = false;
globalThis.window = {};
globalThis.document = {
  createElement: () => ({ href: '', download: '', click() {}, remove() {}, style: {} }),
  body: { appendChild() {} },
};
const origCreate = URL.createObjectURL;
const origRevoke = URL.revokeObjectURL;
URL.createObjectURL = () => 'blob:stub';
URL.revokeObjectURL = () => {};
globalThis.createImageBitmap = async () => ({ width: 16, height: 8, close() {} });
globalThis.VideoFrame = class {
  constructor(src, opt = {}) {
    this.codedWidth = src.width || 16;
    this.codedHeight = src.height || 8;
    this.timestamp = opt.timestamp || 0;
    this.duration = opt.duration || 33333;
    this.closed = false;
  }
  close() { this.closed = true; }
};
let mode = 'unsupported'; // unsupported | encoder-error
let simulatedError = null;
globalThis.VideoEncoder = class {
  constructor(opts) { this._out = opts.output; this._err = opts.error; }
  static async isConfigSupported() { return { supported: mode !== 'unsupported' }; }
  configure() {}
  encode(vf) {
    if (mode === 'encoder-error' && !simulatedError) {
      simulatedError = new Error('simulated encoder error');
      this._err(simulatedError); // 只记录、不 throw —— 正是线上真实回调行为
    }
  }
  async flush() {}
  close() {}
};

const { Recorder } = await import(pathToFileURL(path.join(root, 'src/cinematic/Recorder.js')).href);
const fakeFrame = () => ({ arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer });
const origWarn = console.warn;
console.warn = () => {};
try {
  const r1 = new Recorder({});
  r1.frames = [fakeFrame(), fakeFrame(), fakeFrame()];
  const res1 = await r1.exportVideo({ fps: 30, baseName: 'probe_a', captureVideo: false });
  eq(res1.method, 'zip', 'WebCodecs 不支持 + 无跨源隔离时降级为 ZIP 帧序列');
  ok(/WebCodecs:/.test(res1.reason || ''), 'reason 含 WebCodecs 失败原因');
  ok(/ffmpeg:/.test(res1.reason || ''), 'reason 含 ffmpeg 跳过原因');
  ok(/跨源隔离|COOP/.test(res1.reason || ''), 'ffmpeg 原因明确指向跨源隔离，不是含糊的网络错误');

  mode = 'encoder-error';
  simulatedError = null;
  const r2 = new Recorder({});
  r2.frames = [fakeFrame(), fakeFrame(), fakeFrame()];
  const res2 = await r2.exportVideo({ fps: 30, baseName: 'probe_b', captureVideo: false });
  eq(res2.method, 'zip', '编码器回调报错后仍走完整降级，不抛未捕获异常');
  ok(/simulated encoder error/.test(res2.reason || ''), '编码器错误冒泡到 reason（旧版会卡死在「合成视频中」）');
} finally {
  console.warn = origWarn;
  URL.createObjectURL = origCreate;
  URL.revokeObjectURL = origRevoke;
}

console.log(`\n通过 ${pass} 项，失败 ${fails.length} 项`);
if (fails.length) {
  fails.forEach((f) => console.log('FAIL: ' + f));
  process.exitCode = 1;
}
