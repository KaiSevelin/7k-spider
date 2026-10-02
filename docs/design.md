# 7K Spider — design

Spider is how you look at a 7K model and at what happened when it ran. Three views over one model:
a **graph** (space — who talks to whom), a **sequence** (interaction — what followed what), and a
**timeline** (time — when, and how long it waited). Selecting in one highlights in all three.

Spider is not part of the 7K language. `00-overview.md` puts it outside, so nothing here constrains
a conforming implementation, and this document lives in this repository rather than in `docs/spec/`.

## 1. What Spider is allowed to know

Two inputs, and no others.

**The model**, through `@sevenk/core`. Spider lexes, parses, links and analyses with the same code
the checker uses — not a copy of it, and not a serialised form of its output. This is possible
because Core runs in a browser: there is no `node:` import anywhere in `packages/core/src`, and
`buildWorkspace` takes sources as strings. So the IR serialisation format a plan like this would
otherwise need does not have to exist, and Spider's view of a model cannot drift from the checker's,
because it *is* the checker's.

**The trace**, as NDJSON, through Core's `readTrace`. Never the sandbox: `30-scenarios.md` section 7
makes the trace an interchange artifact precisely so that a trace file is a shareable bug report and a
converter from OpenTelemetry spans can point these views at production. The format is defined in Core,
so a producer and a consumer import one definition rather than agreeing twice.

A trace is **optional**. The graph is worth drawing before anything has run, and the first increment
has no trace at all.

### What the trace pins down

Writing the first consumer of the trace format turned up a gap, and closing it changed this design, so
it belongs here.

`30-scenarios.md` section 7 declared the trace "the third of 7K's published interchange artifacts" and
then specified none of it: no field list, no event kinds, no rule for how names are written. The format
existed as a TypeScript interface in the sandbox — the one place section 7 says a tool must not read —
so this file held a hand-written copy of it, inferred from that producer's source.

Section 7 is now written, and the contract lives in `@sevenk/core` (D93). Spider imports `TraceEvent`,
`readTrace` and `eventKey` rather than restating them, so there is no copy left to drift. Four things
that inference had got wrong or could not have known:

- **An event's identity is `(run, seq)`, not `seq`.** `seq` restarts at 0 for each run, so a file of
  two runs has two events numbered 0 — which the sandbox's own `--ndjson` across several scenarios
  produced. Spider's first selection model keyed events on `seq` alone and would have merged them.
- **`service` is qualified**, like every other name. It used to be bare, which left two packages each
  declaring a `PickingService` indistinguishable.
- **`published` may carry no `service` at all**, because a message the scenario published itself has no
  originating service. Filling the field with something that is not a declaration would be worse.
- **Field order is fixed**, so two runs of one scenario produce byte-identical files and a trace diffs.

Spider still tolerates a bare service name, because section 7.7 makes a converter from another
observability format a legitimate lesser producer. It resolves one only when exactly one declaration
matches, and records the collision in `Join.ambiguous` otherwise — highlighting the wrong service is
worse than highlighting neither, and picking the first match would bury the problem for good.

## 2. The selection model

D25 says "selecting in one view highlights in all three" and stops, which leaves the hard part
unsaid: the three views show different kinds of thing. The graph shows declarations, the sequence
shows trace events, the timeline shows instants. The sentence only means something once there is a
mapping between them.

The mapping rests on one observation. **The trace is the join.** A trace event names its message, its
pipe and its service, plus a saga and an instance key where it has them, plus a sequence number and
an instant — which is already enough to resolve any event to the declarations it touched and to a
point in time. Nothing needs to be invented to correlate the views; the artifact 7K already
publishes does it.

### 2.1 You select one thing; many things light up

A **selection** is singular. A **highlight** is a set.

```ts
type Selection =
  | { k: "declaration"; id: SelectionId }      // anything the graph draws
  | { k: "event"; run: string; seq: number }   // one trace event
  | { k: "instance"; saga: string; key: string } // one saga instance
  | { k: "interval"; from: Instant; to: Instant } // a stretch of clock
  | { k: "none" }

interface Highlight {
  declarations: ReadonlySet<SelectionId>
  events: ReadonlySet<EventKey>
  interval?: Interval
}
```

