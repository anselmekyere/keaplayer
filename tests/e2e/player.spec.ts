import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const media = (name: string) => path.resolve("tests/fixtures/media", name);
let home: string;

test.beforeEach(() => {
  // Profil isolé : positions de reprise et captures dans un dossier jetable.
  home = mkdtempSync(path.join(tmpdir(), "keaplayer-e2e-"));
});
test.afterEach(() => rmSync(home, { recursive: true, force: true }));

async function launch(...files: string[]): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [".", ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []), ...files],
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config") },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  // Coupe le son pour ne pas dépendre d'une carte audio.
  await page.evaluate(() => ((document.getElementById("video") as HTMLVideoElement).muted = true));
  return { app, page };
}

/** Position affichée (en secondes), lue dans l'horloge de l'interface. */
async function shownTime(page: Page): Promise<number> {
  const text = (await page.locator("#time").textContent()) ?? "0:00";
  return text.split(":").reduce((acc, part) => acc * 60 + Number(part), 0);
}

async function expectPlaying(page: Page) {
  const t0 = await page.evaluate(() => (document.getElementById("video") as HTMLVideoElement).currentTime);
  await expect
    .poll(() => page.evaluate(() => (document.getElementById("video") as HTMLVideoElement).currentTime), { timeout: 15_000 })
    .toBeGreaterThan(t0 + 1);
}

test("MP4 H.264/AAC : lecture native, recherche, vitesse, capture et reprise", async () => {
  let { app, page } = await launch(media("native.mp4"));
  await expect(page.locator("#mode")).toHaveText("natif");
  await expect(page.locator("#title")).toHaveText("native.mp4");
  await expectPlaying(page);

  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => shownTime(page)).toBeGreaterThanOrEqual(30);

  await page.keyboard.press("]");
  expect(await page.evaluate(() => (document.getElementById("video") as HTMLVideoElement).playbackRate)).toBe(1.25);
  await page.keyboard.press("=");

  await page.keyboard.press("Shift+S");
  await expect(page.locator("#osd")).toContainText("Capture enregistrée");
  const pictures = await app.evaluate(({ app: electronApp }) => electronApp.getPath("pictures"));
  expect(pictures.startsWith(home)).toBe(true);
  const shots = path.join(pictures, "KEAPlayer");
  expect(readdirSync(shots).filter((f) => f.endsWith(".png"))).toHaveLength(1);

  // Pause puis fermeture : la position est mémorisée et reprise au prochain lancement.
  await page.keyboard.press(" ");
  const pausedAt = await shownTime(page);
  await app.close();

  ({ app, page } = await launch(media("native.mp4")));
  await expect(page.locator("#osd")).toContainText("Reprise à");
  await expect.poll(() => shownTime(page)).toBeGreaterThanOrEqual(pausedAt);
  await app.close();
});

test("MKV multipiste : remux, sous-titres externes et intégrés, changement de piste audio et décalages", async () => {
  const { app, page } = await launch(media("multi.mkv"));
  await expect(page.locator("#mode")).toHaveText("remux");
  await expectPlaying(page);

  // Le fichier multi.fr.srt voisin est activé d'office.
  const cueText = () =>
    page.evaluate(() => {
      const track = (document.getElementById("video") as HTMLVideoElement).textTracks[0];
      return Array.from(track.cues ?? []).map((c) => (c as VTTCue).text).join("|");
    });
  await expect.poll(cueText).toBe("Sous-titre externe");

  await page.locator("#tracks-toggle").click();
  await expect(page.locator("#audio-track option")).toHaveCount(2);
  await page.locator("#subtitle-track").selectOption("emb-0");
  await expect.poll(cueText).toBe("Sous-titre intégré");

  // Piste audio anglaise (AC-3) : le flux est relancé à la position courante.
  const before = await shownTime(page);
  await page.locator("#audio-track").selectOption("1");
  await expect(page.locator("#mode")).toHaveText("remux");
  await expectPlaying(page);
  expect(await shownTime(page)).toBeGreaterThanOrEqual(before);

  await page.keyboard.press("k");
  await expect(page.locator("#audio-delay")).toHaveText("50 ms");
  await page.keyboard.press("h");
  await page.keyboard.press("h");
  await expect(page.locator("#sub-delay")).toHaveText("100 ms");
  await expectPlaying(page);
  await app.close();
});

