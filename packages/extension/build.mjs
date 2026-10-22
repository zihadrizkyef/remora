// Build script: bundle TS with esbuild into dist/ loadable via "Load unpacked".
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, "dist");

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const shared = {
  bundle: true,
  format: "esm",
  target: "es2022",
  sourcemap: false,
  minify: false,
};

await build({ ...shared, entryPoints: [join(root, "src/background.ts")], outfile: join(dist, "background.js") });
await build({ ...shared, entryPoints: [join(root, "src/content.ts")], outfile: join(dist, "content.js") });
await build({ ...shared, entryPoints: [join(root, "src/popup.ts")], outfile: join(dist, "popup.js") });

cpSync(join(root, "manifest.json"), join(dist, "manifest.json"));
cpSync(join(root, "src/popup.html"), join(dist, "popup.html"));
cpSync(join(root, "src/popup.css"), join(dist, "popup.css"));
if (existsSync(join(root, "icons"))) {
  cpSync(join(root, "icons"), join(dist, "icons"), { recursive: true });
} else {
  console.warn("[remora build] icons/ missing — create icons before loading unpacked");
}

console.log("[remora build] dist/ ready");