That asymmetry is what makes "click a service, see everything it did" work without a multi-select
UI, and what keeps the three views from needing to agree on a shared cursor.

Four selection kinds, because there are four questions a reader asks of a system that has run: *what
is this thing*, *what happened here*, *where did this one instance get to*, and *what was going on
then*. A saga instance is one of them and is **not** a declaration — `Fulfilment["order-1"]` is not
something the model declares — so it is its own kind rather than a declaration with a suffix.

### 2.2 Resolution happens once, not once per view

There is one function:

```ts
resolve(join: Join, selection: Selection): Highlight
```

Each view renders what it is handed: the graph emphasises `declarations` and dims the rest, the
sequence scrolls to and marks `events`, the timeline brackets `interval`.

The alternative — each view resolving the selection for itself — would eventually have two views
disagreeing about one selection, and a disagreement between two views of the same thing is the class
of bug nobody can describe out loud, let alone file. One resolver makes that impossible rather than
unlikely.

Selecting a declaration emphasises **that declaration only**, not its neighbours. Lighting up every
pipe a service touches would wash the graph out, and the service's edges are already visible through
its events.

### 2.3 A selection is an identity, never a reference

Spider re-parses on every keystroke, so a selection must survive the model object it pointed into
being discarded. Every selection is therefore a string id, an event key or an instance key — never a
`Decl`.

Three consequences, all asserted in [`test/selection.test.ts`](../test/selection.test.ts):

- A selection **survives a re-parse**, which is the whole point.
- A selection **survives the thing it names being deleted**. It resolves to an empty highlight, and
  the id stays emphasised — because a view that dropped the selection on a transient parse failure
  would lose it on every keystroke.
- An **event identity is `(run, seq)`**, never an index into a filtered array. Filtering the sequence
  view is a feature; an index that shifts when a filter changes is a bug waiting for it. And never
  `seq` alone, which is not unique in a file holding more than one run.

### 2.4 The id form is the one the sidecars already use

A declaration's selection id is `service:acme.sales.OrderService` — the selector form `layout.json`
keys a position by and `views.json` writes a lens with (`20-ir.md` 6.1, 6.2). One id form spans
selection, layout and lenses, so a rename touches all three the same way.

Core's `symbolKey` was the obvious alternative and is the wrong choice: it is case-folded and
NUL-separated, which is correct for a lookup key and unusable in a URL fragment or a JSON key, and
it would be a second id form to keep in step with the first. `declById` bridges the two, and it
checks the kind — one package namespaces all kinds together (D40), so a lookup that ignored the kind
would answer a pipe when asked for a service of the same name.

A **dead-letter pipe is selectable** even though it is not a declaration. It is a node on the graph,
`views.json` already addresses it, and selecting it also highlights the pipe it belongs to: a reader
clicking a dead letter means "show me that queue".

### 2.5 The join is built once

`join(model, trace)` indexes the two against each other up front — events per declaration,
declarations per event, the instances the trace mentions, its extent. `resolve` runs on every click
and hover, and a linear scan of the trace per name per event is the difference between a graph that
responds and one that stutters.

A re-parse builds a new join; selections carry over untouched.

## 3. The graph

Increment 1. Services, pipes, packages and the boundary, with no trace.

### 3.1 It is bipartite: services and pipes, never service to service

A message is an edge **label**, not a node.

That mirrors the model exactly. A service declares `emits M to p` and `reacts M from p`, and nothing in
7K says "service A calls service B" — so an A-to-B edge would assert a coupling the language
deliberately does not have. Loose coupling is the thing being described; drawing it away in the first
picture would be an odd way to start.

Two consequences that look like omissions and are not:

- "What talks to OrderService" takes two edges to answer rather than one. That is the honest answer:
  both services are coupled to a *pipe*, and either can be replaced without the other knowing.
- Several messages between one service and one pipe collapse into **one edge with several labels**. Six
  messages to one pipe are one relationship, and six parallel curves would say otherwise while also
  being unreadable.

