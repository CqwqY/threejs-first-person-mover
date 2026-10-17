// 职责：逐帧渲染产物的视频合成（纯前端，零后端）。
//
// 主路径：ffmpeg.wasm（浏览器内跑 FFmpeg，跨浏览器）把 PNG 序列编码成 MP4/WebM。
//   - 用单线程 core-st（无需 SharedArrayBuffer，GitHub Pages 不支持自定义 COOP/COEP 头也能跑）。
//   - 核心/worker 从 jsDelivr CDN 动态加载（@vite-ignore，不进打包）。
// 降级：ffmpeg 加载/编码失败时，逐帧下载 PNG 序列（用户可本地用任何工具合成）。
//
// 帧抓取依赖渲染器开启 preserveDrawingBuffer（见 main.js 的 renderer 配置）。

const FF_BASE = 'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/esm';
const CORE_BASE = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core-st@0.12.6/dist/esm';

let _ff = null;
let _ffLoading = null;

async function loadFFmpeg(onLog) {
  if (_ff) return _ff;
  if (_ffLoading) return _ffLoading;
  _ffLoading = (async () => {
    const mod = await import(/* @vite-ignore */ `${FF_BASE}/index.js`);
    const FFmpeg = mod.FFmpeg || mod.default?.FFmpeg;
    const ffmpeg = new FFmpeg();
    if (onLog) ffmpeg.on('log', ({ message }) => onLog(message));
    await ffmpeg.load({
      coreURL: `${CORE_BASE}/ffmpeg-core.js`,
      wasmURL: `${CORE_BASE}/ffmpeg-core.wasm`,
      classWorkerURL: `${FF_BASE}/worker.js`,
    });
    _ff = ffmpeg;
    return ffmpeg;
  })();
  return _ffLoading;
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export class Recorder {
  constructor(canvas) {
    this.canvas = canvas;
    this.frames = []; // 逐帧 PNG Blob
  }

  async grabFrame() {
    return await new Promise((resolve) => {
      this.canvas.toBlob((b) => resolve(b), 'image/png');
    });
  }

  // 把抓取到的帧合成视频并触发下载；返回 { fallback? } 标记是否走了降级路径
  async exportVideo({ fps, format = 'mp4', onProgress, onLog }) {
    const n = this.frames.length;
    if (n === 0) throw new Error('没有帧可导出');

    let ffmpeg;
    try {
      ffmpeg = await loadFFmpeg(onLog);
    } catch (e) {
      console.warn('[rec] ffmpeg 加载失败，降级逐帧下载 PNG:', e);
      await this._downloadFrames();
      return { fallback: 'png' };
    }

    // 写帧（前半进度）
    for (let i = 0; i < n; i++) {
      const buf = new Uint8Array(await this.frames[i].arrayBuffer());
      await ffmpeg.writeFile(`f${String(i).padStart(4, '0')}.png`, buf);
      if (onProgress) onProgress((i + 1) / n / 2);
    }

    const out = format === 'webm' ? 'out.webm' : 'out.mp4';
    const codec = format === 'webm' ? 'libvpx-vp9' : 'libx264';
    const args = ['-framerate', String(fps), '-i', 'f%04d.png', '-c:v', codec];
    if (format === 'mp4') args.push('-pix_fmt', 'yuv420p'); // 浏览器/微信/iOS 兼容
    args.push(out);

    try {
      await ffmpeg.exec(args);
    } catch (e) {
      console.warn('[rec] ffmpeg 编码失败，降级逐帧下载 PNG:', e);
      await this._downloadFrames();
      return { fallback: 'png' };
    }

    const data = await ffmpeg.readFile(out);
    const type = format === 'webm' ? 'video/webm' : 'video/mp4';
    downloadBlob(new Blob([data.buffer || data], { type }), `cinematic.${format}`);
    if (onProgress) onProgress(1);
    return { fallback: null };
  }

  async _downloadFrames() {
    for (let i = 0; i < this.frames.length; i++) {
      downloadBlob(this.frames[i], `frame_${String(i).padStart(4, '0')}.png`);
      await new Promise((r) => setTimeout(r, 60)); // 避免浏览器批量下载拦截
    }
  }
}
