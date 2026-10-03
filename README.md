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
npm run serve ../7K/examples                        # the graph
npm run serve ../7K/examples -- --trace run.ndjson  # and watch a trace play over it
```

Then open http://127.0.0.1:7007. `Space` plays, arrows step, `s` opens the sequence diagram,
`c` the composer, `n` connects two things, `Ctrl-K` finds things, `f` focuses.

It watches the files, so editing a `.7k` redraws the page — and because the layout is deterministic,
the parts you did not change stay where they were.

```
npm test        # 253 tests
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

## Watching a trace

Point it at an NDJSON trace and the messages move. The edge pulses so the path is legible, a dot travels so
the direction is, and a failure — a rejection, a dead letter, a compensation — animates differently,
because those are the events you opened the trace for.

Playback is **event-paced**, because virtual time is not wall time: a scenario where `advance 30d` is
instant would otherwise stall for a simulated month. A real gap earns one extra beat and a mark. The
**timeline** is drawn in virtual time with the gaps at their true size, because that is the one thing a
timeline is for — so the transport compresses and the track tells the truth.

A trace file routinely holds several runs, which cannot be played as one: each starts its clock where it
likes. There is a run picker.

## The sequence diagram

`s` opens it. **Pipes are lifelines, not arrows** — which costs two arrows per hop and buys the two things
a conventional diagram throws away.

It does not invent causality: one publish and three deliveries are four facts, and joining them into
service-to-service arrows would assert something the trace never said and competing consumers make false.

And it shows the waiting, which is the most interesting thing a message-driven system does. Read down a
real trace and the ack timeout and the retry backoff are plain:

```
  +5.0s   failed      ReserveSeats      <- the ack timeout elapsing
  +1.0s   delivered   ReserveSeats      <- the first retry
  +5.0s   failed      ReserveSeats
  +2.0s   delivered   ReserveSeats      <- backoff doubling
```

Selecting in one view highlights in all three, which turned out to be *less* code rather than more: one
`resolve`, and each view renders what it is handed.

## Building a message

`c` opens the composer. Pick a message, fill in a form, watch it validated.

**The form is derived, never configured.** Declare a value with a pattern and an example and you get a
text box that checks the pattern and shows the example, having told the composer nothing. `forms.json` may
override a label, an order or a widget — and carries no validation hints ever, which is enforced rather
than documented.

**Validation comes from Core, not from the JSON Schema projection.** The projection is lossy by design, so
a composer built on one would accept a payload breaking an `invariant` and have no way to say it had
missed something. Validating against Core makes the composer exactly as strict as `7k check`.

## Dragging, and the rule that makes it worth it

Drag a node and it stays dragged, in `.7k/layout.json`.

> **A missing node falls back to auto-layout for that node, not for the view.**

That rules out the obvious implementation. Lay the graph out and then move the saved nodes, and every
*unsaved* node sits where it would have gone if the saved ones were elsewhere — so adding one service
shuffles the picture anyway, just less obviously. Instead a saved node is placed and fixed, and an unsaved
one is nudged only as far as it must be to clear it. No saved position depends on what else exists.

There is a test that re-runs ELK over a bigger graph and asserts the saved node did not budge.

## Editing the model

`n`, then click one end and the other. Because the graph is **bipartite**, a connection is one of exactly
two things and which one follows from which end you started at — so there is nothing to choose and no
handle to miss. Click a service then a pipe and it is an `emits`; the other way round and it is a `reacts`.

Nothing is written until you have read it. The proposal shows the clause **as it will be written** — the
reference through the right import, the file's own indentation — because an editor that wrote the file the
instant two nodes were clicked is one you stop clicking in.

The mutation API is Core's, not Spider's: the specification says "one implementation, three front ends".
Every byte outside the edit is unchanged, and connect-then-disconnect is byte-identical — both verified on
the real examples.

## Three ways to narrow what you are looking at

A **lens** hides durably, because someone saved it in `views.json`. A **focus** hides transiently, derived
from what is selected. A **selection** hides nothing — it emphasises one thing and dims the rest. They
compose in that order, and keeping them apart is what stops a filter becoming something you cannot
switch off.

Both hiding verbs put a **port** where they cut an edge, rather than dropping it. A pipe drawn with
traffic arriving from nowhere is not a partial picture, it is a wrong one, and a reader has no way to
tell.

Focus reaches **two hops** by default, because the graph is bipartite on purpose: a service's neighbours
at one hop are pipes, and "what does this talk to" is a question the decoupling makes you ask twice.

## Finding things

`Ctrl-K` searches the **model**, not the graph — because a message is an edge label rather than a node, and
`OrderPlaced` is exactly the sort of name people remember. Records, values, sagas and schedules are findable
too. A bare kind word lists that kind: `pipes`.

Ranking is deterministic down to the tie-break, so the list never shifts under the cursor. A result the lens
or focus has hidden is still shown, marked *not drawn*, because finding out the thing you wanted is outside
the current view beats not finding it.

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
2. **Replay** — a trace animated over the graph, timeline as transport. **Done.**
3. **Sequence** — a sequence diagram, with all three views linked. **Done.**
4. **Composer, read-only** — build a message and watch it validated. **Done.**
5. **Mutation** — saved layout and editing the model. **Done**, except `rename` and `moveToPackage`.

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
