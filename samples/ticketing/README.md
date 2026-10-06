# A support desk

Spider's second example workspace, and a deliberately different system from the parcel lockers: that
one moves a physical object through a process measured in days, this one moves a **work item** through
a process measured in people being available.

## What the system does

Somebody has a problem and says so — through a portal, an email, or a phone call somebody types up. The
desk has to find an agent on the right team and hold them for it, tell the requester their ticket
exists, hand the work to the agent, and then let the agent go once the ticket is resolved — or once it
is clear nobody is going to get to it.

That is one business transaction across four packages that do not trust each other to be up:

| Package | What it owns |
|---|---|
| `support.desk` | the ticket itself: accepting it, running the process, and the hourly sweep |
| `support.roster` | who is on duty, who is free, and the heartbeats that say so |
| `support.contact` | reaching a person: whether they can be reached, and the mail that goes out |
| `support.common` | the shared vocabulary, and the only place `@pii` is declared |

**The interesting part is what has to be given back.** An agent's attention is a scarce resource, so
claiming one is a commitment: if the requester turns out to be unreachable *after* an agent was claimed,
the claim has to be released. That is why resolution is a saga rather than a sequence of calls — and why
`claim` and `greet` run as a parallel stage, since neither needs the other's answer and every ticket
would otherwise wait for the mail service before the roster was even asked.

The waits are real and they are different sizes. A step waits eight hours for the work to be done — a
working day, past which the ticket is not being worked whatever the board says. The saga's own deadline
is three days, because a ticket stuck for three days is a different problem from one nobody got to
today, and the two should not look the same.

**Personal data is deliberately fenced.** An email address lives in `support.contact` and nowhere else.
The desk's saga knows a `Requester` and asks `support.contact` to reach them; it never learns how.
`@pii` is declared on two values in `support.common` and propagates upward from there to every record,
message and pipe that carries them, which is what the `PiiFlow` lens draws.

## Running it

From the repository root:

```
npm run serve -- samples/ticketing --trace samples/ticketing/resolution.ndjson
```

Or press **`o`** in a Spider that is already open and browse to this folder — the trace does not come
with it, because a trace belongs to the model it was recorded from.

## What to try

| | |
|---|---|
| **Press `Space`** | the trace plays. Pick `TicketResolvedQuickly` first |
| **Press `a`** | this file, beside the graph |
| **Press `?`** | what every shape means |
| **Press `g`** | the saga view. `claim` and `greet` sit side by side, because they share a stage |
| **Pick `PiiFlow`** | how little of the system an email address reaches |
| **Pick `Lossy`** | the heartbeat pipe, which nothing may depend on for progress |

### The runs worth watching

**`TicketResolvedQuickly`** — the whole path: raised, an agent claimed while the requester is emailed,
then assigned and resolved forty-five minutes later. Press `g` while it plays: the two branches of the
first stage fill in **`greet` first**, because the mail service answers in 100ms and the roster takes
200ms. They were sent at the same instant.

**`RequesterUnreachable`** — the agent is held, and *then* the address bounces. The saga rejects and
releases an agent it had already claimed, which a sequence could never have arranged: in a sequence the
address would have failed first and nobody would have been held. This is the run the parallel stage
exists to make possible.

**`NobodyResolves`** — nine hours of nothing, then the work step times out, the saga rejects, and the
stage is unwound: `ReleaseAgent` goes out for `claim`, and `greet` is skipped because it declared
`undo none`. An email cannot be unsent.

**`RosterNeverAnswers`** — the roster never replies, so the step's own 30-second timeout fires. A
different thing from the saga's three-day deadline, and the sequence diagram shows which.

**`NoAgentFree`** — everyone on that team is busy. The ticket is refused before anybody is handed
anything, and the branch still waiting never gets to fire its own timeout, because the saga is already
over.

**`SweepRunsHourly`** — the schedule firing three hours running, with an hour between occurrences.

**`RaiseWithoutScope`** — a claim check failing. Refused before the handler runs, and never retried,
because a rejection is not a failure.

## What is in it, and why

**`common.7k`** — the shared vocabulary, and the only place `@pii` is declared. It is on two values,
`EmailAddress` and `PersonName`, and it propagates upward from there. That propagation is what makes the
`PiiFlow` lens select anything at all.

**`roster.7k`** — who is free. `presence` is `delivery at-most-once` with `dlq none`: a heartbeat that
is lost is a heartbeat, the next one is along in seconds, and nothing waits for one. Spider draws it
dashed. A missed heartbeat makes an agent look busy, which costs a claim and never a ticket.

**`contact.7k`** — the only package that sends personal data outside, through an `@external` mail vendor
with a five-attempt retry. It is also where `issues` earns its place:

```7k
reacts EmailRequester from commands {
  once per ticketRef
  replies RequesterReached | RequesterUnreachable
  issues  SendEmail
}
```

`replies` is the outcome space the saga awaits — *can* this person be reached. `issues` is the mail
going out, which nobody waits for. Putting `SendEmail` in `replies` would make every sender wait for it
(D103).

**`desk.7k`** — the process. The `Resolution` saga and the `SlaSweep` schedule. The sweep is hourly with
`onMissed once` rather than `all`: after a two-day outage, twenty-four catch-up sweeps would escalate
the same backlog twenty-four times, because lateness is a property of the ticket and not of the
occurrence that noticed it.

## How it differs from the parcel example

Both exist to be looked at, so they deliberately share the vocabulary the views have something to say
about — a boundary, PII that propagates, a lossy pipe, a saga with a parallel stage, and a schedule.
What they do not share is the shape of the problem:

| | parcel lockers | support desk |
|---|---|---|
| The scarce thing | a compartment, physically held | an agent's attention |
| What ends the process | a person collects, or three days pass | a person resolves, or eight hours pass |
| The schedule's point | a local-time cron across a daylight-saving change | `onMissed once`, so a backlog is not escalated twice |
| The query | "where is my parcel?" | "what is happening with my ticket?" |
| `issues` | a door that must open | a mail that must go out |

## Regenerating the trace

`resolution.ndjson` is checked in so the demo works without a sandbox checkout. With one beside this
repository, `npm run trace` from the repository root regenerates both this and the parcel one, and
validates each against the trace format before writing it.
