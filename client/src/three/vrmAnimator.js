// VRM 程序化人体动画（与现有角色同名的动作），运行时标定骨骼轴向，兼容任意 VRM（0.x/1.0、不同 roll）。
import * as THREE from 'three';

const D = Math.PI / 180;
const ID = () => new THREE.Quaternion();
const qx = (r, d) => r.setFromAxisAngle(X_AXIS, d);
const qy = (r, d) => r.setFromAxisAngle(Y_AXIS, d);
const qz = (r, d) => r.setFromAxisAngle(Z_AXIS, d);
const X_AXIS = new THREE.Vector3(1, 0, 0);
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const smooth = (x) => x * x * (3 - 2 * x);
const easeOutCubic = (x) => 1 - Math.pow(1 - x, 3);

// 需要标定/会被写入的骨骼（标准帧：前 +Z、上 +Y、T-pose 手臂沿 ±X、腿沿 −Y）
const CALIB = ['hips','spine','chest','neck','head',
  'leftUpperArm','rightUpperArm','leftLowerArm','rightLowerArm','leftHand','rightHand',
  'leftUpperLeg','rightUpperLeg','leftLowerLeg','rightLowerLeg','leftFoot','rightFoot','leftToes','rightToes'];

export class VrmAnimator {
  constructor(vrm) {
    this.vrm = vrm;
    this.humanoid = vrm.humanoid;
    this.bones = {};
    for (const [name, node] of Object.entries(this.humanoid.normalizedHumanBones)) {
      if (node && node.node) this.bones[name] = node.node;
    }
    // 静息（T-pose）姿态与髋位置
    this.rest = {};
    for (const [name, b] of Object.entries(this.bones)) this.rest[name] = b.quaternion.clone();
    this.hipsRestPos = this.bones.hips.position.clone();

    this.state = 'idle'; this.motion = 0;
    this.walkPhase = 0;
    this.attackSide = 1; this.attackT = 0;
    this.cur = {};
    for (const name of Object.keys(this.bones)) this.cur[name] = this.rest[name].clone();
    this.curHipsPos = this.hipsRestPos.clone();

    this._calibrate();

    // 初始写一帧 T-pose，避免首帧是模型自带姿势
    this._write(this.rest, this.hipsRestPos, 1);
  }

  // 标定：求每根骨骼“归一化局部轴”在世界中的朝向 W，进而得到标准帧→局部帧的换算
  _calibrate() {
    const h = this.humanoid;
    const CAL_THETA = 30 * D;
    this.frameQ = {};   // qW
    this.frameQi = {};  // qW^{-1}
    const rawWorld = (bn) => {
      const r = h.getRawBoneNode(bn);
      return r.getWorldQuaternion(new THREE.Quaternion());
    };
    const setAllIdentity = () => {
      for (const b of Object.values(this.bones)) b.quaternion.identity();
    };
    const axes = [
      { k: 'x', loc: X_AXIS, ref: Y_AXIS, refLoc: new THREE.Vector3(0, 1, 0) },
      { k: 'y', loc: Y_AXIS, ref: Z_AXIS, refLoc: new THREE.Vector3(0, 0, 1) },
      { k: 'z', loc: Z_AXIS, ref: Y_AXIS, refLoc: new THREE.Vector3(0, 1, 0) },
    ];
    for (const bn of CALIB) {
      if (!this.bones[bn]) continue;
      // 基：全身 T
      setAllIdentity(); h.update(); this.vrm.scene.updateMatrixWorld(true);
      const M0 = this._rawWorldMatrix(bn);
      const cols = {};
      for (const a of axes) {
        setAllIdentity();
        this.bones[bn].quaternion.setFromAxisAngle(a.loc, CAL_THETA);
        h.update(); this.vrm.scene.updateMatrixWorld(true);
        const M1 = this._rawWorldMatrix(bn);
        const Dm = M1.clone().multiply(M0.clone().invert());           // 世界旋转增量
        const dq = new THREE.Quaternion().setFromRotationMatrix(Dm);
        // 铰链世界轴（方向，符号稍后定）
        let hinge = new THREE.Vector3(dq.x, dq.y, dq.z);
        if (hinge.lengthSq() < 1e-8) hinge = a.loc.clone(); else hinge.normalize();
        // 用参考向量求符号
        const v0 = a.refLoc.clone().transformDirection(M0);
        const v1 = a.refLoc.clone().transformDirection(M1);
        let sign = 1;
        if (new THREE.Vector3().crossVectors(v0, v1).dot(hinge) < 0) sign = -1;
        cols[a.k] = hinge.clone().multiplyScalar(sign);
      }
      // 组装 W（列=局部轴在世界），正交化并保证右手系
      let x = cols.x || new THREE.Vector3(1,0,0);
      let y = cols.y || new THREE.Vector3(0,1,0);
      let z = cols.z || new THREE.Vector3(0,0,1);
      x = x.clone().normalize();
      z = z.clone().normalize();
      y = new THREE.Vector3().crossVectors(z, x).normalize();
      x = new THREE.Vector3().crossVectors(y, z).normalize();
      const W = new THREE.Matrix4().makeBasis(x, y, z);
      if (W.determinant() < 0) { W.makeBasis(x.clone().negate(), y, z); }
      const qW = new THREE.Quaternion().setFromRotationMatrix(W);
      this.frameQ[bn] = qW;
      this.frameQi[bn] = qW.clone().invert();
    }
    // 标定完恢复 T
    setAllIdentity(); h.update();
  }

