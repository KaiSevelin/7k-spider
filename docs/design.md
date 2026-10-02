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

## 5. Replay: the timeline as a transport

Increment 2. `spider serve <paths> --trace <file>`.

A trace is **optional and separate from the sources**. The graph is worth drawing before anything has run,
and a model and a recording of it running are different inputs. No trace is a *state*, not a failure — the
server answers `204`, and the timeline simply is not there.

### 5.1 Virtual time is not wall time

A scenario runs on a clock where `advance 30d` is instant and many events share one instant, because the
runtime drains everything due now before moving. So mapping virtual milliseconds onto wall milliseconds
fails at both ends: a thirty-day advance would stall the animation for a simulated month, and nine events
at one instant would all fire in a single frame and read as one.

Playback is therefore **event-paced**: one beat per event, at a rate you choose. A real gap in the clock
earns **exactly one extra beat** and a mark, however large it was — compressed rather than ignored, so the
passing of time is visible without being waited out.

**The timeline is not paced that way.** It is drawn in *virtual* time, with the gaps at their true size,
because a month and a millisecond looking the same would lose the one thing a timeline is for. The
transport compresses; the track tells the truth. On a real sandbox trace: a 1.0s virtual span, 31s of
playback, 15 gaps marked.

Seeking is by virtual time too, so a click lands where it was aimed rather than at the nth event.

### 5.2 A file holds several runs

The sandbox's own `trace --ndjson` across several scenarios writes one run each, which is why an event's
identity is `(run, seq)` and not `seq` (`30-scenarios.md` 7.2).

They **cannot be played as one sequence**, and this was not obvious until measured. Each run starts its
clock where it likes, so a track drawn across all of them overlays run two on run one: seven runs, and 27
of 59 events inside the first 1% of the track. So there is a run picker, shown only when there is more than
one, and a trace is read one run at a time — which is how you read a bug report anyway.

### 5.3 What a message looks like going past

Both at once, because either alone reads as a flicker:

- **The edge pulses** — accent-coloured, thicker, with a dashed pattern — so the path is legible even while
  the dot is between two nodes.
- **A dot travels along it**, so the direction is.

The dot follows `edge.midpoint()`, which is a point the curve actually passes through. Interpolating
straight from source to target sends it off a bezier and reads as broken; the bezier's *control* point is
off-curve, so it is the wrong waypoint too.

A **failure animates differently** — warn-coloured, for a rejection, a failure, a dead letter, a drop, a
compensation. Those are the events a trace is usually opened for, and a failure that looked like a success
would be one you never notice.

Markers are transient nodes excluded from selection, from dimming, and from surviving a redraw: a marker
left behind would be a message that never arrived.

**This does not contradict D25.** "Nothing animates on a relayout" stays true. Layout does not move;
messages do.

### 5.4 Which edge an event travelled

A trace names a message, a pipe and a service, all qualified (`30-scenarios.md` 7.6), and the graph's edges
are exactly those pairs — so this is a lookup rather than a guess. On a real trace, **53 of 59 events**
animate along an edge.

Three cases worth stating:

- **A dead letter** names the `<pipe>.dead` companion, which the graph draws without edges — it annotates
  its pipe rather than participating. So the event animates along the delivery edge it died on, marked bad,
  which is both truthful and what a reader wants to see.
- **A port**, when the counterparty is outside the lens or focus. The message really did go out of view,
  and animating to the port says so; the alternative is a message that silently does not appear.
- **No edge at all** for a saga event, a schedule firing, the clock moving, or a publish by the scenario
  itself. Returned as nothing rather than forced onto a nearby edge. The six events of the real trace with
  no edge are all `advanced` — the clock moving, which travelled nowhere.

An event with no edge still highlights what it touched, through the same `resolve` a click uses. So what
lights up during a replay is what would light up if you had clicked the thing yourself.

### 5.5 Still missing

A **dead-letter pipe has no edges**, so it floats beside its own pipe: fine
as an annotation, and it would need an edge that breaks the bipartite rule to be more.

