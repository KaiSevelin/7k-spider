/**
 * Enough Markdown to read a model's README beside the graph.
 *
 * A *parser*, not a renderer: it returns blocks and spans, and the DOM is built from those in
 * `web/markdown-ui.ts`. Split that way for the same reason the graph is — the part worth testing runs
 * in Node, and the part worth looking at needs a browser.
 *
 * **A deliberate subset**, and the reason is honesty rather than effort. A half-written Markdown
 * renderer that silently mangles a table is worse than one that says what it understands: headings,
 * paragraphs, fenced code, lists, pipe tables, block quotes, rules, and inline code, emphasis and
 * links. Anything else arrives as the text it was written as, which is always readable even when it is
 * not pretty.
 *
 * Nothing here produces HTML. Raw HTML in the source is text like any other, so a README cannot inject
 * anything into the page that renders it — which matters, because a model is a directory somebody else
 * may have written.
 */

export type Span =
  | { readonly k: "text"; readonly text: string }
  | { readonly k: "code"; readonly text: string }
  | { readonly k: "strong"; readonly text: string }
  | { readonly k: "em"; readonly text: string }
  | { readonly k: "link"; readonly text: string; readonly href: string };

export type Block =
  | { readonly k: "heading"; readonly level: number; readonly spans: readonly Span[] }
  | { readonly k: "para"; readonly spans: readonly Span[] }
  | { readonly k: "quote"; readonly spans: readonly Span[] }
  | { readonly k: "code"; readonly text: string; readonly lang?: string }
  | { readonly k: "list"; readonly ordered: boolean; readonly items: readonly (readonly Span[])[] }
  | {
      readonly k: "table";
      readonly head: readonly (readonly Span[])[];
      readonly rows: readonly (readonly (readonly Span[])[])[];
    }
  | { readonly k: "rule" };

/**
 * Schemes a link may use.
 *
 * `javascript:` is the one that matters, but an allow-list rather than a deny-list, because the next
 * scheme worth refusing is always one nobody thought of. A link with any other scheme keeps its text
 * and loses its href, so nothing in the README disappears.
 */
const SAFE = /^(https?:|mailto:)/i;

const HEADING = /^(#{1,6})\s+(.*)$/;
const FENCE = /^```(\S*)\s*$/;
const BULLET = /^[-*]\s+(.*)$/;
const NUMBERED = /^\d+[.)]\s+(.*)$/;
const RULE = /^(-{3,}|\*{3,}|_{3,})$/;
const QUOTE = /^>\s?(.*)$/;
const ROW = /^\|(.*)\|\s*$/;
const DIVIDER = /^\|[\s:|-]+\|\s*$/;

/** Splits a table row on its unescaped pipes. */
const cells = (line: string): string[] =>
  (ROW.exec(line)?.[1] ?? "").split("|").map((c) => c.trim());

/**
 * One line of inline markup.
 *
 * Code spans are taken first and are opaque: `**` inside backticks is two asterisks, which is the one
 * rule that stops a document about syntax from rewriting itself.
 */
export function parseSpans(text: string): Span[] {
  const out: Span[] = [];
  let plain = "";
  const flush = (): void => {
    if (plain !== "") out.push({ k: "text", text: plain });
    plain = "";
  };

  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);

    const code = /^`([^`]+)`/.exec(rest);
    if (code !== null) {
      flush();
      out.push({ k: "code", text: code[1]! });
      i += code[0].length;
      continue;
    }

    const link = /^\[([^\]]*)\]\(([^)\s]+)\)/.exec(rest);
    if (link !== null) {
      flush();
      const [, label, href] = link as unknown as [string, string, string];
      if (SAFE.test(href)) out.push({ k: "link", text: label, href });
      else out.push({ k: "text", text: label });
      i += link[0].length;
      continue;
    }

    const strong = /^\*\*([^*]+)\*\*/.exec(rest);
    if (strong !== null) {
      flush();
      out.push({ k: "strong", text: strong[1]! });
      i += strong[0].length;
      continue;
    }

    const em = /^\*([^*]+)\*/.exec(rest);
    if (em !== null) {
      flush();
      out.push({ k: "em", text: em[1]! });
      i += em[0].length;
      continue;
    }

    plain += text[i];
    i += 1;
  }

  flush();
  return out;
}

/** The blocks a Markdown document is made of, in order. */
export function parseMarkdown(text: string): Block[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    if (line.trim() === "") {
      i += 1;
      continue;
    }

    const fence = FENCE.exec(line.trim());
    if (fence !== null) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i]!.trim())) {
        body.push(lines[i]!);
        i += 1;
      }
      // A file that ends mid-fence still shows what it had, rather than nothing.
      i += 1;
      const lang = fence[1] ?? "";
      blocks.push({ k: "code", text: body.join("\n"), ...(lang === "" ? {} : { lang }) });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading !== null) {
      blocks.push({ k: "heading", level: heading[1]!.length, spans: parseSpans(heading[2]!.trim()) });
      i += 1;
      continue;
    }

    // Before the rule, because `|---|---|` under a header row is a divider and not a thematic break.
    if (ROW.test(line) && i + 1 < lines.length && DIVIDER.test(lines[i + 1]!)) {
      const head = cells(line).map(parseSpans);
      i += 2;
      const rows: Span[][][] = [];
      while (i < lines.length && ROW.test(lines[i]!)) {
        rows.push(cells(lines[i]!).map(parseSpans));
        i += 1;
      }
      blocks.push({ k: "table", head, rows });
      continue;
    }

    if (RULE.test(line.trim())) {
      blocks.push({ k: "rule" });
      i += 1;
      continue;
    }

    const bullet = BULLET.exec(line);
    const numbered = NUMBERED.exec(line);
    if (bullet !== null || numbered !== null) {
      const ordered = numbered !== null;
      const items: string[] = [];
      while (i < lines.length) {
        const at = lines[i]!;
        const next = ordered ? NUMBERED.exec(at) : BULLET.exec(at);
        if (next !== null) {
          items.push(next[1]!);
          i += 1;
          continue;
        }
        // An indented continuation belongs to the item above it, which is how a wrapped bullet is
        // written in every file in this repository.
        if (/^\s+\S/.test(at) && items.length > 0) {
          items[items.length - 1] += ` ${at.trim()}`;
          i += 1;
          continue;
        }
        break;
      }
      blocks.push({ k: "list", ordered, items: items.map(parseSpans) });
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote !== null) {
      const said: string[] = [quote[1]!];
      i += 1;
      while (i < lines.length && QUOTE.test(lines[i]!)) {
        said.push(QUOTE.exec(lines[i]!)![1]!);
        i += 1;
      }
      blocks.push({ k: "quote", spans: parseSpans(said.join(" ").trim()) });
      continue;
    }

    // A paragraph runs to the next blank line or the next thing that is not one.
    const said: string[] = [];
    while (i < lines.length) {
      const at = lines[i]!;
      if (
        at.trim() === "" ||
        HEADING.test(at) ||
        FENCE.test(at.trim()) ||
        RULE.test(at.trim()) ||
        QUOTE.test(at) ||
        ROW.test(at) ||
        BULLET.test(at) ||
        NUMBERED.test(at)
      ) {
        break;
      }
      said.push(at.trim());
      i += 1;
    }
    blocks.push({ k: "para", spans: parseSpans(said.join(" ")) });
  }

  return blocks;
}
