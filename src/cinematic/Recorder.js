// 职责：逐帧渲染产物的导出（纯前端，零后端）。
//
// 导出优先级（自动降级，且每层失败都会把原因带回页面，不静默吞掉）：
//   1) WebCodecs + 本地 mp4-muxer 合成 MP4 —— 零网络依赖、无需 SharedArrayBuffer，Pages 可用（Chrome/Edge）。
//   2) ffmpeg.wasm 合成 MP4 —— 需跨源隔离（COOP/COEP）；Pages 上不可用，仅本地自托管兜底。
//   3) 帧序列导出 —— 用户「选文件夹」直接写入；浏览器不支持文件夹选择器时，打包成单个 ZIP 下载。
//
// 帧抓取依赖渲染器开启 preserveDrawingBuffer（见 main.js 的 renderer 配置）。

// ⚠ MP4 合成器必须是本地依赖（npm 包，随产物打包），不能从 CDN 动态 import：
//   实测 cdn.jsdelivr.net 在国内/部分网络下直接不可达，而 WebCodecs 编码 + ffmpeg.wasm
//   兜底曾同时挂在同一家 CDN 上 —— 结果「渲染并导出 MP4」最后只吐出一堆 PNG/ZIP，
//   用户看到的就是「合成视频没了」。本地化后主路径零网络依赖，离线也能出 MP4。
import { Muxer, ArrayBufferTarget } from 'mp4-muxer';

// ffmpeg.wasm 兜底：只在跨源隔离环境（本地自托管 + COOP/COEP）才可能跑起来，
// GitHub Pages 上没有隔离头，直接跳过，不再白等 CDN 超时。CDN 多源按顺序重试。
const FF_BASES = [
  'https://unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/esm',
  'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/esm',
];
const CORE_BASES = [
  'https://unpkg.com/@ffmpeg/core-st@0.12.6/dist/esm',
  'https://cdn.jsdelivr.net/npm/@ffmpeg/core-st@0.12.6/dist/esm',
];

let _ff = null;
let _ffLoading = null;

async function loadFFmpeg(onLog) {
  if (_ff) return _ff;
  if (_ffLoading) return _ffLoading;
  _ffLoading = (async () => {
    // ffmpeg.wasm 单线程版也要 SharedArrayBuffer；没有跨源隔离时 load() 必然失败。
    if (!globalThis.crossOriginIsolated) {
      throw new Error('当前页面未开启跨源隔离（COOP/COEP），ffmpeg.wasm 不可用');
    }
    let lastErr = null;
    for (let i = 0; i < FF_BASES.length; i++) {
      try {
        const mod = await import(/* @vite-ignore */ `${FF_BASES[i]}/index.js`);
        const FFmpeg = mod.FFmpeg || mod.default?.FFmpeg;
        const ffmpeg = new FFmpeg();
        if (onLog) ffmpeg.on('log', ({ message }) => onLog(message));
        await ffmpeg.load({
          coreURL: `${CORE_BASES[i]}/ffmpeg-core.js`,
          wasmURL: `${CORE_BASES[i]}/ffmpeg-core.wasm`,
          classWorkerURL: `${FF_BASES[i]}/worker.js`,
        });
        _ff = ffmpeg;
        return ffmpeg;
      } catch (e) {
        lastErr = e;
        console.warn('[rec] ffmpeg CDN 源不可用，尝试下一个:', FF_BASES[i], e);
        // 单个 FFmpeg 实例加载失败后不能复用，下一轮重新 new
      }
    }
    throw lastErr || new Error('ffmpeg.wasm 加载失败');
  })().finally(() => { _ffLoading = null; });
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

function sanitizeName(s) {
  return (s || 'frames').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60) || 'frames';
}

function pickAvcCodec(w, h) {
  const maxd = Math.max(w, h);
  if (maxd <= 1280) return 'avc1.42001f'; // Baseline 3.1
  if (maxd <= 1920) return 'avc1.4d0028'; // Main 4.0
  return 'avc1.640032';                    // High 5.0
}

function pickBitrate(w, h) {
  const maxd = Math.max(w, h);
  if (maxd <= 1280) return 6_000_000;
  if (maxd <= 1920) return 12_000_000;
  return 24_000_000;
}

