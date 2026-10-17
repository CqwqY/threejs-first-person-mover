// 职责：相机关键帧时间轴。在时间点 t 存/删相机状态（pos/quat/fov），
// 取帧时在相邻关键帧之间做 lerp（位置/fov）+ slerp（旋转）插值，得到任意时刻的相机位姿。
import * as THREE from 'three';

export class Timeline {
  constructor() {
    this.keys = []; // 升序排列：{ t, pos:[3], quat:[4], fov }
    this.duration = 5; // 总时长（秒）
    this.fps = 30;
    // 复用的临时量，避免每帧 new
    this._pa = new THREE.Vector3();
    this._pb = new THREE.Vector3();
    this._qa = new THREE.Quaternion();
    this._qb = new THREE.Quaternion();
  }

  // 在 t 处存/更新关键帧（同 t 覆盖）
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

  // 取 t 时刻的相机状态，写入 out（{pos:Vector3, quat:Quaternion, fov}），返回是否取到了值
  sampleAt(t, out) {
    const ks = this.keys;
    if (ks.length === 0) return false;
    if (ks.length === 1) {
      this._write(ks[0], out);
      return true;
    }
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
