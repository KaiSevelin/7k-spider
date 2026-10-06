/**
 * Rendering a derived form.
 *
 * Every input here comes from a field's kernel type and its constraints — there is no table of known
 * facets, and that is the point (D24). A value declared with a pattern gets a text box that checks it.
 *
 * Kept out of `main.ts` because it is the only part of the page that is a form rather than a view, and
 * out of `compose.ts` because that half is pure and testable.
 */

import type { JsonValue } from "@sevenk/core";
import { blank, type Field, type Form } from "../compose.js";

export interface FormRender {
  /** Problems by path, so each field can show what is wrong with it. */
  readonly problems: ReadonlyMap<string, readonly string[]>;
  /**
   * An edit happened.
   *
   * `structural` is true only when the *shape* of the form changed — a list item added or removed, a
   * map key added or renamed — and is what tells the caller it has to build the nodes again. Typing a
   * character does not: it was rebuilding the whole form on every keystroke, which replaced the very
   * input being typed into, so focus fell back to the page and the next letter was read as a shortcut.
   * One character went in and the rest opened panels.
   */
  readonly onChange: (structural?: boolean) => void;
}

const tag = <K extends keyof HTMLElementTagNameMap>(
  name: K,
  className?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(name);
  if (className !== undefined) node.className = className;
  return node;
};

/** Reads a dotted path out of a payload. */
function read(root: JsonValue, path: readonly (string | number)[]): JsonValue {
  let at: JsonValue = root;
  for (const step of path) {
    if (at === null || typeof at !== "object") return undefined as unknown as JsonValue;
    at = (at as Record<string, JsonValue>)[String(step)] as JsonValue;
  }
  return at;
}

/** Writes a dotted path into a payload, making the objects on the way. */
function write(root: Record<string, JsonValue>, path: readonly (string | number)[], value: JsonValue): void {
  let at: Record<string, JsonValue> = root;
  for (const step of path.slice(0, -1)) {
    const key = String(step);
    const next = at[key];
    if (next === null || typeof next !== "object") at[key] = {};
    at = at[key] as Record<string, JsonValue>;
  }
  const last = String(path[path.length - 1]);
  if (value === undefined) delete at[last];
  else at[last] = value;
}

/**
 * Draws a form into a container, reading and writing one payload object.
 *
 * The payload is mutated in place and `onChange` fires after every edit, so validation is live. A form
 * that only told you what was wrong when you asked would be a form you stop trusting.
 */
export function renderForm(
  container: HTMLElement,
  form: Form,
  payload: Record<string, JsonValue>,
  render: FormRender,
): void {
  container.replaceChildren();
  for (const field of form.fields) {
    container.append(fieldNode(field, payload, [], render));
  }
}

function label(field: Field): HTMLLabelElement {
  const node = tag("label");
  node.textContent = field.label;
  if (!field.optional) {
    const req = tag("span", "req");
    req.textContent = " *";
    req.title = "required";
    node.append(req);
  }
  if (field.key === true) {
    const key = tag("span", "key");
    key.textContent = " key";
    key.title = "@role(businessKey): this identifies the work";
    node.append(key);
  }
  return node;
}

function problemsFor(render: FormRender, path: string): readonly string[] {
  // The contract reports by path, and a nested problem names its own path, so a field shows only its own.
  return render.problems.get(path) ?? [];
}

function decorate(wrap: HTMLElement, field: Field, path: string, render: FormRender): void {
  // What `repaint` needs to do this again without the `Field`, so marking a form as wrong never means
  // building it again.
  wrap.dataset["path"] = path;
  if (field.hint !== undefined) wrap.dataset["hint"] = field.hint;
  paint(wrap, problemsFor(render, path));
}

/** The part of a field that changes as you type: the mark, the hint, the messages. */
function paint(wrap: HTMLElement, bad: readonly string[]): void {
  for (const old of wrap.querySelectorAll(":scope > .hint, :scope > .bad")) old.remove();
  wrap.classList.toggle("invalid", bad.length > 0);

  const hint = wrap.dataset["hint"];
  if (hint !== undefined && bad.length === 0) {
    const node = tag("div", "hint");
    node.textContent = hint;
    wrap.append(node);
  }
  for (const message of bad) {
    const line = tag("div", "bad");
    line.textContent = message;
    wrap.append(line);
  }
}

