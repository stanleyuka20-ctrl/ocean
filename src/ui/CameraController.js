// ---------------------------------------------------------------------------
//  CameraController.js -- free camera with swim handling and the named
//  viewpoints the ocean has to hold up from.
// ---------------------------------------------------------------------------


import { isMobileDevice } from "../core/quality.js";

const B = () => window.BABYLON;
const D = Math.PI / 180;
const isInteractiveTarget = (target) => !!(target && target.closest &&
  target.closest("button,input,select,textarea,a,[contenteditable='true'],[role='dialog']"));

export const CAMERA_PRESETS = [
  { key: "waterline",  label: "At the waterline", pos: [0, 1.7, 0],           rot: [2, 30] },
  { key: "horizon",    label: "Horizon",          pos: [0, 3.0, 0],           rot: [1, 96] },
  { key: "glitter",    label: "Sun reflection",   pos: [0, 2.1, 0],           rot: [6, 0], lookSun: true },
  { key: "eyelevel",   label: "Open ocean",       pos: [2400, 2.4, -1800],    rot: [3, -152] },
  { key: "lowaerial",  label: "Low aerial",       pos: [-900, 24, 1200],      rot: [22, 64] },
  { key: "aerial",     label: "Aerial",           pos: [140, 120, -260],      rot: [34, -120] },
  { key: "highaerial", label: "High aerial",      pos: [300, 640, 900],       rot: [46, -178] },
  { key: "storm",      label: "Storm scene",      pos: [0, 8.0, 0],           rot: [8, 30],  weather: "storm" },
  { key: "sunset",     label: "Sunset scene",     pos: [0, 1.7, 0],           rot: [2, -100], weather: "sunset" },
  { key: "night",      label: "Night scene",      pos: [0, 1.7, 0],           rot: [2, 30],  weather: "night" },
  { key: "underwater", label: "Underwater",       pos: [0, -3.4, 0],          rot: [-20, -78] },
  { key: "seafloor",   label: "Near the seafloor", pos: [0, -2.6, 0],         rot: [24, 32] },
  { key: "deep",       label: "Seafloor glide",   pos: [0, -6.1, 0],          rot: [8, 28] },
];

export class CameraController {
  constructor(scene, engine, canvas) {
    const BJ = B();
    this.scene = scene;
    this.engine = engine;
    this.canvas = canvas;
    this.keys = Object.create(null);
    this.speed = 9;
    this.boost = 5.0;
    this.presetIndex = 0;
    this.followTarget = null;
    this.followOffset = new BJ.Vector3(0, 2.6, -9);
    this.seaLevel = 0;
    this.player = null;          // set to orbit a character
    this.mode = "free";          // free | third | first
    this.orbitDist = 3.4;
    this.eyeHeight = 1.62;

    const cam = new BJ.UniversalCamera("cam", new BJ.Vector3(0, 1.7, 0), scene);
    cam.minZ = 0.12;
    cam.maxZ = 300000;
    cam.fov = 62 * D;
    cam.inertia = 0.86;
    cam.angularSensibility = 1500;
    cam.speed = 0;                       // movement is handled here
    cam.keysUp = []; cam.keysDown = []; cam.keysLeft = []; cam.keysRight = [];
    cam.attachControl(canvas, true);
    if (cam.inputs) {
      // The overlay owns touch look/move; leaving Babylon's touch input on
      // would double-rotate.  Desktop keeps mouse.  Gamepad is polled here
      // so it can share the same analog stick + dt look path as the overlay.
      if (isMobileDevice() && cam.inputs.attached.touch) {
        cam.inputs.remove(cam.inputs.attached.touch);
      }
      if (cam.inputs.attached.gamepad) cam.inputs.remove(cam.inputs.attached.gamepad);
    }
    cam.rotation.set(2 * D, 30 * D, 0);
    this.camera = cam;
    scene.activeCamera = cam;

    this.touchStickX = 0;
    this.touchStickY = 0;
    this.touchLookX = 0;
    this.touchLookY = 0;
    this.riseHold = false;
    this.downHold = false;
    this.sprintHold = false;
    this.lookSens = 0.00215;
    this.padLook = 2.15;
    this._padX = 0;
    this._padY = 0;
    this._padLookX = 0;
    this._padLookY = 0;
    this._padRise = false;
    this._padDown = false;
    this._padSprint = false;
    this._padWas = Object.create(null);
    this.onPadAction = null;
    this._move = new BJ.Vector3();
    this._fwd = new BJ.Vector3();
    this._right = new BJ.Vector3();

    canvas.addEventListener("click", () => {
      if (document.body.classList.contains("touch-on")) return;
      if (!engine.isPointerLock) engine.enterPointerlock();
    });
    window.addEventListener("keydown", (e) => {
      if (isInteractiveTarget(e.target) || e.isComposing) {
        this.keys[e.code] = false;
        return;
      }
      this.keys[e.code] = true;
      if (["Space", "ControlLeft", "ControlRight", "ShiftLeft", "ShiftRight"].indexOf(e.code) >= 0) {
        e.preventDefault();
      }
    });
    window.addEventListener("keyup", (e) => { this.keys[e.code] = false; });
    window.addEventListener("blur", () => { this.keys = Object.create(null); });
  }