## 6. The sequence diagram

Increment 3. `s`, or the **sequence** button, once a trace is loaded.

### 6.1 Pipes are lifelines, not arrows

The conventional thing would be one arrow per hop, service to service, labelled with the message. It would
read better and it would be a lie in two directions.

It would **invent causality.** One `published` and three `delivered` events are four facts; joining them
into three service-to-service arrows asserts that *this* publish caused *those* deliveries. The trace does
not say that, and competing consumers on a queue make it false. A delivery whose publish is in another run
would have to be drawn as coming from nowhere, or dropped.

And it would **hide the waiting.** A message sitting in a queue is the single most interesting thing a
message-driven system does, and it is exactly what vanishes when the queue is drawn as the middle of an
arrow.

So the queue is a participant, at the cost of two arrows per hop. What that buys shows up immediately on a
real trace — `ReserveNeverAnswers`, read down the page:

```
  +5.0s   failed      ReserveSeats      <- the ack timeout elapsing
  +1.0s   delivered   ReserveSeats      <- the first retry
  +5.0s   failed      ReserveSeats
  +2.0s   delivered   ReserveSeats      <- backoff doubling
  +5.0s   failed      ReserveSeats
  +4.0s   delivered   ReserveSeats
  +5.0s   failed      ReserveSeats
```

The ack timeout and the retry backoff are both visible as vertical distance on the pipe's lifeline. Neither
is visible at all in a diagram where the pipe is an arrow.

A **dead letter folds into the pipe it belongs to** rather than getting a lifeline, for the same reason the
graph draws it as an annotation: a participant that only ever receives is not a participant.

A **saga** and a **schedule** get lanes of their own, and their events are marks on the lifeline rather
than arrows, because they happened *to* a participant without travelling. The clock moving gets no
participant at all — a faint rule across the diagram. On the shop trace that is 3–4 marks per run beside
11–19 arrows.

### 6.2 Rows are event-paced; gaps are marked

The same decision as the transport (5.1), and for the same reason: virtual time clusters, so a
proportional diagram would push everything off the screen to make room for one wait. A row per event, and a
real gap gets a divider saying how long it was — `+24.0h` on the nightly schedule, `+5.0s` on an ack
timeout.

`sayGap` scales the units, because a queue's whole character is how long things sit in it and
`2592000000ms` says nothing.

### 6.3 A drawer, not a pane

It takes the right-hand edge, full height, over the graph. The graph is the view you keep; the sequence is
the one you open when a trace is the question. Opening it squeezes the viewport and **does not re-lay out
the graph**, so nothing moves underneath.

The sidebar steps aside, since both live on the right.

### 6.4 The linkage, finally

D25's "selecting in one view highlights in all three" is now actually three views, and it turned out to
mean less code rather than more: there is **one** `resolve`, and each view renders the `Highlight` it is
handed.

- Clicking a row seeks the transport to that event, which highlights it in the graph **and** animates the
  message along its edge.
- Clicking a lane heading selects that service or pipe, which highlights its rows in the sequence.
- A replay drives both: what lights up as a trace plays is what would light up if you had clicked the
  thing yourself.

There was never a second resolver to keep in step, which is exactly what section 2.2 was for.

Drawn with plain SVG and no library. The graph needed Cytoscape for layout and hit testing; a grid of lines
whose coordinates `layoutSequence` has already computed needs neither.

## 7. The composer

Increment 4. `c`, or the **compose** button.

Pick a message or a record, fill in a form, and watch it validated against the contract. Read-only in the
sense that matters: it builds a payload and tells you whether it is one. Sending it is a runtime's job.

### 7.1 The form is derived, never configured

A widget comes from the field's kernel type and its constraints. There is no table of known facets, and
that is the whole point (D24): declare

```
value PostCode : string { pattern /^[0-9]{3} [0-9]{2}$/; example "114 51" }
```

and the composer offers a text box that checks that pattern and shows `114 51` as its placeholder, having
been told nothing about post codes. A declared `example` beats any placeholder a tool could invent.

