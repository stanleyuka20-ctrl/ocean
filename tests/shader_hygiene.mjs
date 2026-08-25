// ---------------------------------------------------------------------------
//  shader_hygiene.mjs -- source-level guards for two traps that only ever show
//  up on WebGPU, and only as a rendering artefact.
//
//    node tests/shader_hygiene.mjs
//
//  1. No early `return` in a shader entry point.  Babylon assigns the WGSL
//     output struct AFTER the user body when it transpiles, so a return in the
//     middle skips it: a vertex leaves with an uninitialised clip position and
//     the whole draw rasterises as huge garbage quads, while every count reads
//     zero.  WebGL2 does exactly what the code says, so this is invisible until
//     someone runs the other backend.
//  2. No backtick inside a GLSL comment.  These shaders are JS template
//     literals; a backtick ends the literal and the page dies with a syntax
//     error pointing at the next English word.
// ---------------------------------------------------------------------------
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIRS = ["src/shaders"];
let fails = 0;
const files = [];
for (const d of DIRS) for (const f of readdirSync(d)) if (f.endsWith(".js")) files.push(join(d, f));

for (const path of files) {
  const src = readFileSync(path, "utf8");
  const lines = src.split("\n");

  // --- backticks inside // comments ---------------------------------------
  lines.forEach((line, i) => {
    const c = line.indexOf("//");
    if (c >= 0 && line.slice(c).includes("`")) {
      console.log(`FAIL  ${path}:${i + 1}  backtick inside a GLSL comment ends the template literal`);
      fails++;
    }
  });

  // --- semicolon in a trailing comment on a uniform line -------------------
  // Babylon's shader processor splits uniform declarations on ";" so it can
  // emit one uniform per declaration, and it does not respect comment
  // boundaries: everything after a second ";" on the line is handed to the
  // compiler as code.  `uniform float uKeepCeil;  // ceiling; 0.97 here` cost a
  // shader with "ERROR: 0:54: syntax error, unexpected FLOATCONSTANT", and
  // Babylon surfaces that to the page only as "GLSL compilation failed" with
  // the post-process silently absent -- which read as every mode in a
  // persistence matrix landing BELOW_MEASUREMENT_FLOOR.
  lines.forEach((line, i) => {
    if (!/^\s*(uniform|varying|attribute)\s/.test(line)) return;
    const c = line.indexOf("//");
    if (c >= 0 && line.slice(c).includes(";")) {
      console.log(`FAIL  ${path}:${i + 1}  semicolon inside the trailing comment `
        + `on a uniform line (Babylon splits declarations on ";")`);
      fails++;
    }
  });

  // --- early return inside void main() ------------------------------------
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*void\s+main\s*\(\s*\)\s*\{/.test(lines[i])) continue;
    let depth = 0, started = false;
    for (let j = i; j < lines.length; j++) {
      for (const ch of lines[j]) {
        if (ch === "{") { depth++; started = true; }
        else if (ch === "}") depth--;
      }
      if (started && j > i && /\breturn\s*;/.test(lines[j]) && depth > 0) {
        console.log(`FAIL  ${path}:${j + 1}  early return in a shader entry point `
          + `(WGSL output struct is assigned after the body)`);
        fails++;
      }
      if (started && depth <= 0) { i = j; break; }
    }
  }
}

console.log(fails === 0
  ? `PASS  ${files.length} shader files: no early returns, no backticks, no ";" in uniform comments`
  : `\n${fails} problem(s)`);
process.exit(fails === 0 ? 0 : 1);
