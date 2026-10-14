/**
 * Registre de modules à la manière de VLC (src/modules/modules.c) :
 * chaque module annonce une capacité et un score ; pour une tâche, les
 * candidats sont essayés du score le plus haut au plus bas et le premier
 * dont la sonde accepte l'entrée l'emporte. Un score <= 0 n'est jamais
 * choisi automatiquement, seulement quand il est demandé par son nom.
 */
export type Module<Input, Output> = {
  name: string;
  capability: string;
  score: number;
  /** Renvoie null si le module ne sait pas traiter cette entrée. */
  probe(input: Input): Output | null | Promise<Output | null>;
};

export type LoadResult<Output> = { module: string; output: Output };

export class ModuleRegistry {
  private readonly modules: Module<unknown, unknown>[] = [];

  register<Input, Output>(module: Module<Input, Output>): void {
    this.modules.push(module as Module<unknown, unknown>);
  }

  /** Candidats pour une capacité, triés par score décroissant (ordre stable). */
  candidates(capability: string, names = "any"): Module<unknown, unknown>[] {
    const all = this.modules
      .filter((m) => m.capability === capability)
      .sort((a, b) => b.score - a.score);

    const picked: Module<unknown, unknown>[] = [];
    for (const name of names.split(",").map((n) => n.trim()).filter(Boolean)) {
      // "none" ne correspond à rien et termine la recherche ; "any" ajoute
      // tous les modules restants de score strictement positif.
      if (name === "none") return picked;
      if (name === "any") {
        for (const m of all) if (m.score > 0 && !picked.includes(m)) picked.push(m);
        return picked;
      }
      const m = all.find((c) => c.name === name);
      if (m && !picked.includes(m)) picked.push(m);
    }
    return picked;
  }

  async load<Input, Output>(
    capability: string,
    input: Input,
    names = "any",
  ): Promise<LoadResult<Output> | null> {
    for (const m of this.candidates(capability, names)) {
      const output = await m.probe(input);
      if (output !== null) return { module: m.name, output: output as Output };
    }
    return null;
  }
}