`forms.json` may override a **label**, an **order** or a **widget**, and nothing else. The order is
partial, so adding a field does not require editing the sidecar to keep it from disappearing. A widget
name is advisory — an unrecognised one falls back to the derived widget, which stops the sidecar becoming
a UI API every tool must implement.

**It carries no validation hints, ever**, and that is enforced rather than documented: a `pattern`,
`length`, `range`, `required` or `constraints` key is reported as a problem. Constraints belong to the
model, and a second copy in a presentation file is a second source of truth that drifts
(`20-ir.md` 6.3).

One place a constraint changes the *kind* of input rather than what it accepts: a `string` whose `length`
allows more than 120 characters gets a textarea, because a 2000-character field in a one-line box is a
form nobody can fill in. A `decimal` gets a **text** box, not a number one, because it travels as a string
and must not round-trip through a double (`01-kernel.md` 7.1).

A `map<K,V>` gets free key/value pairs, deliberately unstructured, because it is an unversioned extension
point and a form that pretended otherwise would be claiming a contract that does not exist (D91).

### 7.2 Validation is Core's, not a projection of it

This is the decision that made increment 4 bigger than it looked, and it forced the work in 7k's D97.

The obvious shortcut is to validate against the JSON Schema the projection already generates. It would be
wrong, because **the projection is lossy by design** (D90): no invariants, no nominal types. A composer
built on it would accept

```
total:  { amount: "19.99", currency: "SEK" }
lines: [{ amount: "19.99", currency: "EUR" }]
```

as a valid order, when the model declares `invariant total.currency == lines[].currency`. It would not
merely miss the problem; it would have no way to express that it was missing one.

So validation comes from `@sevenk/core`, which makes the composer exactly as strict as `7k check` — the
only useful thing for it to be. That meant moving contract semantics out of the sandbox, where they had
lived because the sandbox was the first thing to need them. Spider would have been the second
implementation.

**Normalize, then validate**, which is the order a runtime uses: `normalize trim` means a value with
spaces around it *is* the trimmed value, so validating first would reject a payload the contract accepts.

**Canonical JSON only while it is valid.** Canonical JSON of something that is not a legal payload would
be a confident artifact about something nobody agreed on.

### 7.3 Blank, not invented

An empty form has every required field present and empty, and no optional one. Nothing is filled in with a
plausible value, because a composer that did that is one you stop reading — and `"$auto"` generation
belongs to a runtime with a seed, not to a form.

The one exception is an enum, where the first member is the only honest blank: there is no empty enum
value.

### 7.4 What a half-written model looks like

A field whose type did not resolve is **drawn**, named, and marked as unresolved. A form that vanished
while you were typing a type name would be useless at the moment you need it (D20) — the same rule the
graph follows.

## 8. Saved layout, and the first thing Spider writes

Increment 5, first half. Drag a node and it stays dragged, in `.7k/layout.json`.

### 8.1 Why layout before the model

D92 deferred mutation as "both the riskiest part and the one most likely to consume the schedule", and
named the three hard parts: the unsaved-buffer problem, the file watcher, surgical editing of source text.

Only one of those is about the *model*. A layout file is per-developer, gitignored, deletable, and
"deleting this file loses saved positions and nothing else" — so writing it exercises the whole write path
where a mistake costs nothing, while the surgical-editing problem waits. It was also a recorded gap and a
prerequisite: dragging a node is meaningless without persisting it, and persisting needs reading.

### 8.2 The rule the design turns on

> **A missing node falls back to auto-layout for that node, not for the view.** Adding a service places
> the new one and leaves everything else where it was. (`20-ir.md` 6.2)

That sentence rules out the obvious implementation, which is to lay the graph out and then move the saved
nodes into place. Do that and every *unsaved* node is positioned as though the saved ones were somewhere
else — so adding one service shuffles the picture anyway, just less obviously.

