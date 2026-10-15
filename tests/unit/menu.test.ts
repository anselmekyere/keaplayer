import { describe, expect, it } from "vitest";
import type { MenuItemConstructorOptions } from "electron";
import { buildMenuTemplate, DEFAULT_MENU_STATE, sanitizeMenuState } from "../../src/main/menu";
import type { MenuCommand, MenuState } from "../../src/shared/types";

function setup(state: Partial<MenuState> = {}) {
  const sent: MenuCommand[] = [];
  const calls: string[] = [];
  const template = buildMenuTemplate({ ...DEFAULT_MENU_STATE, ...state }, {
    send: (c) => sent.push(c),
    toggleFullscreen: () => calls.push("fullscreen"),
    toggleAlwaysOnTop: () => calls.push("top"),
    about: () => calls.push("about"),
    quit: () => calls.push("quit"),
  });
  const find = (...path: string[]): MenuItemConstructorOptions => {
    let items = template;
    let item: MenuItemConstructorOptions | undefined;
    for (const label of path) {
      item = items.find((i) => i.label === label);
      if (!item) throw new Error(`Entrée introuvable : ${path.join(" > ")}`);
      items = (item.submenu as MenuItemConstructorOptions[]) ?? [];
    }
    return item!;
  };
  const click = (...path: string[]) => (find(...path).click as () => void)();
  return { template, sent, calls, find, click };
}

const withMedia: Partial<MenuState> = {
  hasMedia: true,
  audioTracks: [{ index: 0, label: "fre · aac" }, { index: 1, label: "VO · eng · ac3" }],
  audioIndex: 1,
  subtitles: [{ id: "ext-0", label: "film.fr.srt (fichier)" }],
  subtitleId: "ext-0",
  presets: [{ id: "flat", label: "Plat" }, { id: "rock", label: "Rock" }],
  preset: "rock",
};

describe("barre de menus", () => {
  it("propose les menus de VLC, dans le même ordre", () => {
    expect(setup().template.map((m) => m.label)).toEqual(["&Média", "&Lecture", "&Audio", "&Vidéo", "&Sous-titres", "Affic&hage", "&Aide"]);
  });

  it("désactive les commandes de lecture tant qu'aucun média n'est ouvert", () => {
    const { find } = setup();
    expect(find("&Lecture", "Lecture").enabled).toBe(false);
    expect(find("&Média", "Ouvrir des fichiers…").enabled).not.toBe(false);
  });

  it("reflète les pistes, les sous-titres et l'égaliseur en cours", () => {
    const { find } = setup(withMedia);
    const tracks = find("&Audio", "Piste audio").submenu as MenuItemConstructorOptions[];
    expect(tracks.map((t) => [t.label, t.checked])).toEqual([["fre · aac", false], ["VO · eng · ac3", true]]);
    expect(find("&Sous-titres", "Piste de sous-titres", "film.fr.srt (fichier)").checked).toBe(true);
    expect(find("&Sous-titres", "Piste de sous-titres", "Désactivés").checked).toBe(false);
    expect(find("&Audio", "Égaliseur", "Rock").checked).toBe(true);
    expect(find("&Lecture", "Vitesse", "1×").checked).toBe(true);
  });

  it("envoie les commandes à l'interface", () => {
    const { click, sent, calls } = setup(withMedia);
    click("&Audio", "Piste audio", "fre · aac");
    click("&Lecture", "Vitesse", "1,5×");
    click("&Lecture", "Avancer d'1 min");
    click("&Sous-titres", "Piste de sous-titres", "Désactivés");
    click("&Vidéo", "Plein écran");
    click("Affic&hage", "Zone suivante");
    expect(sent).toEqual([
      { type: "audio-track", value: 0 },
      { type: "speed", value: 1.5 },
      { type: "seek", value: 60 },
      { type: "subtitle", value: "" },
      { type: "focus-next" },
    ]);
    expect(calls).toEqual(["fullscreen"]);
  });

  it("laisse à l'interface les raccourcis qu'elle gère, sauf F11, Ctrl+Maj+O et Ctrl+Q", () => {
    const { template } = setup(withMedia);
    const all: MenuItemConstructorOptions[] = [];
    const walk = (items: MenuItemConstructorOptions[]) =>
      items.forEach((i) => (all.push(i), Array.isArray(i.submenu) && walk(i.submenu as MenuItemConstructorOptions[])));
    walk(template);
    const registered = all.filter((i) => i.accelerator && i.registerAccelerator !== false).map((i) => i.accelerator);
    expect(registered.sort()).toEqual(["CmdOrCtrl+Q", "CmdOrCtrl+Shift+O", "F11"]);
  });

  it("ne garde que des valeurs bien formées venant de l'interface", () => {
    expect(sanitizeMenuState("n'importe quoi")).toBeNull();
    const s = sanitizeMenuState({ hasMedia: "oui", speed: "vite", audioTracks: [{ index: 1, label: "x".repeat(500) }, { label: "sans index" }], fullscreen: true })!;
    expect(s.hasMedia).toBe(false);
    expect(s.speed).toBe(1);
    expect(s.audioTracks).toEqual([{ index: 1, label: "x".repeat(120) }]);
    expect(s.fullscreen).toBe(false);
  });
});
