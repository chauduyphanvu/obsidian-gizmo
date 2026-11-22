---
kind: chore
shortcut: chore
fields:
  task: {type: text, label: Chore}
  who: [Alex, Sam]
  area: [kitchen, laundry, rooms, outside, upkeep]
  note: text
match: {task: contains, at: 45d}
# To keep the chores with someone who has a vault of their own, remove the # before share, then run
# Gizmo: Invite to a kind in this note. Nothing is sent before you allow it.
# share: {relay: "https://ntfy.sh", key: {secret: chore-key}}
---
Each chore done around the house, and each bit of upkeep that keeps it working: who did it, and in
which part of the house. Put the people of your household in `who` in place of Alex and Sam. A chore
planned for a time still to come is a turn on the rota, with whose turn it is: `chore "Take the bins
out" Sam outside @every week from thu 20:00 until 2027-03-01`. Upkeep comes round less often, the
furnace filter every three months, the smoke alarms once a year:
`chore "Replace the furnace filter" Sam upkeep @every 3 months from dec 12 until 2028-01-01`. Done, it settles the planned one, by
anyone: `chore vacuum Alex` settles "Vacuum the house" within 45 days, the nearest first. What
upkeep costs is money, and goes in Spend. The rows are kept in Chore data.

Two people with a vault each can keep Chore together: turn on `share` above, run Gizmo: Invite to a
kind here, and send the link it gives in a private message. Each chore either of you logs goes to
the other, sealed, through ntfy.sh. For someone without Gizmo, a sitter or a cleaner, Gizmo: Make a
guest page makes a page with this form that they open on their phone: it adds chores, and it can't
read yours.
