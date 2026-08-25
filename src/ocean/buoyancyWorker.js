// ---------------------------------------------------------------------------
//  buoyancyWorker.js -- runs the CPU ocean mirror off the main thread.
//  Three inverse FFTs per cascade per tick would cost ~8 ms on the render
//  thread; here it costs nothing the frame can feel.
// ---------------------------------------------------------------------------

import { CpuCascade } from "./oceanCpu.js";

let cascades = [];
let spare = null;

self.onmessage = (ev) => {
  const m = ev.data;
  switch (m.type) {
    case "init": {
      cascades = m.cascades.map(
        (c) => new CpuCascade(c.N, c.L, c.cutLow, c.cutHigh, m.params));
      self.postMessage({ type: "ready", sizes: cascades.map((c) => c.N) });
      break;
    }
    case "params": {
      for (const c of cascades) c.setParams(m.params);
      self.postMessage({ type: "ready", sizes: cascades.map((c) => c.N) });
      break;
    }
    case "tick": {
      if (!cascades.length) return;
      if (m.recycle) spare = m.recycle;
      let total = 0;
      for (const c of cascades) total += c.N * c.N * 6;
      let buf = spare && spare.length === total ? spare : new Float32Array(total);
      spare = null;
      let off = 0;
      for (const c of cascades) {
        const out = c.evolve(m.time);
        buf.set(out, off);
        off += out.length;
      }
      self.postMessage({ type: "grid", time: m.time, buf }, [buf.buffer]);
      break;
    }
  }
};