  _rawWorldMatrix(bn) {
    const r = this.humanoid.getRawBoneNode(bn);
    r.updateWorldMatrix(true, false);
    return r.matrixWorld.clone();
  }

  setState(name, opts = {}) {
    if (name === 'walk') this.motion = clamp(opts.motion != null ? opts.motion : 1, 0, 1);
    if (name === 'attack') {
      // 仅在「进入」attack 的那一帧重置相位；否则每帧清 0 会把攻击钉在第一帧
      if (this.state !== 'attack') this.attackT = 0;
      if (opts.side != null) this.attackSide = opts.side;
    }
    this.state = name;
  }
  setWalkMotion(m) { this.motion = clamp(m, 0, 1); }

  update(dt) {
    const target = this._buildTarget(dt);
    const rate = this.state === 'die' ? 9 : this.state === 'attack' ? 13 : 11;
    const a = 1 - Math.exp(-rate * dt);
    for (const name of Object.keys(this.cur)) {
      if (target.rot[name]) this.cur[name].slerp(target.rot[name], a);
    }
    this.curHipsPos.lerp(target.hipsPos, a);
    this._write(this.cur, this.curHipsPos, 1);
  }

  // 把标准帧姿态换算为该模型局部帧并写入
  _write(rot, hipsPos, alpha) {
    for (const [name, b] of Object.entries(this.bones)) {
      const qStd = rot[name]; if (!qStd) continue;
      if (this.frameQ[name]) b.quaternion.copy(this.frameQi[name]).multiply(qStd).multiply(this.frameQ[name]);
      else b.quaternion.copy(qStd);
    }
    if (hipsPos && this.bones.hips) this.bones.hips.position.copy(hipsPos);
  }

  _t() { const rot = {}; for (const [n, q] of Object.entries(this.rest)) rot[n] = q.clone(); return rot; }

  _buildTarget(dt) {
    const rot = this._t();
    const hipsPos = this.hipsRestPos.clone();
    switch (this.state) {
      case 'idle': this._applyIdle(rot, hipsPos); break;
      case 'walk': this._applyWalk(rot, hipsPos, dt); break;
      case 'crouch': this._applyCrouch(rot, hipsPos); break;
      case 'sit': this._applySit(rot, hipsPos); break;
      case 'attack': this._applyAttack(rot, hipsPos, dt); break;
      case 'die': this._applyDie(rot, hipsPos); break;
    }
    return { rot, hipsPos };
  }

