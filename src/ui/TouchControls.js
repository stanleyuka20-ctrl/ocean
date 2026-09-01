// ---------------------------------------------------------------------------
//  TouchControls.js -- on-screen fly controls for phones and tablets.
//
//  This project has no character, jump animation, crouch pose, interact
//  prompt or attack.  The buttons map onto the fly camera that already
//  exists: stick = WASD, right-drag = look, Rise/Down = Space/Ctrl,
//  Sprint = Shift, Dive = U, View = C, Menu = H.
// ---------------------------------------------------------------------------

import { isMobileDevice } from "../core/quality.js";

export { isMobileDevice };

export class TouchControls {
  constructor(app) {
    this.app = app;
    this.ctrl = app.camera;
    this.uni = app.camera.camera;
    this.root = document.getElementById("touch");
    this.joy = document.getElementById("touchJoy");
    this.knob = document.getElementById("touchKnob");
    this.hint = document.getElementById("rotateHint");
    this.visible = false;
    this._joyPtr = -1;
    this._lookPtr = -1;
    this._joyOrigin = { x: 0, y: 0 };
    this._lookLast = { x: 0, y: 0 };
    this._lastTouch = 0;
    this._radius = 56;
    this._onAction = null;
    this._mouseInput = null;
    const params = new URLSearchParams(location.search);
    this.forceOn = params.get("touch") === "1";
    this.forceOff = params.get("touch") === "0";

    this.ctrl.touchStickX = 0;
    this.ctrl.touchStickY = 0;
    this.ctrl.touchLookX = 0;
    this.ctrl.touchLookY = 0;
    this.ctrl.riseHold = false;
    this.ctrl.downHold = false;
    this.ctrl.sprintHold = false;

    if (!this.root) return;
    this._bind();
    if (this.forceOff) this.hide();
    else if (this.forceOn || isMobileDevice()) this.show();
    else this.hide();
  }

  onAction(fn) { this._onAction = fn; return this; }

  show() {
    if (!this.root || this.forceOff) return;
    this.visible = true;
    this.root.classList.remove("hidden");
    this.root.setAttribute("aria-hidden", "false");
    document.body.classList.add("touch-on");
    this._detachMouse();
    this._syncHint();
    this.updateDiveState();
  }

  hide() {
    if (!this.root) return;
    if (this.forceOn && this.visible) return;
    this.visible = false;
    this.root.classList.add("hidden");
    this.root.setAttribute("aria-hidden", "true");
    document.body.classList.remove("touch-on");
    this._releaseAllInputs();
    if (this.hint) this.hint.classList.add("hidden");
    this._attachMouse();
  }

  _syncHint() {
    if (!this.hint) return;
    const portrait = window.matchMedia && window.matchMedia("(orientation: portrait)").matches;
    this.hint.classList.toggle("hidden", !this.visible || !portrait);
  }

  _resetStick() {
    this.ctrl.touchStickX = 0;
    this.ctrl.touchStickY = 0;
    if (this.knob) this.knob.style.transform = "translate(-50%,-50%)";
  }

  _releaseAllInputs() {
    this._resetStick();
    this._joyPtr = -1;
    this._lookPtr = -1;
    this.ctrl.touchLookX = 0;
    this.ctrl.touchLookY = 0;
    this.ctrl.riseHold = false;
    this.ctrl.downHold = false;
    this.ctrl.sprintHold = false;
    if (this.root) this.root.querySelectorAll(".touch-btn.on").forEach((b) => b.classList.remove("on"));
  }

  updateDiveState() {
    if (!this.root || !this.app.ocean) return;
    const button = this.root.querySelector('[data-act="dive"]');
    if (!button) return;
    const c = this.ctrl.camera.position;
    const h = this.app.ocean.getHeight(c.x, c.z);
    const underwater = c.y < h;
    const label = button.querySelector("[data-label]");
    if (label) label.textContent = underwater ? "Surface" : "Dive";
    const icon = button.querySelector("span:first-child");
    if (icon) icon.textContent = underwater ? "↑" : "↓";
    button.setAttribute("aria-label", underwater ? "Return above the surface" : "Dive below the surface");
  }

  _detachMouse() {
    const inputs = this.uni && this.uni.inputs;
    if (!inputs || !inputs.attached) return;
    if (inputs.attached.mouse) {
      this._mouseInput = inputs.attached.mouse;
      inputs.remove(this._mouseInput);
    }
    if (inputs.attached.touch) {
      this._touchInput = inputs.attached.touch;
      inputs.remove(this._touchInput);
    }
  }

  _attachMouse() {
    const inputs = this.uni && this.uni.inputs;
    if (!inputs) return;
    if (this._mouseInput && !inputs.attached.mouse) inputs.add(this._mouseInput);
    if (this._touchInput && !inputs.attached.touch) inputs.add(this._touchInput);
    this._mouseInput = null;
    this._touchInput = null;
  }

