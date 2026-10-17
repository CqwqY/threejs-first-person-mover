// 职责：逐帧渲染产物的导出（纯前端，零后端）。
//
// 导出优先级（自动降级）：
//   1) WebCodecs + mp4-muxer 合成 MP4 —— 不依赖 SharedArrayBuffer，GitHub Pages 可用（Chrome/Edge）。
//   2) ffmpeg.wasm 合成 MP4 —— 需跨源隔离（COOP/COEP），Pages 上通常不可用，作为本地自托管兜底。
//   3) 帧序列导出 —— 用户「选文件夹」直接写入；浏览器不支持文件夹选择器时，打包成单个 ZIP 下载。
//
// 帧抓取依赖渲染器开启 preserveDrawingBuffer（见 main.js 的 renderer 配置）。

const FF_BASE = 'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/esm';
const CORE_BASE = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core-st@0.12.6/dist/esm';
const MP4MUXER_URL = 'https://cdn.jsdelivr.net/npm/mp4-muxer@5.1.5/+esm';

let _ff = null;
let _ffLoading = null;
let _muxerMod = null;
let _muxerLoading = null;

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

async function loadMp4Muxer() {
  if (_muxerMod) return _muxerMod;
  if (_muxerLoading) return _muxerLoading;
  _muxerLoading = (async () => {
    const mod = await import(/* @vite-ignore */ MP4MUXER_URL);
    _muxerMod = mod.Muxer ? mod : (mod.default || {});
    return _muxerMod;
  })();
  return _muxerLoading;
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
  async exportVideoWebCodecs({ fps, baseName, onProgress, onLog }) {
    if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
      throw new Error('WebCodecs 不可用');
    }
    const { Muxer, ArrayBufferTarget } = await loadMp4Muxer();
    if (!Muxer || !ArrayBufferTarget) throw new Error('mp4-muxer 加载失败');

    const first = this.frames[0];
    const probeBmp = await createImageBitmap(first);
    const w = probeBmp.width, h = probeBmp.height;
    probeBmp.close();

    const codec = pickAvcCodec(w, h);
    const supported = await VideoEncoder.isConfigSupported({
      codec, width: w, height: h, bitrate: pickBitrate(w, h), framerate: fps,
    });
    if (!supported?.supported) throw new Error(`WebCodecs 编码器不支持 ${codec}`);

    const muxer = new Muxer({
      target: new ArrayBufferTarget(),
      video: { codec: 'avc', width: w, height: h },
      fastStart: 'in-memory',
    });
    const encoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: (e) => { throw e; },
    });
    encoder.configure({ codec, width: w, height: h, bitrate: pickBitrate(w, h), framerate: fps });

    const frameDur = 1_000_000 / fps; // 微秒
    const n = this.frames.length;
    const gop = Math.max(1, Math.round(fps * 2));
    for (let i = 0; i < n; i++) {
      const bmp = await createImageBitmap(this.frames[i]);
      const vf = new VideoFrame(bmp, {
        timestamp: Math.round(i * frameDur),
        duration: Math.round(frameDur),
      });
      bmp.close();
      encoder.encode(vf, { keyFrame: i % gop === 0 });
      vf.close();
      if (onProgress) onProgress((i + 1) / n / 2);
    }
    await encoder.flush();
    muxer.finalize();
    const { buffer } = muxer.target;
    downloadBlob(new Blob([buffer], { type: 'video/mp4' }), `${sanitizeName(baseName)}.mp4`);
    if (onProgress) onProgress(1);
    return { method: 'webcodecs' };
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
    downloadBlob(new Blob([data.buffer || data], { type: 'video/mp4' }), 'cinematic.mp4');
    if (onProgress) onProgress(1);
    return { method: 'ffmpeg' };
  }

  // 主导出入口：WebCodecs → ffmpeg → 帧序列（文件夹/ZIP）
  async exportVideo({ fps, baseName = 'frames', onProgress, onLog } = {}) {
    if (this.frames.length === 0) throw new Error('没有帧可导出');
    try {
      return await this.exportVideoWebCodecs({ fps, baseName, onProgress, onLog });
    } catch (e) {
      console.warn('[rec] WebCodecs 不可用，试 ffmpeg:', e);
    }
    try {
      return await this.exportVideoFFmpeg({ fps, onProgress, onLog });
    } catch (e) {
      console.warn('[rec] ffmpeg 不可用，降级为帧序列:', e);
    }
    // 帧序列兜底：先尝试文件夹，失败则 ZIP
    let dirHandle = null;
    try { dirHandle = await this.pickFolder(); } catch (_) { dirHandle = null; }
    return await this.exportFrames({ dirHandle, baseName, onProgress });
  }
}
