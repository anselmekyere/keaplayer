/**
 * Chaîne audio inspirée des filtres de VLC : égaliseur 10 bandes (mêmes
 * fréquences et préréglages que modules/audio_filter/equalizer_presets.h),
 * normalisation du volume par compresseur, et amplification jusqu'à 200 %.
 */
export const EQ_FREQUENCIES = [60, 170, 310, 600, 1000, 3000, 6000, 12000, 14000, 16000];

export const EQ_PRESETS: Record<string, { label: string; gains: number[] }> = {
  flat: { label: "Plat", gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  classical: { label: "Classique", gains: [0, 0, 0, 0, 0, 0, -7.2, -7.2, -7.2, -9.6] },
  club: { label: "Club", gains: [0, 0, 8, 5.6, 5.6, 5.6, 3.2, 0, 0, 0] },
  dance: { label: "Danse", gains: [9.6, 7.2, 2.4, 0, 0, -5.6, -7.2, -7.2, 0, 0] },
  fullbass: { label: "Basses renforcées", gains: [-8, 9.6, 9.6, 5.6, 1.6, -4, -8, -10.4, -11.2, -11.2] },
  fullbasstreble: { label: "Basses et aigus", gains: [7.2, 5.6, 0, -7.2, -4.8, 1.6, 8, 11.2, 12, 12] },
  fulltreble: { label: "Aigus renforcés", gains: [-9.6, -9.6, -9.6, -4, 2.4, 11.2, 16, 16, 16, 16.8] },
  headphones: { label: "Casque", gains: [4.8, 11.2, 5.6, -3.2, -2.4, 1.6, 4.8, 9.6, 12.8, 14.4] },
  largehall: { label: "Grande salle", gains: [10.4, 10.4, 5.6, 5.6, 0, -4.8, -4.8, -4.8, 0, 0] },
  live: { label: "Concert", gains: [-4.8, 0, 4, 5.6, 5.6, 5.6, 4, 2.4, 2.4, 2.4] },
  party: { label: "Fête", gains: [7.2, 7.2, 0, 0, 0, 0, 0, 0, 7.2, 7.2] },
  pop: { label: "Pop", gains: [-1.6, 4.8, 7.2, 8, 5.6, 0, -2.4, -2.4, -1.6, -1.6] },
  reggae: { label: "Reggae", gains: [0, 0, 0, -5.6, 0, 6.4, 6.4, 0, 0, 0] },
  rock: { label: "Rock", gains: [8, 4.8, -5.6, -8, -3.2, 4, 8.8, 11.2, 11.2, 11.2] },
  ska: { label: "Ska", gains: [-2.4, -4.8, -4, 0, 4, 5.6, 8.8, 9.6, 11.2, 9.6] },
  soft: { label: "Doux", gains: [4.8, 1.6, 0, -2.4, 0, 4, 8, 9.6, 11.2, 12] },
  softrock: { label: "Rock doux", gains: [4, 4, 2.4, 0, -4, -5.6, -3.2, 0, 2.4, 8.8] },
  techno: { label: "Techno", gains: [8, 5.6, 0, -5.6, -4.8, 0, 8, 9.6, 9.6, 8.8] },
};

export const MAX_VOLUME = 2;

/**
 * Pré-atténuation (dB) qui évite la saturation quand des bandes sont
 * fortement relevées : on retire la moitié du plus fort relèvement.
 */
export function preampFor(gains: number[]): number {
  return -Math.max(0, ...gains) / 2;
}

/** Volume demandé (0 à 200 %) → volume de l'élément vidéo (≤ 1) et gain d'amplification (≥ 1). */
export function splitVolume(level: number): { element: number; boost: number } {
  const v = Math.min(MAX_VOLUME, Math.max(0, level));
  return { element: Math.min(1, v), boost: Math.max(1, v) };
}

const dbToGain = (db: number) => Math.pow(10, db / 20);

export class AudioChain {
  private ctx?: AudioContext;
  private filters: BiquadFilterNode[] = [];
  private preamp?: GainNode;
  private compressor?: DynamicsCompressorNode;
  private makeup?: GainNode;
  private boost?: GainNode;
  private preset = "flat";
  private normalize = false;
  private boostValue = 1;

  constructor(private readonly video: HTMLVideoElement) {}

  /**
   * Construit le graphe au premier besoin : une fois l'élément raccordé à
   * Web Audio, tout son passe par ce graphe (même origine kp://local requise).
   */
  private ensure(): AudioContext {
    if (this.ctx) return this.ctx;
    const ctx = new AudioContext();
    const source = ctx.createMediaElementSource(this.video);
    this.filters = EQ_FREQUENCIES.map((frequency, i) => {
      const f = ctx.createBiquadFilter();
      f.type = i === 0 ? "lowshelf" : i === EQ_FREQUENCIES.length - 1 ? "highshelf" : "peaking";
      f.frequency.value = frequency;
      f.Q.value = 1.1;
      return f;
    });
    this.preamp = ctx.createGain();
    this.compressor = ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -24;
    this.compressor.knee.value = 30;
    this.compressor.ratio.value = 8;
    this.compressor.attack.value = 0.005;
    this.compressor.release.value = 0.3;
    this.makeup = ctx.createGain();
    this.makeup.gain.value = dbToGain(8);
    this.boost = ctx.createGain();

    let node: AudioNode = source;
    for (const f of this.filters) node = node.connect(f);
    node.connect(this.preamp);
    this.compressor.connect(this.makeup);
    this.boost.connect(ctx.destination);
    this.ctx = ctx;
    this.apply();
    return ctx;
  }

  private apply() {
    if (!this.ctx) return;
    const gains = EQ_PRESETS[this.preset]?.gains ?? EQ_PRESETS.flat.gains;
    this.filters.forEach((f, i) => (f.gain.value = gains[i]));
    this.preamp!.gain.value = dbToGain(preampFor(gains));
    // Normalisation : le compresseur s'intercale ou se retire du chemin.
    this.preamp!.disconnect();
    this.makeup!.disconnect();
    if (this.normalize) {
      this.preamp!.connect(this.compressor!);
      this.makeup!.connect(this.boost!);
    } else {
      this.preamp!.connect(this.boost!);
    }
    this.boost!.gain.value = this.boostValue;
  }

  /** Le graphe n'est utile que si un réglage s'écarte du neutre. */
  private needed() {
    return this.preset !== "flat" || this.normalize || this.boostValue > 1;
  }

  async resume() {
    if (this.ctx?.state === "suspended") await this.ctx.resume();
  }

  setPreset(name: string) {
    this.preset = name in EQ_PRESETS ? name : "flat";
    if (this.needed()) this.ensure();
    this.apply();
  }

  setNormalize(on: boolean) {
    this.normalize = on;
    if (this.needed()) this.ensure();
    this.apply();
  }

  setBoost(gain: number) {
    this.boostValue = Math.min(MAX_VOLUME, Math.max(1, gain));
    if (this.needed()) this.ensure();
    this.apply();
  }

  /** État actuel, pour l'affichage et les tests. */
  state() {
    return {
      preset: this.preset,
      normalize: this.normalize,
      boost: this.boostValue,
      active: Boolean(this.ctx),
      bands: this.filters.map((f) => Math.round(f.gain.value * 10) / 10),
    };
  }
}
