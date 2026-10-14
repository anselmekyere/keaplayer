export type StreamInfo = {
  /** Index parmi les flux du même type (0 = première piste audio, etc.). */
  index: number;
  codec: string;
  language?: string;
  title?: string;
  isDefault: boolean;
};

export type SubtitleStreamInfo = StreamInfo & {
  /** Sous-titres texte (SRT, ASS, WebVTT…) : les seuls affichables ici. */
  isText: boolean;
};

export type MediaInfo = {
  path: string;
  formatName: string;
  duration: number;
  video?: StreamInfo & { width: number; height: number; fps: number };
  audio: StreamInfo[];
  subtitles: SubtitleStreamInfo[];
};

export type PlaybackMode = "native" | "remux" | "transcode";

/**
 * Codecs (noms FFmpeg) que Chromium sait décoder sur cette machine, mesurés au
 * démarrage : le HEVC, par exemple, dépend du matériel et du système.
 */
export type Capabilities = { video: string[]; audio: string[] };

export type PlaybackOptions = {
  /** Position de départ, en secondes. */
  start: number;
  /** Piste audio choisie (index parmi les pistes audio). */
  audioIndex: number;
  /** Décalage audio en secondes (positif : le son arrive plus tard). */
  audioDelay: number;
};

export type PlaybackPlan = {
  mode: PlaybackMode;
  /** Module retenu, pour le diagnostic (équivalent du "using … module" de VLC). */
  module: string;
  url: string;
  /**
   * Position réelle du début du flux : 0 en lecture native (le fichier entier
   * est servi) ; la position demandée quand FFmpeg produit le flux à la volée.
   */
  startOffset: number;
  /** Le lecteur peut-il chercher directement dans le flux ? */
  seekable: boolean;
};

export type SubtitleSource = {
  id: string;
  label: string;
  language?: string;
  external: boolean;
  url: string;
};

export type PreparedMedia = {
  id: string;
  info: MediaInfo;
  plan: PlaybackPlan;
  subtitles: SubtitleSource[];
  resumeAt: number | null;
};

export type KeaplayerApi = {
  openFilesDialog(): Promise<string[]>;
  openFolderDialog(): Promise<string[]>;
  pathsForFiles(files: File[]): string[];
  expandPaths(paths: string[]): Promise<string[]>;
  setCapabilities(capabilities: Capabilities): Promise<void>;
  prepare(path: string): Promise<PreparedMedia>;
  plan(id: string, options: PlaybackOptions): Promise<PlaybackPlan>;
  saveResume(path: string, time: number, duration: number): Promise<void>;
  saveScreenshot(pngDataUrl: string, baseName: string): Promise<string>;
  onOpenPaths(callback: (paths: string[]) => void): void;
};
