import { describe, expect, it } from "vitest";
import { ModuleRegistry } from "../../src/main/core/modules";

function registry() {
  const r = new ModuleRegistry();
  const seen: string[] = [];
  const mod = (name: string, score: number, accepts: boolean) => ({
    name,
    capability: "demo",
    score,
    probe: (input: string) => {
      seen.push(name);
      return accepts ? `${name}:${input}` : null;
    },
  });
  r.register(mod("bas", 10, true));
  r.register(mod("haut", 100, false));
  r.register(mod("moyen", 50, true));
  r.register(mod("manuel", 0, true));
  r.register({ ...mod("autre", 999, true), capability: "autre" });
  return { r, seen };
}

describe("ModuleRegistry (comme vlc_module_load)", () => {
  it("essaie les modules par score décroissant et garde le premier qui accepte", async () => {
    const { r, seen } = registry();
    expect(await r.load("demo", "x")).toEqual({ module: "moyen", output: "moyen:x" });
    expect(seen).toEqual(["haut", "moyen"]);
  });

  it("n'utilise jamais un module de score 0 sans le nommer", async () => {
    const { r } = registry();
    expect(r.candidates("demo").map((m) => m.name)).toEqual(["haut", "moyen", "bas"]);
    expect((await r.load("demo", "x", "manuel"))?.module).toBe("manuel");
  });

  it("respecte une liste de noms, avec 'any' et 'none'", async () => {
    const { r } = registry();
    expect(r.candidates("demo", "bas,any").map((m) => m.name)).toEqual(["bas", "haut", "moyen"]);
    expect(r.candidates("demo", "bas,none,moyen").map((m) => m.name)).toEqual(["bas"]);
    expect(await r.load("demo", "x", "haut")).toBeNull();
  });
});
