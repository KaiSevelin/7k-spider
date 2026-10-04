# A parcel locker network

Spider's example workspace. Four packages, a boundary, personal data that propagates, a lossy pipe, a
saga with a parallel stage and a three-day wait, and a nightly schedule across a daylight-saving
change.

It exists to be looked at, so it deliberately contains the things the views have something to say
about.

## Running it

From the repository root:

```
npm install
npm run demo
```

Then open **http://127.0.0.1:7007**.

Or, in VS Code, press **F5** — the `Spider: demo` configuration runs the same command, opens the browser
when the server says it is ready, and leaves the debugger attached so breakpoints in `src/` work.

`npm run demo` is `spider serve examples --trace examples/handover.ndjson`, so the graph comes up with a
trace already loaded.

To see the graph with no trace at all — which is how it looks before anything has run:

```
npm run serve examples
```

## What to try

| | |
|---|---|
| **Press `Space`** | the trace plays. Messages move along the edges; a failure is a different colour |
| **Pick a run** | the footer's first dropdown. Seven scenarios, one run each. Try `NobodyCollects` |
| **Press `s`** | the sequence diagram. Pipes are lifelines, so the waiting is visible |
| **Press `g`** | the saga view. `reserve` and `verify` sit side by side, because they share a stage |
| **Pick a lens** | `PiiFlow` shows where personal data goes; `Perimeter` shows where the system ends |
| **Press `f`** on a selection | focus: only that and what it touches, two hops out |
| **Press `Ctrl-K`** | find anything. Try `pipes`, or `ordsvc`-style abbreviations |
| **Press `c`** | the composer. Build a `DropParcel` and watch the invariant checked |
| **Press `n`** | connect two things. Click a service, then a pipe |
| **Drag a node** | it stays where you put it, in `.7k/layout.json` |

### The runs worth watching

**`HandoverSucceeds`** — the whole path in 31 virtual seconds: dropped, a compartment reserved while
the recipient is verified, then notified and collected. Press `g` while it plays: the two branches of
the first stage fill in **`verify` first**, because the address book answers in 100ms and the locker
takes 200ms. They were sent at the same instant.

**`NobodyCollects`** — three virtual days of nothing, then the step times out, the saga rejects, and the
stage is unwound: `ReleaseCompartment` goes out for `reserve`, and `verify` is skipped because it
declared `undo none`. The order is **reverse completion**, so `reserve` is reversed before `verify`
even though it was declared first — the two branches finished in the other order, and there is no
order to reverse but the one that happened. The timeline draws that three-day gap at its real size
while playback crosses it in one beat.

**`RecipientUnreachable`** — the compartment is held, and *then* the recipient turns out to be
unreachable. The saga rejects and releases a compartment it had already reserved, which a sequence
could never have arranged: in a sequence the verification would have failed first and nothing would
have been held. This is the run the parallel stage exists to make possible, and the one the saga view
makes legible.

**`LockerNeverAnswers`** — the compartment service never replies, so the step's own timeout fires. A
different thing from the saga's week-long deadline, and the sequence diagram shows which. Its sibling
had already succeeded, so unwinding it records `saga-irreversible`: `undo none` is a decision, and the
trace says it was taken.

**`SweepRunsEachNight`** — the schedule firing three nights running, with `+24.0h` between occurrences.

**`DropWithoutScope`** — a claim check failing. Refused before the handler runs, and never retried,
because a rejection is not a failure.

## What is in it, and why

**`common.7k`** — the shared vocabulary, and the only place `@pii` is declared. It is on two values,
`PhoneNumber` and `PersonName`, and it propagates upward from there to every record, message and pipe
that carries them. That propagation is what makes the `PiiFlow` lens select anything at all.

**`lockers.7k`** — the hardware. `telemetry` is `delivery at-most-once` with `dlq none`: a door sensor
reading that is lost is a door sensor reading, and nothing waits for one. Spider draws it dashed.

**`notify.7k`** — the only package that sends personal data outside, through an `@external` SMS vendor
with a five-attempt retry.

**`delivery.7k`** — the process. The `Handover` saga, and the `NightlySweep` schedule. Both of the
schedule's clauses that look optional are required and for the same reason: a local-time schedule across
a daylight-saving change either fires twice or not at all, and after an outage `skip` loses a day's
returns.

## Its two warnings are the point

```
7k check: 5 units from 5 files, 0 errors, 2 warnings
```

Both are `unexplained-emit`, and both are correct:

```
CompartmentService emits the @command lockers.OpenDoor, but no `replies`, saga or
schedule says what makes it do so — so the model cannot say what instructs this
```

Those two hops are **choreographed**: a service issues a command in the course of handling another one,
and nothing in the model names what drives it. That is a real property of the design and the checker is
right to ask about it. Making it an orchestration — a saga step — would remove the warning and change
the system.

An example with no warnings would teach less than one that explains its own.

## Regenerating the trace

`examples/handover.ndjson` is checked in so the demo works without a sandbox checkout. With one beside
this repository:

```
cd ../7k-sandbox
npx tsx src/cli.ts trace ../7k-spider/examples/handover.scenario.7k --ndjson > ../7k-spider/examples/handover.ndjson
```

`test/example.test.ts` validates it against the trace format, so a stale one fails rather than misleads.

## What the sandbox found while this was being written

Worth recording, because it is the argument for the sandbox existing.

The model checked out — 0 errors — and was still wrong in three ways, each of which only running it
revealed:

- **Two steps that did not have to wait for each other.** `reserve` and `verify` were a sequence,
  which meant every parcel waited for the address book before the locker was even asked — a delay
  with no cause anywhere in the model. They became a `parallel` stage. `handover` could not join them:
  it reads the pin that `reserve` produced, which is the test for whether two steps belong in one
  stage at all.

- **A step that awaited nothing.** The `tell` step sent a notification and then had only a timeout, so
  its sole possible outcome was its own expiry. Every run ended `reject: could not notify`. Telling the
  recipient and waiting for them is one step, not two.
- **An enum written as a path.** `outcome = Collected` read as a path and held no value. An enum member
  travels as its name, so it is a literal: `outcome = "Collected"`.
- **An invariant the generator could not satisfy.** `compartment.size == size` sat on a message whose two
  sides the runtime generates independently, so the synthesised reply could not satisfy its own contract.
  It moved to a message the scenario writes both sides of.