test("AVI MPEG-4 : transcodage et recherche par relance de FFmpeg", async () => {
  const { app, page } = await launch(media("legacy.avi"));
  await expect(page.locator("#mode")).toHaveText("transcode");
  await expectPlaying(page);
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => shownTime(page), { timeout: 20_000 }).toBeGreaterThanOrEqual(20);
  await expectPlaying(page);
  await expect(page.locator("#duration")).toHaveText("0:40");
  await app.close();
});

test("liste de lecture : plusieurs fichiers, suivant/précédent, MP3 seul", async () => {
  const { app, page } = await launch(media("music.mp3"), media("native.mp4"));
  await expect(page.locator("#playlist-items li")).toHaveCount(2);
  await expect(page.locator("#title")).toHaveText("music.mp3");
  await expect(page.locator("#mode")).toHaveText("natif");
  await expectPlaying(page);

  await page.keyboard.press("n");
  await expect(page.locator("#title")).toHaveText("native.mp4");
  await expect(page.locator("#playlist-items li.current")).toHaveText(/native\.mp4/);
  await page.keyboard.press("p");
  await expect(page.locator("#title")).toHaveText("music.mp3");
  await app.close();
});

test("fichier illisible : message d'erreur, l'application reste utilisable", async () => {
  const bad = path.join(home, "faux.mp4");
  writeFileSync(bad, "pas une vidéo");
  const { app, page } = await launch(bad);
  await expect(page.locator("#osd")).toContainText(/illisible|Aucun module/);
  expect(existsSync(bad)).toBe(true);
  await app.close();
});

test("MPEG-TS (enregistrement TNT) : analyse et lecture", async () => {
  const { app, page } = await launch(media("recording.ts"));
  await expect(page.locator("#mode")).toHaveText("transcode");
  await expectPlaying(page);
  await expect(page.locator("#duration")).toHaveText("0:20");
  await app.close();
});

test("HEVC : moteur choisi selon ce que la machine décode, transcodage réactif", async () => {
  const { app, page } = await launch(media("hevc.mp4"));
  const hevcNative = await page.evaluate(async () =>
    (await navigator.mediaCapabilities.decodingInfo({
      type: "file",
      video: { contentType: 'video/mp4; codecs="hvc1.1.6.L120.90"', width: 1920, height: 1080, bitrate: 8e6, framerate: 30 },
    })).supported);
  await expect(page.locator("#mode")).toHaveText(hevcNative ? "natif" : "transcode");
  await expectPlaying(page);
  // Recherche : le flux relancé doit reprendre en quelques secondes au plus.
  const started = Date.now();
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => shownTime(page), { timeout: 8_000 }).toBeGreaterThanOrEqual(10);
  await expectPlaying(page);
  expect(Date.now() - started).toBeLessThan(8_000);
  await app.close();
});

test("vidéo entrelacée : désentrelacée par FFmpeg plutôt que lue en natif", async () => {
  const { app, page } = await launch(media("interlaced.ts"));
  await expect(page.locator("#mode")).toHaveText("transcode");
  await expectPlaying(page);
  await app.close();
});

test("son : volume jusqu'à 200 %, égaliseur, normalisation, réglages conservés", async () => {
  let { app, page } = await launch(media("native.mp4"));
  await expectPlaying(page);
  const audio = () => page.evaluate(() => (window as unknown as { __keaplayerAudio: () => Record<string, unknown> }).__keaplayerAudio());

  for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowUp");
  await expect(page.locator("#osd")).toHaveText("Volume : 130 %");
  expect(await audio()).toMatchObject({ volume: 1.3, boost: 1.3, active: true });

  await page.locator("#tracks-toggle").click();
  await page.locator("#eq-preset").selectOption("rock");
  await page.locator("#normalize").check();
  expect(await audio()).toMatchObject({ preset: "rock", normalize: true, bands: [8, 4.8, -5.6, -8, -3.2, 4, 8.8, 11.2, 11.2, 11.2] });
  await expectPlaying(page);
  await app.close();

  ({ app, page } = await launch(media("native.mp4")));
  await expectPlaying(page);
  expect(await audio()).toMatchObject({ volume: 1.3, preset: "rock", normalize: true });
  await expect(page.locator("#eq-preset")).toHaveValue("rock");
  await app.close();
});

