# Start here

A gizmo is an ordinary note whose properties start with `app:` and one sentence saying what it is for, and the keys you type under it (a view, a source, a form, a button) turn it into a small app. It takes input, keeps state and writes back to your vault, saving what you log in a data note beside it, with no code and nothing hidden in a database. A component is a note that other apps, or every note in a folder, can reuse.

- [[Medication log]]: Log every dose I take and keep my streak going
- [[Weight]]: Log my weight and watch the trend toward my goal (needs [[Tracker kit]])
- [[Sleep]]: Log how long I sleep and see whether I'm getting my eight hours (needs [[Tracker kit]])
- [[Budget]]: Log what I spend and get told when the month runs past my limit
- [[Household chores]]: Log the chores we do on our own phones and see who did what this week
- [[Book finder]]: Find books on Open Library and keep the ones I want on my shelf
- [[Reading progress]]: Track where I am in a book, on the book's own note
- [[Project board]]: Move my projects from idea to done and open the one I'm working on
- [[Task inbox]]: Capture tasks and tick them off wherever they live in my notes
- [[Decision journal]]: Write down a decision before I know how it turns out, score it later, and see how often I'm right
- [[Decision review]]: Score a decision on its own note, next to what I wrote about it
- [[Trip planner]]: Plan one trip: days to go, packing, itinerary, weather and what I spend abroad (needs [[Destination weather]] and Trips/Tokyo.ics)
- [[Watchlist]]: Watch a stock, record what I buy and see what my holdings are worth
- [[Aurora watch]]: Get told when an aurora is likely and keep my own record of what I saw
- [[Read later]]: Save articles from a few feeds to read later and tick them off
- [[Today]]: A plain note with the medication button and a water counter in its text (needs [[Medication log]])
- [[Destination weather]]: A destination's weather now, the week ahead and a typical year
- [[Tracker kit]]: Log a number each time I measure it, and see this week against the last and the trend toward my goal

Gizmo's board, calendar (or year heatmap), timeline, chart and number also work inside any base, with
no app note: add a view to the base and pick one whose name starts with Gizmo.

You can log to an app without opening it. Gizmo: Do… takes one line that starts with a shortcut's
name and goes on with its values: `spend 14.5 food lunch`, `weight 81.2`, `meds`, `task renew the
passport`, `pack charg`. A line starting `;;` in any note does the same and leaves a receipt behind.
Each shows what it will do before you press Enter. Values fill the form's fields in order, dates can
be words (today, yday, fri, last mon), and a name is the panel's `alias:` or its `shortcut:`. Copy
capture link gives a phone's shortcut or a launcher the same line.

Copy a note into your vault and open it; it will ask before it touches anything.