  applyPreset(i, hooks) {
    const BJ = B();
    const p = CAMERA_PRESETS[((i % CAMERA_PRESETS.length) + CAMERA_PRESETS.length) % CAMERA_PRESETS.length];
    this.presetIndex = CAMERA_PRESETS.indexOf(p);
    if (p.follow) {
      this.followTarget = hooks && hooks.get ? hooks.get(p.follow) : null;
    } else {
      this.followTarget = null;
      this.camera.position.set(p.pos[0], p.pos[1], p.pos[2]);
      this.camera.rotation.set((p.rot ? p.rot[0] : 0) * D, (p.rot ? p.rot[1] : 0) * D, 0);
      if (p.lookSun && hooks && typeof hooks.sunYaw === "number") {
        this.camera.rotation.y = hooks.sunYaw;
      }
    }
    if (p.weather && hooks && hooks.weather) hooks.weather(p.weather);
    return p;
  }
  cyclePreset(hooks) { return this.applyPreset(this.presetIndex + 1, hooks); }

  update(dt, ocean) {
    const BJ = B();
    const cam = this.camera;
    const k = this.keys;

    // ---- character camera -------------------------------------------------
    if (this.player && this.mode !== "free") {
      const pp = this.player.position;
      const head = this._head || (this._head = new BJ.Vector3());
      head.set(pp.x, pp.y + this.eyeHeight * (1 - this.player.swimAmount * 0.55), pp.z);
      const dir = cam.getDirection(BJ.Axis.Z);
      if (this.mode === "first") {
        cam.position.copyFrom(head).addInPlace(dir.scale(0.12));
      } else {
        // Orbit: the look direction IS the mouse, and the rig hangs off it, so
        // the framing never lags behind a moving character.
        const d = this.orbitDist * (1 + this.player.swimAmount * 0.25);
        cam.position.set(head.x - dir.x * d, head.y - dir.y * d + 0.35, head.z - dir.z * d);
        if (ocean && ocean.shoreline) {
          const bed = ocean.shoreline.sample(cam.position.x, cam.position.z);
          if (cam.position.y < bed + 0.45) cam.position.y = bed + 0.45;
        }
      }
      return;
    }

    if (this.followTarget) {
      const t = this.followTarget;
      const m = BJ.Matrix.Identity();
      (t.rotationQuaternion || BJ.Quaternion.Identity()).toRotationMatrix(m);
      const off = BJ.Vector3.TransformCoordinates(this.followOffset, m).addInPlace(t.position);
      // Do NOT smooth the POSITION.  Exponential smoothing settles exactly v/k
      // behind a moving target, so the framing silently changes with speed and
      // a fast boat shrinks to a speck.  Snap the position to the rig and ease
      // the ORIENTATION instead: the trailing feel survives, the lag does not.
      cam.position.copyFrom(off);
      const aim = t.position.subtract(cam.position);
      const len = aim.length();
      if (len > 1e-3) {
        aim.scaleInPlace(1 / len);
        const wantYaw = Math.atan2(aim.x, aim.z);
        const wantPitch = -Math.asin(Math.max(-1, Math.min(1, aim.y)));
        let dy = wantYaw - cam.rotation.y;
        while (dy > Math.PI) dy -= 2 * Math.PI;
        while (dy < -Math.PI) dy += 2 * Math.PI;
        const k = 1 - Math.exp(-dt * 7);
        cam.rotation.y += dy * k;
        cam.rotation.x += (wantPitch - cam.rotation.x) * k;
        cam.rotation.z = 0;
      }
      return;
    }

    const under = cam.position.y < this.seaLevel;
    let sp = this.speed * (under ? 0.55 : 1);
    sp *= 1 + Math.max(0, cam.position.y) * 0.035;
    if (under) sp *= 1 + Math.min(90, Math.max(0, this.seaLevel - cam.position.y)) * 0.045;
    this._pollGamepad();
    if (k.ShiftLeft || k.ShiftRight || this.sprintHold || this._padSprint) sp *= this.boost;

    const lookX = this.touchLookX;
    const lookY = this.touchLookY;
    this.touchLookX = 0;
    this.touchLookY = 0;
    if (lookX || lookY || this._padLookX || this._padLookY) {
      cam.rotation.y += lookX * this.lookSens + this._padLookX * this.padLook * dt;
      cam.rotation.x += lookY * this.lookSens + this._padLookY * this.padLook * dt;
      const lim = Math.PI * 0.49;
      if (cam.rotation.x > lim) cam.rotation.x = lim;
      if (cam.rotation.x < -lim) cam.rotation.x = -lim;
    }

    const wm = cam.getWorldMatrix();
    BJ.Vector3.TransformNormalToRef(BJ.Axis.Z, wm, this._fwd);
    BJ.Vector3.TransformNormalToRef(BJ.Axis.X, wm, this._right);
    this._fwd.normalize();
    this._right.normalize();
    const move = this._move;
    move.set(0, 0, 0);
    let sx = this.touchStickX + this._padX;
    let sy = this.touchStickY + this._padY;
    if (k.KeyW) sy += 1;
    if (k.KeyS) sy -= 1;
    if (k.KeyD) sx += 1;
    if (k.KeyA) sx -= 1;
    const sl = Math.hypot(sx, sy);
    if (sl > 1) { sx /= sl; sy /= sl; }
    move.x += this._fwd.x * sy + this._right.x * sx;
    move.y += this._fwd.y * sy + this._right.y * sx;
    move.z += this._fwd.z * sy + this._right.z * sx;
    if (k.Space || this.riseHold || this._padRise) move.y += 1;
    if (k.ControlLeft || k.ControlRight || this.downHold || this._padDown) move.y -= 1;
    if (move.lengthSquared() > 0) {
      const ml = move.length();
      if (ml > 1) move.scaleInPlace(1 / ml);
      move.scaleInPlace(sp * dt);
      cam.position.addInPlace(move);
    }
    if (under && !k.Space && !k.ControlLeft && !k.ControlRight && !this.riseHold && !this.downHold && !this._padRise && !this._padDown) {
      // Only bob in the top metre -- a constant 0.18 m/s rise surfaces a
      // dive in seconds and is why underwater views kept collapsing to
      // god-rays-in-a-void just under the waves.
      const sub = this.seaLevel - cam.position.y;
      if (sub < 1.2) cam.position.y += dt * 0.18;
    }

    // never walk through the sea bed
    if (ocean && ocean.shoreline) {
      const bed = ocean.shoreline.sample(cam.position.x, cam.position.z);
      if (cam.position.y < bed + 0.6) cam.position.y = bed + 0.6;
    } else if (ocean && ocean.seafloor && ocean.seafloor.enabled) {
      const bed = ocean.seaLevel - ocean.seafloor.depth + 0.85;
      if (cam.position.y < bed) cam.position.y = bed;
    }
  }

