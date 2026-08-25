// ---------------------------------------------------------------------------
//  CameraController.js -- free camera with swim handling and the named
//  viewpoints the ocean has to hold up from.
// ---------------------------------------------------------------------------


const B = () => window.BABYLON;
const D = Math.PI / 180;

export const CAMERA_PRESETS = [
  { key: "waterline",  label: "Water level",      pos: [0, 1.7, 0],           rot: [2, 30] },
  { key: "horizon",    label: "Horizon",          pos: [0, 3.0, 0],           rot: [1, 96] },
  { key: "glitter",    label: "Glitter path",     pos: [0, 2.1, 0],           rot: [6, 0], lookSun: true },
  { key: "eyelevel",   label: "Open ocean",       pos: [2400, 2.4, -1800],    rot: [3, -152] },
  { key: "lowaerial",  label: "Low aerial",       pos: [-900, 24, 1200],      rot: [22, 64] },
  { key: "aerial",     label: "Aerial",           pos: [140, 120, -260],      rot: [34, -120] },
  { key: "highaerial", label: "High aerial",      pos: [300, 640, 900],       rot: [46, -178] },
  { key: "storm",      label: "Storm",            pos: [0, 8.0, 0],           rot: [8, 30],  weather: "storm" },
  { key: "sunset",     label: "Sunset",           pos: [0, 1.7, 0],           rot: [2, -100], weather: "sunset" },
  { key: "night",      label: "Night",            pos: [0, 1.7, 0],           rot: [2, 30],  weather: "night" },
  { key: "underwater", label: "Underwater",       pos: [0, -3.4, 0],          rot: [-20, -78] },
  { key: "reef",       label: "Coral reef",       xz: [-6, 38], above: 1.6, lookXZ: [12, 16], lookAbove: 0.9 },
  { key: "arch",       label: "Rock arch",        xz: [72, 20], above: 1.65, lookXZ: [72, 38], lookAbove: 3.4 },
  { key: "dropoff",    label: "Drop-off",         xz: [176, 8], y: -24,     lookXZ: [158, 8], lookAbove: 1.2 },
  { key: "vents",      label: "Bubble vents",     xz: [42, -13], above: 1.25, lookXZ: [44, -28], lookAbove: 4.2 },
  { key: "shafts",     label: "Sunlight cavern",  xz: [88, -95], above: 3.5, rot: [-58, 12] },
  { key: "canyon",     label: "Canyon",           xz: [292, -90], above: 4.5, lookXZ: [318, -78], lookAbove: 14 },
  { key: "d50",        label: "50 m",             xz: [175, 0], y: -50,     lookXZ: [160, 0], lookAbove: 2 },
  { key: "d100",       label: "100 m",            xz: [210, -20], y: -100,  lookXZ: [198, -8], lookAbove: 8 },
  { key: "d250",       label: "250 m",            xz: [250, -50], y: -250,  lookXZ: [268, -40], lookAbove: 12 },
  { key: "d500",       label: "500 m",            xz: [310, -90], y: -500,  lookXZ: [328, -78], lookAbove: 16 },
  { key: "d1000",      label: "1 km",             xz: [380, -150], y: -1000, lookXZ: [398, -138], lookAbove: 20 },
  { key: "d2000",      label: "2 km",             xz: [450, -210], y: -2000, lookXZ: [468, -198], lookAbove: 24 },
  { key: "d4000",      label: "4 km abyss",       xz: [510, -270], y: -3985, lookXZ: [528, -255], lookAbove: 18 },
  { key: "seafloor",   label: "Sandy bottom",     pos: [0, -2.6, 0],          rot: [24, 32] },
  { key: "deep",       label: "Along the sand",   pos: [0, -6.1, 0],          rot: [8, 28] },
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
    cam.rotation.set(2 * D, 30 * D, 0);
    this.camera = cam;
    scene.activeCamera = cam;

    canvas.addEventListener("click", () => {
      if (!engine.isPointerLock) engine.enterPointerlock();
    });
    window.addEventListener("keydown", (e) => {
      this.keys[e.code] = true;
      if (["Space", "ControlLeft", "ShiftLeft"].indexOf(e.code) >= 0) e.preventDefault();
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
      if (p.xz && hooks && hooks.bathyY) {
        const floor = hooks.bathyY(p.xz[0], p.xz[1]);
        let y = p.y !== undefined ? p.y : floor + (p.above || 2);
        if (y < floor + 0.75) y = floor + 0.75;
        this.camera.position.set(p.xz[0], y, p.xz[1]);
      } else {
        this.camera.position.set(p.pos[0], p.pos[1], p.pos[2]);
      }
      this.camera.rotation.set((p.rot ? p.rot[0] : 0) * D, (p.rot ? p.rot[1] : 0) * D, 0);
      if (p.lookXZ && hooks && hooks.bathyY) {
        const tx = p.lookXZ[0], tz = p.lookXZ[1];
        const ty = p.lookY !== undefined
          ? p.lookY
          : hooks.bathyY(tx, tz) + (p.lookAbove !== undefined ? p.lookAbove : 1.5);
        const dx = tx - this.camera.position.x;
        const dy = ty - this.camera.position.y;
        const dz = tz - this.camera.position.z;
        const len = Math.hypot(dx, dy, dz) || 1;
        this.camera.rotation.y = Math.atan2(dx, dz);
        this.camera.rotation.x = -Math.asin(Math.max(-1, Math.min(1, dy / len)));
        this.camera.rotation.z = 0;
      }
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
    if (k.ShiftLeft || k.ShiftRight) sp *= this.boost;

    const f = cam.getDirection(BJ.Axis.Z);
    const r = cam.getDirection(BJ.Axis.X);
    const move = new BJ.Vector3(0, 0, 0);
    if (k.KeyW) move.addInPlace(f);
    if (k.KeyS) move.subtractInPlace(f);
    if (k.KeyD) move.addInPlace(r);
    if (k.KeyA) move.subtractInPlace(r);
    if (k.Space) move.y += 1;
    if (k.ControlLeft || k.ControlRight) move.y -= 1;
    if (move.lengthSquared() > 0) {
      move.normalize().scaleInPlace(sp * dt);
      cam.position.addInPlace(move);
    }
    if (under && !k.Space && !k.ControlLeft) {
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
    } else if (ocean && ocean.world && ocean.world.sample) {
      const bed = ocean.world.sample(cam.position.x, cam.position.z) + 0.7;
      if (cam.position.y < bed) cam.position.y = bed;
      const ceil = ocean.world.terrain && ocean.world.terrain.ceiling
        ? ocean.world.terrain.ceiling(cam.position.x, cam.position.z) : null;
      if (ceil !== null && cam.position.y > ceil - 0.45 && cam.position.y < ceil + 6)
        cam.position.y = Math.min(cam.position.y, ceil - 0.45);
    } else if (ocean && ocean.seafloor && ocean.seafloor.enabled) {
      const bed = ocean.seaLevel - ocean.seafloor.depth + 0.85;
      if (cam.position.y < bed) cam.position.y = bed;
    }
  }
}