/**
 * Re-marks what is wrong, in the nodes that are already there.
 *
 * The whole point: validation stays live on every keystroke, and the input you are typing into is the
 * same element afterwards, so it keeps focus and its caret. Only a change of shape rebuilds.
 */
export function refreshProblems(container: HTMLElement, render: FormRender): void {
  for (const wrap of container.querySelectorAll<HTMLElement>("[data-path]")) {
    paint(wrap, problemsFor(render, wrap.dataset["path"] ?? ""));
  }
}

function fieldNode(
  field: Field,
  payload: Record<string, JsonValue>,
  prefix: readonly (string | number)[],
  render: FormRender,
): HTMLElement {
  const path = [...prefix, field.name];
  const key = path.join(".");

  if (field.widget === "group") {
    const group = tag("div", "group");
    const name = tag("div", "groupName");
    name.textContent = field.label;
    group.append(name);
    for (const inner of field.fields ?? []) {
      group.append(fieldNode(inner, payload, path, render));
    }
    decorate(group, field, key, render);
    return group;
  }

  if (field.widget === "list") return listNode(field, payload, path, render);
  if (field.widget === "dictionary") return dictionaryNode(field, payload, path, render);

  const wrap = tag("div", "f");
  wrap.append(label(field));

  const current = read(payload, path);
  const set = (value: JsonValue): void => {
    write(payload, path, value);
    render.onChange();
  };

  if (field.widget === "unknown") {
    // Shown, not hidden: a half-written model is normal, and the field the author typed is more use to
    // them than a gap (D20).
    const note = tag("div", "unknownField");
    note.textContent = "this type did not resolve";
    wrap.append(note);
    decorate(wrap, field, key, render);
    return wrap;
  }

  if (field.widget === "checkbox") {
    const input = tag("input");
    input.type = "checkbox";
    input.checked = current === true;
    input.addEventListener("change", () => set(input.checked));
    wrap.append(input);
  } else if (field.widget === "select") {
    const select = tag("select");
    for (const option of field.options ?? []) {
      const node = tag("option");
      node.value = option;
      node.textContent = option;
      select.append(node);
    }
    select.value = typeof current === "string" ? current : (field.options?.[0] ?? "");
    select.addEventListener("change", () => set(select.value));
    wrap.append(select);
  } else if (field.widget === "textarea") {
    const area = tag("textarea");
    area.value = typeof current === "string" ? current : "";
    if (field.placeholder !== undefined) area.placeholder = field.placeholder;
    area.addEventListener("input", () => set(area.value));
    wrap.append(area);
  } else {
    const input = tag("input");
    // `number` only for an int or a float. A decimal travels as a string and must not round-trip through
    // a double (`01-kernel.md` 7.1), so it gets a text box.
    input.type = field.widget === "number" ? "number" : "text";
    input.value = current === undefined || current === null ? "" : String(current);
    if (field.placeholder !== undefined) input.placeholder = field.placeholder;
    input.addEventListener("input", () => {
      if (field.widget === "number") {
        const n = Number(input.value);
        set(input.value === "" ? "" : Number.isFinite(n) ? n : input.value);
      } else set(input.value);
    });
    wrap.append(input);
  }

  decorate(wrap, field, key, render);
  return wrap;
}