test("barre de menus : menus de VLC, pistes du fichier, commandes et panneaux", async () => {
  const { app, page } = await launch(media("multi.mkv"));
  await expect(page.locator("#mode")).toHaveText("remux");
  await expectPlaying(page);

  const labels = await app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.items.map((i) => i.label.replace("&", "")));
  expect(labels).toEqual(["Média", "Lecture", "Audio", "Vidéo", "Sous-titres", "Affichage", "Aide"]);

  // Clic réel sur une entrée du menu natif.
  const clickMenu = (path: string[]) =>
    app.evaluate(({ Menu, BrowserWindow }, path) => {
      let items = Menu.getApplicationMenu()!.items;
      let item;
      for (const label of path) {
        item = items.find((i) => i.label.replace("&", "") === label);
        if (!item) throw new Error(`Entrée introuvable : ${path.join(" > ")}`);
        items = item.submenu?.items ?? [];
      }
      item!.click(undefined, BrowserWindow.getAllWindows()[0], undefined as never);
    }, path);

  // Les pistes du fichier apparaissent dans le menu Audio.
  await expect
    .poll(() => app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.items[2].submenu!.items[0].submenu!.items.map((i) => i.label)))
    .toEqual(["fre · aac", "VO · eng · ac3"]);
  await clickMenu(["Audio", "Piste audio", "VO · eng · ac3"]);
  await expect(page.locator("#audio-track")).toHaveValue("1");
  await expectPlaying(page);
  await expect
    .poll(() => app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.items[2].submenu!.items[0].submenu!.items[1].checked))
    .toBe(true);

  await clickMenu(["Affichage", "Liste de lecture"]);
  await expect(page.locator("#playlist")).toBeVisible();
  await clickMenu(["Sous-titres", "Piste de sous-titres", "Désactivés"]);
  await expect(page.locator("#subtitle-track")).toHaveValue("");
  await clickMenu(["Lecture", "Vitesse", "1,5×"]);
  expect(await page.evaluate(() => (document.getElementById("video") as HTMLVideoElement).playbackRate)).toBe(1.5);
  await app.close();
});

