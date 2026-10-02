# 7K Spider

Three views over a [7K](https://github.com/KaiSevelin/7k) model and what happened when it ran: a
**graph** (who talks to whom), a **sequence** (what followed what), and a **timeline** (when, and how
long it waited). Select something in one, and it lights up in all three.

Spider is not part of the 7K language — `00-overview.md` puts it outside — so nothing here constrains
a conforming implementation.

## Status

The **graph** works. Services, pipes, packages and the boundary, laid out so that it holds still.

```
npm install
npm run serve ../7K/examples     # then open http://127.0.0.1:7007
```

It watches the files, so editing a `.7k` redraws the page — and because the layout is deterministic,
the parts you did not change stay where they were.

```
npm test        # 65 tests
npm run build
```

The sequence and timeline views do not exist yet. The **selection model** that will link all three is
built and tested, and the graph already uses it: clicking a node resolves a selection through the same
one function the other two views will.

Read [`docs/design.md`](docs/design.md) first. It settles the selection model, what the graph draws and
why, the increments, and what Spider is allowed to know.

## What it reads

Two inputs, and no others.

**The model**, through `@sevenk/core` — the same lexer, parser, linker and analyses the checker uses,
not a copy and not a serialised form of their output. Core runs in a browser (no `node:` imports,
sources in as strings), so Spider's view of a model cannot drift from the checker's, because it *is*
the checker's.

**A trace**, as NDJSON, through Core's reader — never from the sandbox directly. The trace is one of
7K's published interchange artifacts, which is what makes a trace file a shareable bug report and lets
a converter from OpenTelemetry spans point these views at production.

Being its second consumer is how that format came to be specified at all. Section 7 named the artifact
and described none of it, so this package began with a hand-written copy of the shape inferred from the
sandbox's source — and the copy keyed events on `seq`, which is not unique across a file holding more
than one run. Section 7 is now written and the contract lives in Core, so there is no copy left to
drift.

A trace is optional. The graph is worth drawing before anything has run.

## What the graph draws

**It is bipartite: services and pipes, never service to service.** A message is an edge *label*, not a
node. Nothing in 7K says "service A calls service B", so an A-to-B edge would assert a coupling the
language deliberately does not have — and loose coupling is the thing being described.

**The layout holds still.** ELK's layered algorithm, fed declarations in order. D25 makes stability
matter more than optimality, which rules out force-directed layout outright: a graph that reshuffles
whenever the model changes is the named failure, not a side effect. There is a test that adds a service
and asserts the rest of the graph did not move.

**A node says what matters without being asked.** A lossy pipe is dashed, because nothing may depend on
it for progress. A boundary pipe is bordered, derived from the `@external` marking rather than declared.
An unresolved reference is drawn, not hidden — a half-written model is normal, and a graph that vanished
while you typed would be useless at the moment you need it.

**Only declared packages get a box.** `acme.retail.sales` implies `acme` and `acme.retail`; neither is
drawn, because an implied package is a naming prefix rather than an ownership boundary, and a box would
claim an owner nobody wrote.

## The idea the whole thing rests on

**The trace is the join.** A trace event already names its message, its pipe and its service, plus a
saga and an instance key where it has them, plus a sequence number and an instant — which is enough
to resolve any event to the declarations it touched and to a point in time. Nothing had to be
invented to link the three views; the artifact 7K already publishes does it.

From there, three rules:

- **You select one thing; many things light up.** A selection is singular, a highlight is a set. That
  is what makes "click a service, see everything it did" work with no multi-select UI.
- **Resolution happens once, not once per view.** Three views each resolving for themselves would
  eventually disagree, and a disagreement between two views of one selection is the kind of bug
  nobody can describe out loud.
- **A selection is an identity, never a reference.** Spider re-parses on every keystroke, so a
  selection has to survive the model object it pointed into being discarded — and survive the thing
  it names being deleted.

## Increments

1. **Graph** — services, pipes, packages, the boundary. No trace. **Done.**
2. **Sequence** — a trace as a sequence diagram.
3. **Linked selection and timeline** — the selection model wired to all three views.
4. **Composer, read-only** — build a message and watch it validated.
5. **Mutation** — editing the model from the graph.

Read-only first and mutation last, because the authoring experience already exists in the
[VS Code extension](https://github.com/KaiSevelin/7k-vscode) while surgical mutation is the riskiest
part of this.

## Related

| | |
|---|---|
| [7k](https://github.com/KaiSevelin/7k) | the language, the specification and `@sevenk/core` |
| [7k-sandbox](https://github.com/KaiSevelin/7k-sandbox) | a deterministic runtime; it writes the traces Spider reads |
| [7k-vscode](https://github.com/KaiSevelin/7k-vscode) | the editor |

## License

Apache-2.0.