So the merge runs the other way. A saved node is placed exactly where it was saved and is then **fixed**.
An unsaved node takes its auto position and is moved only as far as it must be to clear a fixed one, along
one axis, deterministically, and bounded so a crowded corner cannot loop. **No saved node's position
depends on which other nodes exist** — the rule holds by construction rather than by care.

`test/layout-file.test.ts` asserts it on the pure merge, and `test/layout.test.ts` asserts it again
against real Cytoscape and real ELK: the engine re-runs over a bigger graph, reports different positions
for everything, and the saved node does not budge.

### 8.3 The loop a write creates

Drag → `PUT /layout.json` → the server writes → the watcher sees the write → the page is told to reload →
the page re-reads the positions it had just sent. Harmless once and maddening while dragging.

The server remembers when it last wrote a sidecar itself and does not announce a change within a moment
of it. That is a **window, not a mode**: editing a model file still reloads the page, and there is a test
for each half, because suppressing too much is the same bug as suppressing too little.

### 8.4 What the write is, and is not

**The page sends the whole file.** It read it, changed some positions and kept everything else — which is
the only way a **stale entry survives**. A deleted service leaves its position behind on purpose: the file
is shared with a half-renamed model and another branch, and silently dropping the position of something
temporarily unresolved would lose work for a reason the author cannot see.

**Keys are sorted and coordinates are integers**, so two people dragging different nodes produce a diff of
the lines they changed rather than a reordering of the file. This is a file that gets reviewed.

**A failed write is said, not swallowed.** It appears in the problems count like anything else. A drag that
silently does not persist is worse than one that was never offered — which is also why the graph is
draggable only when the host passes a handler that can save: `autoungrabify` is on without one.

### 8.5 What is left, and what it needs

**Model mutation.** Adding a service, renaming one, adding an `emits`. Three things it needs that layout
did not:

- **Surgical text editing.** The source *is* the model, so a rename edits text in place. Regenerating a
  file from the IR would reformat it, lose comments, and make every change an unreviewable diff.
- **An answer to the unsaved buffer.** A browser cannot know that the file is open in an editor with
  unsaved changes; a VS Code webview can ask. That asymmetry may be what decides the host for this
  increment rather than the other way round.
- **Rename touching the sidecars in the same operation** (`20-ir.md` 6.4), or a rename silently discards
  every saved position and lens entry that named the old name.

**Collapsing a package**, where coordinates are relative to the collapsed parent, so collapsing does not
invalidate its children's positions. The `collapsed` list is read and kept; nothing acts on it yet.

**Edge waypoints** are read, kept and written back untouched. Nothing draws them.

## 9. Increments

Each one is useful on its own, and none is a prerequisite rewrite of the one before.

1. **Graph** — services, pipes, packages, the boundary. No trace. **Done**, see section 3.
2. **Replay** — a trace animated over the graph, with the timeline as its transport. **Done**, see
   section 5. Swapped with the sequence diagram: it reuses the graph and the selection model that already
   exist, and it shows a message-driven system *behaving* rather than listing what it did.
3. **Sequence** — a trace as a sequence diagram, with the three views linked. **Done**, see section 6.
   This absorbed the old "linked selection" increment, because linking three views turned out to be one
   `resolve` and no new machinery.
4. **Composer, read-only** — build a message and watch it validated. **Done**, see section 7.
5. **Mutation** — in two halves. **Saved layout is done**, see section 8: dragging persists to
   `.7k/layout.json`, which is where the write path belongs first because a mistake there costs nothing.
   **Model mutation** is not, and section 8.5 says what it needs.

Read-only first, and mutation last, because the authoring experience already exists in the extension
(D67) while the no-unsaved-buffer, file-watcher, surgical-mutation problem is both the riskiest part
and the one most likely to eat the schedule (D92).

## 10. Rendering

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

## 11. Host

A **local web app**, served by a command. The renderer goes in a package that knows nothing about its
host, so a **VS Code webview** can host the same bundle later (D92). A reviewer opening a flow or a
colleague opening a shared trace is not necessarily in an editor, and the webview's real advantages —
workspace access, file watching, writing files — only begin to matter at increment 5.