  _bind() {
    const cam = this.ctrl;
    const joy = this.joy;
    const canvas = this.app.canvas;
    const btns = this.root.querySelectorAll("[data-act]");

    const prevent = (e) => { e.preventDefault(); };

    this.root.addEventListener("touchmove", prevent, { passive: false });
    canvas.addEventListener("touchmove", prevent, { passive: false });
    canvas.addEventListener("wheel", prevent, { passive: false });
    canvas.addEventListener("gesturestart", prevent, { passive: false });
    document.addEventListener("contextmenu", (e) => {
      if (this.visible) e.preventDefault();
    });

    const setHold = (act, on) => {
      if (act === "rise") cam.riseHold = on;
      if (act === "down") cam.downHold = on;
      if (act === "sprint") cam.sprintHold = on;
    };

    btns.forEach((el) => {
      const act = el.getAttribute("data-act");
      const discrete = act === "dive" || act === "view" || act === "panel";
      const down = (e) => {
        this._noteTouch();
        this.show();
        if (!discrete) e.preventDefault();
        e.stopPropagation();
        el.classList.add("on");
        try { el.setPointerCapture(e.pointerId); } catch (err) { /* ok */ }
        setHold(act, true);
      };
      const up = (e) => {
        if (!discrete) e.preventDefault();
        e.stopPropagation();
        el.classList.remove("on");
        setHold(act, false);
      };
      el.addEventListener("pointerdown", down);
      el.addEventListener("pointerup", up);
      el.addEventListener("pointercancel", up);
      el.addEventListener("lostpointercapture", up);
      el.addEventListener("keydown", (e) => {
        if (discrete || (e.code !== "Space" && e.code !== "Enter")) return;
        e.preventDefault();
        el.classList.add("on");
        setHold(act, true);
      });
      el.addEventListener("keyup", (e) => {
        if (discrete || (e.code !== "Space" && e.code !== "Enter")) return;
        el.classList.remove("on");
        setHold(act, false);
      });
      if (discrete) {
        el.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          this._noteTouch();
          this.show();
          if (this._onAction) this._onAction(act);
          this.updateDiveState();
        });
      }
    });

    const joyDown = (e) => {
      if (this._joyPtr !== -1) return;
      this._noteTouch();
      this.show();
      e.preventDefault();
      this._joyPtr = e.pointerId;
      const r = joy.getBoundingClientRect();
      this._joyOrigin.x = r.left + r.width * 0.5;
      this._joyOrigin.y = r.top + r.height * 0.5;
      this._radius = Math.min(r.width, r.height) * 0.38;
      try { joy.setPointerCapture(e.pointerId); } catch (err) { /* ok */ }
      this._joyMove(e);
    };
    const joyMove = (e) => {
      if (e.pointerId !== this._joyPtr) return;
      e.preventDefault();
      this._joyMove(e);
    };
    const joyUp = (e) => {
      if (e.pointerId !== this._joyPtr) return;
      this._joyPtr = -1;
      this._resetStick();
    };
    joy.addEventListener("pointerdown", joyDown);
    joy.addEventListener("pointermove", joyMove);
    joy.addEventListener("pointerup", joyUp);
    joy.addEventListener("pointercancel", joyUp);
    joy.addEventListener("lostpointercapture", joyUp);

    const lookDown = (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      if (e.target.closest && e.target.closest("#touch, #panel, #help, #boot")) return;
      if (this._lookPtr !== -1) return;
      if (e.pointerType === "mouse" && !this.visible) return;
      this._noteTouch();
      if (e.pointerType !== "mouse") this.show();
      this._lookPtr = e.pointerId;
      this._lookLast.x = e.clientX;
      this._lookLast.y = e.clientY;
      try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ok */ }
    };
    const lookMove = (e) => {
      if (e.pointerId === this._joyPtr) {
        e.preventDefault();
        this._joyMove(e);
        return;
      }
      if (e.pointerId !== this._lookPtr) return;
      e.preventDefault();
      cam.touchLookX += e.clientX - this._lookLast.x;
      cam.touchLookY += e.clientY - this._lookLast.y;
      this._lookLast.x = e.clientX;
      this._lookLast.y = e.clientY;
    };
    const lookUp = (e) => {
      if (e.pointerId === this._joyPtr) {
        this._joyPtr = -1;
        this._resetStick();
      }
      if (e.pointerId === this._lookPtr) this._lookPtr = -1;
    };
    canvas.addEventListener("pointerdown", lookDown);
    window.addEventListener("pointermove", lookMove, { passive: false });
    window.addEventListener("pointerup", lookUp);
    window.addEventListener("pointercancel", lookUp);
    canvas.addEventListener("lostpointercapture", lookUp);

    window.addEventListener("keydown", () => {
      if (this.forceOn) return;
      if (Date.now() - this._lastTouch > 600) this.hide();
    });
    window.addEventListener("mousemove", (e) => {
      if (this.forceOn) return;
      if (this._lookPtr !== -1 || this._joyPtr !== -1) return;
      if (e.movementX === 0 && e.movementY === 0) return;
      if (Date.now() - this._lastTouch > 800) this.hide();
    });
    const reset = () => this._releaseAllInputs();
    window.addEventListener("blur", reset);
    window.addEventListener("pagehide", reset);
    document.addEventListener("visibilitychange", () => { if (document.hidden) reset(); });
    window.addEventListener("orientationchange", () => { reset(); this._syncHint(); });
    window.addEventListener("resize", () => { reset(); this._syncHint(); });
  }

  _noteTouch() { this._lastTouch = Date.now(); }

  _joyMove(e) {
    const dx = e.clientX - this._joyOrigin.x;
    const dy = e.clientY - this._joyOrigin.y;
    const len = Math.hypot(dx, dy);
    const max = this._radius;
    const k = len > max && len > 1e-6 ? max / len : 1;
    const ox = dx * k, oy = dy * k;
    if (this.knob) {
      this.knob.style.transform = `translate(calc(-50% + ${ox}px), calc(-50% + ${oy}px))`;
    }
    let nx = (ox / max);
    let ny = -(oy / max);
    const mag = Math.hypot(nx, ny);
    const dead = 0.12;
    if (mag < dead) { nx = 0; ny = 0; }
    else {
      const t = (mag - dead) / (1 - dead);
      nx = (nx / mag) * Math.min(1, t);
      ny = (ny / mag) * Math.min(1, t);
    }
    this.ctrl.touchStickX = nx;
    this.ctrl.touchStickY = ny;
  }
}
