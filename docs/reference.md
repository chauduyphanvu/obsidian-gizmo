# Gizmo reference

This page gives the technical details of Gizmo. All keys are YAML in the properties of a note, and you type them by hand. Gizmo does not write into an app note. The key language is version 1.

- [Write an app](#write-an-app)
- [The gallery](#the-gallery)
- [Top-level keys](#top-level-keys)
- [Views](#views)
- [How an app is laid out](#how-an-app-is-laid-out)
- [Sources](#sources)
- [Shape the data](#shape-the-data)
- [Forms and fields](#forms-and-fields)
- [Actions](#actions)
- [Inputs and names](#inputs-and-names)
- [Components, kits and lenses](#components-kits-and-lenses)
- [Embeds](#embeds)
- [Gizmo views in Bases](#gizmo-views-in-bases)
- [Background work](#background-work)
- [Expectations](#expectations)
- [Shortcuts and links](#shortcuts-and-links)
- [The capture line](#the-capture-line)
- [Apps that start apps](#apps-that-start-apps)
- [Permissions](#permissions)
- [Data policy](#data-policy)
- [The automation map](#the-automation-map)
- [Activity, history and replay](#activity-history-and-replay)
- [Share and install](#share-and-install)
- [Devices and sync](#devices-and-sync)
- [gizmod: Gizmo without Obsidian](#gizmod-gizmo-without-obsidian)
- [Secrets](#secrets)
- [Commands](#commands)
- [Where Gizmo keeps your data](#where-gizmo-keeps-your-data)
- [What Gizmo does not do](#what-gizmo-does-not-do)
- [Development](#development)

## Write an app

1. Make a new note with the name `Water`.
2. Open the note in **Source mode**.
3. Type these properties at the top of the note:

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

4. Run **Gizmo: Open this note as an app**.
5. Select **Drank a glass**. The progress bar moves, and a notice says what Gizmo added. Select **Undo** to take it back.

The button saves a row with the time into the list `water`. The progress panel counts the rows for today. Gizmo keeps the list in the note `Water data`, beside the app.

To add a panel quickly, run **Gizmo: Insert panel**. Then select a view. Gizmo also shows possible keys while you type.

## The gallery

Run **Gizmo: New app from the gallery** to copy an app and its components into your vault.

| App | What it does |
| --- | --- |
| Medication log | Save each dose with one button. See the count for today, your streak and a calendar of the year. Gizmo tells you if you save no dose by 10:00. |
| Weight and Sleep | Save a value each time that you measure. Compare this week with the last week, and see a chart of your values against your goal. |
| Budget | Save each amount that you spend, with its category. See the month total against your limit. Gizmo tells you when the total reaches the limit. |
| Household chores | Each person saves chores on their phone. See who did which chore this week. Two people can save at the same time, and Gizmo keeps all rows. |
| Book finder | Search Open Library. Add a book to your shelf as a note, then set its status on its card. |
| Project board | Move each project from idea to done on a board. See the dates of all projects on a timeline. |
| Task inbox | Add a task from anywhere. Set a task to done in the table, and Gizmo changes the checkbox in the note of that task. |
| Decision journal | Write a decision before you see the result. Give it a score later, and see the percentage of correct decisions. |
| Trip planner | Prepare one trip: the days until you go, a list of items to pack, the itinerary, the weather and the money that you spend. |
| Watchlist | Monitor a stock price. Save the shares that you buy, and see their value. |
| Aurora watch | Gizmo tells you when the Kp index is 5 or more, now or in the forecast. It also keeps a record of the Kp index each hour. |
| Read later | Save articles from RSS feeds as notes. Set each article to read when you complete it. |
| Today | A note that is not an app. Its text has two small apps in it: the medication button and a water counter. |

The gallery also has components that many apps can use:

| Component | What it does |
| --- | --- |
| Tracker kit | A full tracker app in one component. Give it a name, a unit and a goal. Weight and Sleep are three lines each on this kit. |
| Destination weather | The weather in a city now, for the next week and for an average year. |
| Reading progress | Your progress in a book, on the note of that book. |
| Decision review | Give a decision a score on its note, next to the text that you wrote about it. |

## Top-level keys

| Key | What it does |
| --- | --- |
| `app` | One sentence about the app. This key makes the note an app. |
| `panels` | The list of panels. Each panel has a `view`. |
| `tabs` | Panels in tabs: a map from each tab name to a list of panels. |
| `layout` | How the app is laid out: `composed` (the default) or `grid`. Refer to [How an app is laid out](#how-an-app-is-laid-out). |
| `data` | Named blocks of data. Panels use a block by its name in `source`. |
| `inputs` | Controls at the top of the app: a text field, a dropdown or a date. Panels read their values as `$name`. |
| `refresh` | The interval for new web data, for example `15m`. |
| `store` | The note that keeps the saved rows, if it is not `<App> data`. |
| `expect` | Rules for your data. Refer to [Expectations](#expectations). |
| `use`, `with` | Use a component for the full app, with values for its parameters. |
| `spec` | The version of the key language. The version now is `1`. |

## Views

The `view` key sets the view of a panel. Each panel also accepts `title`, `tab` and `span` (1 to 4 columns). `span` applies only with `layout: grid`.

| View | What it shows |
| --- | --- |
| `number` | One value. It can compare the value with the previous period. |
| `text` | A line of text from your data. |
| `progress` | A value against a maximum. |
| `countdown` | The time until a date. |
| `line`, `bar` | A chart over time or by group. It can show more than one series, stacks and a goal line. |
| `pie` | Parts of a whole, as a ring of up to six parts. |
| `scatter` | One point for each row, from two values. |
| `table` | Rows and columns. Cells can be inputs, links, images or checkboxes. `layout: cards` shows the rows as cards. |
| `list` | One line for each row. It can have a button on each row. |
| `calendar` | A month grid. `layout: year` shows a heatmap of the year. |
| `board` | Cards in columns. Drag a card to a different column to change its field. |
| `timeline` | One bar for each row, from a start date to an end date. |
| `button` | One button that does an action. |
| `form` | Fields and a button that saves their values. |
| `checklist` | Items that you can select as done. |
| `timer` | A timer for a number of minutes. |
| `alerts` | The alerts of all apps that are true now. |

**Ledgers.** A table or a list groups its rows by date when they are in date order. The rows are sorted by a date field, or they show a dated `at` column. Gizmo groups by day (Today, Yesterday, a weekday or a date). It groups by week (This week, Last week, Week of…) when the dates have no time of day and span more than two weeks. A table shows a total in each group: the sum if its first number column has a money format (`$`, `€`, `£` or `¥`), and the average if not. A list shows the same total for the first number that its `item` shows. A list with no `item` uses its `value` field. In a table, the date column shows the time of day in a day group, and the date in a week group. In a day group, the column goes away if the dates have no time. A new row of a table or list slides in. A ledger needs 2 rows or more. A table or list with `group` or `layout: cards` is not a ledger.

**Colours.** Charts draw data in ink and pencil grey. A bar chart with one series draws its bars in pencil, and the current period in ink. A bar over `goal` is amber. The goal is a dashed line, with its label at the right of the plot. A line with one series is ink, and its last value is a label at its end. Several series keep different colours. With `stack: true` and several `y` fields, a bar chart draws one bar for each x: the total. The composition of the bar that you see (the last bar, or the one under the pointer) is a strip above the chart, and a legend gives each value.

**Calendar, board and timeline.** The year heatmap is grey. Today has an outline, and a caption under it names the day that you point at, with its count and the meaning of the shades. A board has no box around a column. A card splits its text at the first ` · `: the first part is its name, and the rest is a line under it. A timeline has a Today line in the accent colour. A bar that ended before today is pencil, and an item that starts after today is an outline.

Ledgers and colours are the same in both layouts.

## How an app is laid out

Gizmo lays out each app in one column, by what its panels show. An app is an answer, not a dashboard. You change no key.

Each view has a role. The role tells where its panel goes:

| Role | Views | Where it goes |
| --- | --- | --- |
| Answer | `number`, `progress`, `countdown`, `text` | The answer band. |
| Verb | `button`, and `form` unless it has `save: this` | The add line. |
| Evidence | `line`, `bar`, `pie`, `scatter`, and `calendar` with `layout: year` | The flow. |
| Workspace | `board`, `timeline`, `timer`, other `calendar` panels, and `form` with `save: this` | The flow. |
| Records | `table`, `list`, `checklist`, `alerts` | The flow. |
| Sheet | Any panel that reads a name that another panel selects | The side sheet, when you pick. |

The app is at most 848 px wide. It reads from the top down:

1. The title of the note, and the text of `app`.
2. The time rail. Refer to [Activity, history and replay](#activity-history-and-replay).
3. The answer band. Controls from `inputs` come before it.
4. The add line.
5. The flow: evidence, workspaces and records, in the order that you write them.
6. The side sheet, at the right, when you pick something.

**The answer band.** The first `number` is the headline: a big figure with its unit and label. If there is no `number`, the first `progress` is the headline, or else the first answer panel. The other answer panels sit beside it as facts. A figure counts up when its value changes, unless your system is set for reduced motion. With `compare: previous`, the headline says how the value differs from the window before, for example `↑ 12% more than Oct 1–20 · $1,146.90`. If that window is shorter than 3 days, it gives the amount and not the percent. When the `alert` of an answer panel is on, a line under the panel says so, in the error colour.

**The meter.** A `progress` with the same `source`, `where`, `field` and `agg` as a `number` is not a fact. Gizmo draws it under that number, as its meter. The meter shows how much is left. If `where` has a date window that holds now, it also shows how much is left for each of the days that remain, and a tick marks an even pace. The fill turns to the error colour only when the value is greater than `max`. A value equal to `max` is not over.

**The side sheet.** Select a row, a card, a bar or a day to open it in a sheet at the right of the app. On a narrow screen, the sheet comes up from the bottom. The sheet shows the name of what you picked and its `detail` text. For a row of a table or a list, a card of a board or an item of a timeline, it also shows the fields, and the field controls of `edit`, the row actions and **Open** for a note. The panels that read the pick show in the sheet. A table, list, board or timeline row opens the sheet even without `select` or `detail`. A day, a bar, a slice or a dot opens it only with `select` or `detail`. To close the sheet, select the same thing again, select **Close**, push Escape or go to another tab. The pick is then cleared.

**Tabs and hosts.** Each tab keeps its own pane, laid out the same way. An app in an embed or a lens has the same layout, with no title, no time rail, no side sheet and no width limit. There, the `detail` text shows under the rows, and the panels that read a pick show at the end of the app.

**`layout: grid`.** Add `layout: grid` to keep the earlier layout. Panels sit in a grid of up to 4 columns, in the order that you write them, and `span` sets the width of each. Forms, buttons and picks are as they were, with no side sheet. Only the text `composed` or `grid` sets the layout of the app. In a note that is one panel, any other `layout` value belongs to that panel, for example `cards` for a table or `year` for a calendar.

## Sources

The `source` key tells a panel where its rows come from.

| `source` | The rows |
| --- | --- |
| `https://…` | The answer of a web address. Gizmo reads JSON, CSV, RSS and Atom feeds, and ICS calendars. |
| A name, for example `doses` | A block in `data`, or a list that the app saves in its data note. |
| `notes`, with `from` | One row for each note in a folder or with a tag, for example `from: Books` or `from: "#book"`. |
| `tasks`, with `from` | One row for each checkbox line in those notes. |
| `this` | The properties of the note that shows the panel. |
| A base, for example `Books.base` | The notes that the Obsidian base finds. |
| A vault file: `.csv`, `.json` or `.ics` | The rows of that file. |
| `expect` | The results of the `expect` rules of the app. |

A web source can also have `headers` and a `body`. A source with a `body` sends a POST request.

## Shape the data

| Key | What it does |
| --- | --- |
| `pick` | Selects the rows inside a web answer, for example `chart.result.0`. |
| `where` | Keeps only the rows that match, for example `{at: this week}` or `{kp: ">= 5"}`. |
| `sort` | Puts the rows in order. `-at` puts the newest row first. |
| `limit` | Keeps only the first rows. |
| `compute` | Adds columns from formulas, for example `cost: shares * price`. |
| `group`, `per` | Makes one row for each group, or for each `day`, `week`, `month` or `year`. |
| `field`, `agg` | Makes one value: `count`, `sum`, `avg`, `min`, `max`, `first`, `last`, `streak` or `share`. |

Gizmo writes the time into the `at` field of each saved row. Dates in `where` can be words: `today`, `this week`, `this month`, `this year`, `last 30 days`, `last 6 months` or `past`.

Formulas use a fixed list of functions, for example `if`, `round` and `prev`. They have no variables and no loops.

To change how Gizmo shows values, use `unit`, `decimals`, `format`, `labels` and `values`. A format can be a pattern, for example `"$0,0.00"`, or a word: `date`, `time` or `relative`. A `number` can have `compare: previous`. A chart can have `goal`, and a bar chart can have `stack: true`.

`compare: previous` needs a date window in `where`, for example `{at: this month}`. Gizmo compares a window that still runs with the same part of the window before. On Nov 20, `this month` is compared with Oct 1 to 20, and not with all of October. A month steps back by calendar months. If the month before is shorter, Gizmo stops at its last day. A window that looks ahead, for example `next 7 days`, is compared whole.

## Forms and fields

A `fields` map gives each field a type. A form uses all fields, or a list of field names.

```yaml
fields:
  amount: {type: number, label: Spent, format: "$0,0.00"}
  category: [food, home, transport, fun, other]
  note: text
  due: {type: date, default: today}
```

A field type can be `text`, `number`, `date`, `checkbox` or a list of choices. A field can also have a `label`, a `format` and a `default`. Put `fields` in a `data` block, and all panels that use the block use the same fields. A table with `edit: true` then lets you edit those fields in its cells.

### The add line

In the composed layout, a form with up to 5 fields is one line that you type. Gizmo reads the line with the rules of the [capture line](#the-capture-line), and shows each field under the line before you push Enter. For the Budget form, type `14.5 lunch`: the amount is 14.5 and the note is `lunch`. A choice with up to 6 options shows as chips. Select a chip to change the choice.

If you type no choice, Gizmo guesses it from the earlier rows of the list. It takes the choice of the newest row that has a word of 3 letters or more in common with your text. The preview shows the guess, and Gizmo saves it. If no row matches, the choice takes its default.

A form with a `textarea` or `checkbox` field, or with more than 5 fields, shows its fields and not one line. Select **Use the form** to see the fields of a form that fits one line. Select **Use one line** to go back. A form with `save: this` is not a line. It stays as fields.

Push `/` to move to the first add line, when no field has focus. After a save, a notice under the line says what Gizmo added, with **Undo**. The notice stays for 6 seconds. ⌘Z on a Mac, or Ctrl Z, does the same when no field has focus. The `notify` text of the panel shows in this place, and not as a pop-up. In the composed layout, a `button` is one large button with the same notice. On the grid, forms and buttons are as they were.

## Actions

| Key | What it does |
| --- | --- |
| `save: <list>` | Saves a row into a list in the data note. |
| `save: <notes block>`, `name` | Makes a note in the folder of that block. `template` gives its first text. |
| `save: this` | Writes the form values into the properties of the note that shows the form. |
| `row` | Sets the values that a save writes, for example `title: "{title}"`. |
| `append`, `line` | Adds a line to the end of a note, for example `line: "- [ ] {task}"`. `append` names the note by its path from the vault's root, plain or as a link: `Journal/Inbox` and `"[[Journal/Inbox]]"` are the same note. |
| `notify` | Shows a notice. In the composed layout, a form or a button says it under itself. |
| `open` | Opens a note. |
| `action` | Puts a button with this label on each row of a list or a table. |
| `edit` | Lets you edit table cells: `true` for all fields, or a list of fields. |
| `then` | Runs a shortcut of a different app. Refer to [Apps that start apps](#apps-that-start-apps). |

Text in braces takes a value from the row, for example `{title}` or `{author_name.0}`.

## Inputs and names

An app can have `inputs`, and a component can have `params`. Panels use their values with a dollar sign: `$symbol`, `$q`, `$what`.

```yaml
inputs:
  symbol: [SPY, QQQ, VTI]
  range: [3mo, 6mo, 1y]
data:
  chart:
    source: https://query1.finance.yahoo.com/v8/finance/chart/$symbol?range=$range&interval=1d
```

A panel with `select` also gives a value to other panels. A calendar with `select: day` gives `$day`, and a table can give its selected row. `$this` is the note that shows the panel.

Gizmo replaces only the names in the `inputs` or `params` of that note. A name cannot go into a host, a secret, `from`, `append`, `store` or a save target. This rule keeps the permissions of an app the same when an input changes.

## Components, kits and lenses

A component is a note with `component`, `params` and `panels`. An app uses it with `use` and `with`, for one panel or for the full app. Keys beside `use` replace the keys of the component, one key at a time.

```yaml
panels:
  - use: "[[Destination weather]]"
    with: {name: Tokyo, lat: 35.68, lon: 139.69}
```

A **kit** is a full app in one component. Weight and Sleep are three lines each on the Tracker kit.

A **lens** is a component with `for`. It shows on each note that matches, and it reads that note as `this`:

```yaml
component: Track where I am in a book, on the book's own note
for: Books/
panels:
  - view: progress
    source: this
    field: page
    max: $this.pages
```

## Embeds

A `gizmo` code block puts panels into the text of a note. It can show panels of an app by their titles:

````markdown
```gizmo
app: "[[Medication log]]"
panels: [Took meds, Doses today]
```
````

The block can also have its panels inside it, with the same keys as an app.

## Gizmo views in Bases

Gizmo adds five views to Obsidian Bases: board, calendar (or year heatmap), timeline, chart and number. An app note is not necessary.

1. Open a base.
2. Add a view.
3. Select a view name that starts with Gizmo.

Gizmo keeps a log of each move on a board, and you can undo it.

## Background work

Some keys operate when the app is not open:

| Key | What it does |
| --- | --- |
| `record: 1h` | On a `data` block, saves a sample of its web data at this interval. |
| `alert: ">= 5"` | Shows a notice when the value matches. On a list, `alert: {kp: ">= 5"}` tells you about each new row that matches. |
| `pin: status` | Shows the value in the status bar, on desktop. |

Background work operates only for apps that you opened one time and gave permission. It operates while Obsidian is open, or with `gizmod`. Only one device does background work at a time. In **Settings → Gizmo**, set **Background work** on or off for each device. A phone does background work only when no other device does it.

## Expectations

`expect` has rules for your data:

```yaml
expect:
  - id: morning-dose
    every: day
    by: "10:00"
    source: doses
    say: no dose logged by 10:00
```

- **Rhythm** (`every`, `by`): A row must come before the time in each day, week or month. If no row comes, Gizmo tells you.
- **Value rule** (`check`): Each new row must match. If a row does not match, Gizmo does not save it.
- **State rule** (`none`): A row must not match. If a row matches, Gizmo tells you.

`source: expect` shows the results, for example a streak of days on time. A rhythm uses the time zone of the device that you used last. After a gap, Gizmo tells you about no more than the last three periods without a row.

## Shortcuts and links

Add `shortcut: <name>` to a button, a form, a number or a progress panel. Gizmo then adds:

- A command, `<App>: <label>`. You can give it a hotkey.
- A link: `obsidian://gizmo?app=<app>&do=<shortcut>&key=<key>`. Add field values at the end, for example `&task=Call%20the%20bank`.
- A name for the capture line.

Run **Gizmo: Copy link to an app shortcut** to copy a link. The app tab menu also has this item. A copied link has a key, and it runs immediately. A link without the key first shows a **Run** or **Cancel** window with its values. Each shortcut accepts 20 link runs in each hour.

**Answer links.** A shortcut on a `number` or a `progress` panel sends its value to `x-success`. The destination can be `shortcuts`, `raycast`, `alfred`, `kmtrigger`, `drafts` or `https`. For each new destination, Gizmo asks you first: **Once** or **Always**. An action link sends `result=done`.

## The capture line

Run **Gizmo: Do…**, then type one line. The first word is the `alias` or the `shortcut` of a panel. The other words fill the form fields in their order:

```text
spend 14.5 food lunch
weight 81.2
meds
task call the bank
```

Dates can be words: `today`, `yday`, `fri` or `last mon`. Before you push Enter, Gizmo shows what the line will do. A line that starts with `;;` in a note does the same, and Gizmo writes a receipt in its place. **Gizmo: Copy capture link** gives the same line to a phone shortcut or a launcher.

The [add line](#the-add-line) of a form reads more freely than **Do…**. **Do…** gives the words to the fields in their order, and it guesses nothing. The add line gives each value to the first field that it fits, anywhere on the line. You can type a choice as its start, if the start has 3 letters or more and only one choice has it. The words that are left go to the first text field.

## Apps that start apps

`then` runs a shortcut of a different app after a form, a button or an alert:

```yaml
then: {app: "[[Errands]]", do: add, fill: {errand: "Call {who} back by {back}"}}
```

The two apps must both have permission. An alert runs its `then` one time for each new row that matches. Gizmo stops a chain at a repeat, after four apps in a row, or after 20 runs of one `then` in an hour.

## Permissions

The permission card comes from the keys. It shows each item that the app asks for:

- the sites that it downloads from,
- the notes that it reads, makes or changes,
- the secrets that it uses,
- the data that it sends to a site,
- the other apps that it starts.

You select **Allow** one time for each note. When the keys ask for more, Gizmo asks again. If an app asks for more than you permitted, Gizmo pauses the app and tells you. An app can write to its data note without permission.

## Data policy

Write a note with the name `Gizmo policy` at the root of your vault:

```yaml
---
labels:
  "Health/**": private
  "#finance": private
sinks:
  api.open-meteo.com: public
release:
  - app: Apps/Meds
    panel: Doses today
    to: [pin]
---
```

- `labels` tells how private each folder, note or tag is.
- `sinks` tells where data can go, and how private the data can be there. Notices and the status bar accept personal data unless you change them.
- `release` lets the value of one panel go to a sink.

Then run **Gizmo: Review and apply data policy**. Gizmo stops each app that sends data to a sink that does not permit it, and it tells you why. An app that only reads notes and downloads from the sites in `sinks` opens without a permission card.

## The automation map

Run **Gizmo: Open the automation map**. The map shows each app with what it reads, downloads, sends and changes, and what makes it act. From the map, you can:

- remove the permission of an app (**Revoke**),
- make a new link key for a shortcut,
- do a dry run, which shows what a run will change without a change to your notes,
- apply the data policy.

**Gizmo: Which apps can change this note?** opens the map for the note that is open. **Gizmo: Save the automation map as a canvas** saves the map as an Obsidian canvas.

## Activity, history and replay

- **Gizmo: Show app activity** shows each change, with **Undo**. Undo operates only while the vault still has what the app wrote. Gizmo moves a note that an app made to the trash only if the note is unchanged.
- **See it then** on a change shows the app at that time.
- The **time rail** is under the title of an app, in its own tab. Each change of the last 30 days is a tick. A change that you undid has no tick. Drag the handle, or push `[` and `]`, to show the app as it was at a change. With the rail in focus, the arrow keys do the same. Select **Back to now**, or push Escape, to return. The rail is only in the composed layout, and not in an embed or a lens. It uses **As of…** and the activity log, so the past is read only.
- **As of…** in the tab menu (**⋯** in the tab header) shows the app at a past time. Saved lists and web answers come from history. Notes, tasks and files show as they are now, and a banner shows the names of those panels. The fields of `edit` show as text, with no row actions, and you cannot move the cards of a board. Buttons, forms and checklists are dim, and you cannot use them.
- **Gizmo: Backtest this app** applies the alerts and `expect` rules of the app, as they are now, to its past data.

## Share and install

**Gizmo: Share this app** makes one Markdown text with the app, its components and its templates. Your data is not in it.

**Gizmo: Install an app from a link or text** accepts that text, an `https` link, a gist or an `obsidian://gizmo?install=` link. It shows a preview of the notes that it will make and the permissions that the app will ask for. It does not replace a note with the same name, and it gives no permissions. Select **Try it** to operate the app on copies first.

## Devices and sync

Gizmo operates with iCloud, Syncthing and other sync services:

- Each device writes its events to a log that only it uses, in the plugin folder.
- The data note shows the rows of all devices together.
- If two devices edit the same row at the same time, Gizmo keeps the two values. The cell shows the other value as an option.
- If you edit a data note by hand, the app shows a card with **Import** and **Discard**.
- Each saved time has its zone offset, for example `2026-11-19T08:14-08:00`.
- If Obsidian closes on the device that does background work, a different device starts the work immediately.

In **Settings → Gizmo**, give the device a name. You can also set its background work there. The settings also show the other devices. Gizmo shows a warning when two devices both do background work.

A list from `record` keeps its newest 500 rows in the data note. Gizmo keeps the older rows in checkpoints in the plugin folder.

## gizmod: Gizmo without Obsidian

`gizmod.mjs` is in each release. It is a Node.js script (Node 20 or later) that does background work when Obsidian is closed. It saves records, gives alerts, applies `expect` rules and runs `then`. It sends alerts to your phone through [ntfy](https://ntfy.sh) and answers shortcuts over HTTP.

```sh
node gizmod.mjs serve --vault ~/Notes                  # start it on port 7468
node gizmod.mjs run "Medication log" took-meds         # run a shortcut
node gizmod.mjs get "Medication log" doses-today       # read the value of a shortcut
node gizmod.mjs do "spend 14.5 food lunch"             # run a capture line
node gizmod.mjs dry "Task inbox" add task="Call the bank"  # show what a run will do
node gizmod.mjs status                                 # show the device and the paused apps
node gizmod.mjs install --vault ~/Notes                # start it at each login (macOS)
node gizmod.mjs uninstall
```

| Variable | What it does |
| --- | --- |
| `GIZMOD_NTFY_URL` | The ntfy topic address for alerts to your phone. |
| `GIZMOD_PORT` | The port. The default is `7468`. |
| `GIZMOD_HOME` | The state folder. The default is `~/.config/gizmod`. |
| `GIZMOD_MAC_NOTICES` | Set to `0` to stop macOS notices. |
| `GIZMO_SECRET_<ID>` | The value of `{secret:<id>}`, with dashes as underscores. |

gizmod listens on this computer and on its Tailscale address. It reads the permissions in `data.json`, but it does not write them. Because of this, an app that you move while Obsidian is closed waits for a new **Allow**.

`install` makes a launchd agent. For secrets under launchd, put the token of a 1Password service account in the Keychain, with the name `gizmod-op`. Then put a `.env` file of `op://` references in `GIZMOD_HOME`. The agent then starts gizmod through `op run`, and no secret goes to disk.

## Secrets

Put `{secret:<id>}` in a web address or a header:

```yaml
source: https://api.example.com/data?key={secret:example}
headers: {authorization: "Bearer {secret:example}"}
```

Obsidian keeps the value in its secret storage, not in a note. The permission card shows each secret. Gizmo does not keep a disk copy of an answer that used a secret or a body.

## Commands

| Command | What it does |
| --- | --- |
| Open this note as an app | Shows the note that is open as an app. |
| New app from the gallery | Copies a gallery app and its components into your vault. |
| Insert panel | Adds a starter panel for a view to the app that is open. |
| Do… | Runs a capture line. |
| Copy capture link | Copies a link that runs a capture line. |
| Copy link to an app shortcut | Copies the link of a shortcut, with its key. |
| Share this app | Makes the app into Markdown that you can send. |
| Install an app from a link or text | Shows a preview, then installs an app. |
| Review and apply data policy | Applies the `Gizmo policy` note. |
| Show app activity | Shows the changes of the app that is open, or of all apps. |
| Backtest this app | Applies the rules of the app to its past data. |
| Open the automation map | Shows all apps and what they can do. |
| Save the automation map as a canvas | Saves the map as a canvas. |
| Which apps can change this note? | Opens the map for the note that is open. |
| `<App>: <label>` | Runs a shortcut. Gizmo adds one command for each shortcut. |

## Where Gizmo keeps your data

| What | Where |
| --- | --- |
| Rows that apps save | `<App> data.md` beside the app, as lists in its properties. Or the note in `store`. |
| Notes that forms make | The folder of the `notes` block. |
| Event logs, checkpoints and activity | The plugin folder. Each device has separate files. |
| Permissions, link keys and settings | `data.json` in the plugin folder. |

## What Gizmo does not do

- It does not run scripts. Formulas have a fixed list of functions.
- It does not load components from the web. You install an app, and Gizmo copies its notes into your vault first.
- It does not use AI. You type each key.
- It does not run Obsidian commands.
- It does not join two sources.

## Development

```sh
npm install
npm run build                          # type check, then bundle main.js and gizmod.mjs
npm test                               # unit and DOM tests
npm run test:tz                        # the same tests in two more time zones
npm install --prefix tools/lint        # once, for the lint
npm run lint                           # Obsidian's lint rules, as the community directory applies them
node test/live/smoke.mjs <empty-dir>   # live checks in an isolated Obsidian
uvx --from pymobiledevice3 python test/live/phone.py eval '<js>'   # run JS in Obsidian on a USB iPhone
```

Gizmo has no runtime dependencies. The lint has its own folder, `tools/lint`, because its TypeScript rules run on TypeScript 6 and the build uses TypeScript 7. `npm run build` puts the gallery into `main.js`. The live checks start Obsidian with copies of `test/vault` and the gallery, so Obsidian must be on the computer. Run `npm run build` before the live checks.

| Folder | What it has |
| --- | --- |
| `src/` | The plugin. |
| `src/views/` | One file for each view: its keys, its checks, its examples and the code that draws it. |
| `src/sources/` | One file for each kind of source. |
| `src/node/` | gizmod. |
| `gallery/` | The gallery apps and components. |
| `test/` | Unit and DOM tests. |
| `test/vault/` | A test vault with more example apps. |
| `test/live/` | Live checks that operate Obsidian. |
