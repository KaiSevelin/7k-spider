/**
 * The layouts a reader can choose between, named once for every canvas that offers them.
 *
 * There are four drawings of one model here and they are not all the same shape. A topology is a
 * bipartite graph that reads down the page; a data model around one message is a fan, and a fan with
 * thirty leaves laid out in layers is a row of boxes and a bundle of lines, which is a picture of
 * nothing. So which layout to use is a reader's question about the drawing in front of them, and the
 * answer belongs in a control rather than in a constant.
 *
 * **This does not weaken D25.** What that forbids is a picture that reshuffles when you were not
 * looking: the same model must give the same drawing, so nothing here depends on a clock or an unseeded
 * random. `stress` is the only one that would, and it is pinned. A reader choosing a different layout
 * is not the drawing changing under them — it is them changing it, which is the difference between a
 * control and a surprise.
 *
 * Only the keys that choose and orient the algorithm are here. Spacing belongs to the canvas, because
 * what a topology needs between two nodes is not what a wall of value types needs.
 */

export interface LayoutChoice {
  readonly id: string;
  /** What the picker shows. Short, because it sits in a toolbar beside four other controls. */
  readonly label: string;
  /** What the picker's tooltip says, which is where the reason goes. */
  readonly title: string;
  /** The ELK options this contributes, merged over the canvas's own. */
  readonly elk: Readonly<Record<string, unknown>>;
}

export const LAYOUTS: readonly LayoutChoice[] = [
  {
    id: "down",
    label: "layered ↓",
    title: "layered, top to bottom — messages flow down the page",
    elk: { algorithm: "layered", "elk.direction": "DOWN" },
  },
  {
    id: "right",
    label: "layered →",
    title: "layered, left to right — fits a wide, shallow model on a wide screen",
    elk: { algorithm: "layered", "elk.direction": "RIGHT" },
  },
  {
    id: "tree",
    label: "tree",
    title: "a tree, which is what a message and what it holds actually is",
    elk: { algorithm: "mrtree" },
  },
  {
    id: "radial",
    label: "radial",
    title: "rings around the centre, for one thing and everything that reaches it",
    elk: { algorithm: "radial" },
  },
  {
    id: "stress",
    label: "stress",
    title: "placed by distance rather than in layers; seeded, so it is still the same picture twice",
    elk: { algorithm: "stress", "elk.randomSeed": 1 },
  },
];

/** What a canvas starts on, and what an unknown id falls back to. */
export const DEFAULT_LAYOUT = "down";

export const layoutChoice = (id: string): LayoutChoice =>
  LAYOUTS.find((l) => l.id === id) ?? LAYOUTS.find((l) => l.id === DEFAULT_LAYOUT) ?? LAYOUTS[0]!;

/**
 * The canvas's own options with one choice applied.
 *
 * A merge rather than a replacement, so the spacing and padding a canvas decided for itself survive
 * the choice. The layered-only keys in a base are left in place when a non-layered algorithm is
 * chosen: ELK reads the options its algorithm declares and ignores the rest, and stripping them here
 * would mean this module knowing which keys belong to which algorithm — a second table to keep in step
 * with ELK's own.
 */
export function withLayout(
  base: Readonly<Record<string, unknown>>,
  id: string,
): Record<string, unknown> {
  const chosen = layoutChoice(id);
  return {
    ...base,
    elk: { ...((base.elk as Record<string, unknown> | undefined) ?? {}), ...chosen.elk },
  };
}