But two **named subscriptions** of one service on one pipe stay two edges. `as <name>` exists to tell a
fast path from a slow batch path (`03-topology.md` 2.4), and collapsing them would throw away the only
thing that distinguishes them. The edge id is `from -> to`, which is what `layout.json` keys an edge by,
and gains a `#<subscription>` suffix only where it must — so the ordinary edge keeps the layout file's
spelling.

### 3.2 Only declared packages get a box

`acme.retail.sales` implies `acme` and `acme.retail` in the model. Neither gets drawn.

A package is "the namespace, the ownership boundary and the unit of contract at once"
(`03-topology.md`), and an implied one is none of those — it is a naming prefix. A box around it would
claim an owner nobody wrote. `PackageIr.declared` exists for exactly this distinction.

So nesting **skips** an implied level: a declared `acme.a.b` sits directly inside a declared `acme`,
labelled `a.b` rather than wrapped in an invented `a`. A declaration whose own package is undeclared
goes in the nearest declared ancestor, because it still belongs somewhere — floating it outside every
box would read as "not in a package" rather than "this package was never declared".

An empty package is left out too. It survives in the model, because it was declared, but an empty box
suggests something is missing from the picture rather than from the package.

### 3.3 What a node shows without being asked

Shape carries structure, because colour is already carrying boundary and selection:

| | |
|---|---|
| queue, topic, stream | rectangle, hexagon, barrel — a queue competes, a topic fans out, a stream is a log |
| `@external` service | a dashed tag, not a service. 7K describes no behaviour for one; drawing it solid would claim otherwise |
| a boundary pipe | a thick accent border. Derived from the `@external` marking, never declared (`03-topology.md` 1.6) |
| `delivery at-most-once` | dashed. It may lose a message, so nothing may depend on it for progress — the sort of thing a reader should not have to hover to find out |
| a dead-letter pipe | dotted and muted, and off by default. It is what you turn on when looking at a failure |
| anything unresolved | a doubled warning border, because a half-written model is normal (D20) and a graph that vanished while you typed would be useless at the moment you need it |

### 3.4 Layout

ELK's `layered` algorithm, flowing down the page, fed nodes and edges in declaration order.

D25 makes stability matter more than optimality, which rules out force-directed layout outright: a
graph that reshuffles whenever the model changes is the named failure, not a side effect. Nothing
animates on a relayout either — an animated reshuffle is a reshuffle you watched happen.

[`test/layout.test.ts`](../test/layout.test.ts) asserts this against real Cytoscape and real ELK,
headlessly: the same model lays out identically twice, and **adding a service leaves the rest of the
graph where it was**. That last one is the requirement in a single test, and a force-directed layout
fails it outright.

`collect` sorts the files it finds for the same reason. A graph seeded by a directory listing would
differ between two machines looking at one repository.

### 3.5 What is not here yet

**Ports are not drawn as connection points.** D92 planned for boundary ports as child nodes on a
parent's perimeter, because Cytoscape has no port concept. At increment 1's edge density an edge
meeting a node's border is unambiguous, so the workaround is not yet earning its complexity. An
`@external` service is drawn as a boundary marker in its own right, which is the thing a reader is
looking for.

**`layout.json` is not read.** Reading it is read-only and belongs here eventually, with the rule that
matters most: a node missing from the file is laid out **on its own**, never by re-running layout for
the whole view. Writing it is mutation, which is increment 5.

**Nothing is verified by looking except the picture.** The graph's derivation, the layout's stability,
the stylesheet's validity, the server and the page-to-script contract are all tested. How it *looks* is
checked by running it.

## 4. Narrowing: three verbs, kept apart

Three different things reduce what you are looking at, and conflating any two of them is how a filter
becomes something you cannot switch off.

| | what it does | how long it lasts | where it comes from |
|---|---|---|---|
| **select** | emphasises one thing, dims the rest | until you select something else | a click |
| **focus** | hides everything outside a neighbourhood | until you clear it | derived from the selection |
| **lens** | hides everything outside a saved filter | until you pick another | `views.json`, on disk |

