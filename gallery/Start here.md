# Start here

A gizmo is an ordinary note whose properties start with `app:` and one sentence saying what it is for, and the keys you type under it (a view, a source, a form, a button) turn it into a small app. It takes input, keeps state and writes back to your vault, saving what you log in a data note beside it, with no code and nothing hidden in a database. A component is a note that other apps, or every note in a folder, can reuse. A kind is a note for rows of one shape that any app can read and add to.

- [[Medication log]]: Take each dose on time, catch the ones I miss, refill before I run out, and show my doctor how it went (saves into [[Dose]])
- [[Vitals]]: See whether my weight, blood pressure, pulse and sleep are moving the right way, and take the numbers to an appointment (saves into [[Measurement]])
- [[Practice]]: Log how long I practise and see this week against the last and the trend toward my goal (needs [[Tracker kit]])
- [[Budget]]: Know where the month will end before it ends, with every bill and bank charge in it (saves into [[Spend]])
- [[Bills and renewals]]: Keep every bill and renewal in one place, so nothing lapses and no price rise slips by (saves into [[Spend]] and [[Renewal]])
- [[Household chores]]: Share the chores and keep up the house, with what is due this week, what is overdue, who did what, and a year of upkeep (saves into [[Chore]] and [[Spend]])
- [[Book finder]]: Find books on Open Library and keep the ones I want on my shelf
- [[Reading progress]]: Track where I am in a book, on the book's own note
- [[Project board]]: Move my projects from idea to done and open the one I'm working on
- [[Task inbox]]: Capture tasks and tick them off wherever they live in my notes
- [[Decision journal]]: Write down a decision before I know how it turns out, score it later, and see how often I'm right
- [[Decision review]]: Score a decision on its own note, next to what I wrote about it
- [[Trip planner]]: Plan one trip: days to go, packing, the itinerary, the weather, and what the trip will cost against its budget (needs [[Destination weather]], [[Spend]] and Trips/Tokyo.ics)
- [[Trades]]: Keep every trade, see what I hold and what it cost, plan my buys, and watch the price (saves into [[Trade]])
- [[Aurora watch]]: Get told when an aurora is likely and keep my own record of what I saw
- [[Read later]]: Save articles from a few feeds to read later and tick them off
- [[Today]]: A plain note with a medication button and a water counter in its text (needs [[Medication log]])
- [[Destination weather]]: A destination's weather now, the week ahead and a typical year
- [[Tracker kit]]: Log a number each time I measure it, and see this week against the last and the trend toward my goal
- [[Spend]]: A kind: every amount I spend or plan to, in dollars, which Budget, Bills and renewals and Trip planner read and add to; your bank's CSV export comes in through Inbox/Bank (a sample is there)
- [[Renewal]]: A kind: every deadline I must act on, with the day to start on it, which Bills and renewals reads and adds to
- [[Dose]]: A kind: every dose taken or planned, and every refill, which Medication log reads and adds to
- [[Measurement]]: A kind: every reading of weight, blood pressure, pulse or sleep, which Vitals reads and adds to; a health app's CSV export comes in through Inbox/Health (a sample is there)
- [[Trade]]: A kind: every buy and sell, made or planned, which Trades reads and adds to; your broker's CSV export comes in through Inbox/Broker (a sample is there)
- [[Chore]]: A kind: every chore and bit of upkeep, done or planned, and who did it, which Household chores reads and adds to

Gizmo's board, calendar (or year heatmap), timeline, chart and number also work inside any base, with
no app note: add a view to the base and pick one whose name starts with Gizmo.

You can log to an app without opening it. Gizmo: Do… takes one line that starts with a shortcut's
name and goes on with its values: `spend 14.5 food lunch`, `weight 81.2`, `meds`, `task renew the
passport`, `pack charg`. A line starting `;;` in any note does the same and leaves a receipt behind.
Each shows what it will do before you press Enter. Values fill the form's fields in order, dates can
be words (today, yday, fri, last mon), and a name is the panel's `alias:` or its `shortcut:`, or a
kind's `shortcut:` (`spend` is the Spend kind's). Copy capture link gives a phone's shortcut or a
launcher the same line.

To say once what may happen to your data, write a note called Gizmo policy at the root of your vault:
`labels` says how private notes are (`"Health/**": private`, `"#finance": private`), `sinks` says
where data may go and how private it may be there (`api.open-meteo.com: public`; notices and the
status bar take personal unless you say), and `release` lets one panel's value through anyway. Then
run Gizmo: Review and apply data policy. From then on an app that would send data somewhere it may
not go is blocked and says why, and an app that only reads notes and fetches from sites you listed
opens without asking.

A kind is allowed on its own. Once you allow an app, it shows a card for each kind it reads that
you haven't allowed yet, such as Spend in Budget: Allow Spend there, and Spend reads the bank's file
in Inbox/Bank and asks in Next about what needs you.

Copy a note into your vault and open it; it will ask before it touches anything.
