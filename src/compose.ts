/**
 * The composer: build a message and watch it validated.
 *
 * **The form is derived, never configured.** A widget comes from the field's kernel type and its
 * constraints, which is what makes this work for a value facet nobody anticipated: declare
 * `value PostCode : string { pattern /…/ }` and the composer offers a text box that checks that pattern,
 * having been told nothing about post codes (D24). `forms.json` may override a label, an order or a
 * widget, and carries **no validation hints ever** — constraints belong to the model, and a second copy
 * in a presentation file is a second source of truth that drifts (`20-ir.md` 6.3).
 *
 * **Validation is Core's.** Not a projection of it: the JSON Schema projection is lossy by design — no
 * invariants, no nominal types (D90) — so validating against a generated schema would accept payloads
 * the model forbids and have no way to say so. Validating against `@sevenk/core` makes the composer
 * exactly as strict as `7k check`, which is the only useful thing for it to be (7k D97).
 *
 * Read-only in the sense that matters: it builds a payload and tells you whether it is one. Sending it is
 * a runtime's job.
 */

import {
  bounds,
  examples,
  fieldSpec,
  normalizeValue,
  specOfDecl,
  validate,
  type Decl,
  type FieldIr,
  type JsonValue,
  type LinkedModel,
  type Problem,
  type Spec,
} from "@sevenk/core";

/** How a field is edited. Derived from its type and constraints, never declared. */
export type Widget =
  | "text"
  | "textarea"
  | "number"
  | "decimal"
  | "checkbox"
  | "select"
  | "date"
  | "instant"
  | "duration"
  | "uuid"
  | "bytes"
  /** A nested record: its own set of fields. */
  | "group"
  /** A list: zero or more of whatever its item is. */
  | "list"
  /** A `map<K,V>`: an unversioned extension point (D91), so free key/value pairs. */
  | "dictionary"
  /** Something the model did not resolve. Shown, not hidden: a half-written model is normal (D20). */
  | "unknown";

export interface Field {
  readonly name: string;
  readonly label: string;
  readonly path: string;
  readonly widget: Widget;
  readonly optional: boolean;
  readonly spec: Spec;
  /** For a `select`: the members, in declared order. */
  readonly options?: readonly string[];
  /** Nested fields, for a group or a list of groups. */
  readonly fields?: readonly Field[];
  /** What the model says about the bounds, for a hint beside the input. */
  readonly hint?: string;
  /** A declared `example`, which is the best placeholder there is. */
  readonly placeholder?: string;
  /** True when the field is a `@role(businessKey)` and so identifies the work. */
  readonly key?: boolean;
}

export interface Form {
  readonly id: string;
  readonly qname: string;
  readonly kind: "message" | "record" | "envelope";
  readonly fields: readonly Field[];
}

/** `forms.json`: optional overrides, and never validation. */
export interface FormHints {
  readonly order?: readonly string[];
  readonly fields?: Readonly<Record<string, { readonly label?: string; readonly widget?: string }>>;
}

export type Forms = Readonly<Record<string, FormHints>>;

