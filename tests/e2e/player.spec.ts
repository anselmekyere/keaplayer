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