  _bend(rot, bone, x = 0, y = 0, z = 0) {
    const q = ID()
      .multiply(qx(ID(), x))
      .multiply(qy(ID(), y))
      .multiply(qz(ID(), z));
    rot[bone] = q;
  }
  _chainBend(rot, bones, x = 0, z = 0) {
    let cx = 0, cz = 0;
    bones.forEach((bn, i) => {
      const fx = x / bones.length, fz = z / bones.length;
      cx += fx; cz += fz;
      this._bend(rot, bn, cx, 0, cz);
    });
  }
  _arm(rot, side, swingX = 0, extraZ = 0) {
    const bn = side > 0 ? 'leftUpperArm' : 'rightUpperArm';
    const qDown = qz(ID(), side * -90 * D);
    const qSwing = qx(ID(), swingX);
    const qExtra = qz(ID(), extraZ);
    rot[bn] = qSwing.multiply(qDown).multiply(qExtra);
  }
  _forearm(rot, side, flex = 0) {
    const bn = side > 0 ? 'leftLowerArm' : 'rightLowerArm';
    rot[bn] = qx(ID(), side * flex);
  }
  _leg(rot, side, swingX = 0, kneeFlex = 0, footAng = 0) {
    const up = side > 0 ? 'leftUpperLeg' : 'rightUpperLeg';
    const lo = side > 0 ? 'leftLowerLeg' : 'rightLowerLeg';
    const ft = side > 0 ? 'leftFoot' : 'rightFoot';
    rot[up] = qx(ID(), swingX);
    rot[lo] = qx(ID(), -kneeFlex);
    rot[ft] = qx(ID(), footAng + kneeFlex * 0.5 - swingX * 0.5);
  }

  _applyIdle(rot, hipsPos) {
    const t = performance.now() / 1000;
    const b = Math.sin(t * 1.7);
    this._chainBend(rot, ['spine', 'chest'], b * 1.2 * D, 0);
    rot.hips = ID()
      .multiply(qx(ID(), b * 0.6 * D))
      .multiply(qz(ID(), b * 0.4 * D));
    this._arm(rot, +1, b * 2 * D, 3 * D);
    this._arm(rot, -1, b * 2 * D, -3 * D);
    this._forearm(rot, +1, 8 * D);
    this._forearm(rot, -1, 8 * D);
    hipsPos.y = this.hipsRestPos.y + b * 0.006;
  }

  _applyWalk(rot, hipsPos, dt) {
    const m = this.motion;
    this.walkPhase += dt * (3.2 + 3.2 * m);
    const ph = this.walkPhase;
    const L = Math.sin(ph), R = Math.sin(ph + Math.PI);
    const amp = 26 * D * m + 4 * D;
    const knee = clamp(Math.cos(ph), 0, 1) * 42 * D * m;
    const kneeR = clamp(Math.cos(ph + Math.PI), 0, 1) * 42 * D * m;
    this._leg(rot, +1, L * amp, knee, 0);
    this._leg(rot, -1, R * amp, kneeR, 0);
    // 手臂反向摆动
    this._arm(rot, +1, -R * 22 * D * m, 3 * D);
    this._arm(rot, -1, -L * 22 * D * m, -3 * D);
    this._forearm(rot, +1, 10 * D);
    this._forearm(rot, -1, 10 * D);
    // 躯干微前倾 + 起伏 + 左右摆
    this._chainBend(rot, ['spine', 'chest'], 5 * D * m, Math.sin(ph * 2) * 2 * D);
    rot.hips = ID()
      .multiply(qx(ID(), 4 * D * m))
      .multiply(qz(ID(), -Math.sin(ph * 2) * 3 * D * m))
      .multiply(qy(ID(), Math.sin(ph) * 2.5 * D * m));
    hipsPos.y = this.hipsRestPos.y + Math.abs(Math.sin(ph * 2)) * 0.035 * m;
    hipsPos.x = this.hipsRestPos.x + Math.sin(ph) * 0.02 * m;
  }

