# Gizmo cookbook

This cookbook has 43 recipes for Gizmo 0.6.1. Each recipe is one note, or two or three notes, that you copy into your vault. The first recipes are small. Each recipe after them adds one idea. The [reference](reference.md) gives the full details of each key.

## How to use this cookbook

1. Make a new note with the name that the recipe gives. The name `Books/Dune` is the note `Dune` in the folder `Books`.
2. Open the note in **Source mode**. This mode shows the YAML as it is. The YAML must be exact.
3. Paste the text of the recipe. The keys are between the two `---` lines at the top of the note.
4. Run **Gizmo: Open this note as an app**.
5. If the app shows a permission card, read the card. Then select **Allow**. To run the app on copies first, select **Try it first**.

In all recipes:

- A recipe can use a note from an earlier recipe. The recipe names that note. Make that note first.
- The names, numbers and dates are examples. Change them to your own.
- An app saves its data in a note beside the app. The name of that note is `<App> data`. You can read that note. Obsidian Bases and Dataview can read it.
- If a key has a mistake, the app shows a card with the fix. For example, the card says `unknown key "lable" (did you mean label?)`.

## Contents

**Basic**

1. [Count the days to a date](#1-count-the-days-to-a-date)
2. [Keep a streak with one button](#2-keep-a-streak-with-one-button)
3. [Count the glasses of water you drink](#3-count-the-glasses-of-water-you-drink)
4. [Log a number with a note](#4-log-a-number-with-a-note)
5. [Keep a packing list](#5-keep-a-packing-list)
6. [Keep a table that you can edit](#6-keep-a-table-that-you-can-edit)
7. [Keep a monthly limit](#7-keep-a-monthly-limit)
8. [Draw a chart](#8-draw-a-chart)
9. [List the notes in a folder](#9-list-the-notes-in-a-folder)
10. [Mark the tasks in your notes as done](#10-mark-the-tasks-in-your-notes-as-done)
11. [Put an app in your daily note](#11-put-an-app-in-your-daily-note)
12. [Time a focus block](#12-time-a-focus-block)

**Intermediate**

13. [Make a kind that many apps share](#13-make-a-kind-that-many-apps-share)
14. [Log from anywhere with Do…](#14-log-from-anywhere-with-do)
15. [Write rows in your daily note with ;;](#15-write-rows-in-your-daily-note-with-)
16. [Use one kit for many apps](#16-use-one-kit-for-many-apps)
17. [Calculate a value with a formula](#17-calculate-a-value-with-a-formula)
18. [Pay in a different currency](#18-pay-in-a-different-currency)
19. [Move projects on a board](#19-move-projects-on-a-board)
20. [Put your projects on a timeline](#20-put-your-projects-on-a-timeline)
21. [See your days on a calendar](#21-see-your-days-on-a-calendar)
22. [Put the panels of an app in tabs](#22-put-the-panels-of-an-app-in-tabs)
23. [Select what a panel shows](#23-select-what-a-panel-shows)
24. [Run a shortcut from outside Obsidian](#24-run-a-shortcut-from-outside-obsidian)
25. [Set a daily deadline](#25-set-a-daily-deadline)
26. [Receive a notice when a figure passes a limit](#26-receive-a-notice-when-a-figure-passes-a-limit)
27. [Plan your bills and answer them in Next](#27-plan-your-bills-and-answer-them-in-next)
28. [Check your bank file against what you logged](#28-check-your-bank-file-against-what-you-logged)
29. [Show data from the web](#29-show-data-from-the-web)

**Advanced**

30. [Ask your data a question](#30-ask-your-data-a-question)
31. [Make an app from a list that you keep](#31-make-an-app-from-a-list-that-you-keep)
32. [Try a purchase first with What if…](#32-try-a-purchase-first-with-what-if)
33. [Find the rows behind a figure, and solve for a target](#33-find-the-rows-behind-a-figure-and-solve-for-a-target)
34. [See an app as it was](#34-see-an-app-as-it-was)
35. [Let one app start a different app](#35-let-one-app-start-a-different-app)
36. [Show a panel on each note in a folder](#36-show-a-panel-on-each-note-in-a-folder)
37. [Make a panel one time and use it in many apps](#37-make-a-panel-one-time-and-use-it-in-many-apps)
38. [Use Gizmo views in Obsidian Bases](#38-use-gizmo-views-in-obsidian-bases)
39. [Keep private notes out of the status bar](#39-keep-private-notes-out-of-the-status-bar)
40. [Seal a record to show a later change](#40-seal-a-record-to-show-a-later-change)
41. [Share a kind with a different vault and with a guest](#41-share-a-kind-with-a-different-vault-and-with-a-guest)
42. [Run Gizmo while Obsidian is closed](#42-run-gizmo-while-obsidian-is-closed)
43. [Send an app to a different person](#43-send-an-app-to-a-different-person)

---

## Basic

### 1. Count the days to a date

**Goal:** See how many days there are until a date.

Make the note `Holiday`:

<!-- note: Holiday.md -->
```yaml
---
app: Count the days until my holiday
view: countdown
to: 2027-07-01
---
```

**What you see.** The app shows a large number of days. Under the number, it shows the date, for example `218 days · until Jul 1, 2027`. On the day, the app says "today". After the day, the app shows the number of days with "ago". The app does not ask for permission and does not save data.

**Variations and pitfalls.**

- An app with one panel can have the keys of that panel at the top of the note, as here. For two or more panels, put the panels under `panels:`. The next recipes do this.
- Add `label: Flight to Lisbon` to show these words in place of "until".
- The value of `to` must be a date, for example `2027-07-01`. A word, for example `soon`, gives an error.

Reference: [Views](reference.md#views).

### 2. Keep a streak with one button

**Goal:** Log each time that you stretch with one button. See how many days in a row you stretched.

Make the note `Stretch`:

<!-- note: Stretch.md -->
```yaml
---
app: Log each time I stretch, and keep my streak going
panels:
  - view: button
    label: Stretched
    save: stretches
  - view: number
    title: Streak
    source: stretches
    group: at
    per: day
    agg: streak
    unit: days
---
```

**What you see.** The app shows the streak at the top and a large **Stretched** button under it. Select the button. The streak increases by one. A line under the button says what Gizmo saved and shows **Undo**.

Each time that you select the button, Gizmo saves one row into the list `stretches`. You do not make the list. Gizmo makes the list the first time that you select the button. Each row has the time in its `at` field. Gizmo keeps the list in the note `Stretch data`.

**Variations and pitfalls.**

- To change the words under the button, add `notify: Well done.` to the button.
- To save a value in each row, add `row: {where: office}` to the button.
- A streak counts the days in a row until today. A day with no row ends the streak.

Reference: [Actions](reference.md#actions), [Shape the data](reference.md#shape-the-data).

### 3. Count the glasses of water you drink

**Goal:** Count the glasses of water that you drink each day, and compare the count with a target of 8.

Make the note `Water`:

<!-- note: Water.md -->
```yaml
---
app: Count the glasses of water I drink each day
panels:
  - view: button
    label: Drank a glass
    save: water
  - view: progress
    title: Today
    source: water
    where: {at: today}
    max: 8
    unit: glasses
---
```

**What you see.** The app shows a bar at 0/8 glasses, with a mark for an even pace through the day. Select **Drank a glass**. The bar moves to 1/8. Tomorrow, the bar starts again at 0, because `where: {at: today}` keeps only the rows of today.

**Variations and pitfalls.**

- `where` accepts these date words: `today`, `this week`, `this month`, `this year`, `last 30 days`, `last 8 weeks`, `past` and `upcoming`.
- A `progress` panel without `field` counts the rows. To add the value in each row, give `field` and `agg: sum`.
- The bar changes to the error colour only when the value is more than `max`. A value equal to `max` is not over.

Reference: [Shape the data](reference.md#shape-the-data).

### 4. Log a number with a note

**Goal:** Write a number, for example your weight, with a note. See the latest value.

Make the note `Weight`:

<!-- note: Weight.md -->
```yaml
---
app: Log my weight and see the latest
panels:
  - view: form
    title: Weigh-in
    fields:
      weight: number
      note: text
    save: weights
    label: Log
  - view: number
    title: Latest
    source: weights
    sort: at
    field: weight
    agg: last
    unit: kg
  - view: table
    title: Weigh-ins
    source: weights
    sort: -at
    columns: [at, weight, note]
    format: {at: datetime}
    edit: [weight, note]
---
```

**What you see.** The app shows the add line. Type `81.2 after a run`. Gizmo shows each field under the line: the weight is 81.2 and the note is `after a run`. Push Enter.

The latest weight shows at the top. The table shows each weigh-in, with the newest first. To change a value, select a cell of the table.

**Variations and pitfalls.**

- To log a row for an earlier time, end the line with `@` and a time. For example, type `81.2 @yday` or `80.9 @8am`. The app refuses a time that has not come yet.
- A form with 5 fields or fewer shows as one line. Select **Use the form** to see one box for each field.
- With `edit: true`, you can edit each field. With `edit: [weight, note]`, you can edit only these two fields.

Reference: [Forms and fields](reference.md#forms-and-fields), [The add line](reference.md#the-add-line).

### 5. Keep a packing list

**Goal:** Keep a list of things to pack. Mark each thing as done when you pack it.

Make the note `Packing list`:

<!-- note: Packing list.md -->
```yaml
---
app: Pack for the trip
view: checklist
title: Packing
items: [Passport, Chargers, Rain jacket, Snacks, Book]
save: packed
---
```

**What you see.** The app shows each item with a box. Select an item to mark it as done. Gizmo saves the marked items in the list `packed`, in the note `Packing list data`. The marks stay after a restart. Your sync service sends them to your other devices.

**Variations and pitfalls.**

- Add `shortcut: pack`. Then type `pack rain` in **Gizmo: Do…** to mark Rain jacket as done. Refer to [recipe 14](#14-log-from-anywhere-with-do).
- `items` is a plain list. To keep items with more fields, use a table, as in the next recipe.

Reference: [Views](reference.md#views).

### 6. Keep a table that you can edit

**Goal:** Keep a list of chores. Mark each chore as done in a table.

Make the note `Chores`:

<!-- note: Chores.md -->
```yaml
---
app: Keep the chores around the house
data:
  chores:
    source: chores
    fields:
      task: text
      room: [kitchen, bathroom, garden]
      done: checkbox
panels:
  - view: form
    title: New chore
    fields: [task, room]
    save: chores
    label: Add
  - view: table
    title: To do
    source: chores
    where: {done: "!= true"}
    columns: [task, room, done]
    edit: [room, done]
---
```

**What you see.** Type `Clean the oven kitchen`. Push Enter. Gizmo puts `kitchen` in `room`, because `kitchen` is a choice of `room`. The other words are the task. The chore shows in the table.

Select the **done** box of the chore. The chore leaves the table.

`data` gives a name to a block of rows. The `fields` of the block give a type to each field. Each panel that uses the block has the same fields. For this reason, `edit` can show a dropdown for `room` and a box for `done`.

**Variations and pitfalls.**

- A choice with 6 options or fewer shows as chips under the line. Select a chip to change the choice.
- If you type no room, Gizmo guesses the room from the newest row that has a word in common with your text.
- `where: {done: "!= true"}` keeps the rows where `done` is not marked. It keeps the rows that have no `done` value. `where: {done: false}` does not keep rows without the field.
- To see the finished chores, add a second table with `where: {done: true}`.

Reference: [Forms and fields](reference.md#forms-and-fields).

### 7. Keep a monthly limit

**Goal:** See what you spend on coffee this month. Compare the total with last month and with a limit.

Make the note `Coffee money`:

<!-- note: Coffee money.md -->
```yaml
---
app: See what I spend on coffee this month, against my limit
data:
  coffees:
    source: coffees
    fields:
      price: {type: number, format: "$0.00"}
      place: text
panels:
  - view: form
    title: Bought a coffee
    save: coffees
    label: Add
  - view: number
    title: This month
    source: coffees
    where: {at: this month}
    field: price
    agg: sum
    compare: previous
  - view: progress
    title: Against my limit
    source: coffees
    where: {at: this month}
    field: price
    agg: sum
    max: 60
---
```

**What you see.** Type `4.50 corner cafe`. Push Enter. The large figure at the top is the total of the month, in the format of the field: `$4.50`. The fields are in a `data` block. Each panel that reads `coffees` uses their format. Under the figure, Gizmo compares the total with the same days of last month.

The progress panel has the same `source`, `where`, `field` and `agg` as the number. For this reason, Gizmo draws the progress panel under the number as its meter. The meter shows how much is left for each day of the month, with a mark for an even pace.

**Variations and pitfalls.**

- `compare: previous` requires a date window in `where`, for example `{at: this month}` or `{at: this week}`.
- To keep the limit in a property of the note, put `limit: 60` in the keys of the note. Then write `max: $this.limit` in the panel.
- If the panels do not have the same four keys, the progress panel shows as a separate figure beside the number.
- A `format` or a unit in the `fields` of a form applies to that form only. To use the format in each panel, put the fields in a `data` block, as here, or in a [kind](#13-make-a-kind-that-many-apps-share).

Reference: [How an app is laid out](reference.md#how-an-app-is-laid-out).

### 8. Draw a chart

**Goal:** Log your runs. See the distance of each week and compare it with a goal.

Make the note `Runs`:

<!-- note: Runs.md -->
```yaml
---
app: Log my runs and see the distance of each week
panels:
  - view: form
    title: Run
    fields:
      km: number
      route: text
    save: runs
    label: Log
  - view: bar
    title: Kilometres each week
    source: runs
    where: {at: last 8 weeks}
    group: at
    per: week
    y: km
    agg: sum
    goal: 20
  - view: line
    title: Each run
    source: runs
    x: at
    y: km
---
```

**What you see.** Type `5.2 park loop`. Push Enter. The bar chart shows one bar for each week, with the goal as a dashed line. A bar over the goal is amber. The line chart shows each run, with its last value at the end of the line.

**Variations and pitfalls.**

- To show parts of a whole, use `view: pie` with `group: route`, `y: km` and `agg: sum`.
- To compare two values, give `y` a list, for example `y: [km, minutes]`. To stack the bars, add `stack: true` to the bar chart.
- `per` requires `group` on a date field, for example `at`.

Reference: [Views](reference.md#views).

### 9. List the notes in a folder

**Goal:** See the notes of a folder as rows. Change a property of a note in a table.

Make two notes in the folder `Books`. Make the note `Books/The Quiet Harbour`:

<!-- note: Books/The Quiet Harbour.md -->
```yaml
---
genre: novel
status: reading
pages: 320
---
```

Make the note `Books/A Field Guide to Clouds`:

<!-- note: Books/A Field Guide to Clouds.md -->
```yaml
---
genre: nature
status: to read
pages: 180
---
```

Make the note `Bookshelf`:

<!-- note: Bookshelf.md -->
```yaml
---
app: See my books and set the status of each
data:
  books:
    source: notes
    from: Books
    fields:
      status: [to read, reading, done]
panels:
  - view: number
    title: Reading now
    source: books
    where: {status: reading}
    label: books
  - view: table
    title: Shelf
    source: books
    sort: name
    columns: [name, genre, status]
    edit: [status]
---
```

**What you see.** The card shows that the app asks to read the notes in Books and to change their properties. Select **Allow**.

Each note in Books is a row. The properties of the note are the fields of the row. `name` is the name of the note. Change the status of a book in the table. Gizmo writes the new status into the properties of that note.

**Variations and pitfalls.**

- `from: "#book"` reads the notes that have a tag, in place of the notes of a folder.
- Add `layout: cards` to the table to show each note as a card.
- Select a row to open the row in the side sheet. The sheet has **Open** to go to the note.

Reference: [Sources](reference.md#sources).

### 10. Mark the tasks in your notes as done

**Goal:** See the open tasks of your notes in one table. Mark tasks as done there. Add new tasks.

Make the note `Tasks/Home`. This note has tasks and no properties:

<!-- note: Tasks/Home.md -->
```markdown
- [ ] Fix the gate 📅 2026-12-05
- [ ] Call the plumber
- [x] Buy light bulbs
```

Make the note `Task list`:

<!-- note: Task list.md -->
```yaml
---
app: See the open tasks in my notes, tick them off, and add new ones
data:
  todo:
    source: tasks
    from: Tasks
panels:
  - view: form
    title: New task
    fields: {task: text}
    append: Tasks/Home
    line: "- [ ] {task}"
    label: Add
  - view: table
    title: Open
    source: todo
    where: {done: false}
    sort: due
    columns: [text, name, due, done]
    edit: [done]
---
```

**What you see.** The card shows that the app asks to read the notes in Tasks, to change the tasks in them and to add lines to `Tasks/Home.md`. Select **Allow**. The table shows the two open tasks. Gizmo reads `due` from `📅 2026-12-05` or `due:: 2026-12-05` in the task.

Select the **done** box of a task. Gizmo marks the task as done in the note. Type `Order firewood`. Push Enter. Gizmo adds `- [ ] Order firewood` at the end of `Tasks/Home`.

**Variations and pitfalls.**

- `append` gives the path of the note, from the root of the vault.
- A checkbox line in a code block is not a task.

Reference: [Sources](reference.md#sources), [Actions](reference.md#actions).

### 11. Put an app in your daily note

**Goal:** Use the water counter of [recipe 3](#3-count-the-glasses-of-water-you-drink) inside your daily note.

Make the note `Daily/2026-11-25`. This note has text and a `gizmo` code block:

<!-- note: Daily/2026-11-25.md -->
````markdown
# Wednesday

```gizmo
app: "[[Water]]"
panels: [Drank a glass, Today]
```

Write the rest of the day here.
````

**What you see.** The note shows the button and the bar of Water inside the text, in reading view and in live preview. Select **Drank a glass**. Gizmo saves the row in `Water data`, as it does in the app.

**Variations and pitfalls.**

- An embed finds a panel by its `title`, or by its `label` for a button or a form.
- A block can have its own panels, with the same keys as an app. Then the lists of the block go into the data note of the note with the block, for example `Daily/2026-11-25 data`.
- Run **Gizmo: Embed an app's panels here** to write the block for you. **Copy embed** in the tab menu of an app copies a block for the full app.

Reference: [Embeds](reference.md#embeds).

### 12. Time a focus block

**Goal:** Time 25 minutes of work. Write a line in your journal at the end.

Make the note `Focus`:

<!-- note: Focus.md -->
```yaml
---
app: Time a focus block and note it in my journal
view: timer
title: Focus
minutes: 25
append: Journal
line: "- Focus block done at {time}"
---
```

**What you see.** The card shows that the app adds lines to `Journal.md`. Select **Allow**. The app shows a timer at 25:00 and a **Start** button. Select **Start**. When the time ends, Gizmo adds the line to the end of the note `Journal`, with the time in place of `{time}`. If the note `Journal` does not exist, Gizmo makes the note.

**Variations and pitfalls.**

- To log a row for each block, as a button does, use `save: focus` in place of `append` and `line`.
- Text in braces becomes a value: `{date}`, `{time}` or a field of the row.

Reference: [Actions](reference.md#actions).

---

## Intermediate

### 13. Make a kind that many apps share

**Goal:** Keep your expenses in one place. All your apps can read the rows and add rows.

A **kind** is a note with `kind` and `fields`. The rows of a kind belong to your vault, not to one app. Make the note `Expense`:

<!-- note: Expense.md -->
```yaml
---
kind: expense
shortcut: expense
fields:
  amount: {type: number, format: "$0,0.00"}
  category: [food, home, transport, fun]
  note: text
---
```

Make the note `Spending`:

<!-- note: Spending.md -->
```yaml
---
app: Log what I spend and see this month
panels:
  - view: number
    title: This month
    source: "[[Expense]]"
    where: {at: this month}
    field: amount
    agg: sum
  - view: form
    title: Spent
    save: "[[Expense]]"
    label: Add
  - view: table
    title: Recent
    source: "[[Expense]]"
    sort: -at
    limit: 10
    columns: [at, amount, category, note]
    format: {at: relative}
---
```

Make the note `Food budget`:

<!-- note: Food budget.md -->
```yaml
---
app: See what I spend on food this month
panels:
  - view: number
    title: Food this month
    source: "[[Expense]]"
    where: {category: food, at: this month}
    field: amount
    agg: sum
---
```

**What you see.** Open `Expense`. The kind note opens as an app, with an add line and a table of all rows. The kind note asks for no permission.

Open `Spending`. The card shows that the app asks to read and change the rows of Expense. Select **Allow**. Type `12.50 food lunch`. Push Enter.

Open `Food budget`. Select **Allow**. The app shows `$12.50`, the row that Spending saved. Gizmo keeps the rows in `Expense data`, beside the kind note.

**Variations and pitfalls.**

- A form that saves to a kind uses the fields of the kind. You do not write them again.
- An app that only reads a kind cannot change or delete its rows.
- **Gizmo: Make a list a kind** changes a list that an app saves into a kind. The rows of the list go into the kind.
- The value of `kind` has letters, digits and `_`. The recipes after this one use Expense. Make the Expense kind first.

Reference: [Kinds](reference.md#kinds).

### 14. Log from anywhere with Do…

**Goal:** Add an expense from any place in Obsidian, with no app open.

This recipe uses the kind Expense of [recipe 13](#13-make-a-kind-that-many-apps-share). `shortcut: expense` gives the kind a word for the capture line. The word works after you open the kind note one time.

1. Run **Gizmo: Do…**. To open it faster, give the command a hotkey in **Settings → Hotkeys**.
2. Type `expense 4.20 food coffee`.
3. Read the preview under the line. It shows the amount, the category and the note.
4. Push Enter.

**What you see.** A notice says what Gizmo added and shows **Undo**. The row is in Expense. Spending and Food budget show the row.

**Variations and pitfalls.**

- In **Do…**, the words fill the fields in their order. Gizmo does not guess a value there.
- The last text field takes the rest of the line. For example, `expense 14 food lunch with friends` saves the note `lunch with friends`. To keep the words of a value together, put them in quotes, for example `expense 14 food "lunch with friends"`.
- To log a row for an earlier time, end the line with `@` and a time, for example `expense 4.20 food coffee @yday 9am`.
- To give a button or a form of an app a word, add `alias: water` or `shortcut: water`.
- **Gizmo: Copy capture link** copies a link that runs the same line. Use the link in a launcher or on a phone.
- If no shortcut reads the line, Gizmo opens the app with that name. For example, type `spending`. Then push Enter.

Reference: [The capture line](reference.md#the-capture-line).

### 15. Write rows in your daily note with ;;

**Goal:** Log an expense in a note while you write. A change to the line changes the row, and a change to the row changes the line.

This recipe uses the kind Expense of [recipe 13](#13-make-a-kind-that-many-apps-share).

1. In any note, for example your daily note, type `;; expense 9 transport bus`.
2. Select **Run in Expense** in the menu, or push Enter.

**What you see.** Gizmo saves the row. Gizmo writes the line again as `✓ expense 9 transport bus ^gz-…`. The text after `^gz-` is the id of the row. The id links the line to the row:

- Change `9` to `11`. After a short time, the row changes. Each total changes with the row.
- Delete the line. Gizmo removes the row. To restore the row, select **Undo** in the activity.
- Change the row in an app. Gizmo writes the line again.

**Variations and pitfalls.**

- Gizmo acts only on changes that you make in the editor on this device. A change from a sync does not change the row. For this reason, two devices do not make the same change two times.
- A `;;` line in a code block is not a row.
- A line that saves no row, or more than one row, has a receipt in place of an id. A line for a button is an example.

Reference: [Lines are rows](reference.md#lines-are-rows).

### 16. Use one kit for many apps

**Goal:** Write a full app one time. Then make two apps from it, with three lines for each app.

A **kit** is a full app in one component. Make the note `Daily total kit`:

<!-- note: Daily total kit.md -->
```yaml
---
component: Add up a number each day against a daily goal
params:
  what: pages
  goal: 30
panels:
  - view: form
    title: Add $what
    fields:
      amount: number
    save: $what
    label: Add
  - view: number
    title: Today
    source: $what
    where: {at: today}
    field: amount
    agg: sum
    unit: $what
  - view: progress
    title: Today
    source: $what
    where: {at: today}
    field: amount
    agg: sum
    max: $goal
    unit: $what
---
```

Make the note `Push-ups`:

<!-- note: Push-ups.md -->
```yaml
---
app: Count my push-ups toward 50 a day
use: "[[Daily total kit]]"
with: {what: pushups, goal: 50}
---
```

Make the note `Pages read`:

<!-- note: Pages read.md -->
```yaml
---
app: Count the pages I read toward 30 a day
use: "[[Daily total kit]]"
with: {what: pages, goal: 30}
---
```

**What you see.** Each app shows an add line, the total of today and a meter toward its own goal. In Push-ups, type `20`. Push Enter. The total is 20 pushups, and the meter shows 30 left. Each app keeps its own rows. Push-ups keeps its rows in `Push-ups data`, and Pages read keeps its rows in `Pages read data`.

**Variations and pitfalls.**

- `params` gives a default to each value. `with` replaces the defaults. To use a value in a key, write `$` and its name, for example `$goal`.
- If you change the kit, each app that uses the kit changes.
- Keys beside `use` replace the keys of the kit. To show the app on a grid, add `layout: grid` beside `use`.

Reference: [Components, kits and lenses](reference.md#components-kits-and-lenses).

### 17. Calculate a value with a formula

**Goal:** Log each time that you buy fuel. See the price of each litre.

Make the note `Fuel log`:

<!-- note: Fuel log.md -->
```yaml
---
app: Log each fill-up and see what fuel costs per litre
panels:
  - view: form
    title: Fill-up
    fields:
      litres: number
      paid: {type: number, format: "$0.00"}
    save: fuel
    label: Log
  - view: table
    title: Fill-ups
    source: fuel
    sort: -at
    compute:
      per_litre: round(paid / litres, 3)
    columns: [at, litres, paid, per_litre]
    labels: {per_litre: Per litre}
    format: {at: date, per_litre: "$0.000"}
---
```

**What you see.** Type `40 62.80`. Push Enter. The numbers go to the number fields in their order: 40 litres and $62.80. The table shows the new column `Per litre` with the value `$1.570`. Gizmo calculates the value each time that it shows the table. Gizmo does not save the value.

**Variations and pitfalls.**

- Formulas use only these functions:
  - For numbers: `round`, `floor`, `ceil`, `abs`, `min`, `max` and `number`.
  - For conditions: `if` and `coalesce`.
  - For text: `text`, `lower`, `upper`, `trim`, `len`, `contains`, `startswith`, `endswith` and `replace`.
  - For dates: `date`, `year`, `month`, `day`, `weekday`, `hour`, `days`, `today` and `now`.
  - For rows: `prev` and `field`.
- Formulas have no variables and no loops.
- To save the result of a formula, put the formula in `row` with `=` at the start. `row` sets each value that the form saves. Write each field in `row`, as here: `row: {litres: "{litres}", paid: "{paid}", per_litre: "=round(paid / litres, 3)"}`.

Reference: [Shape the data](reference.md#shape-the-data), [Actions](reference.md#actions).

### 18. Pay in a different currency

**Goal:** Log what a trip costs in dollars. You can pay in yen or in euros.

Make the note `Trip costs`:

<!-- note: Trip costs.md -->
```yaml
---
app: Log what the trip costs, in dollars, whatever I pay in
data:
  costs:
    source: costs
    fields:
      amount: {type: USD, rates: {JPY: 150, EUR: 0.92}}
      note: text
panels:
  - view: form
    title: Paid
    save: costs
    label: Add
  - view: number
    title: The trip so far
    source: costs
    field: amount
    agg: sum
  - view: table
    title: Costs
    source: costs
    sort: -at
    columns: [at, amount, note]
    format: {at: date}
---
```

**What you see.** Type `1500 jpy ramen`. Push Enter. Gizmo saves `$10.00`, because one dollar is 150 yen. The row keeps the text that you typed, in `amount_as: 1500 JPY @150`. The total and the table show dollars with no `format`. This is because the field is in the `data` block that they read.

**Variations and pitfalls.**

- A rate is the quantity of that currency for one unit of the currency of the field. Gizmo does not download rates. You can change a rate at any time. The rows that you saved keep the rate of their day.
- If a currency has no rate, Gizmo does not save the row. Gizmo says which currency has no rate.
- Units of measure work in the same way. With `weight: kg`, the line `180 lb` saves 81.647 kg.
- A formula cannot add two units, for example dollars and yen. Gizmo shows an error in the panel.

Reference: [Units](reference.md#units).

### 19. Move projects on a board

**Goal:** Keep each project as a note. Move the project from idea to done on a board.

Make the note `Projects/Garden shed`:

<!-- note: Projects/Garden shed.md -->
```yaml
---
status: doing
area: garden
start: 2026-11-02
due: 2026-12-14
---
```

Make the note `Projects/New website`:

<!-- note: Projects/New website.md -->
```yaml
---
status: idea
area: work
start: 2026-12-01
due: 2027-02-26
---
```

Make the note `My projects`:

<!-- note: My projects.md -->
```yaml
---
app: Move my projects from idea to done
data:
  projects:
    source: notes
    from: Projects
    fields:
      name: text
      status: {type: [idea, doing, done], default: idea}
      area: [home, work, garden]
panels:
  - view: form
    title: New project
    fields: [name, area]
    save: projects
    label: Add
  - view: board
    title: Projects
    source: projects
    group: status
    item: "{name} · {area}"
---
```

**What you see.** The card shows that the app asks to read, make and change the notes in Projects. Select **Allow**. The board has a column for each status and a card for each project.

Drag a card to a different column. Gizmo changes the `status` of the note. To move a card with the keyboard, select the card. Then push Shift → or Shift ←.

Type `Paint the fence home`. Push Enter. Gizmo makes the note `Projects/Paint the fence` with `status: idea`.

**Variations and pitfalls.**

- A card shows the text before ` · ` as its name. The rest of the text is on a line under the name.
- Select a card to open the card in the side sheet. The sheet has **Open** for the note.
- A form that saves to a block of notes makes a note. The name of the note is the value of the field `name`. To set the name in a different way, give the form a `name` key, for example `name: "{task} {date}"`.

Reference: [Views](reference.md#views), [Actions](reference.md#actions).

### 20. Put your projects on a timeline

**Goal:** See when each project starts and ends.

This recipe uses the notes in Projects of [recipe 19](#19-move-projects-on-a-board). Make the note `Project dates`:

<!-- note: Project dates.md -->
```yaml
---
app: See when each project starts and ends
panels:
  - view: timeline
    title: Schedule
    source: notes
    from: Projects
    start: start
    end: due
    item: "{name}"
---
```

**What you see.** The card shows that the app asks to read the notes in Projects. Select **Allow**. The timeline shows one bar for each project, from `start` to `due`, and a Today line in the accent colour. A bar that ended before today is grey. The bar of a project that starts after today is an outline.

**Variations and pitfalls.**

- A row with no `end` shows as a dot on its day.
- To show text in the side sheet when you select a bar, add `detail: "{name} is {status}"`.
- A note with no `start` date is not in the timeline. Under the timeline, Gizmo gives the number of such notes, for example "1 without a date".

Reference: [Views](reference.md#views).

### 21. See your days on a calendar

**Goal:** See on which days you spent money. Select a day to see what you spent on that day.

This recipe uses the kind Expense of [recipe 13](#13-make-a-kind-that-many-apps-share). Make the note `Spending days`:

<!-- note: Spending days.md -->
```yaml
---
app: See on which days I spent money, and on what
panels:
  - view: calendar
    title: Each day
    source: "[[Expense]]"
    group: at
    y: amount
    agg: sum
    format: "$0"
    select: day
  - view: list
    title: On the day I pick
    source: "[[Expense]]"
    where: {at: $day.at}
    item: "{amount} · {category} · {note}"
---
```

**What you see.** The calendar shows a month grid with the total of each day. Select a day. The side sheet opens with the expenses of that day. `select: day` gives the name `$day` to the day that you select. The list panel reads `$day`.

**Variations and pitfalls.**

- Add `layout: year` to the calendar to see a heatmap of the full year.
- A calendar always counts for each day. Do not give `per` to a calendar.
- A panel that reads a selection shows in the side sheet only after you select something.

Reference: [Inputs and names](reference.md#inputs-and-names), [The side sheet](reference.md#how-an-app-is-laid-out).

### 22. Put the panels of an app in tabs

**Goal:** See your spending in three ways, with one tab for each way.

This recipe uses the kind Expense of [recipe 13](#13-make-a-kind-that-many-apps-share). Make the note `Money`:

<!-- note: Money.md -->
```yaml
---
app: See my spending in three ways
tabs:
  Month:
    - view: number
      title: This month
      source: "[[Expense]]"
      where: {at: this month}
      field: amount
      agg: sum
    - view: pie
      title: By category
      source: "[[Expense]]"
      where: {at: this month}
      group: category
      y: amount
      agg: sum
  Weeks:
    - view: bar
      title: Each week
      source: "[[Expense]]"
      where: {at: last 8 weeks}
      group: at
      per: week
      y: amount
      agg: sum
  All:
    - view: table
      title: Every expense
      source: "[[Expense]]"
      sort: -at
      columns: [at, amount, category, note]
---
```

**What you see.** The app shows three tabs over the panels: Month, Weeks and All. Select a tab to show its panels. When the tabs have focus, ← and → move to the tab beside the current tab.

**Variations and pitfalls.**

- `tabs` replaces `panels`. As an alternative, keep `panels` and add `tab: Weeks` to a panel.
- The pie shows a maximum of six parts. It combines the smallest parts as "Other".

Reference: [Top-level keys](reference.md#top-level-keys).

### 23. Select what a panel shows

**Goal:** Select a category in a dropdown. See only that category.

This recipe uses the kind Expense of [recipe 13](#13-make-a-kind-that-many-apps-share). Make the note `Category lookup`:

<!-- note: Category lookup.md -->
```yaml
---
app: Look up one category of my spending
inputs:
  category: [food, home, transport, fun]
panels:
  - view: number
    title: $category this month
    source: "[[Expense]]"
    where: {category: $category, at: this month}
    field: amount
    agg: sum
  - view: table
    title: Each $category expense
    source: "[[Expense]]"
    where: {category: $category}
    sort: -at
    columns: [at, amount, note]
    format: {at: date}
---
```

**What you see.** The app shows a dropdown at the top. Select `transport`. The titles and the figures change to transport.

**Variations and pitfalls.**

- There are three types of input: a list of choices for a dropdown, `text` for a box to type in, and `date` for a date.
- A name can go into a `where`, a title, a text or a web address. A name cannot go into a `from`, an `append`, a `store` or a `save`. This rule keeps the permissions of the app the same, for each value that you select.

Reference: [Inputs and names](reference.md#inputs-and-names).

### 24. Run a shortcut from outside Obsidian

**Goal:** Log your mood from a phone shortcut, a launcher or a hotkey.

Make the note `Mood`:

<!-- note: Mood.md -->
```yaml
---
app: Log my mood from anywhere
panels:
  - view: form
    title: How I feel
    fields:
      mood: [good, okay, low]
    save: moods
    label: Log
    shortcut: mood
  - view: number
    title: Logged today
    source: moods
    where: {at: today}
    agg: count
    shortcut: moods-today
---
```

**What you see.** The card shows that the app asks to send the value of `moods-today` to the app that opens its link. Select **Allow**. `shortcut` adds three things:

- A command, **Gizmo: Mood: Log**. You can give the command a hotkey in **Settings → Hotkeys**.
- A link. Run **Gizmo: Copy link to an app shortcut**. Select **Mood: Log**. The link has the form `obsidian://gizmo?app=Mood&do=mood&key=…`. To give the field a value, add `&mood=good` at the end. Use the link in an "Open URL" step of Apple Shortcuts, or in Raycast or Alfred.
- A word for **Do…**, for example `mood good`.

**Variations and pitfalls.**

- The key in the link lets the link run immediately. A link without the key first shows **Run** and **Cancel**. Keep the key private.
- A shortcut on a `number` or a `progress` panel can send its value back to the app that called it. Add an `x-success` address to the link of `moods-today`, for example `&x-success=shortcuts://`. Then the count goes to that app.
- The `x-success` address can start with `shortcuts`, `raycast`, `alfred`, `kmtrigger`, `drafts` or `https`. For each new app, Gizmo asks you first. You can select **Cancel**, **Once** or **Always**.
- To log the row for a different time, add `&at=yday%208am`.
- Each shortcut accepts 20 link runs in each hour.

Reference: [Shortcuts and links](reference.md#shortcuts-and-links).

### 25. Set a daily deadline

**Goal:** Take a vitamin by 21:00 each day. Receive a notice when you forget.

Make the note `Evening vitamin`:

<!-- note: Evening vitamin.md -->
```yaml
---
app: Take my vitamin by nine each evening
panels:
  - view: button
    label: Took my vitamin
    save: vitamins
    alias: vitamin
  - view: number
    title: Days on time
    source: expect
    where: {rule: evening-vitamin, met: true}
    group: at
    per: day
    agg: streak
    unit: days
expect:
  - id: evening-vitamin
    every: day
    by: "21:00"
    source: vitamins
    say: no vitamin logged by 21:00
---
```

**What you see.** The label of the button shows the state of the rhythm. Before 21:00, the button says **Due by** and the time. After 21:00, the button says **Late**. After you select the button, it says **Done today**.

If no row comes by 21:00, Gizmo shows a notice with the words of `say`. **Gizmo: Next** asks "Took my vitamin? by 21:00". Push Enter to log the row. **Days on time** counts the days in a row that met the rule.

**Variations and pitfalls.**

- `every` is `day`, `week` or `month`. For a week, `by` has a weekday, for example `by: "sun 18:00"`. For a month, `by` has a day, for example `by: "1 09:00"`.
- A value rule refuses a wrong row before Gizmo saves the row, for example `- {id: sane-weight, source: weights, check: {weight: "between 30 and 250"}}`.
- A state rule gives a notice when a row matches, for example `- {id: overdue, source: chores, none: {due: past}, say: a chore is overdue}`.
- Next uses the button because the button has an `alias`. If the panel has no `alias` and no `shortcut`, Next shows the `id` of the rule, and Enter opens the app.
- A rhythm uses the time zone of the device that you used last.
- Background work runs only for apps that you opened one time and allowed.

Reference: [Expectations](reference.md#expectations), [Next](reference.md#next).

### 26. Receive a notice when a figure passes a limit

**Goal:** Receive a notice when the spending of the month passes your limit. See the figure in the status bar.

This recipe uses the kind Expense of [recipe 13](#13-make-a-kind-that-many-apps-share). Make the note `Spending alert`:

<!-- note: Spending alert.md -->
```yaml
---
app: Tell me when the spending of this month passes my limit
limit: 400
panels:
  - view: number
    title: Spent this month
    source: "[[Expense]]"
    where: {at: this month}
    field: amount
    agg: sum
    alert: "> $this.limit"
    pin: status
---
```

Make the note `Needs attention`:

<!-- note: Needs attention.md -->
```yaml
---
app: Show each alert that is on now
view: alerts
title: Needs attention
---
```

**What you see.** On desktop, the status bar shows the figure, for example `Spent this month: $16.70`.

In **Do…**, type `expense 450 home sofa`. This expense makes the total of the month more than 400. Gizmo shows a notice. In the app, a line under the figure says that the alert is on. The note `Needs attention` lists each alert that is on now, from all apps.

**Variations and pitfalls.**

- `$this.limit` reads the property `limit` of the app note. If you change the property, the alert changes. This adds no permission.
- On a table or a list, `alert: {due: past}` gives a notice for each row that matches.
- Alerts and pins work for apps that you opened and allowed, while Obsidian is open or while [gizmod](#42-run-gizmo-while-obsidian-is-closed) runs.

Reference: [Background work](reference.md#background-work).

### 27. Plan your bills and answer them in Next

**Goal:** Plan each bill one time. See what is still to pay. Answer each bill when its day comes.

This recipe uses the kind Expense of [recipe 13](#13-make-a-kind-that-many-apps-share). Make the note `Bills`:

<!-- note: Bills.md -->
```yaml
---
app: Plan my bills and see what is still to pay
data:
  coming:
    source: "[[Expense]]"
    lines: planned
    where: {matched: ""}
    sort: at
panels:
  - view: number
    title: Still to pay
    source: coming
    field: amount
    agg: sum
  - view: form
    title: Plan a bill
    save: "[[Expense]]"
    label: Plan
  - view: table
    title: Bills to come
    source: coming
    limit: 12
    columns: [at, amount, note]
    format: {at: date}
---
```

**What you see.** Select **Allow**. Type `1200 home rent @every month from dec 1 until 2027-12-01`. The preview says how many rows the line plans. Push Enter. On a kind, a row for a time that has not come yet is a **planned** row.

The table shows the next 12 bills. **Still to pay** is the sum of all the planned bills.

When the day of a bill passes and no row paid the bill, **Gizmo: Next** asks "1200 home rent, planned …: did it happen?" Use one of these keys to answer:

- Enter for **It happened**.
- `s` to skip the bill until tomorrow.
- `x` to dismiss the bill.

If you log `expense 1200 home rent` near the day of the bill, the new row settles the planned row. Then Next asks nothing.

**Variations and pitfalls.**

- A panel that reads a kind sees only the logged rows. `lines: planned` shows the planned rows. `lines: [logged, planned]` counts a paid bill one time, at the amount that you paid.
- `where: {matched: ""}` keeps only the planned rows that nothing settled yet.
- `@every 2 weeks`, `@every 3 months` and `@every year` work in the same way. `until` is necessary. One line plans a maximum of 366 rows.
- The `match` key of the kind says which rows settle a planned row. If the kind has no `match`, the amount must be the same, and the dates must be 2 days apart or less.

Reference: [Planned rows](reference.md#planned-rows), [Next](reference.md#next).

### 28. Check your bank file against what you logged

**Goal:** Read the export of your bank. See which charges you logged and which charges you did not log.

Make the note `Card`:

<!-- note: Card.md -->
```yaml
---
kind: card
shortcut: card
fields:
  amount: {type: number, format: "$0,0.00"}
  note: text
import:
  bank: {folder: Inbox/Bank, at: Date, amount: "-Amount", note: Description, where: {Amount: "< 0"}}
match:
  - {amount: exact, at: 3d}
---
```

Save the export of your bank as a CSV file in the folder `Inbox/Bank`. To try the recipe, save these lines as `Inbox/Bank/November.csv`:

<!-- file: Inbox/Bank/November.csv -->
```csv
Date,Description,Amount
2026-11-20,CORNER CAFE,-4.50
2026-11-21,CITY TRANSIT,-2.75
2026-11-22,BOOKSHOP,-18.00
2026-11-23,SALARY,2400.00
```

1. Open `Card`. The card shows that the kind asks to read `Inbox/Bank`. Select **Allow**.
2. Read the new card. It says that 3 rows wait for a check. Gizmo does not read the salary, because `where` keeps only the rows with a negative `Amount`. `-Amount` makes each charge a positive number.
3. Log the coffee that you bought on the day of the file. In **Do…**, type `card 4.50 coffee @2026-11-20`.

**What you see.** The card counts the rows again: 1 row pairs with a row that you logged, the coffee, and 2 rows are only in the file. For each row, select **Accept** if the row is yours. Select **Not mine** if the row is not yours. **Accept all** accepts each row. **Accept** makes a row from the file a logged row.

**Variations and pitfalls.**

- If Gizmo reads the same file again, or a later file with some of the same rows, it adds nothing for those rows.
- An app can show the same card. Add the panel `{view: reconcile, title: Charges to check, source: "[[Card]]"}`.
- **Gizmo: Import rows into a kind…** reads one file from any folder.
- The kind reads no file until you allow the kind.
- `match` can have more than one rule. Refer to the Spend kind of the gallery.

Reference: [Import rows from a file](reference.md#import-rows-from-a-file), [Match and reconcile](reference.md#match-and-reconcile).

### 29. Show data from the web

**Goal:** See the temperature in your city now and the highest temperatures of the next days.

Make the note `Weather now`:

<!-- note: Weather now.md -->
```yaml
---
app: See the temperature in my city now and the highs of the week
refresh: 30m
data:
  forecast:
    source: https://api.open-meteo.com/v1/forecast?latitude=48.85&longitude=2.35&current=temperature_2m&daily=temperature_2m_max&timezone=auto
panels:
  - view: number
    title: Now
    source: forecast
    pick: current
    field: temperature_2m
    unit: °C
    decimals: 0
  - view: bar
    title: Highs this week
    source: forecast
    pick: daily
    x: time
    y: temperature_2m_max
    unit: °C
---
```

Change `latitude` and `longitude` to the position of your city.

**What you see.** The card shows that the app asks to fetch data from `api.open-meteo.com`. Nothing goes to the web before you select **Allow**. After you select **Allow**, the figure shows the temperature now, and the chart shows a bar for each day. `refresh: 30m` loads new data each 30 minutes. `pick` selects a part of the answer.

**Variations and pitfalls.**

- Gizmo reads JSON, CSV, RSS and Atom feeds, and ICS calendars.
- To keep a sample each hour, add `record: 1h` to the block `forecast`. A panel then reads the samples as `forecast_log`.
- If the site requires a key, put `{secret:my-key}` in the address or in `headers`. Obsidian keeps the value in its secret storage, not in a note.
- If the site does not answer, the panel says why and shows **Try again**.

Reference: [Sources](reference.md#sources), [Secrets](reference.md#secrets).

---

## Advanced

### 30. Ask your data a question

**Goal:** Ask a question about a kind. Keep the answer as a panel.

This recipe uses the kind Expense of [recipe 13](#13-make-a-kind-that-many-apps-share). Run **Gizmo: Do…**. Type one of these lines:

```text
? expense this month
? expense by category this month
? expense food per week
? expense list transport
? expense count last 30 days
```

**What you see.** Gizmo draws the answer under the line while you type. Gizmo shows the YAML of the panel for the answer.

An answer with `by` or `per` is a chart. An answer with `list` is a table. Other answers are a number. An ask only reads the rows of one kind. It asks for no permission and saves nothing.

To keep the answer, use one of these:

- **Add to an app…** adds the panel to the app that you select. The app then asks to read the kind.
- **Copy YAML** copies the panel. Paste the YAML under `panels:` in an app.
- **Copy embed** copies a `gizmo` block for any note.

**Variations and pitfalls.**

- Type `?` alone to see the words that an ask accepts and the kinds of your vault.
- Gizmo does not guess. An unknown word gives an error that shows the word.
- To keep the rows whose value is an ask word, write the field name, for example `note=list`.

Reference: [The ask line](reference.md#the-ask-line).

### 31. Make an app from a list that you keep

**Goal:** Change a list that you write by hand into a kind and an app.

1. Run **Gizmo: New app from lines…**.
2. Paste these lines:

   <!-- lines -->
   ```text
   nov 3 groceries 62.10 weekly shop
   nov 4 coffee 4.50
   nov 9 transport 31 train
   nov 12 groceries 48.30
   ```

3. In **What is each line?**, type `purchase`.
4. In **One answer you know**, type `groceries = 110.40`.
5. Select one of the questions that give your answer.
6. Select **Keep**.

**What you see.** The window shows what it read: the day, a category, an amount and a note. The category is one of groceries, coffee and transport. The window shows each question that gives your answer, and the text of the two notes that it makes.

**Keep** makes the kind `Purchase`, with one row for each line. **Keep** makes the app `Purchase log`. The app has an add line, the panel of your question and a table. Gizmo then opens the app.

**Variations and pitfalls.**

- Gizmo does not use a line that has a different shape. The window gives the number of the line and the reason.
- A date with no year means the latest earlier date with that month and day. If the lines have no dates, each row has the time of now.
- Gizmo finds the fields with a fixed search. It does not use AI. The same lines always give the same notes.

Reference: [New app from lines](reference.md#new-app-from-lines).

### 32. Try a purchase first with What if…

**Goal:** See if a purchase makes the month more than your limit before you spend the money.

This recipe uses Expense of [recipe 13](#13-make-a-kind-that-many-apps-share) and Spending alert of [recipe 26](#26-receive-a-notice-when-a-figure-passes-a-limit).

1. Open `Spending alert`.
2. Run **Gizmo: Do…**.
3. Type `what if expense 450 fun concert @dec 20`.
4. Push Enter.

**What you see.** The app opens in a new tab. The tab shows the app as it is at the end of the month of the concert. A banner says what the alerts do, for example "“Spent this month” (> 400) would go on Sun Dec 20". Nothing real changes.

A planned row counts when its day comes. With the rent of [recipe 27](#27-plan-your-bills-and-answer-them-in-next), the alert goes on at Dec 1.

To make the what-if row a planned row of Expense, select **Keep as planned**. To remove the what-if row, select **Discard**.

**Variations and pitfalls.**

- To start in an app, run **Gizmo: What if…** or select **What if…** in the tab menu. Then use the add line of the app to add what-if rows.
- To see a different day, use the date in the banner or drag the time rail. You can look one year ahead at most.
- Only a kind has planned rows. The list of one app has no **Keep** button.
- Gizmo keeps what-if rows on this device only, until you select **Keep** or **Discard**.

Reference: [What if](reference.md#what-if).

### 33. Find the rows behind a figure, and solve for a target

**Goal:** See the rows behind a figure. Find the value of a planned row that gives the figure that you want.

This recipe uses the kind Expense of [recipe 13](#13-make-a-kind-that-many-apps-share). Make the note `Month ahead`:

<!-- note: Month ahead.md -->
```yaml
---
app: Know where the month will land, with the plans still to come
data:
  lands:
    source: "[[Expense]]"
    lines: [logged, planned]
    where: {at: this month}
panels:
  - view: number
    title: The month lands at
    source: lands
    field: amount
    agg: sum
  - view: form
    title: Plan something
    save: "[[Expense]]"
    label: Plan
---
```

1. Open `Month ahead`. The card shows that the app asks to read and change the rows of Expense. Select **Allow**.
2. Plan a dinner for a day that has not come yet in this month. For example, on November 25, type `160 fun "birthday dinner" @nov 28` on the line. Push Enter.
3. Select the figure, or push `=`.

**What you see.** The side sheet says how Gizmo calculates the figure, for example "The sum of amount over 5 rows". Under that text, the sheet shows the rows behind the figure, with the largest first. Each row shows when Gizmo wrote the row. The row of the dinner says "planned".

To see what changed the figure since an earlier time, select **Yesterday**, **A week ago** or **A month ago**. Or give a time and select **Compare**. The sheet shows the changes row by row.

Under **Pull it to**, type the figure that you want. For example, type a figure that is 50 less than the figure now. Select **Solve**. Gizmo shows the amount of the planned dinner that gives your figure: `$160.00 → $110.00`. To change the planned row, select **Keep**. Nothing changes before you select **Keep**.

**Variations and pitfalls.**

- **Pull it to** can change a number property of the app note, if a formula reads the property as `$this.<name>`.
- **Pull it to** shows only for rows that the app can change, and only in the tab of the app as it is now. In this recipe, the form that saves to Expense lets the app change the rows. An app that only reads a kind has no **Pull it to**.
- **Explain the first figure** in the tab menu does the same as `=`.

Reference: [Explain a figure](reference.md#explain-a-figure), [Pull the answer](reference.md#pull-the-answer).

### 34. See an app as it was

**Goal:** Look at an earlier state of an app. Undo a change.

This recipe uses Water of [recipe 3](#3-count-the-glasses-of-water-you-drink). Select **Drank a glass** two times. Then:

1. Push `[`. The time rail under the title opens. The app shows how it was before the last change. The bar shows one glass less.
2. Push `[` again to see an earlier change. Push `]` to see a later change.
3. To return to now, push Escape or select **Back to now**.
4. Select **History** in the tab header. The side sheet lists the changes of the app. To undo a change, select **Undo** on that change. To see the app at that time, select **See it then**.

**What you see.** In the past, you can only read the app. Buttons and forms are dim. Each change of the last 30 days is a tick on the rail.

**Variations and pitfalls.**

- **As of…** in the tab menu shows the app at a past time that you give.
- Gizmo reads saved lists and web answers from the history. Notes, tasks and files show as they are now. A banner gives the names of those panels.
- **Gizmo: Backtest this app** applies the alerts and rules of the app, as they are now, to its past data.

Reference: [Activity, history and replay](reference.md#activity-history-and-replay).

### 35. Let one app start a different app

**Goal:** Log a call to return. Add an errand for the call in a different app.

Make the note `Errands`:

<!-- note: Errands.md -->
```yaml
---
app: Keep a list of errands
panels:
  - view: form
    title: Add an errand
    fields: {errand: text}
    save: errands
    label: Add
    shortcut: add
  - view: list
    title: To do
    source: errands
    sort: -at
    item: "{errand}"
---
```

Make the note `Calls`:

<!-- note: Calls.md -->
```yaml
---
app: Log the calls to return, and add an errand for each
data:
  calls:
    source: calls
    fields:
      who: text
      back: {type: date, label: Call back by}
panels:
  - view: form
    title: Log a call
    fields: [who, back]
    save: calls
    label: Log
    then: {app: "[[Errands]]", do: add, fill: {errand: "Call {who} back by {back}"}}
  - view: table
    title: Calls
    source: calls
    sort: -at
    columns: [who, back]
---
```

**What you see.** Open `Errands` one time. Open `Calls`. The card shows that the app asks to run "add" in Errands. Select **Allow**.

Type `Dana +3d`. Push Enter. Calls saves the call. Then Calls runs the shortcut `add` of Errands, with the text of `fill`. Errands shows "Call Dana back by" and the date.

**Variations and pitfalls.**

- `then` works on a button and on an alert. For example, `alert: {back: past}` with `then` adds an errand for each call that becomes overdue.
- The two apps must both have permission.
- Gizmo stops a chain at a repeat, after four apps in a row, or after 20 runs of one `then` in an hour.

Reference: [Apps that start apps](reference.md#apps-that-start-apps).

### 36. Show a panel on each note in a folder

**Goal:** See and change the page that you are on, at the top of each book note.

This recipe uses the notes in Books of [recipe 9](#9-list-the-notes-in-a-folder). A **lens** is a component with `for`. Make the note `Book progress`:

<!-- note: Book progress.md -->
```yaml
---
component: Track the page I am on, on the note of each book
for: Books/
panels:
  - view: progress
    title: Where I am
    source: this
    field: page
    max: $this.pages
    unit: pages
  - view: form
    title: Update
    fields:
      page: number
    save: this
---
```

**What you see.** Open `Books/The Quiet Harbour`. The lens shows above the text of the note. The lens asks to change the properties of the notes in Books. Select **Allow**.

Type the page, for example `120`. The bar moves. Gizmo writes `page: 120` into the properties of the note.

**Variations and pitfalls.**

- `source: this` is the note that shows the lens. `$this.pages` reads the property `pages` of that note.
- A form with `save: this` writes into the properties of that note. The form shows as fields, not as one line.
- The button beside the name of the lens folds the lens. Gizmo keeps the lens folded on each note. The lens stays folded after a restart.

Reference: [Components, kits and lenses](reference.md#components-kits-and-lenses).

### 37. Make a panel one time and use it in many apps

**Goal:** Write the total of one category one time. Show the total for two categories.

This recipe uses the kind Expense of [recipe 13](#13-make-a-kind-that-many-apps-share). Make the note `Category total`:

<!-- note: Category total.md -->
```yaml
---
component: The total of one category of Expense this month
params:
  category: food
panels:
  - view: number
    title: $category this month
    source: "[[Expense]]"
    where: {category: $category, at: this month}
    field: amount
    agg: sum
---
```

Make the note `Food and fun`:

<!-- note: Food and fun.md -->
```yaml
---
app: See food and fun side by side
panels:
  - use: "[[Category total]]"
    with: {category: food}
  - use: "[[Category total]]"
    with: {category: fun}
---
```

**What you see.** The app shows two figures: food this month and fun this month. The card asks one time to read the rows of Expense, for both panels.

**Variations and pitfalls.**

- Keys beside `use` replace the keys of the component, one key at a time. For example, add `title: Eating out` beside the first `use`.
- A component cannot use itself, directly or through a different component. Gizmo shows the loop in an error.
- Gizmo does not load components from the web. A component is a note in your vault.

Reference: [Components, kits and lenses](reference.md#components-kits-and-lenses).

### 38. Use Gizmo views in Obsidian Bases

**Goal:** Show the notes of a base on a board, on a timeline or as a number, with no app note.

This recipe uses the notes in Projects of [recipe 19](#19-move-projects-on-a-board).

1. Make a base.
2. Add a filter to the base: the folder is Projects.
3. Add a view. Select **Gizmo board**.
4. Set **Group by** to `status`.
5. Add a second view. Select **Gizmo timeline**.
6. Set **Start** to `start`. Set **End** to `due`.

The file of the base, for example `Projects.base`, then has this text. A third view, **Gizmo number**, counts the notes:

<!-- file: Projects.base -->
```yaml
filters:
  and:
    - file.inFolder("Projects")
views:
  - type: gizmo-board
    name: Board
    group: note.status
    item: "{name} · {area}"
  - type: gizmo-timeline
    name: Schedule
    start: note.start
    end: note.due
  - type: gizmo-number
    name: Count
    label: projects
```

**What you see.** The board shows a card for each project, in the column of its status. Drag a card to a different column. Gizmo changes the property of the note. The activity log keeps the move and shows **Undo**. The timeline shows the dates. The number counts the notes.

**Variations and pitfalls.**

- Gizmo adds five views: **Gizmo board**, **Gizmo calendar**, **Gizmo timeline**, **Gizmo chart** and **Gizmo number**. For a heatmap in **Gizmo calendar**, set **Layout** to year.
- A Gizmo view works in a base that you embed in a note.

Reference: [Gizmo views in Bases](reference.md#gizmo-views-in-bases).

### 39. Keep private notes out of the status bar

**Goal:** Mark your health notes as private. Then no app sends their data to the status bar or the web.

Make the note `Health/Dentist`:

<!-- note: Health/Dentist.md -->
```yaml
---
date: 2027-01-12
---
```

Make the note `Checkups`:

<!-- note: Checkups.md -->
```yaml
---
app: See my next checkup
data:
  visits:
    source: notes
    from: Health
panels:
  - view: number
    title: Next checkup
    source: visits
    where: {date: upcoming}
    sort: date
    field: date
    agg: first
    format: until
    pin: status
---
```

Open `Checkups`. Select **Allow**. The status bar shows the days until the checkup. Then make the note `Gizmo policy` at the root of the vault:

<!-- note: Gizmo policy.md -->
```yaml
---
labels:
  "Health/**": private
sinks:
  api.open-meteo.com: public
---
```

Run **Gizmo: Review and apply data policy**. Select **Apply**.

**What you see.** The window lists each app that the policy stops, and why. For Checkups, the window says that data from notes in Health (private) would go to the status bar (personal). Checkups is then blocked. Checkups says which flow the policy stops. Its figure leaves the status bar.

An app that only fetches from a site in `sinks` opens without a permission card. Weather now of [recipe 29](#29-show-data-from-the-web) is an example.

**Variations and pitfalls.**

- `labels` accepts folders, for example `"Health/**"`, notes, and tags, for example `"#finance"`.
- To permit one figure to go to the status bar, add `release: [{app: Checkups, panel: Next checkup, to: [pin]}]`. Then apply the policy again.
- Gizmo does not use the policy note until you apply it. After you change the note, apply it again.
- The policy never gives a permission. You still select **Allow**.

Reference: [Data policy](reference.md#data-policy).

### 40. Seal a record to show a later change

**Goal:** Keep a log of hours worked. The log shows if someone changed a row, or logged a row later than its time.

Make the note `Hours`:

<!-- note: Hours.md -->
```yaml
---
kind: hours
shortcut: hours
fields:
  hours: number
  job: text
seal: true
---
```

1. Open `Hours`. Log some rows in **Do…**, for example `hours 3.5 fence repair`, or on the add line of the kind note.
2. Run **Gizmo: Seal this kind's rows now** in the kind note.
3. Run **Gizmo: Check this kind's seals**. The notice says how many seals hold.
4. Run **Gizmo: Make a sealed extract**.

**What you see.** The extract is one HTML file beside the kind note. Open the file in a browser. The file checks itself. It shows each row, when Gizmo wrote the row, how many times the row changed, and the time of the seal. The file marks a row that Gizmo wrote more than one day after the time of the row.

**Variations and pitfalls.**

- `seal: true` sends nothing. The times are the times of this device.
- `seal: {authority: "https://tsa.example.com/tsr"}` asks a time-stamp authority (RFC 3161) to sign the hash of each seal. Replace the address with the address of an authority that you trust. The kind then asks for permission to send the hash. The hash has 32 bytes and shows nothing about the rows.
- A seal shows when Gizmo wrote a line and that the line did not change. It does not show that the line is true.
- The device that does background work seals each sealed kind one time each day.

Reference: [Sealed records](reference.md#sealed-records).

### 41. Share a kind with a different vault and with a guest

**Goal:** Keep the chores of a house with a different person, each in your own vault. Let a sitter add chores from a phone.

Make the note `Chore`:

<!-- note: Chore.md -->
```yaml
---
kind: chore
shortcut: chore
fields:
  task: text
  who: [Alex, Sam]
share:
  relay: https://ntfy.sh
  key: {secret: chore-key}
---
```

Replace `Alex` and `Sam` with your names. If you have your own ntfy server, replace `https://ntfy.sh` with its address.

1. Open `Chore`. The card shows that the kind shares its rows through ntfy.sh, with the secret `chore-key`. Gizmo sends no row and receives no row before you select **Allow**.
2. Run **Gizmo: Invite to a kind** in the note. The first time, type your name. Then select **Make a key**. Gizmo keeps the key in the secret storage of Obsidian and never in a note.
3. Send the link `obsidian://gizmo?invite=…` to the other person in a private message. The key is in the link.
4. For a person without Obsidian, run **Gizmo: Make a guest page**. Type the name of the guest, for example `Sitter`. Gizmo makes the file `Chore guest page (Sitter).html` beside the note, and a code. Give both to the guest.

**What you see.** Each row that one of you logs goes to the other person, sealed with the key. A row from a new person waits in **Next** until you accept the person. The guest page shows the form of the kind. The guest can add rows but cannot read any row.

**Variations and pitfalls.**

- The relay sees sealed text, its size and when it comes. It cannot read a row, the name of the kind or your name.
- Each person with the key can read every row. To stop a person from reading new rows, give `key` a new secret. Make a new key. Invite the other people again.
- **Remove** on the automation map stops the rows of one person or one guest page, in your vault.
- The gallery kinds Chore and Dose have the `share` line with a `#` before it. To share a kind, remove the `#`.

Reference: [Shared kinds](reference.md#shared-kinds).

### 42. Run Gizmo while Obsidian is closed

**Goal:** Keep alerts, records and rhythms active while Obsidian is closed. Run shortcuts from a phone.

`gizmod.mjs` is a separate Node.js script, for Node 20 or later, in each release. It is not part of the plugin. Download the script from the release. Then run it with the path of your vault:

```sh
node gizmod.mjs serve --vault ~/Notes
```

In a second terminal, use the apps of the earlier recipes:

```sh
node gizmod.mjs status                          # this device, and the apps that are paused
node gizmod.mjs do "expense 3.80 food snack"    # run a capture line
node gizmod.mjs get Mood moods-today            # read the value of a shortcut
node gizmod.mjs run Mood mood mood=good         # run a shortcut with a value
node gizmod.mjs dry Errands add errand="Post the letter"   # show what a run would change
```

**What you see.** Each command answers with JSON. `serve` does the background work of the vault while Obsidian is closed. This work includes records, alerts, rhythms and `then`. `serve` answers HTTP on port 7468, on this computer and on its Tailscale address. A request from a different device requires the key of a link, for example from **Copy link to an app shortcut**. This command sends such a request:

```sh
curl -X POST http://127.0.0.1:7468/run/Mood/mood -H "authorization: Bearer <link key>" -H "content-type: application/json" -d '{"mood":"good"}'
```

Replace `<link key>` with the key at the end of the link (`&key=…`).

**Variations and pitfalls.**

- gizmod runs only the apps that you opened and allowed in Obsidian. An app that asks for more waits for a new **Allow**.
- To receive alerts on your phone, set `GIZMOD_NTFY_URL` to your own ntfy topic, for example `https://ntfy.sh/<your-topic>`.
- `node gizmod.mjs install --vault ~/Notes` starts gizmod at each login on macOS. `uninstall` removes it.
- To use secrets under launchd, put the token of a 1Password service account in the Keychain with the name `gizmod-op`. Put a `.env` file of `op://` references in `~/.config/gizmod`. gizmod then starts through `op run`, and no secret goes to disk.
- For a shared kind, give gizmod the key in `GIZMO_SECRET_<ID>`, for example `GIZMO_SECRET_CHORE_KEY`.

Reference: [gizmod](reference.md#gizmod-gizmo-without-obsidian).

### 43. Send an app to a different person

**Goal:** Give a friend a copy of an app. Your data is not in the copy.

1. Open the app, for example `Push-ups` of [recipe 16](#16-use-one-kit-for-many-apps).
2. Run **Gizmo: Share this app**. Gizmo makes one Markdown text with the app and the components that it uses. Your data is not in the text.
3. Send the text, or put the text in a GitHub Gist and send the link.
4. Your friend runs **Gizmo: Install an app from a link or text**.
5. Your friend pastes the text or the link.
6. Your friend selects **Preview**.

**What you see.** The preview lists the notes that the install makes and the permissions that the app asks for. **Try it** runs the app on copies first. **Install** makes the notes. **Install** does not replace a note with the same name. **Install** does not give permissions.

**Variations and pitfalls.**

- The text includes each kind that the app reads, without the rows of the kind.
- If your friend already has a note with the same name, the install refuses the note. Change the name in the text first.

Reference: [Share and install](reference.md#share-and-install).
