---
kind: dose
shortcut: dose
fields:
  med: [Medication A, Medication B]
  note: text
  refill: {type: number, label: Refill}
match: {med: exact, refill: exact, at: 0d}
# To keep the doses with a carer, or someone else with a vault of their own, remove the # before
# share, then run Gizmo: Invite to a kind in this note. Nothing is sent before you allow it.
# share: {relay: "https://ntfy.sh", key: {secret: dose-key}}
---
Each dose of a medication I take, or someone I care for takes: what it was, and a note if something
was off. A row with a `refill` is not a dose: it is the doses I picked up at the pharmacy, counted
in doses (60 tablets at two a dose is a refill of 30). A dose planned for a time still to come is the
schedule, and a dose taken the same day settles the planned one nearest in time; Next asks about a
planned dose whose time passed with none taken. Put your own medications in `med` in place of
Medication A and B. Type `dose "Medication B"` in Gizmo: Do… to log one without opening anything.
The rows are kept in Dose data.

Two people with a vault each can keep Dose together: turn on `share` above, run Gizmo: Invite to a
kind here, and send the link it gives in a private message. Each dose either of you logs goes to
the other, sealed, through ntfy.sh. For a carer without Gizmo, Gizmo: Make a guest page makes a page
with this form that they open on their phone: it adds doses, and it can't read yours. If your data
policy labels health notes private, clear sharing for them first with `sinks: {share: private}`.