  _applyCrouch(rot, hipsPos) {
    this._chainBend(rot, ['spine', 'chest'], 14 * D, 0);
    this._leg(rot, +1, 18 * D, 95 * D, 0);
    this._leg(rot, -1, 18 * D, 95 * D, 0);
    this._arm(rot, +1, 20 * D, 6 * D);
    this._arm(rot, -1, 20 * D, -6 * D);
    this._forearm(rot, +1, 40 * D);
    this._forearm(rot, -1, 40 * D);
    hipsPos.y = this.hipsRestPos.y - 0.34;
  }

  _applySit(rot, hipsPos) {
    this._chainBend(rot, ['spine', 'chest'], 6 * D, 0);
    this._leg(rot, +1, 88 * D, 95 * D, 0);
    this._leg(rot, -1, 88 * D, 95 * D, 0);
    this._arm(rot, +1, 0, 4 * D);
    this._arm(rot, -1, 0, -4 * D);
    this._forearm(rot, +1, 25 * D);
    this._forearm(rot, -1, 25 * D);
    hipsPos.y = this.hipsRestPos.y - 0.42;
  }

  _applyAttack(rot, hipsPos, dt) {
    const s = this.attackSide;
    this.attackT += dt / 0.62;
    const t = clamp(this.attackT, 0, 1);
    let pose;
    if (t < 0.28) pose = t / 0.28;                       // 蓄力
    else if (t < 0.55) pose = easeOutCubic((t - 0.28) / 0.27); // 挥出
    else pose = 1 - (t - 0.55) / 0.45;                  // 回收
    const wind = smooth(pose);
    // 躯干拧转与前倾
    const twistAng = (-38 * D + 58 * D * wind) * s;
    const fwd = 8 * D + 10 * D * wind;
    this._chainBend(rot, ['spine', 'chest'], fwd, 0);
    rot.chest = (rot.chest || ID()).multiply(qy(ID(), twistAng));
    // 攻击侧手臂：蓄力后摆→大幅前挥
    const armSwingX = (-30 * D + 95 * D * wind);
    this._arm(rot, s, armSwingX, s * (10 * D - 25 * D * wind));
    this._forearm(rot, s, 50 * D - 35 * D * wind);
    // 另一侧格挡
    this._arm(rot, -s, 25 * D, -s * 8 * D);
    this._forearm(rot, -s, 70 * D);
    // 上步
    this._leg(rot, s, 12 * D * wind, 12 * D * wind, 0);
    this._leg(rot, -s, -8 * D * wind, 6 * D, 0);
    hipsPos.y = this.hipsRestPos.y - 0.04 * wind;
  }

  _applyDie(rot, hipsPos) {
    // 对称、静止仰躺：背部近乎全平，头贴地，双臂摊开，双腿伸直，脚与腿成自然角度
    hipsPos.y = 0.15;
    hipsPos.z = this.hipsRestPos.z;
    rot.hips = qx(ID(), -88 * D);
    rot.spine = qx(ID(), 2 * D);
    rot.chest = qx(ID(), 2 * D);
    rot.neck = qx(ID(), 14 * D);
    // 双臂向两侧摊开
    rot.leftUpperArm = qz(ID(), -18 * D);
    rot.rightUpperArm = qz(ID(), 18 * D);
    rot.leftLowerArm = qx(ID(), 18 * D);
    rot.rightLowerArm = qx(ID(), 18 * D);
    // 双腿伸直、微外展
    rot.leftUpperLeg = qz(ID(), 3 * D);
    rot.rightUpperLeg = qz(ID(), -3 * D);
    rot.leftLowerLeg = qx(ID(), 0);
    rot.rightLowerLeg = qx(ID(), 0);
    rot.leftFoot = qx(ID(), 82 * D);
    rot.rightFoot = qx(ID(), 82 * D);
    rot.leftToes = qx(ID(), 0);
    rot.rightToes = qx(ID(), 0);
  }
}
