/**
 * The model as text, beside the model as a graph.
 *
 * A graph answers "what talks to what" and a file answers "what exactly does it say", and the two
 * questions alternate constantly while you read a model. Spider could draw one and not show the other,
 * so the answer to the second was to go and find the file yourself, in another window, and then find
 * your way back to where you were. This is the same model, flipped over.
 *
 * **Coloured by the language's own lexer.** `lex` is Core's, so what is a keyword here is what is a
 * keyword to the checker: a second grammar for highlighting would be a second answer to "is this
 * reserved", and the first time they disagreed the colours would be lying. Every byte is accounted
 * for — a token's `leading` trivia carries the whitespace and the comments before it, which is the
 * same property `reconstruct` relies on to round-trip a file.
 *
 * **Every declaration is a target.** A top-level declaration's span wraps its whole text, so clicking
 * one selects it exactly as clicking a node does, and selecting anywhere else scrolls to it here. That
 * is the whole point of a flip rather than a separate window: the selection is one thing, and both
 * sides of the flip are looking at it.
 *
 * Read-only. Writing is `/mutate`'s job and goes through Core's operations with a preview first
 * (`connect-ui.ts`), and a text box that silently became a second way to write the same file would be
 * a second answer to what the file says.
 */

import { lex, qualify, type Decl, type LinkedModel } from "@sevenk/core";
import type { SelectionId } from "../selection.js";
import { idOf } from "../selection.js";

export interface CodeOptions {
  /** Called with a declaration's selection id when its text is clicked. */
  readonly onSelect: (id: SelectionId) => void;
}

export interface CodeView {
  /** Marks one declaration and brings it into view. */
  show(id: SelectionId | undefined): void;
  destroy(): void;
}

/** A token's class, by what the lexer already decided it is. */
const classOf = (kind: string, keyword: string | undefined): string => {
  if (keyword !== undefined) return "k";
  switch (kind) {
    case "string":
      return "s";
    case "regex":
      return "rx";
    case "int":
    case "decimal":
    case "duration":
    case "size":
    case "version":
      return "n";
    case "punct":
      return "p";
    case "unknown":
      return "bad";
    default:
      return "i";
  }
};

const span = (className: string, text: string): HTMLSpanElement => {
  const node = document.createElement("span");
  node.className = className;
  node.textContent = text;
  return node;
};

/**
 * One file's text, coloured, with each top-level declaration wrapped so it can be clicked.
 *
 * Built by walking the lexer's tokens and their leading trivia, which between them cover every byte.
 * The declarations are consumed in source order, so a token either starts one, sits inside the open
 * one, or falls outside every one.
 */
function fileNode(
  path: string,
  shown: string,
  source: string,
  decls: readonly Decl[],
  options: CodeOptions,
): HTMLElement {
  const wrap = document.createElement("section");
  wrap.className = "codeFile";

  const head = document.createElement("header");
  head.textContent = shown;
  // The whole path on hover, because the short one is for reading and the long one is for finding.
  head.title = path;
  wrap.append(head);

  const pre = document.createElement("pre");
  const mine = [...decls]
    .filter((d) => d.span.file === path)
    .sort((a, b) => a.span.start - b.span.start);

  /** Where the text goes: the open declaration's own box, or the file. */
  let sink: HTMLElement = pre;
  let open: Decl | undefined;
  let next = 0;

  const put = (className: string, text: string, at: number): void => {
    // Close a declaration the moment the text passes its end, before anything else is placed.
    if (open !== undefined && at >= open.span.end) {
      sink = pre;
      open = undefined;
    }
    // And open the next one when its text begins.
    const upcoming = mine[next];
    if (open === undefined && upcoming !== undefined && at >= upcoming.span.start) {
      const box = document.createElement("span");
      box.className = "decl";
      box.dataset["id"] = idOf(upcoming);
      box.title = qualify(upcoming.id);
      box.addEventListener("click", (e) => {
        e.stopPropagation();
        options.onSelect(idOf(upcoming));
      });
      pre.append(box);
      sink = box;
      open = upcoming;
      next += 1;
    }
    sink.append(span(className, text));
  };

  for (const token of lex(source, path).tokens) {
    for (const trivia of token.leading) {
      const className = trivia.kind === "lineComment" || trivia.kind === "blockComment" ? "c" : "w";
      put(className, trivia.text, trivia.start);
    }
    if (token.kind === "eof") continue;
    put(classOf(token.kind, token.keyword), token.text, token.start);
  }

  wrap.append(pre);
  return wrap;
}

/**
 * The paths with the part they all share taken off the front.
 *
 * The server hands over absolute paths, and a column of `C:\tmp\7k-spider\examples\` repeated
 * five times is five times nothing. What is left is what tells one file from another.
 */
export function shortNames(paths: readonly string[]): string[] {
  const split = paths.map((p) => p.split(/[\\/]/));
  const first = split[0] ?? [];
  let common = 0;
  while (
    common < first.length - 1 &&
    split.every((parts) => parts.length > common + 1 && parts[common] === first[common])
  ) {
    common += 1;
  }
  return split.map((parts) => parts.slice(common).join("/"));
}

/** Draws every file of the model, in the order the model holds them. */
export function renderCode(
  container: HTMLElement,
  model: LinkedModel,
  files: readonly { readonly path: string; readonly source: string }[],
  options: CodeOptions,
): CodeView {
  container.replaceChildren();
  // Only what a reader can point at: a declaration has a span of its own, and an upcast is identified
  // by the message and versions it bridges rather than by a name, so it is text like any other.
  const decls = model.decls.filter((d) => d.kind !== "upcast" && d.id.name !== "");

  const shown = shortNames(files.map((f) => f.path));
  for (const [i, file] of files.entries()) {
    container.append(fileNode(file.path, shown[i] ?? file.path, file.source, decls, options));
  }

  let marked: HTMLElement | undefined;

  return {
    show(id) {
      marked?.classList.remove("on");
      marked = undefined;
      if (id === undefined) return;
      const found = container.querySelector<HTMLElement>(`.decl[data-id="${CSS.escape(id)}"]`);
      if (found === null) return;
      found.classList.add("on");
      marked = found;
      found.scrollIntoView({ block: "center", behavior: "smooth" });
    },
    destroy() {
      container.replaceChildren();
    },
  };
}