// ---- 最小 ZIP 写入（store 法，不压缩；PNG 本身已压缩，省去依赖）----
let _crcTable = null;
function crc32(buf) {
  let table = _crcTable;
  if (!table) {
    table = _crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function makeZip(files) {
  const enc = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const data = f.data;
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true); local.setUint16(6, 0, true); local.setUint16(8, 0, true);
    local.setUint16(10, 0, true); local.setUint16(12, 0, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true); local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true); local.setUint16(28, 0, true);
    const localHeader = new Uint8Array(local.buffer);
    chunks.push(localHeader, nameBytes, data);

    const ce = new DataView(new ArrayBuffer(46));
    ce.setUint32(0, 0x02014b50, true);
    ce.setUint16(4, 20, true); ce.setUint16(6, 20, true); ce.setUint16(8, 0, true);
    ce.setUint16(10, 0, true); ce.setUint16(12, 0, true);
    ce.setUint32(14, crc, true);
    ce.setUint32(18, data.length, true); ce.setUint32(22, data.length, true);
    ce.setUint16(26, nameBytes.length, true); ce.setUint16(28, 0, true);
    ce.setUint16(30, 0, true); ce.setUint16(32, 0, true); ce.setUint16(34, 0, true);
    ce.setUint16(36, 0, true); ce.setUint32(38, 0, true); ce.setUint32(42, offset, true);
    central.push(new Uint8Array(ce.buffer), nameBytes);
    offset += localHeader.length + nameBytes.length + data.length;
  }
  const centralSize = central.reduce((s, c) => s + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(4, 0, true); end.setUint16(6, 0, true);
  end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true); end.setUint32(16, offset, true); end.setUint16(20, 0, true);

  return new Blob([...chunks, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
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

  // 选文件夹（File System Access API，需 https + 用户手势；Firefox/Safari 不支持时返回 null）
  async pickFolder() {
    if (!window.showDirectoryPicker) return null;
    try {
      return await window.showDirectoryPicker();
    } catch (e) {
      console.warn('[rec] 文件夹选择取消/不可用:', e);
      return null;
    }
  }

  // 把已抓取的 frames 写入用户所选文件夹下的 <baseName>/ 子目录
  async writeToFolder(dirHandle, baseName, onProgress) {
    const sub = await dirHandle.getDirectoryHandle(sanitizeName(baseName), { create: true });
    const n = this.frames.length;
    for (let i = 0; i < n; i++) {
      const name = `${sanitizeName(baseName)}_${String(i + 1).padStart(4, '0')}.png`;
      const fh = await sub.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      await w.write(this.frames[i]);
      await w.close();
      if (onProgress) onProgress((i + 1) / n);
    }
  }

  // 把 frames 打包成单个 ZIP 下载（浏览器不支持文件夹选择器时的兜底）
  async writeZip(baseName, onProgress) {
    const n = this.frames.length;
    const files = [];
    for (let i = 0; i < n; i++) {
      const name = `${sanitizeName(baseName)}_${String(i + 1).padStart(4, '0')}.png`;
      const data = new Uint8Array(await this.frames[i].arrayBuffer());
      files.push({ name, data });
      if (onProgress) onProgress((i + 1) / n);
    }
    downloadBlob(makeZip(files), `${sanitizeName(baseName)}.zip`);
  }

  // 帧序列导出：有文件夹就写文件夹，否则打包 ZIP
  async exportFrames({ dirHandle = null, baseName = 'frames', onProgress } = {}) {
    if (dirHandle) {
      await this.writeToFolder(dirHandle, baseName, onProgress);
      return { method: 'folder' };
    }
    await this.writeZip(baseName, onProgress);
    return { method: 'zip' };
  }

  // WebCodecs + mp4-muxer 合成 MP4（无需 SharedArrayBuffer，Pages 可用）
  // captureVideo=true 且首帧是 VideoFrame 时，直接消费已抓好的 VideoFrame（零 PNG 往返）；
  // 否则把 PNG Blob 解码成 VideoFrame 再编码（兜底 / 帧序列路径）。
  async exportVideoWebCodecs({ fps, baseName, captureVideo = false, onProgress, onLog }) {
    if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
      throw new Error('WebCodecs 不可用');
    }
    // 合成器是本地 npm 包（顶部静态 import），不需要任何网络请求。
    const first = this.frames[0];
    const isVF = captureVideo && (first instanceof VideoFrame);
    let w, h;
    if (isVF) {
      w = first.codedWidth; h = first.codedHeight;
    } else {
      const probeBmp = await createImageBitmap(first);
      w = probeBmp.width; h = probeBmp.height;
      probeBmp.close();
    }

    const codec = pickAvcCodec(w, h);
    const supported = await VideoEncoder.isConfigSupported({
      codec, width: w, height: h, bitrate: pickBitrate(w, h), framerate: fps,
    });
    if (!supported?.supported) throw new Error(`WebCodecs 编码器不支持 ${codec}`);

    const muxer = new Muxer({
      target: new ArrayBufferTarget(),
      video: { codec: 'avc', width: w, height: h, frameRate: fps },
      fastStart: 'in-memory',
    });
    let encodeError = null;
    const encoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      // ⚠ 回调里 throw 不会冒泡到 await（只会变成未捕获异常，导出卡死在「合成视频中」）。
      //   先记下来，在编码循环与 flush 之后统一抛出，才能被 exportVideo 的降级链捕获。
      error: (e) => { encodeError = e instanceof Error ? e : new Error(String(e)); },
    });
    encoder.configure({ codec, width: w, height: h, bitrate: pickBitrate(w, h), framerate: fps });

    const frameDur = 1_000_000 / fps; // 微秒
    const n = this.frames.length;
    const gop = Math.max(1, Math.round(fps * 2));
    try {
      for (let i = 0; i < n; i++) {
        if (encodeError) throw encodeError;
        let vf;
        if (isVF) {
          vf = this.frames[i]; // 已是 VideoFrame，直接喂编码器
        } else {
          const bmp = await createImageBitmap(this.frames[i]);
          vf = new VideoFrame(bmp, {
            timestamp: Math.round(i * frameDur),
            duration: Math.round(frameDur),
          });
          bmp.close();
        }
        encoder.encode(vf, { keyFrame: i % gop === 0 });
        vf.close();
        if (onProgress) onProgress((i + 1) / n / 2);
      }
      await encoder.flush();
      if (encodeError) throw encodeError;
    } catch (e) {
      // 编码器已坏，别继续复用；错误交给上层决定是否降级
      try { encoder.close(); } catch (_) { /* 忽略关闭异常 */ }
      throw encodeError || e;
    }
    muxer.finalize();
    const { buffer } = muxer.target;
    const name = `${sanitizeName(baseName)}.mp4`;
    const blob = new Blob([buffer], { type: 'video/mp4' });
    downloadBlob(blob, name);
    if (onProgress) onProgress(1);
    // 回传 blob：页面里可直接 <video> 预览/另存，不必只依赖浏览器下载栏。
    return { method: 'webcodecs', blob, name };
  }

  // ffmpeg.wasm 兜底（需跨源隔离；Pages 上通常失败）
  async exportVideoFFmpeg({ fps, onProgress, onLog }) {
    const ffmpeg = await loadFFmpeg(onLog);
    const n = this.frames.length;
    for (let i = 0; i < n; i++) {
      const buf = new Uint8Array(await this.frames[i].arrayBuffer());
      await ffmpeg.writeFile(`f${String(i).padStart(4, '0')}.png`, buf);
      if (onProgress) onProgress((i + 1) / n / 2);
    }
    await ffmpeg.exec([
      '-framerate', String(fps), '-i', 'f%04d.png',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', 'out.mp4',
    ]);
    const data = await ffmpeg.readFile('out.mp4');
    const name = 'cinematic.mp4';
    const blob = new Blob([data.buffer || data], { type: 'video/mp4' });
    downloadBlob(blob, name);
    if (onProgress) onProgress(1);
    return { method: 'ffmpeg', blob, name };
  }

  // 把已抓好的 VideoFrame 转回 PNG Blob（仅 WebCodecs 失败、需要走 ffmpeg / 帧序列兜底时用到）
  async _videoFramesToPng(onProgress) {
    const n = this.frames.length;
    const out = [];
    for (let i = 0; i < n; i++) {
      const vf = this.frames[i];
      // 若 WebCodecs 编码到一半才失败，前面的 VideoFrame 可能已被 close()，
      // 再 createImageBitmap 会抛 InvalidStateError。别静默吞掉半个帧序列，
      // 明确报错让上层提示「重新渲染一次」（这几帧已经不可恢复）。
      let bmp;
      try {
        bmp = await createImageBitmap(vf);
      } catch (e) {
        try { vf.close(); } catch (_) { /* 已关闭 */ }
        throw new Error(`第 ${i + 1} 帧已失效，无法转回 PNG；请重新点击「渲染并导出 MP4」再渲染一次。`);
      }
      const cv = document.createElement('canvas');
      cv.width = bmp.width; cv.height = bmp.height;
      cv.getContext('2d').drawImage(bmp, 0, 0);
      bmp.close();
      const blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
      vf.close();
      out.push(blob);
      if (onProgress) onProgress((i + 1) / n / 2);
    }
    this.frames = out;
  }

  // 主导出入口：WebCodecs → ffmpeg → 帧序列（文件夹/ZIP）
  async exportVideo({ fps, baseName = 'frames', captureVideo = false, onProgress, onLog } = {}) {
    if (this.frames.length === 0) throw new Error('没有帧可导出');
    const reasons = [];
    try {
      return await this.exportVideoWebCodecs({ fps, baseName, captureVideo, onProgress, onLog });
    } catch (e) {
      reasons.push('WebCodecs: ' + (e && e.message ? e.message : String(e)));
      console.warn('[rec] WebCodecs 失败，降级:', e);
    }
    // 若之前抓的是 VideoFrame，降级路径（ffmpeg / 帧序列）需要 PNG，先转回
    if (captureVideo) await this._videoFramesToPng(onProgress);
    try {
      return await this.exportVideoFFmpeg({ fps, onProgress, onLog });
    } catch (e) {
      reasons.push('ffmpeg: ' + (e && e.message ? e.message : String(e)));
      console.warn('[rec] ffmpeg 不可用，降级为帧序列:', e);
    }
    // 帧序列兜底：先尝试文件夹，失败则 ZIP。
    // ⚠ 带上 reasons：页面必须明说「MP4 没合成出来」，而不是让用户以为拿到了视频。
    let dirHandle = null;
    try { dirHandle = await this.pickFolder(); } catch (_) { dirHandle = null; }
    const res = await this.exportFrames({ dirHandle, baseName, onProgress });
    res.reason = reasons.join(' / ');
    return res;
  }
}
