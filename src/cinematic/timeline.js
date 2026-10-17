// 职责：相机关键帧时间轴（影片/相机模型：以「秒」为时间单位）。
//   · 镜头 = fps（每秒渲染多少帧，即镜头密度）× 时长(秒) → 总帧数 = round(fps × 时长)。
//   · 关键帧打在「秒」上；渲染时第 i 帧取 t = i / fps 处的相机位姿，真正逐帧调用
//     renderer.render 一次（而非录屏 / 每秒截屏 N 次）。
//   · fps 越高 → 同样时长内渲染的帧越多 → 画面越平滑（这才是「一秒多少帧」该有的效果）。
//   · 提高 fps 还会让导出视频的播放帧率同步提高，时长保持不变。
import * as THREE from 'three';

export class Timeline {
  constructor() {
    this.keys = [];          // 升序排列：{ t(秒), pos:[3], quat:[4], fov }
    this.fps = 30;           // 每秒渲染多少帧（镜头密度 / 输出视频帧率）
    this.duration = 5;       // 镜头总时长（秒）
    // 复用的临时量，避免每帧 new
    this._pa = new THREE.Vector3();
    this._pb = new THREE.Vector3();
    this._qa = new THREE.Quaternion();
    this._qb = new THREE.Quaternion();
  }

  // 总帧数 = fps × 时长（向上取整，至少 2）
  get totalFrames() {
    return Math.max(2, Math.round(this.fps * this.duration));
  }

  // 在 t 秒处存/更新关键帧（同秒覆盖）
  setKey(t, state) {
    const tt = Math.max(0, Math.min(this.duration, t));
    const existing = this.keys.find((k) => Math.abs(k.t - tt) < 1e-4);
    const rec = { t: tt, pos: state.pos.slice(), quat: state.quat.slice(), fov: state.fov };
    if (existing) {
      Object.assign(existing, rec);
    } else {
      this.keys.push(rec);
      this.keys.sort((a, b) => a.t - b.t);
    }
  }

  removeKeyAt(t) {
    const i = this.keys.findIndex((k) => Math.abs(k.t - t) < 1e-4);
    if (i >= 0) this.keys.splice(i, 1);
    return i >= 0;
  }

  // 取 t 秒处的相机状态，写入 out（{pos,quat,fov}），返回是否取到值
  sampleAt(t, out) {
    const ks = this.keys;
    if (ks.length === 0) return false;
    if (ks.length === 1) { this._write(ks[0], out); return true; }
    if (t <= ks[0].t) { this._write(ks[0], out); return true; }
    const last = ks[ks.length - 1];
    if (t >= last.t) { this._write(last, out); return true; }
    let i = 0;
    while (i < ks.length - 1 && ks[i + 1].t < t) i++;
    const a = ks[i];
    const b = ks[i + 1];
    const u = (t - a.t) / (b.t - a.t);
    this._pa.fromArray(a.pos);
    this._pb.fromArray(b.pos);
    out.pos.lerpVectors(this._pa, this._pb, u);
    this._qa.fromArray(a.quat);
    this._qb.fromArray(b.quat);
    out.quat.slerpQuaternions(this._qa, this._qb, u);
    out.fov = a.fov + (b.fov - a.fov) * u;
    return true;
  }

  _write(k, out) {
    out.pos.fromArray(k.pos);
    out.quat.fromArray(k.quat);
    out.fov = k.fov;
  }
}
