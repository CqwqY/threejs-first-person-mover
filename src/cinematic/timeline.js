// 职责：相机关键帧时间轴（Blender 式：一切以「帧」为最小单位）。
//   · 关键帧打在「帧号」上（0 .. totalFrames-1），渲染时第 i 帧就取第 i 帧的相机位姿，
//     真正逐帧调用 renderer.render 一次（而非录屏 / 每秒截屏 N 次）。
//   · fps 只用于决定「输出视频的播放帧率 / 时长」（时长 = totalFrames / fps），不参与插值。
import * as THREE from 'three';

export class Timeline {
  constructor() {
    this.keys = [];          // 升序排列：{ frame, pos:[3], quat:[4], fov }
    this.totalFrames = 100;  // 总帧数（要渲染多少张）
    this.fps = 30;           // 输出视频帧率（仅用于播放速度与元数据）
    // 复用的临时量，避免每帧 new
    this._pa = new THREE.Vector3();
    this._pb = new THREE.Vector3();
    this._qa = new THREE.Quaternion();
    this._qb = new THREE.Quaternion();
  }

  // 在 frame 处存/更新关键帧（同帧号覆盖）
  setKey(frame, state) {
    const fr = Math.max(0, Math.min(this.totalFrames, Math.round(frame)));
    const existing = this.keys.find((k) => Math.abs(k.frame - fr) < 1e-4);
    const rec = { frame: fr, pos: state.pos.slice(), quat: state.quat.slice(), fov: state.fov };
    if (existing) {
      Object.assign(existing, rec);
    } else {
      this.keys.push(rec);
      this.keys.sort((a, b) => a.frame - b.frame);
    }
  }

  removeKeyAt(frame) {
    const i = this.keys.findIndex((k) => Math.abs(k.frame - frame) < 1e-4);
    if (i >= 0) this.keys.splice(i, 1);
    return i >= 0;
  }

  // 取 frame 时刻（帧号，可为小数）的相机状态，写入 out（{pos,quat,fov}），返回是否取到值
  sampleAtFrame(frame, out) {
    const ks = this.keys;
    if (ks.length === 0) return false;
    if (ks.length === 1) { this._write(ks[0], out); return true; }
    if (frame <= ks[0].frame) { this._write(ks[0], out); return true; }
    const last = ks[ks.length - 1];
    if (frame >= last.frame) { this._write(last, out); return true; }
    let i = 0;
    while (i < ks.length - 1 && ks[i + 1].frame < frame) i++;
    const a = ks[i];
    const b = ks[i + 1];
    const u = (frame - a.frame) / (b.frame - a.frame);
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
