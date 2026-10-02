/**
 * Search: the one way of getting around whose usefulness does not depend on how big the model is.
 *
 * Panning a graph works at twenty-four nodes and stops working somewhere before two hundred. A lens and
 * a focus both need you to already know roughly where you are going. Typing a name does not, which is why
 * this exists before any of the scale work the model size might eventually demand.
 *
 * **It searches the model, not the graph.** A reader typing `OrderPlaced` is looking for the message, and
 * a message is an edge *label* rather than a node (`docs/design.md` 3.1) — so searching only what is drawn
 * would fail on exactly the names people remember. Records, values, enums, sagas and schedules are
 * findable for the same reason: they are what the model is made of, even where the graph does not draw
 * them.
 *
 * Ranking is **total and deterministic**: the same query gives the same order every time, down to the
 * tie-break. A palette that reshuffled under the cursor would be unusable for the same reason a graph
 * that reshuffles is (D25).
 */

import { qualify, type Decl, type DeclKind, type LinkedModel } from "@sevenk/core";
import { idOf, packageId, type SelectionId } from "./selection.js";

export type EntryKind = DeclKind | "package";

export interface Entry {
  readonly id: SelectionId;
  readonly kind: EntryKind;
  /** `acme.retail.sales.OrderService`. */
  readonly qname: string;
  /** `OrderService`. */
  readonly name: string;
}

export interface Hit extends Entry {
  readonly score: number;
  /** False when the current lens or focus has hidden it — a result, but not one you can click to. */
  readonly drawn: boolean;
}

/**
 * How much a kind is worth at equal match quality.
 *
 * The things the graph draws come first, because a reader searching in a graph tool is usually trying to
 * get *to* somewhere on the graph. A message still outranks a value: it is the thing that travels.
 */
const KIND_WEIGHT: Readonly<Record<EntryKind, number>> = {
  service: 6,
  pipe: 5,
  package: 4,
  message: 3,
  saga: 2,
  schedule: 2,
  record: 1,
  envelope: 1,
  enum: 1,
  value: 1,
  label: 1,
  upcast: 0,
};

export function buildIndex(model: LinkedModel): Entry[] {
  const out: Entry[] = [];

  for (const pkg of model.packages.values()) {
    // Implied packages are not drawn and are not names anyone wrote, so they are not findable either.
    if (!pkg.declared) continue;
    out.push({ id: packageId(pkg), kind: "package", qname: pkg.name, name: bare(pkg.name) });
  }

  for (const decl of model.decls as readonly Decl[]) {
    out.push({
      id: idOf(decl),
      kind: decl.id.kind,
      qname: qualify(decl.id),
      name: decl.id.name,
    });
  }

  // Sorted so the index itself is deterministic, which the tie-break then relies on.
  return out.sort((a, b) => (a.qname < b.qname ? -1 : a.qname > b.qname ? 1 : 0));
}

const bare = (qname: string): string => qname.slice(qname.lastIndexOf(".") + 1);

/**
 * The characters that begin a word in a name: the first, and each capital or character after a separator.
 *
 * `OrderService` begins words with `o` and `s`; `SeatLedgerAdjusted` with `s`, `l` and `a`.
 */
function wordStarts(name: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < name.length; i++) {
    const ch = name[i]!;
    const prior = i === 0 ? undefined : name[i - 1]!;
    const starts =
      prior === undefined ||
      prior === "." ||
      prior === "_" ||
      prior === "-" ||
      (ch === ch.toUpperCase() && ch !== ch.toLowerCase() && prior !== prior.toUpperCase());
    if (starts) out.add(ch.toLowerCase());
  }
  return out;
}

/**
 * Whether every character of `query` appears in `text`, in order, **starting at a word**.
 *
 * The word constraint is what makes this tier usable. Without it `pii` matches `ShippingService` — p from
 * Shi**pp**ing, then i, then i — which is a true subsequence and a useless result. With it, `ordsvc` and
 * `svc` both still reach `OrderService`, because `o` and `s` begin `Order` and `Service`.
 */
function subsequence(query: string, text: string): boolean {
  const first = query[0];
  if (first === undefined) return false;
  if (!wordStarts(text).has(first)) return false;

  let at = 0;
  for (const ch of text) {
    if (ch === query[at]) at++;
    if (at === query.length) return true;
  }
  return at === query.length;
}

