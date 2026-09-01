import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.resolve(root, "dist");
if (path.dirname(dist) !== root || path.basename(dist) !== "dist") {
  throw new Error(`Refusing to replace unexpected build directory: ${dist}`);
}

fs.rmSync(dist, { recursive: true, force: true });
const client = path.join(dist, "client");
const server = path.join(dist, "server");
fs.mkdirSync(client, { recursive: true });
fs.mkdirSync(server, { recursive: true });

for (const entry of ["index.html", "styles.css", ".nojekyll", "assets", "src"]) {
  const source = path.join(root, entry);
  if (!fs.existsSync(source)) continue;
  fs.cpSync(source, path.join(client, entry), { recursive: true });
}

fs.writeFileSync(path.join(server, "index.js"), `export default {
  async fetch(request, env) {
    return env.ASSETS.fetch(request);
  },
};
`);

fs.writeFileSync(path.join(server, "wrangler.json"), JSON.stringify({
  name: "abyssal-ocean",
  main: "index.js",
  compatibility_date: "2026-05-15",
  compatibility_flags: ["nodejs_compat"],
  assets: {
    directory: "../client",
    binding: "ASSETS",
    html_handling: "auto-trailing-slash",
    not_found_handling: "404-page",
  },
  observability: { enabled: true },
  rules: [{ type: "ESModule", globs: ["**/*.js", "**/*.mjs"] }],
  no_bundle: true,
}, null, 2) + "\n");

const files = fs.readdirSync(client, { recursive: true }).length;
console.log(`Built Abyssal static worker: ${files} client entries`);
