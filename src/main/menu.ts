import type { MenuItemConstructorOptions } from "electron";
import type { MenuCommand, MenuState } from "../shared/types";

/**
 * Barre de menus, à la manière de VLC (Média, Lecture, Audio, Vidéo,
 * Sous-titres, Affichage, Aide). Les entrées dynamiques (pistes, égaliseur,
 * vitesse) suivent l'état envoyé par l'interface.
 *
 * Les raccourcis déjà gérés par l'interface sont seulement affichés
 * (`registerAccelerator: false`) : sinon le menu les intercepterait et
 * l'action serait exécutée deux fois, ou plus du tout pendant la saisie.
 */
export type MenuActions = {
  send(command: MenuCommand): void;
  toggleFullscreen(): void;
  toggleAlwaysOnTop(): void;
  about(): void;
  quit(): void;
};

export const DEFAULT_MENU_STATE: MenuState = {
  hasMedia: false,
  playing: false,
  muted: false,
  speed: 1,
  audioTracks: [],
  audioIndex: 0,
  subtitles: [],
  subtitleId: "",
  presets: [],
  preset: "flat",
  normalize: false,
  playlistVisible: false,
  tracksVisible: false,
  fullscreen: false,
  alwaysOnTop: false,
};

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];

/** Raccourci affiché mais laissé à l'interface. */
const shown = (accelerator: string) => ({ accelerator, registerAccelerator: false });

export function buildMenuTemplate(state: MenuState, actions: MenuActions): MenuItemConstructorOptions[] {
  const { send } = actions;
  const media = state.hasMedia;

  return [
    {
      label: "&Média",
      submenu: [
        { label: "Ouvrir des fichiers…", ...shown("CmdOrCtrl+O"), click: () => send({ type: "open-files" }) },
        { label: "Ouvrir un dossier…", accelerator: "CmdOrCtrl+Shift+O", click: () => send({ type: "open-folder" }) },
        { type: "separator" },
        { label: "Capture d'écran", ...shown("Shift+S"), enabled: media, click: () => send({ type: "snapshot" }) },
        { type: "separator" },
        { label: "Quitter", accelerator: "CmdOrCtrl+Q", click: () => actions.quit() },
      ],
    },
    {
      label: "&Lecture",
      submenu: [
        {
          label: state.playing ? "Pause" : "Lecture",
          ...shown("Space"),
          enabled: media,
          click: () => send({ type: "play-pause" }),
        },
        { label: "Précédent", ...shown("P"), enabled: media, click: () => send({ type: "previous" }) },
        { label: "Suivant", ...shown("N"), enabled: media, click: () => send({ type: "next" }) },
        { type: "separator" },
        { label: "Avancer de 10 s", ...shown("Right"), enabled: media, click: () => send({ type: "seek", value: 10 }) },
        { label: "Reculer de 10 s", ...shown("Left"), enabled: media, click: () => send({ type: "seek", value: -10 }) },
        { label: "Avancer d'1 min", ...shown("Shift+Right"), enabled: media, click: () => send({ type: "seek", value: 60 }) },
        { label: "Reculer d'1 min", ...shown("Shift+Left"), enabled: media, click: () => send({ type: "seek", value: -60 }) },
        { label: "Image suivante", ...shown("E"), enabled: media, click: () => send({ type: "frame" }) },
        { type: "separator" },
        {
          label: "Vitesse",
          enabled: media,
          submenu: SPEEDS.map((s) => ({
            label: `${String(s).replace(".", ",")}×`,
            type: "radio" as const,
            checked: Math.abs(state.speed - s) < 0.001,
            click: () => send({ type: "speed", value: s }),
          })),
        },
      ],
    },
    {
      label: "&Audio",
      submenu: [
        {
          label: "Piste audio",
          enabled: media && state.audioTracks.length > 0,
          submenu: state.audioTracks.length
            ? state.audioTracks.map((t) => ({
                label: t.label,
                type: "radio" as const,
                checked: t.index === state.audioIndex,
                click: () => send({ type: "audio-track", value: t.index }),
              }))
            : [{ label: "Aucune", enabled: false }],
        },
        { type: "separator" },
        { label: "Augmenter le volume", ...shown("Up"), click: () => send({ type: "volume", value: 0.05 }) },
        { label: "Baisser le volume", ...shown("Down"), click: () => send({ type: "volume", value: -0.05 }) },
        { label: "Couper le son", ...shown("M"), type: "checkbox", checked: state.muted, click: () => send({ type: "mute" }) },
        { type: "separator" },
        {
          label: "Égaliseur",
          submenu: state.presets.map((p) => ({
            label: p.label,
            type: "radio" as const,
            checked: p.id === state.preset,
            click: () => send({ type: "eq", value: p.id }),
          })),
        },
        {
          label: "Normaliser le volume",
          type: "checkbox",
          checked: state.normalize,
          click: () => send({ type: "normalize", value: !state.normalize }),
        },
        { type: "separator" },
        { label: "Avancer le son (−50 ms)", ...shown("J"), enabled: media, click: () => send({ type: "audio-delay", value: -0.05 }) },
        { label: "Retarder le son (+50 ms)", ...shown("K"), enabled: media, click: () => send({ type: "audio-delay", value: 0.05 }) },
      ],
    },
    {
      label: "&Vidéo",
      submenu: [
        {
          label: "Plein écran",
          accelerator: "F11",
          type: "checkbox",
          checked: state.fullscreen,
          click: () => actions.toggleFullscreen(),
        },
        {
          label: "Toujours au premier plan",
          type: "checkbox",
          checked: state.alwaysOnTop,
          click: () => actions.toggleAlwaysOnTop(),
        },
        { type: "separator" },
        { label: "Capture d'écran", ...shown("Shift+S"), enabled: media, click: () => send({ type: "snapshot" }) },
      ],
    },
    {
      label: "&Sous-titres",
      submenu: [
        {
          label: "Piste de sous-titres",
          enabled: media,
          submenu: [
            {
              label: "Désactivés",
              type: "radio" as const,
              checked: state.subtitleId === "",
              click: () => send({ type: "subtitle", value: "" }),
            },
            ...state.subtitles.map((s) => ({
              label: s.label,
              type: "radio" as const,
              checked: s.id === state.subtitleId,
              click: () => send({ type: "subtitle", value: s.id }),
            })),
          ],
        },
        { type: "separator" },
        { label: "Avancer (−50 ms)", ...shown("G"), enabled: media, click: () => send({ type: "sub-delay", value: -0.05 }) },
        { label: "Retarder (+50 ms)", ...shown("H"), enabled: media, click: () => send({ type: "sub-delay", value: 0.05 }) },
      ],
    },
    {
      label: "Affic&hage",
      submenu: [
        {
          label: "Liste de lecture",
          ...shown("L"),
          type: "checkbox",
          checked: state.playlistVisible,
          click: () => send({ type: "toggle-playlist" }),
        },
        {
          label: "Pistes, son et décalages",
          ...shown("T"),
          type: "checkbox",
          checked: state.tracksVisible,
          click: () => send({ type: "toggle-tracks" }),
        },
        { type: "separator" },
        { label: "Zone suivante", ...shown("F6"), click: () => send({ type: "focus-next" }) },
        { label: "Zone précédente", ...shown("Shift+F6"), click: () => send({ type: "focus-previous" }) },
      ],
    },
    {
      label: "&Aide",
      submenu: [
        { label: "Raccourcis clavier", ...shown("?"), click: () => send({ type: "help" }) },
        { type: "separator" },
        { label: "À propos de KEAPlayer", click: () => actions.about() },
      ],
    },
  ];
}