function listNode(
  field: Field,
  payload: Record<string, JsonValue>,
  path: readonly (string | number)[],
  render: FormRender,
): HTMLElement {
  const group = tag("div", "group");
  const name = tag("div", "groupName");
  name.textContent = `${field.label}${field.hint === undefined ? "" : ` — ${field.hint}`}`;
  group.append(name);

  const items = Array.isArray(read(payload, path)) ? (read(payload, path) as JsonValue[]) : [];

  items.forEach((_, i) => {
    const row = tag("div", "listItem");
    const inner = tag("div");
    if (field.fields !== undefined) {
      for (const child of field.fields) inner.append(fieldNode(child, payload, [...path, i], render));
    } else {
      // A list of scalars: one input, the item's own spec.
      const scalar: Field = { ...field, widget: itemWidget(field), label: `${field.label} ${i + 1}` };
      inner.append(fieldNode({ ...scalar, name: String(i) }, payload, path, render));
    }
    const remove = tag("button", "rowBtn");
    remove.type = "button";
    remove.textContent = "−";
    remove.title = "remove";
    remove.addEventListener("click", () => {
      items.splice(i, 1);
      render.onChange(true);
    });
    row.append(inner, remove);
    group.append(row);
  });

  const add = tag("button", "rowBtn");
  add.type = "button";
  add.textContent = "+ add";
  add.addEventListener("click", () => {
    items.push(field.fields === undefined ? "" : blank(field.fields));
    write(payload, path, items as JsonValue);
    render.onChange(true);
  });
  group.append(add);

  decorate(group, field, path.join("."), render);
  return group;
}

/** A list's item widget, where the item is not a record. */
const itemWidget = (field: Field): Field["widget"] => {
  const kernel = field.spec.item?.kernel;
  if (kernel === "int" || kernel === "float") return "number";
  if (kernel === "bool") return "checkbox";
  return "text";
};

/**
 * A `map<K,V>`: free key/value pairs.
 *
 * Deliberately unstructured, because that is what the type is for. A map has no declared keys, so adding
 * one triggers no version bump — it is an unversioned extension point, and a form that pretended
 * otherwise would be claiming a contract that does not exist (D91).
 */
function dictionaryNode(
  field: Field,
  payload: Record<string, JsonValue>,
  path: readonly (string | number)[],
  render: FormRender,
): HTMLElement {
  const group = tag("div", "group");
  const name = tag("div", "groupName");
  name.textContent = `${field.label} — any keys`;
  group.append(name);

  const current = read(payload, path);
  const entries =
    current !== null && typeof current === "object" && !Array.isArray(current)
      ? Object.entries(current as Record<string, JsonValue>)
      : [];

  // Structural, and safely so: these inputs commit on `change`, which fires when they lose focus, so
  // rebuilding here cannot take the field out from under somebody mid-word. A map's keys *are* its
  // shape — renaming one is not the same kind of edit as typing into a declared field.
  const commit = (pairs: [string, JsonValue][]): void => {
    write(payload, path, Object.fromEntries(pairs.filter(([k]) => k !== "")) as JsonValue);
    render.onChange(true);
  };

  entries.forEach(([k, v], i) => {
    const row = tag("div", "listItem");
    const keyInput = tag("input");
    keyInput.type = "text";
    keyInput.value = k;
    keyInput.placeholder = "key";
    const valueInput = tag("input");
    valueInput.type = "text";
    valueInput.value = v === undefined || v === null ? "" : String(v);
    valueInput.placeholder = "value";

    const push = (): void => {
      const pairs = entries.map(([ek, ev], j) =>
        j === i ? ([keyInput.value, valueInput.value] as [string, JsonValue]) : ([ek, ev] as [string, JsonValue]),
      );
      commit(pairs);
    };
    keyInput.addEventListener("change", push);
    valueInput.addEventListener("change", push);

    const remove = tag("button", "rowBtn");
    remove.type = "button";
    remove.textContent = "−";
    remove.addEventListener("click", () => commit(entries.filter((_, j) => j !== i)));

    const wrap = tag("div");
    wrap.style.display = "flex";
    wrap.style.gap = "6px";
    wrap.append(keyInput, valueInput);
    row.append(wrap, remove);
    group.append(row);
  });

  const add = tag("button", "rowBtn");
  add.type = "button";
  add.textContent = "+ add";
  add.addEventListener("click", () => commit([...entries, ["", ""]]));
  group.append(add);

  decorate(group, field, path.join("."), render);
  return group;
}