/** Turns `postCode` into `Post code`: a label a reader did not have to be given. */
export function labelOf(name: string): string {
  const spaced = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

const KERNEL_WIDGET: Readonly<Record<string, Widget>> = {
  bool: "checkbox",
  int: "number",
  float: "number",
  decimal: "decimal",
  string: "text",
  bytes: "bytes",
  uuid: "uuid",
  instant: "instant",
  duration: "duration",
  date: "date",
};

/**
 * Which widget a spec deserves.
 *
 * A `string` with a long `length` gets a textarea, because a 2000-character field in a one-line box is a
 * form nobody can fill in. That is the only place a constraint changes the *kind* of input rather than
 * what it accepts.
 */
function widgetFor(spec: Spec, options: readonly string[] | undefined): Widget {
  if (options !== undefined) return "select";
  switch (spec.shape) {
    case "record":
      return "group";
    case "list":
      return "list";
    case "map":
      return "dictionary";
    case "enum":
      return "select";
    case "unknown":
      return "unknown";
    default: {
      const widget = KERNEL_WIDGET[spec.kernel ?? ""] ?? "text";
      if (widget !== "text") return widget;
      const length = bounds(constraintArgs(spec, "length"));
      return (length.max ?? 0) > 120 ? "textarea" : "text";
    }
  }
}

const constraintArgs = (spec: Spec, name: string): readonly string[] =>
  spec.constraints.find((c) => c.name === name)?.args ?? [];

/** What the model says about a field's bounds, in a line a reader can act on. */
function hintFor(spec: Spec): string | undefined {
  const parts: string[] = [];

  for (const which of ["length", "size"] as const) {
    const b = bounds(constraintArgs(spec, which));
    if (b.min !== undefined || b.max !== undefined) {
      parts.push(`${which} ${b.min ?? ""}..${b.max ?? ""}`);
    }
  }
  const range = bounds(constraintArgs(spec, "range"));
  if (range.min !== undefined || range.max !== undefined) {
    parts.push(`range ${range.min ?? ""}..${range.max ?? ""}`);
  }
  const pattern = spec.constraints.find((c) => c.name === "pattern");
  if (pattern !== undefined) parts.push("a pattern");
  const normalize = spec.constraints.find((c) => c.name === "normalize");
  if (normalize !== undefined) parts.push(`normalized: ${normalize.args.join(", ")}`);

  return parts.length === 0 ? undefined : parts.join(" · ");
}

/** A declared `example`, which beats any placeholder a tool could invent. */
function placeholderFor(spec: Spec): string | undefined {
  const declared = examples(spec);
  return declared[0];
}

/** An enum's members, in declared order. Off the spec, which already resolved them. */
const enumMembers = (spec: Spec): readonly string[] | undefined =>
  spec.shape === "enum" ? spec.members : undefined;

/**
 * Derives a form from a declaration.
 *
 * Depth-limited, because a record may refer to itself: `record Node { next: Node? }` is legal, and a form
 * is not the place to discover that. Beyond the limit a group simply has no children, which renders as a
 * group you cannot expand rather than as a crash.
 */
export function formOf(
  model: LinkedModel,
  decl: Decl,
  hints: Forms = {},
  depth = 0,
): Form {
  const qname = `${decl.id.pkg}.${decl.id.name}`;
  const spec = specOfDecl(model, decl, [], 0);
  return {
    id: `${decl.id.kind}:${qname}`,
    qname,
    kind: decl.id.kind as Form["kind"],
    fields: fieldsOf(model, spec, hints, "", depth, `${decl.id.kind}:${qname}`),
  };
}

/**
 * The fields of a spec, in the order the form should show them.
 *
 * Driven by the spec rather than by the declaration, because the spec already resolved the chain the
 * field came from — including an `include` splice, which is exactly where a second resolution would
 * diverge from Core's.
 */
function fieldsOf(
  model: LinkedModel,
  spec: Spec,
  hints: Forms,
  prefix: string,
  depth: number,
  hintKey?: string,
): Field[] {
  if (depth > 8 || spec.fields === undefined) return [];

  const own = hintKey === undefined ? undefined : hints[hintKey];
  return order(spec.fields, own?.order).map((field) =>
    toField(model, field, hints, prefix, depth, own),
  );
}

/**
 * Applies `forms.json`'s `order`, which is **partial**.
 *
 * Listed fields come first in that order and the rest follow in declaration order, so adding a field does
 * not require editing the sidecar to keep it from disappearing (`20-ir.md` 6.3).
 */
function order(fields: readonly FieldIr[], wanted: readonly string[] | undefined): FieldIr[] {
  if (wanted === undefined) return [...fields];
  const named = wanted
    .map((name) => fields.find((f) => f.name === name))
    .filter((f): f is FieldIr => f !== undefined);
  const rest = fields.filter((f) => !named.includes(f));
  return [...named, ...rest];
}

const WIDGET_NAMES = new Set<string>([
  "text", "textarea", "number", "decimal", "checkbox", "select",
  "date", "instant", "duration", "uuid", "bytes", "group", "list", "dictionary",
]);

function toField(
  model: LinkedModel,
  field: FieldIr,
  hints: Forms,
  prefix: string,
  depth: number,
  own: FormHints | undefined,
): Field {
  const spec = fieldSpec(model, field);
  const path = prefix === "" ? field.name : `${prefix}.${field.name}`;
  const options = enumMembers(spec);
  const derived = widgetFor(spec, options);

  // A widget name in `forms.json` is advisory: a host that does not recognise one falls back to the
  // derived widget, which keeps the sidecar from becoming a UI API every tool must implement.
  const asked = own?.fields?.[field.name]?.widget;
  const widget = asked !== undefined && WIDGET_NAMES.has(asked) ? (asked as Widget) : derived;

  // A group's children, and a list's item where the item is itself a record.
  const inner = spec.shape === "list" ? spec.item : spec;
  const nested =
    inner !== undefined && inner.shape === "record"
      ? fieldsOf(
          model,
          inner,
          hints,
          path,
          depth + 1,
          // `named` is the declaration the spec came from, which is how a nested record finds its own
          // hints: an `Address` inside an order is still an `Address`.
          inner.named === undefined ? undefined : `record:${inner.named}`,
        )
      : undefined;

  return {
    name: field.name,
    label: own?.fields?.[field.name]?.label ?? labelOf(field.name),
    path,
    widget,
    optional: field.optional,
    spec,
    ...(options === undefined ? {} : { options }),
    ...(nested === undefined || nested.length === 0 ? {} : { fields: nested }),
    ...(hintFor(spec) === undefined ? {} : { hint: hintFor(spec)! }),
    ...(placeholderFor(spec) === undefined ? {} : { placeholder: placeholderFor(spec)! }),
    ...(field.role === "businessKey" ? { key: true } : {}),
  };
}

// ---- validation -------------------------------------------------------------

export interface Checked {
  /** The payload after the model's declared normalizations. */
  readonly normalized: JsonValue;
  /** What the contract says is wrong, by path. Empty means it is a valid payload. */
  readonly problems: readonly Problem[];
  /** The canonical JSON a runtime would put on the wire, or undefined while it is invalid. */
  readonly canonical?: string;
}

/**
 * Normalizes and validates a payload against a declaration.
 *
 * Normalize first, then validate, which is the order a runtime uses: `normalize trim` means a value with
 * spaces around it *is* the trimmed value, so validating before normalizing would reject a payload that
 * the contract accepts.
 */
export function check(model: LinkedModel, decl: Decl, value: JsonValue): Checked {
  const spec = specOfDecl(model, decl, [], 0);
  const normalized = normalizeValue(model, spec, value);
  const problems = validate(model, spec, normalized);
  return {
    normalized,
    problems,
    // Only when it is valid: canonical JSON of something that is not a legal payload would be a confident
    // artifact about something nobody agreed on.
    ...(problems.length === 0 ? { canonical: JSON.stringify(normalized, null, 2) } : {}),
  };
}

/**
 * An empty payload for a form: every required field present and blank, optional ones absent.
 *
 * Blank rather than invented. A composer that filled a form with plausible values would be a composer you
 * stop reading — and `"$auto"` generation belongs to a runtime with a seed, not to a form (D97).
 */
export function blank(fields: readonly Field[]): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const field of fields) {
    if (field.optional) continue;
    switch (field.widget) {
      case "checkbox":
        out[field.name] = false;
        break;
      case "list":
        out[field.name] = [];
        break;
      case "group":
        out[field.name] = field.fields === undefined ? {} : blank(field.fields);
        break;
      case "dictionary":
        out[field.name] = {};
        break;
      case "select":
        out[field.name] = field.options?.[0] ?? "";
        break;
      default:
        out[field.name] = "";
    }
  }
  return out;
}