Spider started with only the first. The three header checkboxes were an ad-hoc fourth, parallel to a
mechanism 7K already specifies — exactly the kind of second source of truth this project keeps deleting.

They compose in one order, and only one: **lens, then focus, then selection.** A focus narrows what the
lens left. A selection emphasises within what survived both.

### 4.1 A narrowed graph must not lie

Both hiding verbs face the same problem: an edge with one end inside and one end outside.

Dropping it is not an option. A pipe whose producer has been hidden would be drawn with traffic arriving
from nowhere; a service whose pipe has been hidden would be drawn emitting into nothing. Those pictures
are not *partial*, they are **wrong**, and a reader has no way to tell.

So an escaping edge ends in a **port**: a stub saying "something out there connects here". That is what
`20-ir.md` 6.1 means by a boundary port — "an edge leaving the view renders as a boundary port, the same
aggregation used for a collapsed package" — and it is why `restrict` is its own module rather than code
in both places. Two implementations of "what does a narrowed graph look like" would eventually disagree,
and a disagreement between the lens and the focus is one nobody would think to look for.

A port is **counted, not named** — "2 outside". A single name would read as a node that is in the view
after all. The names are in the sidebar, where there is room to be exact.

This also forced a rename. `kind: "port"` used to mean an `@external` service, which is a different idea
entirely: one marks where the system ends, the other marks where the *picture* ends. The service is
`external` now.

### 4.2 Lenses

`views.json`, resolved in four steps, in the order 6.1 states: union the includes, close over the edges,
subtract the excludes, stand up the ports.

Two judgement calls the specification leaves open:

**Closure is one step.** "Including a service brings in the pipes it emits to and reacts from; including
a pipe brings in both ends." Iterating that would walk the whole connected component and the lens would
select everything, which is plainly not what a saved filter is for.

**A `package:` selector reaches descendants.** `acme.retail` owns no declarations of its own in the
examples — it is implied by its children — so a lens that stopped at direct members would select
*nothing at all*. That is a trap rather than a rule. A reader naming a parent means that whole area.

A `label:` selector matches **propagated labels and annotations both**, which is what makes `PiiFlow`
reach the pipe carrying the message carrying the record carrying the `@pii` field, and what makes the
specification's own `label:external` perimeter lens mean anything (7K's D95).

### 4.3 Focus

A double tap, or `f` on the selection. Radius in **edges**, default **two**, adjustable with `+` and `-`.

**Two, because the graph is bipartite on purpose.** A service's neighbours at one hop are *pipes*, which
answers nothing — "show me OrderService and what it touches" means the services it talks to, and those
are two hops away through the pipe that decouples them. One hop from a *pipe* does reach both ends, so an
odd radius is useful there and useless from a service. Two answers the question from either end.

It is adjustable because three hops is "and what *they* talk to", which is the next question, and nothing
in the model says when to stop. On the examples, radius two draws 11 of 24 nodes on average.

Three properties, all tested:

- **A stale focus shows everything, not nothing.** Spider re-parses on every keystroke, so a focus
  outliving its subject is normal rather than exceptional. An empty screen is the worst possible answer
  to "where did my model go".
- **It never widens.** Only ports are added; every other node was already there.
- **It is transient by construction.** Nothing writes it anywhere, which is what makes it safe to be
  aggressive. A hidden thing you cannot get back is a different and much worse feature.

`Escape` undoes the most recent narrowing first — the focus, then the selection. A single key that
cleared both would make it impossible to keep a focus while looking at something inside it.

### 4.4 Search

`Ctrl-K`, or `/`, or the **find…** button. Arrows and `Enter`; `Escape` closes.

**It searches the model, not the graph.** A reader typing `OrderPlaced` is looking for the message, and a
message is an edge *label* rather than a node (3.1) — so searching only what is drawn would fail on exactly
the names people remember. Records, values, enums, sagas and schedules are findable for the same reason:
they are what the model is made of, even where the graph has no place for them. On the examples that is 90
entries over 85 declarations.