  _pollGamepad() {
    this._padX = 0;
    this._padY = 0;
    this._padLookX = 0;
    this._padLookY = 0;
    this._padRise = false;
    this._padDown = false;
    this._padSprint = false;
    if (typeof navigator === "undefined" || !navigator.getGamepads) return;
    const pads = navigator.getGamepads();
    let pad = null;
    for (let i = 0; i < pads.length; i++) if (pads[i]) { pad = pads[i]; break; }
    if (!pad) return;
    const dead = (v) => {
      const a = Math.abs(v);
      if (a < 0.18) return 0;
      return Math.sign(v) * (a - 0.18) / 0.82;
    };
    const ax = pad.axes || [];
    this._padX = dead(ax[0] || 0);
    this._padY = -dead(ax[1] || 0);
    this._padLookX = dead(ax[2] || 0);
    this._padLookY = dead(ax[3] || 0);
    const b = pad.buttons || [];
    this._padRise = !!(b[0] && b[0].pressed);
    this._padDown = !!(b[1] && b[1].pressed);
    this._padSprint = !!((b[7] && (b[7].pressed || b[7].value > 0.45))
      || (b[10] && b[10].pressed)
      || (b[6] && b[6].value > 0.45));
    const edge = (i) => !!(b[i] && b[i].pressed);
    if (this.onPadAction) {
      if (edge(2) && !this._padWas[2]) this.onPadAction("view");
      if (edge(3) && !this._padWas[3]) this.onPadAction("dive");
      if (edge(9) && !this._padWas[9]) this.onPadAction("panel");
    }
    this._padWas[2] = edge(2);
    this._padWas[3] = edge(3);
    this._padWas[9] = edge(9);
  }
}