/**
 * The kinds a query may ask for by name: `pipe commands`, `service:order`.
 *
 * The same vocabulary `views.json` selectors use, so there is one set of words to learn rather than two.
 */
const KIND_WORDS = new Set<string>(Object.keys(KIND_WEIGHT));

export interface Query {
  readonly text: string;
  /** Set when the query named a kind, which then filters rather than ranks. */
  readonly kind?: EntryKind;
}

/** The kind a word names, allowing a plural because `pipes commands` is what people type. */
function kindFor(word: string): EntryKind | undefined {
  const lowered = word.toLowerCase();
  const singular = lowered.endsWith("s") ? lowered.slice(0, -1) : lowered;
  for (const candidate of [lowered, singular]) {
    if (KIND_WORDS.has(candidate)) return candidate as EntryKind;
  }
  return undefined;
}

/**
 * Splits `pipe commands`, `service:order` or a bare `pipes` into a kind filter and the rest.
 *
 * A bare kind word lists that kind, because "what pipes are there" is a real question and typing the
 * word is the obvious way to ask it. The cost is that a declaration actually named `Pipe` is reached by
 * typing more of it, or by `message pipe` — predictable, which beats clever here.
 */
export function parseQuery(raw: string): Query {
  const trimmed = raw.trim();

  const alone = kindFor(trimmed);
  if (alone !== undefined) return { text: "", kind: alone };

  const match = /^([a-z]+)[:\s]+(.*)$/i.exec(trimmed);
  if (match !== null) {
    const kind = kindFor(match[1]!);
    if (kind !== undefined) return { text: match[2]!.trim(), kind };
  }

  return { text: trimmed };
}

/**
 * Scores one entry against a query, or returns 0 for no match.
 *
 * Five tiers, coarse on purpose: an exact name beats a prefix beats a substring beats a match in the
 * package path beats a loose subsequence. Fine-grained scoring would make the order hard to predict,
 * and a palette whose order you cannot predict is one you have to read rather than aim at.
 */
function score(entry: Entry, text: string): number {
  const name = entry.name.toLowerCase();
  const qname = entry.qname.toLowerCase();

  if (name === text) return 100;
  if (name.startsWith(text)) return 90;
  if (name.includes(text)) return 70;
  if (qname.includes(text)) return 50;
  // Only for two characters or more: a single letter matches almost everything as a subsequence, which
  // would bury the real answers under noise at exactly the moment you have typed the least.
  if (text.length >= 2 && subsequence(text, name)) return 30;
  return 0;
}

export interface SearchOptions {
  readonly limit?: number;
  /** Ids currently on the graph. Anything else is reported as a hit that is not drawn. */
  readonly drawn?: ReadonlySet<SelectionId>;
}

/**
 * Ranked matches, best first.
 *
 * An empty query returns nothing rather than everything: a palette that opens full of arbitrary results
 * teaches you to ignore it.
 */
export function search(
  index: readonly Entry[],
  raw: string,
  options: SearchOptions = {},
): Hit[] {
  const { text, kind } = parseQuery(raw);
  const limit = options.limit ?? 20;

  // A kind on its own is a real query — `pipes` means "list the pipes" — so an empty text is only empty
  // when there is no kind either.
  if (text === "" && kind === undefined) return [];

  const lowered = text.toLowerCase();
  const hits: Hit[] = [];

  for (const entry of index) {
    if (kind !== undefined && entry.kind !== kind) continue;
    const base = text === "" ? 60 : score(entry, lowered);
    if (base === 0) continue;
    hits.push({
      ...entry,
      score: base + KIND_WEIGHT[entry.kind],
      drawn: options.drawn === undefined || options.drawn.has(entry.id),
    });
  }

  return hits
    .sort(
      (a, b) =>
        b.score - a.score ||
        // Then a drawn thing before a hidden one, since that is the one you can go to.
        Number(b.drawn) - Number(a.drawn) ||
        a.name.length - b.name.length ||
        (a.qname < b.qname ? -1 : a.qname > b.qname ? 1 : 0),
    )
    .slice(0, limit);
}