/** The declarations a composer can build: messages first, since that is what travels. */
export function composable(model: LinkedModel): Decl[] {
  const rank = (d: Decl): number => (d.kind === "message" ? 0 : d.kind === "record" ? 1 : 2);
  return model.decls
    .filter((d) => d.kind === "message" || d.kind === "record" || d.kind === "envelope")
    .sort((a, b) => rank(a) - rank(b) || (a.id.name < b.id.name ? -1 : 1));
}

/** Reads `forms.json`, tolerantly: it is optional, hand-edited and carries no validation. */
export function parseForms(text: string): { forms: Forms; problems: string[] } {
  const problems: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    return { forms: {}, problems: [`not JSON: ${cause instanceof Error ? cause.message : ""}`] };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { forms: {}, problems: ["not a JSON object"] };
  }

  const forms: Record<string, FormHints> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key.startsWith("_")) continue;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      problems.push(`\`${key}\` is not a set of hints`);
      continue;
    }
    const entry = value as { order?: unknown; fields?: unknown };

    // The rule worth enforcing rather than merely documenting: no validation hints, ever.
    for (const banned of ["length", "range", "pattern", "required", "constraints"]) {
      if (banned in entry) {
        problems.push(
          `\`${key}\`.${banned}: forms.json carries no validation. Constraints belong to the model`,
        );
      }
    }

    const wanted = Array.isArray(entry.order) && entry.order.every((x) => typeof x === "string")
      ? (entry.order as string[])
      : undefined;
    const fields =
      typeof entry.fields === "object" && entry.fields !== null && !Array.isArray(entry.fields)
        ? (entry.fields as NonNullable<FormHints["fields"]>)
        : undefined;

    forms[key] = {
      ...(wanted === undefined ? {} : { order: wanted }),
      ...(fields === undefined ? {} : { fields }),
    };
  }

  return { forms, problems };
}

/** Whether a declaration resolved at all, so a form can say so rather than render nothing. */
export const resolvedFields = (fields: readonly Field[]): number =>
  fields.filter((f) => f.widget !== "unknown").length;
