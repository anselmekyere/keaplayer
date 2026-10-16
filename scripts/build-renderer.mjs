// Assemble l'interface : app.js (avec JASSUB/libass) et le worker de rendu
// des sous-titres ASS, puis copie les fichiers statiques et WebAssembly.
import { build } from "esbuild";
import { cpSync, mkdirSync } from "node:fs";

const out = "dist/renderer/renderer";
mkdirSync(`${out}/jassub`, { recursive: true });

const common = { bundle: true, format: "esm", target: "chrome130", sourcemap: true, logLevel: "warning" };
await build({ ...common, entryPoints: ["src/renderer/app.ts"], outfile: `${out}/app.js` });
// Worker libass : chargé par JASSUB via workerUrl, il récupère le .wasm via wasmUrl.
await build({ ...common, entryPoints: ["node_modules/jassub/dist/worker/worker.js"], outfile: `${out}/jassub/worker.js` });

for (const f of ["jassub-worker.wasm", "jassub-worker-modern.wasm"]) {
  cpSync(`node_modules/jassub/dist/wasm/${f}`, `${out}/jassub/${f}`);
}
cpSync("node_modules/jassub/dist/default.woff2", `${out}/jassub/default.woff2`);
for (const f of ["index.html", "styles.css"]) cpSync(`src/renderer/${f}`, `${out}/${f}`);
