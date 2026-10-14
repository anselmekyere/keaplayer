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