Ranking is **total and deterministic**, down to the tie-break, because a palette whose order shifts under
the cursor is one you have to read rather than aim at. Five coarse tiers — exact name, prefix, substring,
a match in the package path, then a loose subsequence — and at equal quality the things the graph draws
come first, since a reader searching in a graph tool is usually trying to get *to* somewhere on it.

Three decisions worth recording:

**A subsequence must start at a word.** Without that rule `pii` matched `ShippingService` — p from
Shi**pp**ing, then i, then i — a true subsequence and a useless result, and the whole tail of every list
looked like that. With it, `ordsvc` and `osrv` both still reach `OrderService`, because `o` and `s` begin
`Order` and `Service`. Subsequence matching is also off entirely for a single character, which would
otherwise match nearly everything at the moment you have typed the least.

**A bare kind word lists that kind.** `pipes` answers "what pipes are there", which is a real question and
typing the word is the obvious way to ask it. `pipe commands` and `service:order` filter and search
together, using the same vocabulary `views.json` selectors use rather than a second set of words to learn.
The cost is that a declaration actually named `Pipe` needs more characters typed — predictable, which
beats clever here.

**An empty query returns nothing**, not everything. A palette that opens full of arbitrary results teaches
you to ignore it.

A result the lens or focus has hidden is still shown, marked **not drawn**, because finding out that the
thing you wanted is outside the current view is more useful than not finding it. Choosing one clears the
**focus**, which is transient and derived, and leaves the **lens** alone — someone chose that, and
silently discarding it would be worse than a dead end the sidebar can explain.

### 4.5 What search exposed

Selecting a message had never worked. The selection model always said a message type was selectable and
"highlights edges", but the renderer resolved a highlight by `cy.getElementById`, and a message has no
element — so the highlight found nothing and bailed out. Nothing had ever selected one, because until
search there was no way to.

Edges now carry their `messageIds`, and selecting a message emphasises every edge carrying it. On the
examples, `SeatsReserved` lights two.

### 4.6 What is still missing

**Collapsing a package.** `layout.json` has a `collapsed` list and the aggregation is the same `restrict`
plus ports, so the hard part is already built.

## 5. Increments

Each one is useful on its own, and none is a prerequisite rewrite of the one before.

1. **Graph** — services, pipes, packages, the boundary. No trace. **Done**, see section 3.
2. **Sequence** — a trace rendered as a sequence diagram.
3. **Linked selection and timeline** — the selection model wired to all three views.
4. **Composer, read-only** — build a message from a record's fields and see it validated.
5. **Mutation** — editing the model from the graph.

Read-only first, and mutation last, because the authoring experience already exists in the extension
(D67) while the no-unsaved-buffer, file-watcher, surgical-mutation problem is both the riskiest part
and the one most likely to eat the schedule (D92).

## 6. Rendering

**Cytoscape.js**, with layout from **ELK** through `cytoscape-elk` (D92).

Layout is **deterministic and layered**, seeded by declaration order. D25 makes stability matter
more than optimality, which rules out force-directed layout outright — a graph that reshuffles
whenever the model changes is the named failure, not a side effect. `layout.json` overrides, and **a
node missing from it is laid out on its own**, never by re-running layout for the view: adding a
service places the new one and leaves the rest where they were.

Two costs are accepted knowingly, both because Cytoscape renders to a canvas with a stylesheet
rather than composing nodes from components:

- **No port concept**, so boundary ports are child nodes positioned on a parent's perimeter. Planned
  for from the start rather than discovered during the first increment.
- **Node affordances are styled, not composed**, so an incompleteness badge or a `pii` marker is a
  generated image rather than markup. Free for the first increment, which is boxes and labels, and
  not free later.

## 7. Host

A **local web app**, served by a command. The renderer goes in a package that knows nothing about its
host, so a **VS Code webview** can host the same bundle later (D92). A reviewer opening a flow or a
colleague opening a shared trace is not necessarily in an editor, and the webview's real advantages —
workspace access, file watching, writing files — only begin to matter at increment 5.
