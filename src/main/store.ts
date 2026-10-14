import { readFileSync, writeFileSync, renameSync } from "node:fs";

type State = { resume: Record<string, { time: number; updatedAt: number }> };

const MAX_ENTRIES = 500;

/**
 * Positions de reprise, comme « Reprendre la lecture » de VLC. Une position
 * proche du début ou de la fin n'est pas gardée : on recommence au début.
 */
export class ResumeStore {
  private state: State = { resume: {} };

  constructor(private readonly file: string) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<State>;
      if (parsed.resume && typeof parsed.resume === "object") this.state.resume = parsed.resume;
    } catch {
      // Premier lancement ou fichier illisible : on repart de zéro.
    }
  }

  get(media: string): number | null {
    return this.state.resume[media]?.time ?? null;
  }

  set(media: string, time: number, duration: number): void {
    const nearStart = time < 10;
    const nearEnd = duration > 0 && time > duration * 0.95;
    if (nearStart || nearEnd) delete this.state.resume[media];
    else this.state.resume[media] = { time, updatedAt: Date.now() };

    const entries = Object.entries(this.state.resume);
    if (entries.length > MAX_ENTRIES) {
      entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt);
      this.state.resume = Object.fromEntries(entries.slice(0, MAX_ENTRIES));
    }
    this.save();
  }

  private save(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state));
    renameSync(tmp, this.file);
  }
}