test("plein écran de la fenêtre (F, menu, Échap) et navigation entre zones (F6)", async () => {
  const { app, page } = await launch(media("native.mp4"), media("music.mp3"));
  await expectPlaying(page);
  const isFullscreen = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen());

  await page.keyboard.press("f");
  await expect.poll(isFullscreen).toBe(true);
  await expect(page.locator("body")).toHaveClass(/fullscreen/);
  await page.keyboard.press("Escape");
  await expect.poll(isFullscreen).toBe(false);
  await expect(page.locator("body")).not.toHaveClass(/fullscreen/);

  // F6 : commandes → liste de lecture (élément en cours) → commandes.
  await expect(page.locator("#playlist")).toBeVisible();
  await page.keyboard.press("F6");
  expect(await page.evaluate(() => document.getElementById("controls")!.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("F6");
  await expect(page.locator("#playlist-items li.current")).toBeFocused();
  // Dans la liste : flèche bas puis Entrée lit l'élément suivant.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.locator("#title")).toHaveText("music.mp3");
  await page.keyboard.press("Shift+F6");
  expect(await page.evaluate(() => document.getElementById("controls")!.contains(document.activeElement))).toBe(true);
  await app.close();
});

/** Compte les pixels d'une zone de la fenêtre qui satisfont `match` (capture réelle, canvas compris). */
async function countPixels(
  app: ElectronApplication,
  rect: { x: number; y: number; width: number; height: number },
  color: "red" | "green",
): Promise<number> {
  const r = { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
  const bgra = await app.evaluate(async ({ BrowserWindow }, area) => {
    const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage(area);
    return Array.from(image.resize({ width: area.width, height: area.height }).toBitmap());
  }, r);
  let n = 0;
  for (let i = 0; i < bgra.length; i += 4) {
    const [b, g, red] = [bgra[i], bgra[i + 1], bgra[i + 2]];
    if (color === "red" ? red > 200 && g < 50 && b < 50 : g > 200 && red < 60 && b < 60) n++;
  }
  return n;
}

/** Zone de l'image vidéo correspondant à un rectangle du script ASS (640×360). */
async function scriptRect(page: Page, x: number, y: number, width: number, height: number) {
  const box = await page.locator("canvas.JASSUB").boundingBox();
  if (!box) throw new Error("pas de canvas libass");
  const sx = box.width / 640;
  const sy = box.height / 360;
  return { x: box.x + x * sx, y: box.y + y * sy, width: width * sx, height: height * sy };
}

test("aperçu au survol de la barre de progression", async () => {
  const { app, page } = await launch(media("native.mp4"));
  await expectPlaying(page);
  const seekBox = await page.locator("#seek").boundingBox();
  if (!seekBox) throw new Error("barre absente");
  // Entre deux images clés (toutes les 10 s) : l'aperçu doit tout de même s'afficher.
  await page.mouse.move(seekBox.x + 8 + (seekBox.width - 16) * 0.37, seekBox.y + seekBox.height / 2);
  await expect(page.locator("#preview")).toBeVisible();
  await expect(page.locator("#preview-time")).toHaveText(/^0:2[12]$/);
  await expect
    .poll(() => page.evaluate(() => (document.getElementById("preview-img") as HTMLImageElement).naturalWidth))
    .toBe(192);
  await expect(page.locator("#preview-img")).toBeVisible();
  // L'image vient de FFmpeg, à l'instant pointé.
  const src = await page.locator("#preview-img").getAttribute("src");
  expect(src).toMatch(/^kp:\/\/local\/thumb\/[^?]+\?t=2[12]&w=192$/);
  await page.mouse.move(seekBox.x + seekBox.width / 2, seekBox.y - 200);
  await expect(page.locator("#preview")).toBeHidden();
  await app.close();
});

test("sous-titres ASS externes : rendu libass (positions, styles, karaoké)", async () => {
  const { app, page } = await launch(media("styled.mp4"));
  await expect(page.locator("#subtitle-track")).toHaveValue("ext-0");
  await expect(page.locator("canvas.JASSUB")).toHaveCount(1);
  await expectPlaying(page);
  await page.keyboard.press(" ");
  // Le bloc rouge \an7\pos(20,20) de 200×80 occupe le coin haut gauche du script ;
  // on regarde la partie posée sur la bande verte de la mire (x ≥ 108).
  const block = await scriptRect(page, 120, 30, 80, 60);
  await expect.poll(() => countPixels(app, block, "red"), { timeout: 15_000 }).toBeGreaterThan(block.width * block.height * 0.8);
  // Aucune piste WebVTT en parallèle : libass dessine seul.
  expect(await page.evaluate(() => (document.getElementById("video") as HTMLVideoElement).textTracks[0].cues?.length ?? 0)).toBe(0);

  // Désactivés : le canvas disparaît.
  await page.locator("#tracks-toggle").click();
  await page.locator("#subtitle-track").selectOption("");
  await expect(page.locator("canvas.JASSUB")).toHaveCount(0);
  // La vidéo est en pause : la capture peut encore montrer l'ancienne image
  // composée tant que la fenêtre n'a pas été redessinée, d'où l'attente.
  await expect.poll(() => countPixels(app, block, "red"), { timeout: 5_000 }).toBeLessThan(block.width * block.height * 0.05);
  await app.close();
});

test("ASS intégré au MKV avec police jointe", async () => {
  const { app, page } = await launch(media("fonts.mkv"));
  await expectPlaying(page);
  await page.locator("#tracks-toggle").click();
  await page.locator("#subtitle-track").selectOption("emb-0");
  await expect(page.locator("canvas.JASSUB")).toHaveCount(1);
  // La police jointe est extraite et servie au moteur libass.
  const fontSize = await page.evaluate(async () => {
    const src = (document.getElementById("video") as HTMLVideoElement).src;
    const id = /\/(?:media|stream)\/([^/?]+)/.exec(src)?.[1];
    const res = await fetch(`kp://local/fonts/${id}/0`);
    return res.ok ? (await res.arrayBuffer()).byteLength : 0;
  });
  expect(fontSize).toBeGreaterThan(100_000);
  await page.locator("#tracks-toggle").click();
  await page.keyboard.press(" ");
  // Texte vert centré en haut (\an8) : des pixels verts apparaissent dans le bandeau supérieur.
  const band = await scriptRect(page, 120, 10, 400, 70);
  await expect.poll(() => countPixels(app, band, "green"), { timeout: 15_000 }).toBeGreaterThan(200);
  await app.close();
});
