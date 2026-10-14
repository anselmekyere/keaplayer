import { cpSync, mkdirSync } from "node:fs";

// Fichiers statiques de l'interface, servis avec le JavaScript compilé.
mkdirSync("dist/renderer/renderer", { recursive: true });
for (const f of ["index.html", "styles.css"]) {
  cpSync(`src/renderer/${f}`, `dist/renderer/renderer/${f}`);
}
