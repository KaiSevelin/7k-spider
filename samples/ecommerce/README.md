# An online shop

Spider's third example workspace, and the one with money in it.

The parcel lockers move a physical object; the support desk moves a work item. This one moves an
**order**, which is the shape most people meet first — and it exists to carry the three things the other
two had no honest use for: a `stream` pipe that is read from the beginning, a payment pipe that
deduplicates in the transport, and a dead-letter pipe that is named rather than implicit.

## What the system does

Somebody fills a basket and presses the button. The shop has to hold the goods and hold the money —
neither of which it can do on its own behalf — and then, and only then, tell a warehouse to pick it. If
either hold fails, the other has to be given back. If nobody picks it, both do.

That is one business transaction across four packages that do not trust each other to be up:

| Package | What it owns |
|---|---|
| `shop.orders` | the order itself: accepting it, the `Fulfilment` saga, and the nightly sweep |
| `shop.catalog` | what is on the shelves, and the ledger of every movement |
| `shop.payments` | authorising and voiding, and the hop that crosses to the card network |
| `shop.common` | the shared vocabulary, the money, and the only place `@pii` is declared |

**The interesting part is that two different things have to be given back.** Stock is a physical
commitment and an authorisation is somebody's money; the saga holds both in a parallel stage, because
neither needs the other's answer and every order would otherwise wait for a card network before the
shelf was even checked. `NothingShipped` is the run where both undos fire.

**Money is `decimal`, never `float`.** An amount is exact, a binary fraction is not, and the currency
travels with the amount because an amount on its own is not a price. `PlaceOrder` carries an invariant
the JSON Schema projection cannot express and the composer still checks:

```7k
invariant total.currency == lines[].price.currency
```

## Running it

From the repository root:

```
npm run serve -- samples/ecommerce --trace samples/ecommerce/fulfilment.ndjson
```

Or press **`o`** in a Spider that is already open and browse to this folder.

## What to look at first

| | |
|---|---|
| **Pick `Ledger`** | `movements` is drawn as a **barrel**. It is the only stream in any of these samples |
| **Tick `dead letters`** | `payments.failed` is a pipe with a name, beside the implicit `.dead` companions |
| **Press `Space`** | the trace plays. Pick `OrderShipsSameDay` first |
| **Press `g`** | the saga view. `reserve` and `authorise` sit side by side, because they share a stage |
| **Pick `PiiFlow`** | an address reaches the order and the picking instruction, and neither the shelf nor the card network |

### Why a stream, and not a topic

A topic delivers each movement to whoever was subscribed at the time. That is enough for anybody
*reacting* to a movement and no use at all to anybody *deriving* a stock level: a reader that starts
today cannot know what the level is without the movements that came before.

A stream is read from a position, so a new reader — or one rebuilding after a bad deploy — replays from
the beginning and arrives at the same number. A different guarantee, so a different kind of pipe, and
Spider draws it differently for that reason. `StockReport` is the service that reads it that way.

### Why the payment pipe deduplicates twice

```7k
pipe commands : queue {
  delivery  effectively-once within 24h
  ordering  by shopId
  carries   AuthorisePayment, VoidAuthorisation
  dlq       failed
}
```

Every consumer in 7K has to be idempotent whatever the delivery mode says, so this is not a licence to
stop deduplicating — `once per orderRef` is still on the handler. It is a second net under the first, in
the one place where the two disagreeing is worth paying for: an authorisation replayed a day later
against a card that has since been charged. The window has to outlast the retries, or it is
deduplication that stops working exactly when duplicates start.

`dlq failed` names where a hopeless message goes. Everywhere else in these samples the dead letter is
implicit — `<pipe>.dead` — and here it is a declared pipe, because somebody has to go and look at the
money that did not move.

### The one versioned message

`OrderPlaced` is at **v1.1**: `note` — a gift message — was added, so a v1.0 producer is still correct.

```7k
message OrderPlaced v1.1 @event {
  note: common.Note? @since(1.1)
}

upcast OrderPlaced v1.0 to v1.1 {
  note = absent
}
```

`absent` rather than an empty string: nobody wrote a gift message, which is a different fact from
writing an empty one. `Reporting` declares `accepts v1.x`, which is what makes the upcast do anything —
pinning `v1.0` exactly would have turned every producer bump into a deployment ordering problem.

### The runs worth watching

**`OrderShipsSameDay`** — the whole path: placed, stock held while the card is authorised, picked six
hours later. Press `g` while it plays: the two branches fill in **`authorise` first**, because the card
answers in 100ms and the shelf takes 200ms. They were sent at the same instant.

**`CardDeclined`** — the stock is held, and *then* the card is declined. The saga rejects and releases
stock it had already reserved, which a sequence could never have arranged.

**`NothingShipped`** — two days of nothing, then the ship step times out and **both** halves of the
stage are unwound: `ReleaseStock` and `VoidAuthorisation`. The only run in any of these samples where
two undos run.

**`OutOfStock`** — the last one sold while the basket was open. Refused before any money moves, and the
authorisation branch still waiting never fires its own timeout, because the saga is already over.

**`CatalogueNeverAnswers`** — the shelf never replies, so the step's own 30-second timeout fires. The
money authorised in the meantime is given straight back.

**`SweepRunsNightly`** — the schedule firing three nights running, with `+24.0h` between occurrences.

**`PlaceWithoutScope`** — a claim check failing. Refused before the handler runs, and never retried.

## How the three samples differ

All three exist to be looked at, so they deliberately share the vocabulary the views speak — a boundary,
PII that propagates, a lossy or unusual pipe, a saga with a parallel stage, and a schedule. What they do
not share is the shape of the problem:

| | parcel lockers | support desk | this shop |
|---|---|---|---|
| The scarce thing | a compartment | an agent's attention | stock, **and** money |
| Undos that run | one | one | **two** |
| The odd pipe | `at-most-once` telemetry | `at-most-once` heartbeats | a `stream`, and a named `dlq` |
| `onMissed` | `all` | `once` | `skip` |
| Also shows | a flaky door | `issues` | `decimal` money, `upcast`, `effectively-once` |

The three `onMissed` values are deliberate: between them the samples cover all of them. `skip` is right
here and wrong in the other two, because an abandoned-order sweep looks at the orders that are abandoned
*now* — a run missed yesterday has nothing of its own to do, since today's sweep sees everything
yesterday's would have.

## Regenerating the trace

`fulfilment.ndjson` is checked in so the demo works without a sandbox checkout. With one beside this
repository, `npm run trace` from the repository root regenerates all three traces and validates each
against the trace format before writing it.