/** L'état vient de l'interface : on ne garde que des valeurs bien formées. */
export function sanitizeMenuState(value: unknown): MenuState | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Partial<MenuState>;
  const text = (s: unknown) => (typeof s === "string" ? s.slice(0, 120) : "");
  const list = <T>(a: unknown, map: (x: Record<string, unknown>) => T | null): T[] =>
    Array.isArray(a) ? a.slice(0, 64).map((x) => (x && typeof x === "object" ? map(x as Record<string, unknown>) : null)).filter((x): x is T => x !== null) : [];
  return {
    hasMedia: v.hasMedia === true,
    playing: v.playing === true,
    muted: v.muted === true,
    speed: typeof v.speed === "number" && Number.isFinite(v.speed) ? v.speed : 1,
    audioTracks: list(v.audioTracks, (x) => (typeof x.index === "number" ? { index: x.index, label: text(x.label) } : null)),
    audioIndex: typeof v.audioIndex === "number" ? v.audioIndex : 0,
    subtitles: list(v.subtitles, (x) => (typeof x.id === "string" ? { id: text(x.id), label: text(x.label) } : null)),
    subtitleId: text(v.subtitleId),
    presets: list(v.presets, (x) => (typeof x.id === "string" ? { id: text(x.id), label: text(x.label) } : null)),
    preset: text(v.preset) || "flat",
    normalize: v.normalize === true,
    playlistVisible: v.playlistVisible === true,
    tracksVisible: v.tracksVisible === true,
    fullscreen: false,
    alwaysOnTop: false,
  };
}
