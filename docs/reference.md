# Gizmo reference

This page gives the technical details of Gizmo. All keys are YAML in the properties of a note, and you type them by hand. Gizmo writes into an app note only when you tell it to: with **New app**, **Insert panel** or a button of the empty app card. The key language is version 1.

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
- [Kinds](#kinds)
- [Shared kinds](#shared-kinds)
- [Sealed records](#sealed-records)
- [Embeds](#embeds)
- [Gizmo views in Bases](#gizmo-views-in-bases)
- [Background work](#background-work)
- [Expectations](#expectations)
- [Shortcuts and links](#shortcuts-and-links)
- [The capture line](#the-capture-line)
- [The ask line](#the-ask-line)
- [New app from lines](#new-app-from-lines)
- [Next](#next)
- [Apps that start apps](#apps-that-start-apps)
- [Permissions](#permissions)
- [Data policy](#data-policy)
- [The automation map](#the-automation-map)
- [Activity, history and replay](#activity-history-and-replay)
- [Explain a figure](#explain-a-figure)
- [What if](#what-if)
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

To start faster, run **Gizmo: New app**. Type a name and one sentence about the app. Gizmo makes the note in the folder for new notes and opens it as an app. On desktop, it also opens the source beside the app. An app with only its `app` line shows a button for each panel that operates alone: button, form, checklist, countdown and timer. Each button adds that panel to the note, as **Insert panel** does. **Start from the Water example** adds the two panels of this example.

To add a panel quickly, run **Gizmo: Insert panel**. Then select a view. While you type, Gizmo shows possible keys and the names of the app. After `source:`, it shows the data blocks and the saved lists. After `field`, `x`, `y`, `group`, `sort`, `columns` or `edit`, it shows the fields of the source.

**Edit source.** On desktop, **Edit source** opens the YAML in Source mode beside the app. The app changes each time that Obsidian saves the note. If the source is already open in a tab, Gizmo goes to that tab. On a phone, the tab of the app changes to the source. A tab with the source of an app has a **Show the app** button. It goes back to the app and closes the source, or it changes the tab to the app.

**Mistakes.** Gizmo tells you each problem in clear words. If a key, a view or a field has one wrong letter, the message gives the fix, for example `unknown key "lable" (did you mean label?)`. A key that does not apply to a view names the views that it applies to, if there are three or fewer. Gizmo checks the names in `field`, `x`, `y`, `group`, `sort`, `columns` and `edit` only for a saved list, with the fields that the app saves into it. If the properties are not valid YAML, a card gives the line and the words of the YAML parser. Select **Show it** to go to that line. If the app showed before, it stays under the card, dim, until the YAML is correct again.

## The gallery

Run **Gizmo: New app from the gallery** to copy an app, its components and its kinds into your vault. For an app that is one kit, for example Practice, Gizmo first asks for the values of the kit, with the values of the gallery filled in. The window also tells what the app will ask for. **Copy** writes your values into the `with` line of the new note. A field that you leave empty keeps the value of the gallery. If your vault already has a note with the name of the app, Gizmo copies nothing and offers **Open yours**. A component or a kind that your vault already has, word for word, is used again. If your note of that name is different, Gizmo copies nothing and tells you.

| App | What it does |
| --- | --- |
| Medication log | Save each dose of each medication with one button, into the kind Dose. Plan the schedule, and **Next** asks about each dose whose time passed with none taken. Supply counts each medication down from its refills and tells you when one has a week or less left. For the doctor shows the last 30 days: the share taken as planned, each medication and the doses missed. Gizmo also tells you if you save no dose of Medication A by 10:00. |
| Vitals | Weight, blood pressure, pulse and sleep, as rows of the kind Measurement. See the latest of each and whether it moved the right way against the 30 days before. Each target is a property of the note, such as `weight_target`, and an alert reads it. **Next** asks for a weigh-in that did not come by 10:00 and for the week's blood pressure. A health app's CSV export comes in through `Inbox/Health` and waits on a card until you check it. For the appointment shows the last 30 and 90 days of each measure: the average, the range and the readings off target. A blood pressure reading is two rows, systolic and diastolic, shown side by side. Vitals shows numbers and says nothing about what they mean for your health. |
| Practice | Save how many minutes you practise. Compare this week with the last week, and see a chart against your goal. It is three lines on the Tracker kit. |
| Budget | See where the month will land: what you spent, plus the bills planned for the rest of it. Gizmo tells you when that total passes your limit, before you spend it. The limit is the `limit` property of the note. The charges of a bank export wait on a card in the app until you check them. |
| Bills and renewals | Each bill is a planned row of Spend, and each renewal a planned row of Renewal, with its deadline and the day to start. See the bills of the next 30 days and of a year, bill by bill, and each bill whose charge cost more than you planned, whatever name the bank gave the charge. **Next** asks about a bill that nothing paid and a renewal whose day to start has come. |
| Household chores | Each chore is a row of the kind Chore, with who did it. Plan the rota as planned rows, for example `@every week from thu 20:00`, and plan each bit of upkeep with how often, such as `@every 3 months` for the furnace filter. A chore done by anyone settles its turn, and **Next** asks about a turn that nothing settled. See this week's rota, what is overdue, who did what this week and the upkeep of the next 12 months. What upkeep costs is saved in Spend, so Budget counts it. Gizmo does not plan the next time when you do one; plan it again. Each phone keeps its own log, so two people can save at the same time. |
| Book finder | Search Open Library. Add a book to your shelf as a note, then set its status on its card. |
| Project board | Move each project from idea to done on a board. See the dates of all projects on a timeline. |
| Task inbox | Add a task from anywhere. Set a task to done in the table, and Gizmo changes the checkbox in the note of that task. |
| Decision journal | Write a decision before you see the result. Give it a score later, and see the percentage of correct decisions. |
| Trip planner | Prepare one trip: the days until you go, a list of items to pack, the itinerary, the weather and the money. Plan each cost of the trip as a planned row of Spend, and see what is spent, what is still to come and what the trip comes to against the `budget` property. Gizmo tells you when the trip will pass its budget, before you spend it. Type each amount abroad in yen, and Gizmo saves it in dollars. A bank charge dated in the days of the trip counts in it when its category is travel. |
| Trades | Save each buy and sell as a row of the kind Trade, long only: a sell over the shares that you hold is shown, not accepted in silence. See what you hold at its average cost, the value of the picked position, and the gain each year that sells made at average cost. Plan buys as planned rows; **Next** asks about one whose day passed, and a buy settles it. A broker's CSV export comes in through `Inbox/Broker`. It is a record of what you did, not advice. |
| Aurora watch | Gizmo tells you when the Kp index is 5 or more, now or in the forecast. It also keeps a record of the Kp index each hour. |
| Read later | Save articles from RSS feeds as notes. Set each article to read when you complete it. |
| Today | A note that is not an app. Its text has two small apps in it: the medication button and a water counter. |

The gallery also has components that many apps can use:

| Component | What it does |
| --- | --- |
| Tracker kit | A full tracker app in one component. Give it a name, a unit and a goal. Practice is three lines on this kit. |
| Destination weather | The weather in a city now, for the next week and for an average year. |
| Reading progress | Your progress in a book, on the note of that book. |
| Decision review | Give a decision a score on its note, next to the text that you wrote about it. |

The gallery also has kinds:

| Kind | What it does |
| --- | --- |
| Spend | Each amount that you spend, or plan to, in dollars. Budget, Bills and renewals and Trip planner save into it. So an expense of a trip and each bill count in the month of Budget. The word `spend` adds a row from **Do…**. It reads the money out of each bank export in `Inbox/Bank`, so it asks for permission to read that folder. A charge settles the bill that you planned for it, also a charge up to a fifth more or less with the name of the bill in it. |
| Renewal | Each deadline that you must act on. Its time is the day to start, and `due` is the deadline. The word `renewal` plans one from **Do…**. |
| Dose | Each dose of a medication, and each refill. A planned dose is the schedule. The word `dose` adds a row from **Do…**. |
| Measurement | Each reading: `what` is weight, sleep, systolic, diastolic or pulse, and `value` is the number. Vitals saves into it. The word `measure` adds a row from **Do…**. It reads each health export in `Inbox/Health`, without its steps rows and its failed readings, so it asks for permission to read that folder. |
| Trade | Each buy and sell: `symbol`, `side`, `shares` and `price`. A planned buy is a tranche. Trades saves into it. The word `trade` adds a row from **Do…**. It reads each broker export in `Inbox/Broker`, without its dividend and interest rows, so it asks for permission to read that folder. |
| Chore | Each chore and bit of upkeep, done or planned, with `who` and `area`. Household chores saves into it. The word `chore` adds a row from **Do…**. A chore done settles the planned one whose task has its words in it, up to 45 days away. |

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
| `reconcile` | The rows that a kind read from a file and that wait for you, with **Accept** and **Not mine**. Refer to [Match and reconcile](#match-and-reconcile). |

**Ledgers.** A table or a list groups its rows by date when they are in date order. The rows are sorted by a date field, or they show a dated `at` column. Gizmo groups by day (Today, Yesterday, a weekday or a date). It groups by week (This week, Last week, Week of…) when the dates have no time of day and span more than two weeks. A table shows a total in each group: the sum if its first number column has a money format (`$`, `€`, `£` or `¥`), and the average if not. A group whose rows have different values in a choice column that the table shows, for example a weight and a pulse in `what`, gets no average, because they are different things. A sum of money is still shown, whatever the category of each row. The total sits over the column that it adds up. A list shows the same total for the first number that its `item` shows. A list with no `item` uses its `value` field. In a table, the date column shows the time of day in a day group, and the date in a week group. In a day group, the column goes away if the dates have no time. A new row of a table or list slides in. A ledger needs 2 rows or more. A table or list with `group` or `layout: cards` is not a ledger.

**Colours.** Charts draw data in ink and pencil grey. A bar chart with one series draws its bars in pencil, and the current period in ink. A bar over `goal` is amber. The goal is a dashed line, with its label at the right of the plot. A line with one series is ink, and its last value is a label at its end. Several series keep different colours. With `stack: true` and several `y` fields, a bar chart draws one bar for each x: the total. The composition of the bar that you see (the last bar, or the one under the pointer) is a strip above the chart, and a legend gives each value.

**Calendar, board and timeline.** The year heatmap is grey. Today has an outline, and a caption under it names the day that you point at, with its count and the meaning of the shades. A board has no box around a column. A card splits its text at the first ` · `: the first part is its name, and the rest is a line under it. A timeline has a Today line in the accent colour. A bar that ended before today is pencil, and an item that starts after today is an outline.

**Empty panels.** With no rows, a `sum` is 0 in the format of the panel, for example `$0.00`, and a `progress` shows 0 of its `max`. A `count` is 0. A sum over rows that all have no value in the field shows `—`. Alerts, the status bar and the answer of a shortcut use the same 0, so an alert like `"< 8"` is on when its window has no rows. A `last`, `first`, `avg`, `min`, `max` or `share` with no rows shows `—`, with "Nothing logged yet" under it. A table, list, board, timeline, chart, pie or scatter with no rows gives the date window of its `where`. For a list that the app saves, it says for example "Nothing logged this month yet." For other sources, it says for example "Nothing here this week." The `empty` key (text) replaces this sentence, for example `empty: "No doses yet today. Tap the button above."`. It operates on each view that shows data, but not on `calendar`.

**Why is this empty?** A panel that shows nothing, while its source gives rows, has a **Why?** link. Select it to see the steps of the rows and the step that removed them. For example, a `pick` found nothing, a `where` kept 0 of 34 rows, a `group` made no groups, or no row has the field (with the field that it is one letter from). **Show in source** goes to the line of the panel. **See the answer** opens **Inspect data** at the source of the panel. The link is in the tab of the app and in the past, but not in an embed, a lens or a try. A panel whose source has no rows has no link, because then its sentence is correct.

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
| Records | `table`, `list`, `checklist`, `alerts`, `reconcile` | The flow. |
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

For a row of a list that the app saves, the sheet also has **Delete**, and its time (**When**) is a date and time field. A row of a [kind](#kinds) is one only in the kind note, or in an app that saves to the kind: an app that only reads a kind cannot delete or move its rows, or change them by any other way. **Delete** removes the row, closes the sheet and shows "Deleted …" under the panel for 6 seconds, with **Undo**. Undo puts back the same row, so edits from other devices still find it. A change to **When** cannot be a time that has not come yet. The activity log and the time rail show the two changes, and you can undo them later. You cannot delete or move notes, tasks, web rows or rows of a base, or any row in the past.

**Keyboard and screen readers.** The items that you can pick in a panel have one Tab stop together: rows, list items, cards, days, bars, the legend of a pie and the dots of a scatter. Tab goes to the picked item, or else to the first item. The next Tab goes out of the panel. The arrow keys move between the items and do not pick: up and down in tables and lists, left and right on bars and dots, and all four in cards, a board and a calendar. Home and End go to the first and the last item. Enter or Space picks the item. A screen reader reads each chart as one sentence, for example "Weight, last 6 months: 24 entries from 82.1 kg on May 3 to 79.4 kg on Nov 20, lowest 79.1, goal 75". A hidden table after a line or bar chart gives each point. On a touch screen, checklist rows, chips, row actions, the **Move** control of a card, the buttons of the add line and the **Close** button of the sheet are at least 44 px tall.

**Tabs and hosts.** Each tab keeps its own pane, laid out the same way. An app in an embed or a lens has the same layout, with no title, no time rail, no side sheet and no width limit. There, the `detail` text shows under the rows, and the panels that read a pick show at the end of the app.

**`layout: grid`.** Add `layout: grid` to keep the earlier layout. Panels sit in a grid of up to 4 columns, in the order that you write them, and `span` sets the width of each. Forms, buttons and picks are as they were, with no side sheet. Only the text `composed` or `grid` sets the layout of the app. In a note that is one panel, any other `layout` value belongs to that panel, for example `cards` for a table or `year` for a calendar.

## Sources

The `source` key tells a panel where its rows come from.

| `source` | The rows |
| --- | --- |
| `https://…` | The answer of a web address. Gizmo reads JSON, CSV, RSS and Atom feeds, and ICS calendars. |
| A name, for example `doses` | A block in `data`, or a list that the app saves in its data note. |
| A link to a kind, for example `"[[Spend]]"` | The logged rows of that kind, or the lines that `lines` names. Refer to [Kinds](#kinds). |
| `notes`, with `from` | One row for each note in a folder or with a tag, for example `from: Books` or `from: "#book"`. |
| `tasks`, with `from` | One row for each checkbox line in those notes. |
| `this` | The properties of the note that shows the panel. |
| A base, for example `Books.base` | The notes that the Obsidian base finds. |
| A vault file: `.csv`, `.json` or `.ics` | The rows of that file. |
| `expect` | The results of the `expect` rules of the app. |
| `asks` | What all apps ask of you now, as **Next** shows it. Refer to [Next](#next). |

A web source can also have `headers` and a `body`. A source with a `body` sends a POST request.

If a web source fails and Gizmo has no saved copy of its answer, the panel tells why in clear words: "Couldn't reach api.example.com. Check the connection.", "api.example.com answered 429: too many requests. Try again later.", "api.example.com answered 500." or "The answer from api.example.com isn't JSON." Select **Try again** to load the panel again. Select **Show in source** to go to the line of the panel. A panel with a saved copy shows that copy and its age.

## Shape the data

| Key | What it does |
| --- | --- |
| `pick` | Selects the rows inside a web answer, for example `chart.result.0`. |
| `lines` | Selects the lines of a kind to read: `all`, or one or more of `logged`, `planned`, `attested` and `dismissed`. Refer to [Lines](#lines). |
| `where` | Keeps only the rows that match, for example `{at: this week}` or `{kp: ">= 5"}`. |
| `sort` | Puts the rows in order. `-at` puts the newest row first. |
| `limit` | Keeps only the first rows. |
| `compute` | Adds columns from formulas, for example `cost: shares * price`. |
| `group`, `per` | Makes one row for each group, or for each `day`, `week`, `month` or `year`. |
| `field`, `agg` | Makes one value: `count`, `sum`, `avg`, `min`, `max`, `first`, `last`, `streak` or `share`. |

Gizmo writes the time into the `at` field of each saved row. Dates in `where` can be words: `today`, `this week`, `this month`, `this year`, `last 30 days`, `last 6 months` or `past`.

Formulas use a fixed list of functions, for example `if`, `round` and `prev`. They have no variables and no loops.

A field with a [unit](#units) shows in that unit without more keys. To change how Gizmo shows other values, use `unit`, `decimals`, `format`, `labels` and `values`. A format can be a pattern, for example `"$0,0.00"`, or a word: `date`, `time` or `relative`. A `number` can have `compare: previous`. A chart can have `goal`, and a bar chart can have `stack: true`.

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

A field type can be `text`, `number`, `date`, `checkbox`, a [unit](#units) such as `USD` or `kg`, or a list of choices. A field can also have a `label`, a `format` and a `default`. A form that takes its fields from a kind can name them in its own words with `labels`, for example `labels: {amount: Amount, note: Bill}`. These names win over the labels of the kind, in the form and in the preview of its line. Put `fields` in a `data` block, and all panels that use the block use the same fields. A table with `edit: true` then lets you edit those fields in its cells.

### Units

A number field can say what it measures. Write the unit as the type of the field:

```yaml
fields:
  amount: USD
  weight: kg
  steps: {type: number, unit: steps}
```

- Gizmo knows the money codes (`USD`, `EUR`, `JPY` and the others of ISO 4217) and these measures: `kg`, `g`, `mg`, `mcg`, `lb`, `oz`, `km`, `m`, `cm`, `mm`, `mi`, `ft`, `in`, `l`, `ml`, `floz`, `cup`, `h`, `min`, `s`, `mmHg`, `kPa`, `kcal`, `kJ` and `bpm`. For a different unit, write `{type: number, unit: <word>}`.
- The field shows in its unit, in each panel, with no `format`: `$1,284.50`, `¥1,500`, `81.2 kg`. A `format` on the field or on the panel has priority.
- You can type a value in a different unit of the same measure. `180 lb` or `180lb` in a `kg` field saves 81.647. The row also keeps what you typed, in `<field>_as`, for example `weight_as: 180 lb`. When you change the number later, in a table, in its line or with **Keep**, Gizmo takes `<field>_as` out, because it no longer says what the row holds.
- A number without a unit is in the unit of the field, as before.
- In a sentence, `in` is a word: `move 5 in the park` saves 5 in the unit of the field. For inches, write `5in`, or end the line with `5 in`.
- Some money codes are also words, for example `TRY` and `PEN`. `spend 12 pen` is refused until the field has a rate for `PEN`. To keep it as a word, put the words in quotes: `spend 12 food "pen refills"`.

**Money in a different currency.** Give the field the rates:

```yaml
fields:
  amount: {type: USD, rates: {JPY: 150.2, EUR: 0.92}}
```

A rate is the quantity of that currency for one of the currency of the field. `spend 1500 jpy food ramen` then saves `amount: 9.99` and `amount_as: 1500 JPY @150.2`. The row keeps the rate that you had on that day, so the amount does not change when you change the rate later. Gizmo does not download rates. Without a rate for a currency, Gizmo does not save the row, and it tells you which rate is missing.

**Formulas.** Gizmo checks the units in each `compute` formula with the app:

- You can add, subtract or compare only two values with the same unit. `amount + local` with dollars and yen is an error: `compute.total: can't add USD and JPY`. The panel does not show.
- A unit multiplied or divided by a number without a unit keeps the unit: `shares * price` is in the unit of `price`, and the column shows in that unit.
- A unit divided by a unit is a number without a unit. A unit multiplied or divided by a `$name`, for example `amount * $this.rate`, is also a number without a unit, because a rate changes the unit. Give the column a `format` to show it.
- `kg` and `lb` are different units for a formula. Gizmo does not convert in formulas.

**A unit for each row.** Some kinds keep different measures in one field. Give the field that makes the difference, with the unit for each of its values:

```yaml
fields:
  what: [weight, systolic, sleep]
  value: {type: number, unit: {what: {weight: kg, systolic: mmHg, sleep: h}}}
```

A `number`, a `progress` or a chart cannot then add up or average `value` for rows with different units. Gizmo gives an error at the panel: "the avg of value would mix kg, mmHg, h". Add `where: {what: weight}`, and the figure shows in `kg`. A panel with `group: what` is permitted, and a table shows each row as it is. A value that you type with a unit is converted to the unit of its row: `measure weight 180 lb` saves 81.647. Gizmo refuses a unit that measures a different thing, for example `measure systolic 180 lb`.

### The add line

In the composed layout, a form with up to 5 fields is one line that you type. Gizmo reads the line with the rules of the [capture line](#the-capture-line), and shows each field under the line before you push Enter. For the Budget form, type `14.5 lunch`: the amount is 14.5 and the note is `lunch`. A choice with up to 6 options shows as chips. Select a chip to change the choice.

If you type no choice, Gizmo guesses it from the earlier rows of the list. It takes the choice of the newest row that has a word of 3 letters or more in common with your text. The preview shows the guess, and Gizmo saves it. If no row matches, the choice takes its default.

The line shows an example in its box and two more under it. A form that saves to a kind and whose label or title says "plan" shows examples with a day still to come, for example `45 BRIGHT MOBILE @2026-12-08` for the bill form of Bills and renewals. A date field with a name such as `due`, `deadline`, `expires` or `renew` shows a date still to come, not `yday`.

A form with a `textarea` or `checkbox` field, or with more than 5 fields, shows its fields and not one line. Select **Use the form** to see the fields of a form that fits one line. Select **Use one line** to go back. A form with `save: this` is not a line. It stays as fields.

To save a row for a different time, end the line with `@` and a time: `81.2 @yday`, `meds @8am` or `14.5 lunch @fri 13:00`. A day alone means that day at the time now. A time alone means today. A weekday or a month and day means the last one, today included, and `@last fri` goes back one more week. On a line that can plan a row, a month and day means the next one: refer to [Planned rows](#planned-rows). The preview shows the time, for example "at Thu Nov 19, 13:00", before you push Enter. Gizmo refuses a time that has not come yet, except on a kind, where it plans a row. Only an `@` at the end that reads as a time has this effect, so `lunch @ cafe` stays text. A row for yesterday counts for the rhythm of yesterday, and it is on time if its time is before the deadline.

Push `/` to move to the first add line, when no field has focus. After a save, a notice under the line says what Gizmo added, with **Undo**. The notice stays for 6 seconds. ⌘Z on a Mac, or Ctrl Z, does the same when no field has focus. A new notice in the app, for example after **Delete**, replaces the notice before it. The `notify` text of the panel shows in this place, and not as a pop-up. In the composed layout, a `button` is one large button with the same notice. On the grid, forms and buttons are as they were.

## Actions

| Key | What it does |
| --- | --- |
| `save: <list>` | Saves a row into a list in the data note. |
| `save: <notes block>`, `name` | Makes a note in the folder of that block. `template` gives its first text. |
| `save: this` | Writes the form values into the properties of the note that shows the form. |
| `row` | Sets the values that a save writes, for example `title: "{title}"`. A value that starts with `=` is a formula. |
| `append`, `line` | Adds a line to the end of a note, for example `line: "- [ ] {task}"`. `append` names the note by its path from the vault's root, plain or as a link: `Journal/Inbox` and `"[[Journal/Inbox]]"` are the same note. |
| `notify` | Shows a notice. In the composed layout, a form or a button says it under itself. |
| `open` | Opens a note. |
| `action` | Puts a button with this label on each row of a list or a table. |
| `edit` | Lets you edit table cells: `true` for all fields, or a list of fields. |
| `then` | Runs a shortcut of a different app. Refer to [Apps that start apps](#apps-that-start-apps). |

Text in braces takes a value from the row, for example `{title}` or `{author_name.0}`.

A `row` value that starts with `=` is a formula. Gizmo works it out when it saves the row:

```yaml
row:
  local: "{yen}"
  amount: "=round(yen / $this.rate, 2)"
```

- A formula reads the same values as text in braces: the fields of the form, or of the row of the button, and `date`, `time` and `at`.
- It can also read `$this.<property>` and the names in `inputs` or `params`.
- It uses the functions of `compute`, but not `prev`.
- Gizmo checks each formula with the app. If a formula has a problem, the panel does not show, and the error gives the reason.
- If a formula works out to nothing, Gizmo does not save the row. This happens when a value that it reads is empty, for example a missing `rate`, or when it divides by zero. The notice names the field and the empty value, and a dry run shows the same refusal.
- A formula never changes where Gizmo saves the row.
- To save text that starts with `=`, write the text as a formula: `="=== a heading"`.

A save to a kind, or to a block with `fields`, keeps a number field a number. Gizmo tells you about a `row` value that cannot be a number, for example `lunch` or `{date}`. It checks other values when it saves the row. Text that is a number, for example `12.50`, is saved as a number. Other text stops the save, and the notice says why.

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

A **kit** is a full app in one component. Practice is three lines on the Tracker kit.

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

## Kinds

A kind is a set of rows that belongs to your vault, not to one app. You save a row one time, and each app that reads the kind shows it.

A note with `kind` and `fields` is a kind:

```yaml
---
kind: spend
shortcut: spend
fields:
  amount: number
  category: [food, home, travel]
  memo: text
---
```

| Key | What it does |
| --- | --- |
| `kind` | The name of the rows: letters, digits and `_`. With `fields`, this key makes the note a kind. |
| `fields` | The fields of each row, written as the fields of a form. |
| `shortcut` | A word that adds a row from the capture line: `spend 14.5 food lunch`. No app has to be open. |
| `import` | Ways to read a file into the rows, each with a name. Refer to [Import rows from a file](#import-rows-from-a-file). |
| `match` | How a row from a file, or a planned row, pairs with a row that you logged. Refer to [Match and reconcile](#match-and-reconcile). |
| `expect` | Rules for the rows. Refer to [Expectations](#expectations). |
| `share` | Shares the rows with other vaults through an ntfy server. Refer to [Shared kinds](#shared-kinds). |
| `seal` | Seals the event logs of the rows, so that a later change shows. Refer to [Sealed records](#sealed-records). |

An app reads the rows with a link in `source`, and adds a row with a link in `save`:

```yaml
panels:
  - view: form
    save: "[[Spend]]"
  - view: number
    source: "[[Spend]]"
    field: amount
    agg: sum
```

- A form that saves to a kind uses the fields of the kind. A table shows them as its columns.
- A block in `data` can read a kind, and a form can save to that block.
- The kind note opens as an app. It shows a line to add a row and a table of all rows, and it asks for no permission.
- Gizmo keeps the rows in `<Kind> data.md` beside the kind note, and their event log beside that note. An app cannot use this note as its `store`.
- An app asks for permission to read the rows of a kind. An app that saves or edits rows also asks for permission to change them.
- The activity of an app shows each change to the kinds that it reads, also a change that a different app made.
- **Share this app** includes the kind notes that the app reads. It does not include their rows.
- A property with the name `kind` in a note that has no `fields` is an ordinary property.

**Make a list a kind** changes a list that an app saves into a kind. It makes the kind note beside the app, copies the rows as they are when you select **Make the kind**, with their times, and changes the lines of the app that name the list. A field that Gizmo keeps on a kind's rows (`line`, `matched`, `by`, `writer` or `imported`) is not copied. The app then asks for permission one time. The first copy of the rows stays in the data note of the app.

### Lines

Each row of a kind is on one of four lines:

| Line | The row |
| --- | --- |
| `logged` | A thing that happened, which you saved. A row with no `line` field is logged. |
| `planned` | A thing that you plan, saved for a time that has not come yet. |
| `attested` | A row that Gizmo read from a file, for example a bank export, or a row from a person whom you did not accept yet in a [shared kind](#shared-kinds). |
| `dismissed` | A row from a file that you set aside with **Not mine**, a planned row that you set aside in **Next**, a row of a shared kind that its writer took back, or a row of a person whom you refused. |

A panel that reads a kind sees only logged rows. Add `lines` to see more: `lines: all`, `lines: planned`, or a list such as `lines: [logged, planned]`. A block in `data` can have `lines` too. Totals, rules, alerts and the past all see the same rows as the panel.

A row that a logged row settled or pairs with, which is a planned row or a row from a file whose `matched` holds the id of a logged row, is the same thing as that logged row. So with `logged` and another line, the panel leaves it out, and the logged row counts in its place: `lines: [logged, planned]` counts a bill that you paid one time, at the amount that you paid. `lines: planned` without `logged` keeps a settled planned row. Add `where: {matched: ""}` to keep only the planned rows that nothing settled yet. `lines: all` keeps every row.

A planned row that a logged row settled has that row in `settled`: its `at` and its fields, for example `settled.amount` or `settled.note`. A planned row that nothing settled has no `settled`, and its fields are empty. A panel with `lines: planned` can compare the two:

```yaml
- view: table
  title: Charged more than planned
  source: "[[Spend]]"
  lines: planned
  compute:
    paid: settled.amount
    rise: settled.amount - amount
  where: {rise: "> 0"}
  columns: [note, amount, paid, rise]
```

Gizmo checks each `settled.` in a formula: it must name `at` or a field of the kind, and the panel must read the planned line without the logged line. A kind cannot have a field called `settled`.

Gizmo keeps five fields on each row of a kind: `line`, `matched`, `by`, `writer` and `imported`. A form never writes them, `fields` cannot use these names, and `edit` and the `group` of a board cannot change them. `by` and `writer` are on the rows that came from a [shared kind](#shared-kinds): the name of the person, and the short id of their key. `imported` is on a row from a file that you accepted as a logged row: the id that the import gave it. A row of a shared kind goes to the others without these fields. The data note of a kind holds only its logged rows. A search or a base thus sees what happened. If you change rows in that note by hand, **Import the edit** keeps the id of each row.

### Planned rows

On a kind, a line for a time that has not come yet saves a planned row. For example, `spend 1200 home rent @2026-12-01` on the capture line, or the same words on an add line. The preview says "planned" and shows the time. An app that saves to its own list still refuses a time that has not come yet.

`@every day`, `@every week`, `@every month` or `@every year`, then `until` and a date, plans one row for each period. Put a number before the period to plan one row for each few periods, with the period in the plural: `@every 2 weeks`, `@every 3 months`, `@every 2 years`. The first row is one period (or that many periods) from now, at the time now. For example, `spend 1200 home rent @every month until 2027-06-01`. One line plans at most 366 rows. A month or a year keeps its day, or takes the last day of the month when it is shorter: a row planned each year from February 29 is on February 28 in the years between.

You can also give a time of day and a day to start, in this order: `@every <period> from <day> <time> until <day>`. Each part is optional, except `until`:

- `dose meds @every day 08:00 until dec 5` plans a row each day at 08:00. The first is today at 08:00, or tomorrow if 08:00 has passed.
- `spend 1450 home rent @every month from 2026-12-01 until 2027-12-01` plans a row on the 1st of each month, at the time now.
- `class @every week from mon 09:00 until 2027-03-01` plans a row each Monday at 09:00, from the next Monday.
- `chore "Replace the furnace filter" Sam upkeep @every 3 months from 2026-12-12 until 2028-01-01` plans the filter on the 12th of every third month, five times.
- `spend 612 transport "SHIELD AUTO INSURANCE" @every year from 2026-12-15 until 2030-01-01` plans a bill on December 15 of each year.

Gizmo plans only the times that have not come yet. `from` and `until` take a date as a date field does (`tomorrow`, `+10d`, `mon`, `2026-12-01`), or a month and a day (`dec 5`). A month and a day without a year is the next one, today included. The preview says the first time, the last time and how many rows the line plans, for example "planned 17 times, Thu Nov 19, 08:00 to Sat Dec 5, 08:00".

On a line that can plan a row, a month and a day without a year is the next one too, today included: on November 22, `spend 1200 home rent @dec 1` plans the rent for December 1, and `@nov 10` plans a row for November 10 of next year. A weekday still means the last one, as on any line. On a line that saves to an app's own list, which cannot plan, `@12-01` is the last December 1, as before.

When you log a row that matches a planned row, Gizmo marks the planned row as settled. Its `matched` field then holds the id of your row. Undo of the log also takes back the mark. The kind's [match rule](#match-and-reconcile) says which rows match. A planned row is settled only while the row in its `matched` is there and logged: if you delete that row, or it is set aside, the planned row waits again, on every device. A row from another vault of a [shared kind](#shared-kinds) settles a planned row as your own row does, when it comes in logged or when you accept its writer.

When the time of a planned row passes and no row settled it, **Next** asks if it happened. Refer to [Next](#next).

### Import rows from a file

`import` holds one or more ways to read a file, each with a name. Each way gives the column of the file for each field:

```yaml
import:
  bank: {folder: Inbox/Bank, amount: "-Amount", at: Posted Date, memo: Description}
```

- `at` is required. It gives the date or time of each row. Gizmo reads `2026-11-19`, a full time stamp, US dates such as `11/19/2026`, and ISO times such as `2026-11-19T23:30:00Z`. A time keeps the clock and the offset that the file gives it (`Z` is `+00:00`), so every device reads a file into the same rows, and pairs them on the same days. A time with no offset is read as the local time of the device that shows it.
- A `-` before a column changes the sign of a number. A bank export often shows money out as a negative number.
- A value that starts with `=` is a formula over the columns of the file, as a value of `row` is over the fields of a row. A column with a space in its name is `field("Posted Date")` there. To give a field the same value in each row, write a formula that is only a text in quotes or a number: `what: '="systolic"'` puts `systolic` in `what` of each row, from a cuff's export that has only a column of numbers. A value without `=` is always the name of a column.
- `folder` is optional. The device that does background work reads each file in that folder, also each new file. The kind then asks for permission to read the folder.
- `where` is optional. It keeps only the rows of the file that match, with the conditions of a panel's `where`, on the columns of the file. Gizmo applies it before it reads the columns into fields. For example, `where: {Amount: "< 0"}` keeps the money out and leaves out a pay cheque. An amount with a currency sign, for example `-$1,012.40`, compares as its number, as a number field reads it. The notice counts the rows that `where` left out: "Imported 14 rows from Checking 2026-11.csv into Spend, skipped 2".
- Gizmo reads `.csv`, `.json` and `.ics` files. The time of a calendar event is the clock of its own time zone, with the offset of that zone, for example `2026-11-19T15:30-08:00`. An event with a floating time, which names no zone, keeps its clock as written, and each device reads it as its own local time.

Run **Gizmo: Import rows into a kind…** to read one file. Select the kind and the way, then the file. The files in the folder of the way come first in the list.

Each row from a file goes on the attested line. All new rows from one file are one change in the activity, so one **Undo** takes them all back. Each row gets an id from the name of the way and what the row holds. If you read the same file again, or a later export that holds some of the same rows, Gizmo adds nothing for those rows. The same charge on the same day in two ways, for example two accounts, is two rows. A row that you imported and then undid stays out, and the notice says so. Gizmo never deletes a row from a file. **Not mine** sets it aside.

### Match and reconcile

`match` says how a row from a file pairs with a row that you logged, field by field:

| Value | Two rows match when |
| --- | --- |
| `exact` | The field has the same value in both rows. |
| A number, for example `0.5` | The numbers are at most that far apart. Only for a number field. |
| A percent, for example `20%` | The numbers are at most that percent apart, of the number of the planned row or the logged row. Only for a number field, and at most `100%`. |
| Days, for example `2d` | The dates are at most that many days apart. Only for a date field or `at`. |
| `contains` | The text of one row has the text of the other in it. Case and spaces do not matter, so `STREAMFLIX` and `Streamflix.com 866` match. An empty text matches only an empty text. Only for a text field. |

For example, `match: {amount: exact, at: 2d}`. A kind without `match` uses `exact` on each of its number fields and `2d` on `at`. A kind with no number field and no `match` has no rule: no rows pair, so each row from a file waits for **Accept** or **Not mine**, and a logged row settles no planned row. A `match` that you write replaces all of this rule.

A percent is always of the row that was there first, so each device finds the same pairs: of the planned row when a row settles it, and of the logged row when a row from a file pairs with it. With `amount: 15%`, a charge of 17.99 does not settle a bill planned at 15.49, because 15% of 15.49 is 2.32. A charge of 15.49 pairs with 17.99 that you logged, because 15% of 17.99 is 2.70.

`match` can also be a list of rules. Two rows match when one of the rules matches them, and Gizmo tries the rules in their order. The Spend kind of the gallery has two:

```yaml
match:
  - {amount: exact, at: 3d}
  - {note: contains, amount: 20%, at: 3d}
```

The first rule pairs a charge with a row that you logged by hand, by its amount, whatever its note. The second lets a dearer charge settle its bill, but only under the name of the bill: the bank's 17.99 for STREAMFLIX settles a bill of 15.49 for STREAMFLIX. An amount near a bill under a different name settles nothing. The logged row keeps the amount of the bank, and the planned row keeps the amount that you planned, so a table can still compare the two.

The kind note shows a card when rows from a file wait for you. The card counts four things: rows that pair with a row you logged, rows only in the file, rows only logged, and rows logged twice. Gizmo counts logged rows only in the days that the file covers. Each row pairs with one row at most: by the first rule that matches them, then the nearest in time. Every device finds the same pairs.

- **Accept** on a row that pairs marks it with the id of your row. The total does not change, because the logged row already counts.
- **Accept** on a row that pairs with nothing makes it a logged row. Gizmo changes the row and does not copy it, and the row keeps the id of its import in `imported`. If the row matches a planned row, that planned row is settled, as when you log the row. A row that you accepted from a file never pairs with another row from a file: two rows of one export are two charges, so only the rows that you logged by hand pair.
- **Not mine** sets the row aside.
- **Accept all** accepts each row on the card.

Each click is one change in the activity, which **Undo** takes back. While rows wait on the card, **Next** has one ask for the kind, which opens the kind note.

An app that reads a kind can show the same card with `view: reconcile` and a `source` that links to the kind:

```yaml
- view: reconcile
  title: Charges from the bank, not checked yet
  source: "[[Spend]]"
  empty: No charge from the bank waits.
```

The card in the app does the same as the card on the kind note, and the activity of the app keeps each click. The panel asks for permission to change the rows of the kind. With no rows to check, it shows its `empty` text. In the past and in a what-if, it shows no card.

## Shared kinds

Two or more people can keep one kind together, each in their own vault, for example the chores of a household. Each row that one of you adds goes to the others, and theirs come to you. Gizmo seals each row before it leaves your device, and sends it through an [ntfy](https://ntfy.sh) server, which passes it on.

```yaml
---
kind: chore
fields:
  task: text
  who: [Alex, Sam]
share:
  relay: https://ntfy.sh
  key: {secret: chore-key}
---
```

| Key | What it does |
| --- | --- |
| `relay` | The address of an ntfy server: `https://ntfy.sh`, or your own. `http` is only for a server on this computer. |
| `key` | The secret that holds the key of the kind, and your own signing key. The note never holds the key. |

To start, add `share` to the kind note, then run **Gizmo: Invite to a kind** in that note. The first time, Gizmo asks for your name, makes the key and keeps it in Obsidian's secret storage. Gizmo never replaces a secret that holds something. On a device where the kind is shared already, for example from another of your devices, or because you joined it, **Invite to a kind** makes no key: it asks you to paste the key that the others use. Then it shows a link, `obsidian://gizmo?invite=…`. Send the link to the other person in a private message: the key is in it. When they open it in Obsidian, they see the kind, its fields, where the rows go and the permissions that it will ask for. Nothing changes until they select **Join**. Then Gizmo makes the kind note in their vault, without your `import` or `expect`, and keeps the key in their secret storage. To join from text, run **Gizmo: Join a shared kind from an invite**.

The kind note asks for permission before anything is sent: "Share the rows of Chore through ntfy.sh", and the secret. Until you select **Allow**, nothing goes out and nothing comes in.

**What goes and what comes.**

- Each row that you log goes out one time. If you change a field of it, or **Undo** a change, it goes out again as a newer version, and the others take its fields as they are now. If you set it aside, delete it, or undo it, Gizmo tells the others to set it aside too. If you put it back, for example with **Undo** of the delete, it goes out again, and the others take it back in. Each message counts up for its row, so a message that comes late, or again, changes nothing. A change is checked as a new row is: its values must fit the fields of the kind.
- A row from someone else comes in with `by` (their name) and `writer`. The table of the kind note shows `by` as **By**. If you accepted that person, it is a logged row, and it counts like your own. Otherwise it is on the `attested` line, and **Next** asks one time for each person: "Accept rows from Sam in Chore?" **Accept** makes their rows logged, now and later. **Refuse** (x) sets them aside, and nothing more from them comes in. The person who invited you is accepted when you join.
- Its writer can add, change and take back a row; nobody else can. In your vault, a row that someone else wrote cannot be changed or deleted: its cells in a table read as text, and they and its side sheet say "By Sam; only Sam can change it". **Not mine** in its side sheet sets it aside in your vault only, and **Undo** brings it back. Nobody can change or remove the rows that you wrote.
- Gizmo checks the relay when it does its background work, and right after you add a row. A save in your vault never waits for the relay. If the relay does not answer, Gizmo keeps the rows and tries again later, at longer and longer gaps, and tells you one time. They go when it answers.
- A row is at most 4 KB once sealed. A longer row stays in your vault, and Gizmo tells you so.
- Gizmo takes in at most 200 rows from one person in an hour. The rest come when that person's Gizmo sends them again.
- A row whose time is more than a day ahead does not come in. Nor does a row whose time is not a full time stamp, or whose values do not fit the fields of the kind: a choice that is not one of the choices, a number field that holds no number, a date that is not a date. Gizmo tells you one time for each person.
- The device that does background work sends and reads for your vault. It keeps what it sent in its own file in the plugin folder, so two of your devices do not send a row twice. Obsidian keeps a secret on each device, so put the key on each device that can do background work: **Copy key** in **Invite to a kind** copies it, and **Invite to a kind** on the other device asks for it and keeps it under the same id. A device without the key tells you so and sends nothing.
- A row's `by` is the name that you know its writer by: the name they had when you accepted them, or, for the person who invited you, the name in the invite. A row from a person whom you did not accept yet has the name that their Gizmo sends, which anyone with the key can type. If a new key comes with the name of a person you accepted, **Next** says that it is another key. Gizmo compares names as you read them, so a name with hidden characters or full-width letters is the same name.

**When the others are offline.** Every hour, each vault also sends a short summary of what it holds from each person, with the version of each row. A vault that sees that someone missed rows, or the latest change to a row, sends them again, a batch at a time, at most every 15 minutes for each person. It reads the summaries only of the people that it accepted, and of at most 32 of them. So all vaults come to hold the same rows, after each of them was online. The public ntfy.sh keeps a message for about 12 hours. Two vaults that are never online in the same 12 hours still catch up from the summaries, but more slowly. With your own ntfy server, you set how long it keeps messages. gizmod can keep a vault in step while Obsidian is closed: set `GIZMO_SECRET_<ID>` to the key. **Invite to a kind** has **Copy key**.

**A guest page.** Run **Gizmo: Make a guest page** in a shared kind note to let someone without Gizmo, for example a carer or a sitter, add rows from their phone. Gizmo asks who it is for, and makes one HTML file beside the kind note, for example `Chore guest page (Sitter).html`, and a code. Give them both. They open the file in a browser, from the file itself or from any `https` web host, and paste the code, or open the page's address with `#` and the code at the end. The page shows the form of the kind, and it says who receives the rows. It loads nothing from the web, and it can reach only the relay. The file has no key in it, so a web host sees only the form. It has a check of its own code, a hash that gives back nothing of the keys: with a code that is cut short, changed, or the code of another page, the page says "This code isn't for this page", shows no form and sends nothing. The code stays in that browser. The page says **Added** only when the relay took the row. If the relay refuses it or cannot be reached, the page says so, keeps what was typed, and adds nothing: try again when you are online. Rows from the page come into your vault as logged rows, with the name of the guest in `by`. In the vaults of the others, they wait to be accepted, as any new person's rows do. Your vault keeps the newest 200 rows of each guest page as they came, and sends them again to a member whose summary shows that they missed them. A row from the page thus reaches the others if your vault was online while the relay kept it.

**On the automation map.** **Shared kinds** lists each shared kind with the people you accepted or removed, and those who wait in **Next**. **Remove** stops the rows of one key, a person's or a guest page's: nothing more under that key comes in. Refer to [What the relay and others can see](#what-the-relay-and-others-can-see) for what a person with the kind's key can still do. The rows of theirs that are already in your vault stay. **Not mine** sets one aside. **Accept again** takes in what they send from then on. Removing someone in your vault does not remove them from the vaults of the others.

**The data policy.** `share` is a place in `sinks`, like `notify`. It is `personal` unless you change it. A kind that is labelled `private` is not shared until the policy clears `share` for it: `sinks: {share: private}`. The rows of a kind also have the labels of the folders that its `import` reads: a kind that reads `Finance/Bank`, which the policy labels `private`, is a `private` kind. The policy never gives the permission. You still select **Allow**.

### What the relay and others can see

- **The relay** sees sealed text, its size, when each message comes and goes, the address of the device that sends or reads it, and the topic. The topic is a hash of the key, so it is the same for everyone who shares the kind and tells nothing about the kind. The relay cannot read a row, its fields, the name of the kind or your name. It could hold messages back, or drop them, but it cannot change a message or make a new one: Gizmo leaves out any message that does not open with the key and carry a valid signature.
- **Everyone with the key** (each person you invited, and each person they sent the link to) can read every row and add rows. Their rows wait to be accepted in each vault that did not accept them. Only the writer of a row can change it or take it back: each change is signed with the key that wrote the row, and a message from another key is a row of its own. Send the link only to the people you share with.
- **A guest** can add rows, under the name of the page. The page seals its rows with a key of its own, which Gizmo makes from the kind's key and the page's signing key, and which its code holds. That key opens nothing that the members seal, or that another guest page seals. So a guest cannot read the rows of the kind or other guests' rows. With the code, the rows that the page sent can be opened again while the relay keeps them, and the page lists the rows that it sent on that device. The page cannot take a row back. Whoever has the page and its code can add rows as that guest, and open what it sent.
- **Remove** is for one key, in your vault: the signing key of a person or a guest page. Nothing more under that key comes in. It does not take back what they already read. A person whom you removed still has the kind's key, so they can still read every row that the members send, and make a new signing key: rows under it come in as a new person's and wait in **Next**, in every vault, until someone accepts or refuses them. A guest's key never could read the rows. To shut a person out, start over with a new key.
- **To start over with a new key**, for example after someone leaves, give the kind note a new secret id in `key`, run **Invite to a kind** to make a new key, and invite the people again. Rows sealed with the old key do not open with the new one. The rows already in your vault stay.

## Sealed records

A sealed kind can show that its rows were not written later than they say, and that they did not change afterwards. Use it for a record that a different person must trust: a medication log for a doctor, a log of repairs, a log of hours.

```yaml
kind: dose
fields:
  what: [morning, evening]
seal: {authority: https://freetsa.org/tsr}
```

| Value | What it does |
| --- | --- |
| `seal: true` | Seals the event logs of the kind on this device. Gizmo sends nothing. The times in the seals are the times of this device. |
| `seal: {authority: <https address>}` | Also asks a time-stamp authority (RFC 3161) to sign the hash of each seal with its time. The kind then asks for permission to send that hash. |

**What a seal is.** Gizmo keeps each change to a row as one line in an event log. A seal is the SHA-256 hash of the lines that each log file has at that time, and the hash of the seal before it. If a line changes later, or goes, the hashes no longer agree. Each device keeps its seals in a file of its own, `<device>.seals`, beside the logs. A sealed kind always reads its rows from these logs and does not use a checkpoint, so what it shows is what the seals check. A very long sealed log can take longer to open.

**What the authority gets.** Gizmo sends only the hash of the seal: 32 bytes. The authority cannot find the rows, the name of the kind or your name from the hash. It sends back the hash with its time and its signature, and Gizmo keeps that answer with the seal. If the authority does not answer, Gizmo keeps the seal without a time stamp and tells you. The next seal asks again.

| Command | What it does |
| --- | --- |
| Seal this kind's rows now | Makes a seal of the lines that are not sealed yet. |
| Check this kind's seals | Makes the hashes again and compares them with each seal. It tells you how many seals hold, or the first problem. |
| Make a sealed extract | Seals the lines that are not sealed yet, then makes one HTML file beside the kind note. |

The device that does background work also seals each sealed kind one time each day, when the kind has permission and has new lines.

**The sealed extract** is one file with the logged rows, the event logs and the seals. It loads nothing and sends nothing. In a browser, it does these checks by itself:

- Each log still starts with the lines that each seal hashed, and each seal follows the seal before it.
- Each row in the table is the row that the logs give: the event that added it, and each change after that.
- Each row shows when it was written, how many times it changed, and the time of the first seal that has all its lines. The time is that of the authority when the seal has a time stamp.
- A row that was written more than one day after the time that it gives is marked "written later than the time it gives". You can still log a row for a past time. The extract shows the two times.

If the extract cannot do these checks, it says that it has not been verified. This occurs in a viewer that runs no scripts, and in a browser that opens the file from a plain `http` address.

**The limits.** A seal shows when a line was written and that it is the same now. It cannot show that the line is true. The extract reads the time and the hash from the answer of the authority, but it does not check the signature of the authority. The answer is in the file, and `openssl ts -verify` checks it against the certificate of the authority. With `seal: true`, a person who can change the clock of the device and write the files again can make new seals. Only the time stamp of an authority prevents that. gizmod does not make seals.

## Embeds

A `gizmo` code block puts panels into the text of a note. It can show panels of an app by their titles:

````markdown
```gizmo
app: "[[Medication log]]"
panels: [Took Medication A, Doses today]
```
````

If the panels that you name are all in one tab of the app, the block shows them without a tab bar.

The block can also have its panels inside it, with the same keys as an app.

To write the block for you, run **Gizmo: Embed an app's panels here** in a note. Select an app, then select the panels to show. Gizmo puts the block at the cursor. If you keep all panels, the block has no `panels` line. A panel with no title or label, or with a title that changes with an input, is grey, because an embed finds a panel only by its title or label. **Copy embed** in the tab menu of an app copies a block for the full app.

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

An alert, a `pin` or a `shortcut` can read the properties of the app note with `$this`, for example `alert: "> $this.limit"` with `limit: 2500` in the properties. This adds no permission. If the note has no `limit` property, the panel says so: "alert reads $this.limit, and this note has no limit property". A `where` on a property that the note does not have matches no row.

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

`source: expect` shows the results, for example a streak of days on time. A rhythm uses the time zone of the device that you used last. After a gap, Gizmo tells you about no more than the last three periods without a row. **Next** asks about a window that is open or missed. A window that holds a planned row of the rule's source is the planned row's to ask about. Refer to [Next](#next).

## Shortcuts and links

Add `shortcut: <name>` to a button, a form, a number or a progress panel. Gizmo then adds:

- A command, `<App>: <label>`. You can give it a hotkey.
- A link: `obsidian://gizmo?app=<app>&do=<shortcut>&key=<key>`. Add field values at the end, for example `&task=Call%20the%20bank`. Add `&at=` to save the row for a different time, with the same words as `@` on the add line or a full date and time, for example `&at=yday%208am`.
- A name for the capture line.

Run **Gizmo: Copy link to an app shortcut** to copy a link. The app tab menu also has this item. A copied link has a key, and it runs immediately. A link without the key first shows a **Run** or **Cancel** window with its values. Each shortcut accepts 20 link runs in each hour.

If a shortcut cannot run, one notice tells which shortcut and why, for example “New task” didn't run: “Renew passport” already exists. This is the same for a command, a link, the capture line and a `then`. A `then` gives the name of its app first. A link with its key sends the same text to `x-error`. If the panel of the shortcut has a problem in its keys, the notice gives that problem. In an app, a form that cannot save tells why under the form and keeps what you typed. If it did part of its work, for example it added a line but could not save the row, it tells what it did and what it could not do, with **Undo**.

**Answer links.** A shortcut on a `number` or a `progress` panel sends its value to `x-success`. The destination can be `shortcuts`, `raycast`, `alfred`, `kmtrigger`, `drafts` or `https`. For each new destination, Gizmo asks you first: **Once** or **Always**. An action link sends `result=done`.

## The capture line

Run **Gizmo: Do…**, then type one line. The first word is the `alias` or the `shortcut` of a panel. The other words fill the form fields in their order:

```text
spend 14.5 food lunch
weight 81.2
meds
task call the bank
```

Dates can be words: `today`, `yday`, `fri` or `last mon`. End a line with `@` and a time to save the row for that time, for example `weight 81.2 @yday`, as on the [add line](#the-add-line). On a kind, a time that has not come yet plans a row. Refer to [Planned rows](#planned-rows). A line that starts with `what if` saves a what-if row. Refer to [What if](#what-if). For this reason, a shortcut or an alias cannot be `what`, and an alias cannot start with `what if`. Before you push Enter, Gizmo shows what the line will do. A line that starts with `;;` in a note does the same. Refer to [Lines are rows](#lines-are-rows). **Gizmo: Copy capture link** gives the same line to a phone shortcut or a launcher.

A text field takes one word. It takes the rest of the line when it is the last field, or when the next word cannot be the value of the next field. For the Spend kind, `spend 14.5 food lunch with friends` saves the note `lunch with friends`, because `with` is not a number for `local`. `spend 12 travel taxi 1800` saves the note `taxi` and `local` 1800. After a note that took the rest of the line, give the other fields by name, for example `trip=Tokyo`. Quotes keep a value whole in all cases: `spend 14.5 food "lunch with friends" 12`. A text field does not take the rest of the line when a word after it looks meant for a later field: a choice, or a word one letter from a choice, or a number with a letter in it. So `chore dishes Sma kitchen` says that `who` must be Alex or Sam, and does not save the task `dishes Sma kitchen`. A capture link with its key, and `/do` of gizmod, run without a preview, so they refuse a line whose text field took the rest of it while fields after it stay empty. Put the text in quotes, or give the later fields by name.

The [add line](#the-add-line) of a form reads more freely than **Do…**. **Do…** gives the words to the fields in their order, and it guesses nothing. The add line gives each value to the first field that it fits, anywhere on the line. You can type a choice as its start, if the start has 3 letters or more and only one choice has it. The words that are left go to the first text field.

A line that starts with `?` asks a question. Refer to [The ask line](#the-ask-line).

### Lines are rows

Type `;;` and a capture line in a note, for example `;; spend 14.5 food lunch` in your daily note, and select **Run**. When the line saves one row, Gizmo writes this in its place:

```text
✓ spend 14.5 food lunch ^gz-8d6b723f059aeb15
```

The text after `^gz-` is the id of the row. From then on, the line and the row are the same thing:

- **Change the line.** Type a different value, for example `41.5` in place of `14.5`. A moment after you stop, Gizmo sets the fields of the row to what the line says. Each total, alert and match that reads the row changes with it. The change is in the activity of the app or kind, as "Edited in" and the name of the note, with **Undo**.
- **Delete the line.** Gizmo takes the row out. **Undo** in the activity puts the row back. The row stays if a different note also has the line.
- **Move the line.** Cut it from one note and paste it into a different note. The row stays, or comes back when you paste the line, while Obsidian stays open. After a restart, a pasted line does not bring back a row that was taken out: use **Undo** in the activity.
- **Change the row in an app.** Gizmo writes the line again from the row, in each note that it saw with that line.
- **Delete the row in an app.** The line stays, with `✗` in place of `✓`. If you undo the delete, the `✓` comes back.

Rules:

- Gizmo reads the line with the rules of the capture line. If it cannot read the line, for example `spend lots food`, the row stays as it was, and a notice tells you why.
- A time in words, for example `@yday 13:00`, becomes the date and the time that it was when the line ran: `@2026-11-19 13:00`. Thus the line reads the same on a different day.
- A value that the line does not give, for example a category that Gizmo guessed, stays in the row as it is.
- Gizmo acts only on the changes that you make on this device, in a note that is open in the editor. A change that comes from a sync changes nothing. Thus two devices do not write the same change twice.
- A line in a code block is not a row.
- A line that saves no row, or more than one row (a button, a checklist, `@every`), gets a receipt as before: a tick, the line, the app and the time.

## The ask line

In **Gizmo: Do…**, a line that starts with `?` asks a question of your [kinds](#kinds). Gizmo draws the answer under the line while you type, and shows the panel that the answer stands for. An ask reads only the rows of one kind. It asks for no permission, it sends nothing out of the vault, and it saves nothing.

```text
? spend this month
? spend food per week since sep
? spend by category last 30 days
? spend avg per month
? spend count food this year
? spend list travel
```

The first word is the `kind` value or the `shortcut` of a kind. The other words can come in any order:

| Words | What they do |
| --- | --- |
| `sum`, `avg`, `count`, `min`, `max`, `last` | How the rows add up. Without one, Gizmo adds up the first number field of the kind. If the kind has no number field, Gizmo counts the rows. |
| A number field, for example `local` | The field to add up. |
| `list` | Shows the rows in a table. |
| A choice, or a value that the rows hold, for example `food` or `Tokyo` | Keeps only the rows with that value. Put a value with spaces in quotes. |
| `field=value`, for example `trip=Tokyo` | Keeps only the rows where that field has that value. |
| `per day`, `per week`, `per month` or `per year` | One bar for each period. With `avg` or `last`, a line. |
| `by` and a field, for example `by category` | One bar for each value of the field. |
| `today`, `yesterday`, `this week`, `last 30 days`, `next 7 days`, `upcoming` or a date | The time of the rows, as in `where`. |
| `since` and a month or a day, for example `since sep`, `since nov 5`, `since 2026-09-01` or `since last mon` | The rows from that day on. A month alone means its first day: this year, or last year for a month that has not come yet. A month and a day is the last one, today included. |
| `planned`, `all` | `planned` reads the planned rows that nothing settled yet, in place of the logged rows: the panel has `where: {matched: ""}`. `all` reads the rows of every line. `logged planned` reads both, and a planned row that a logged row settled counts one time, as that logged row. Refer to [Lines](#lines). |

An answer with `per` or `by` is a chart. An answer without them is a number. An answer with `list` is a table.

Gizmo guesses nothing. An unknown word gives an error that names the word, with a close word if there is one. A word that can mean two things, for example a field and a value of a different field, gives an error that tells you what to type for each meaning. The words in the table come first: to keep the rows with the note `list`, type `note=list`.

Enter saves nothing. To keep the answer:

- **Add to an app…**, or ⌘Enter on a Mac (Ctrl Enter on other computers), adds the panel to the end of the `panels` of the app that you select, as **Insert panel** does. Then Gizmo opens the app, and the app asks for permission to read the kind, as for any panel. Gizmo changes nothing if the app would get a new problem, for example an app whose panels all come from one component with `use`.
- **Copy YAML** copies the panel. Paste it under `panels:` in an app.
- **Copy embed** copies a `gizmo` block that shows the answer in any note. Refer to [Embeds](#embeds).

A `?` alone shows these words and the kinds of the vault. If two kinds have the same name, an ask reaches neither of them. A kind keeps its shortcut on the capture line: `spend 14.5 food lunch` saves a row, and `? spend` asks.

## New app from lines

Run **Gizmo: New app from lines…** when you already have a list, for example in a different note or app. Paste the lines, one thing on each line, as you write them:

```text
mar 3 groceries 62.10 weekly shop
mar 4 coffee 4.50
mar 9 transport 31 train
```

Gizmo finds the fields from the position of the numbers and the words in the lines:

- A date at the start or at the end of most lines is the time of each row. Gizmo reads `2026-03-03`, `3/14/2026`, `3/14`, `mar 3`, `3 March 2025` and the words of the capture line (`yday`, `fri`). A month and a day without a year is the last one. Without dates, each row is for now.
- Each number is a number field. If most of the numbers have a sign or an ending, for example `$4.50` or `81.2kg`, the field has that [unit](#units). If not, and the lines write decimals, the field has a format with the same decimals, so that a total shows `310.40`.
- Words are a choice field when the first word is one of a small number of words that come again in other lines. The words after it are a text field. Other words are a text field.
- The fields keep the order of the lines. Thus the [capture line](#the-capture-line) reads the same lines afterwards.

The window tells you what it read, for example "Read 7 lines, each with its day: category (one of groceries, coffee, transport), then amount (a number), then note (text)". A line with a different shape is left out, and the window gives its number and the reason.

**One answer that you know.** Type an answer, for example `groceries = 310.40`. Gizmo tries each question that the [ask line](#the-ask-line) can ask about the rows: each of `sum`, `avg`, `count`, `min`, `max` and `last`, for each number field, for each value of a choice field, in each of these windows: `today`, `yesterday`, `this week`, `this month`, `this year`, `last 7 days`, `last 30 days`, `last 3 months`, `last 12 months`, or all rows. It shows the questions that give your number, the shortest first. If more than one gives it, each of the others shows a row that it counts and the first does not. Select one, and its panel goes into the app. This is a search through a fixed list. Gizmo uses no AI, and the same lines always give the same result.

Before you select **Keep**, the window shows the text of the two notes that it will make: a [kind](#kinds) with the fields, and an app with a line to add a row, the panel and a table. **Keep** makes the notes in the folder for new notes, adds one row for each line, and opens the app. Without an answer, the panel is the total of the first number field.

## Next

Run **Gizmo: Next** to see the things that need you, one at a time, the oldest due first. Gizmo calls each one an ask:

- **A rhythm that is due.** Its window is open, and no row meets it yet. For example, "Took meds? by 10:00".
- **A missed window.** One of the last three windows of a rule that had no row by the deadline. A row logged later, for a time before the deadline, still meets it.
- **A planned row.** Its time passed, and no row that you logged settled it. For example, "1200 home rent, planned Tue Dec 1, 09:00: did it happen?"
- **Rows from a file.** Rows of a kind that wait on its card. A kind has one ask for all of them.
- **A new person in a shared kind.** Their rows came in and wait, for example "Accept rows from Sam in Chore? 2 rows wait, and later ones will count as logged". Refer to [Shared kinds](#shared-kinds).

An ask goes away by itself when its cause goes. For example, a row comes into the window, or you accept the rows on the card.

**One ask for each thing.** A rhythm and a planned row can be about the same thing, for example a dose that the rule wants by 10:00 and that you planned for 08:00. While a planned row of the rule's source falls in a window of the rule, before its deadline, and matches the rule's `where`, the rule asks nothing about that window. The ask of the planned row stands in: Enter makes it a logged row, which meets the rule, and x sets it aside, which answers the window too. A row set aside in another way, for example a row from a file with **Not mine**, a row of a shared kind that its writer took back, or the rows of a person whom you refused, answers no window. The rule also tells you nothing about that window, in a notice or a push to your phone. It still keeps the miss, and its `then` still runs. In a window with no planned row, the rule asks as before.

| Key | What it does |
| --- | --- |
| Enter | Answers the ask, then shows the next one. |
| s | Skips the ask until tomorrow, on this device. |
| x | Dismisses the ask for good. It acknowledges a missed window, or sets a planned row aside. On a new person in a shared kind, it refuses them. |
| Tab | Goes to the line, where you can change it. |
| Esc | Closes the window. |

s and x act only while you are not in the line, so a letter that you type stays in the line. The buttons under the ask do the same on a phone.

Enter answers each kind of ask in its own way:

- **A rhythm.** Gizmo finds the form or button that saves the rows that the rule counts, in the app first. It shows the capture line of that panel, ready to run, with the preview that **Do…** shows. For a missed window, the line ends with `@` and a time in that window, so the row counts there. Values in the `where` of the rule fill the line when they can: a choice, yes or no, or a number. A button with a `row` that matches `where` is the one that Gizmo uses. If the line needs more values, the cursor is in the line. If no such panel has an `alias` or a `shortcut`, Enter opens the app.
- **A planned row.** Gizmo makes it a logged row at its planned time. It changes the row and does not copy it.
- **Rows from a file.** Gizmo opens the kind note, where the card is.
- **A new person in a shared kind.** Gizmo accepts them: the rows of theirs that wait become logged rows, and the next ones come in logged.

Each answer and each dismiss is one change in the activity. The notice has **Undo**. A skip stays on this device, also after a restart, until the next day.

On desktop, the status bar shows how many asks wait, for example "3 to do". Select it to open **Next**. When nothing waits, it shows nothing.

`source: asks` gives the same asks as rows, so a note such as Today can show them. Each row has `app`, `text`, `due`, `line` (if it has one) and `path`. It asks for no permission, as `view: alerts` does. A data policy treats its rows as data from the whole vault.

Only apps that you opened and gave permission make asks. A paused app makes none. An alert on rows does not make an ask, for example a decision that is ready to score.

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
- the kinds whose rows it reads or changes,
- the secrets that it uses,
- the data that it sends to a site,
- the relay through which a kind shares its rows,
- the time-stamp authority that gets the hash of a sealed kind,
- the other apps that it starts.

You select **Allow** one time for each note. When the keys ask for more, Gizmo asks again. If an app asks for more than you permitted, Gizmo pauses the app and tells you. An app can write to its data note without permission.

A kind note has its own **Allow**. Until you allow it, the kind runs nothing of its own: it reads no file from its `import` folder, and **Next** asks nothing about its rows. An app that reads the kind still shows the rows. Once you allowed the app, it shows a card for each kind that it reads and that you did not allow yet, for example "Spend isn't allowed yet", with what allowing the kind adds: each folder that it reads, each other permission that the kind asks for, and its asks in **Next**. **Allow Spend** gives the kind just what its own note would ask for, and **Open Spend** opens the kind note. While the kind is not allowed, a `reconcile` panel of the kind says which file waits unread in its folder, for example "Checking 2026-11.csv waits in Inbox/Bank; allow Spend to read it." So an app that you copy from the gallery leads you through its kinds after its own **Allow**.

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

- `labels` tells how private each folder, note or tag is. The rows of a [kind](#kinds) have the labels of its note, its data note, and each folder that its `import` reads.
- `sinks` tells where data can go, and how private the data can be there. Notices, the status bar and a [shared kind](#shared-kinds) (`share`) accept personal data unless you change them.
- `release` lets the value of one panel go to a sink.

Then run **Gizmo: Review and apply data policy**. Gizmo stops each app that sends data to a sink that does not permit it, and it tells you why. An app that only reads notes and downloads from the sites in `sinks` opens without a permission card.

## The automation map

Run **Gizmo: Open the automation map**. The map shows each app with what it reads, downloads, sends and changes, and what makes it act. From the map, you can:

- remove the permission of an app (**Revoke**),
- make a new link key for a shortcut,
- do a dry run, which shows what a run will change without a change to your notes,
- apply the data policy,
- see who writes to each shared kind, and remove a person (**Shared kinds**).

An app that you revoked shows **Not allowed: you revoked it**, with no **Revoke** button. An app with no permission and no activity shows **Never opened**.

**Gizmo: Which apps can change this note?** opens the map for the note that is open. **Gizmo: Save the automation map as a canvas** saves the map as an Obsidian canvas.

## Activity, history and replay

- **Gizmo: Show app activity** shows each change, with **Undo**. Undo operates only while the vault still has what the app wrote. Gizmo moves a note that an app made to the trash only if the note is unchanged.
- **See it then** on a change shows the app at that time.
- The **time rail** is under the title of an app, in its own tab. Each change of the last 30 days is a tick. A change that you undid has no tick. Drag the handle, or push `[` and `]`, to show the app as it was at a change. With the rail in focus, the arrow keys do the same. Select **Back to now**, or push Escape, to return. The rail is only in the composed layout, and not in an embed or a lens. It uses **As of…** and the activity log, so the past is read only.
- **As of…** in the tab menu (**⋯** in the tab header) shows the app at a past time. Saved lists and web answers come from history. Notes, tasks and files show as they are now, and a banner shows the names of those panels. The fields of `edit` show as text, with no row actions, and you cannot move the cards of a board. Buttons, forms and checklists are dim, and you cannot use them.
- **Gizmo: Backtest this app** applies the alerts and `expect` rules of the app, as they are now, to its past data.

## Explain a figure

Each `number` and `progress` panel can tell you where its figure comes from. Select the figure, or push `=` in the app for the first figure. The tab menu has **Explain the first figure** too. A figure is not a Tab stop. The window shows:

- **How Gizmo works the figure out**, for example "The sum of amount over 14 rows. 1 row with no number in amount is left out."
- **The rows behind it**, the largest first for a sum. Each row shows its value, its time and its other fields. A saved row also shows when the device wrote it, on which device, and how many times it changed since. A row from a file or from a different person says so.
- **Rows that are the same.** Two rows with the same day, value and words are marked, for example a charge that you imported two times.
- **Delete** on a saved row, when the app can change the rows. The notice has **Undo**.

Gizmo finds the rows with the steps of the panel itself (`where`, `compute`, `lines`, the window of `compare`). Thus the window cannot disagree with the panel. A figure from a web answer or from one note has no rows, and the window says so. A streak has no window.

**What moved it since.** Select **Yesterday**, **A week ago** or **A month ago**, or give a time. Gizmo reads the figure as it was then, as **As of…** does, and shows the difference row by row:

```text
$912.00 on Fri Nov 13, 19:42 → $1,212.00 now: $300.00 more
+$280.00  Added · Nov 18, 09:10 · travel · train
+$40.00   Changed · Nov 15, 08:00 · home · STREAMFLIX · $15.49 → $55.49
−$20.00   Gone · Nov 12, 12:30 · food · lunch
12 rows are the same.
```

For a sum or a count, the lines add up to the difference. For other figures, the lines show the rows that came, went or changed, each with its own number. For a first or a last, they say which row is that row now and which row was. Each window is read at its own time: `this month` on last Friday is the month up to that Friday.

If the keys of the panel changed since that time, the window says when, and which keys. Gizmo keeps the keys of each app each time that you open the app on this device with different keys. It works the two figures out with the keys as they are now.

### Pull the answer

When the figure reads something that you can still set, the window has **Pull it to**. Type the figure that you want as a plain number, for example `2500`, `$2,500.50` or `-5`, and select **Solve**. Gizmo shows, for each thing that it can set, the value that gives your figure:

- a number field of a planned row or of a what-if row behind the figure, for example the amount of a dinner that you planned,
- a number property of the note that a formula of the panel reads as `$this.<name>`, for example a rate or a limit.

For example, "The month lands at" shows 2,640 and you type 2,500. The line for the planned dinner shows `$160.00 → $20.00`. **Keep** sets that value: the row or the property changes as one change in the activity, with **Undo**. Nothing changes before **Keep**.

Gizmo runs the steps of the panel again with each value that it tries. A sum or an average is solved in one step. For other figures, Gizmo looks for two values with the target between them and closes in. When no value gives the figure, for example for a count, the line says so. **Pull it to** shows only in the tab of the app as it is now, not in the past, in a what-if or in an embed, and only for rows that the app can change.

## What if

**What if…** shows an app as it would be at a time that has not come yet. Rows that you add there are what-if rows. Nothing real changes until you select **Keep**.

To start, do one of these:

- Run **Gizmo: What if…** in an app or a kind note.
- Select **What if…** in the tab menu of the app.
- Start a line in **Do…** with `what if`, for example `what if spend 900 travel flight @2026-12-03`.

A `what if` line opens the app that is open, if that app reads or saves to the kind of the line. Otherwise it opens the app of the shortcut. The line saves its row as a what-if row, and the app opens in a new tab. A notice says that nothing real changed.

At first, the app shows the end of the window that its first number reads. For `where: {at: this month}`, that is the last minute of this month. If a what-if row comes later, the app shows the end of the window that holds that row. Use the date in the banner, or drag the time rail, to show a different day, up to a year ahead.

While you look ahead:

- A planned row or a what-if row whose time is at or before the time shown has happened. It is on the logged line then, and no longer on the planned line, for `lines` and for every panel, rule and alert. A row after the time shown is still planned. So at the end of a month, a bill planned in it counts in what you spent, and no longer in what is still to come. A planned row that a logged row settled does not count again.
- The add line saves what-if rows, for any time. The words of a time, such as `tomorrow`, count from now. The notice under the line says that the row is a what-if.
- You can change or remove a what-if row in a table, or select **Remove** in the banner. You cannot change a real row, tick a checklist or write to a note.
- Web data is the latest answer that Gizmo kept. Notes, tasks and files show as they are now. The banner names those panels.
- Nothing goes to the activity until **Keep**, and no `then` runs.

The banner also says what the alerts and `expect` rules of the app would do on the way to the day shown. For example, "“Spent this month” (> 1000) would go on Wed Nov 25". An alert on planned rows too, as Budget's "The month lands at", goes on when the what-if row is planned, as it would after **Keep**. A rule that would go off more than one time says how many times, and when the first is. A `then` is only named, for example "it would run “add” in Errands". Gizmo looks at most a year ahead, at each midnight and each deadline in the time zone of the device that you used last.

**Keep** makes each what-if row of a kind a planned row of that kind. All of them are one change in the activity, so one **Undo** takes them back. If you select **Keep** two times, the second adds nothing. Only a kind has planned rows. So **Keep** is not there for the rows of a list that an app keeps for itself, and the banner says so. **Discard** removes all the what-if rows of the app.

Gizmo keeps the what-if rows on this device only, one set for each app, until **Keep** or **Discard**. If you open **What if…** again, they are still there. They are in a file beside the event log of the rows, `<device>.<app>-<hash>.branch`, where the hash is of the path of the app note, so two apps of one name in two folders have two files. No other device, snapshot or search reads that file.

## Share and install

**Gizmo: Share this app** makes one Markdown text with the app, its components and its templates. Your data is not in it.

**Gizmo: Install an app from a link or text** accepts that text, an `https` link, a gist or an `obsidian://gizmo?install=` link. It shows a preview of the notes that it will make and the permissions that the app will ask for. It does not replace a note with the same name, and it gives no permissions. Select **Try it** to operate the app on copies first.

## Devices and sync

Gizmo operates with iCloud, Syncthing and other sync services:

- Each device writes its events to a log that only it uses, in `<App> data/log/` beside the data note.
- The data note shows the rows of all devices together.
- If two devices edit the same row at the same time, Gizmo keeps the two values. The cell shows the other value as an option.
- If you edit a data note by hand, the app shows a card with **Import** and **Discard**. The card tells what changed in each list. It says "ticked" only for a list of a checklist, and "added" or "removed" for other lists of text.
- If you change the name of a field, a choice or a list in the keys, and saved rows still use the old name, the app shows a card. For example: "34 rows of spend have note, which is no longer a field. It now has memo. Move note into memo?" Gizmo shows the card only for one old name and one new name that no row has, and not for an app with `store`. **Move** (or **Change**) changes the rows as one change in the activity log, and one **Undo** puts them all back. **Leave them** hides the card for that change.
- Each saved time has its zone offset, for example `2026-11-19T08:14-08:00`.
- If Obsidian closes on the device that does background work, a different device starts the work immediately.

In **Settings → Gizmo**, give the device a name. You can also set its background work there. The settings also show the other devices. Gizmo shows a warning when two devices both do background work.

A list from `record` keeps its newest 500 rows in the data note. Gizmo keeps the older rows in checkpoints beside the event log.

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
| `GIZMO_SECRET_<ID>` | The value of `{secret:<id>}`, with dashes as underscores. For a shared kind, the key that **Copy key** in **Invite to a kind** gives. |

gizmod listens on this computer and on its Tailscale address. It reads the permissions in `data.json`, but it does not write them. For a shared kind, it sends and takes in rows, and follows the people that you accepted or removed in Obsidian. A new person's rows wait for Obsidian. Because of this, an app that you move while Obsidian is closed waits for a new **Allow**.

A push for a missed window has a **Done** button when gizmod finds its Tailscale address. The button runs the line that **Next** gives for that window, when the line needs no more values. The phone sends it to gizmod at that address, so the phone must be on your tailnet. Without Tailscale, the push has no button. The button carries a token, not a key, because the push goes through the ntfy server. The token is for the shortcut that the line reached and the values that it gave, when gizmod sent the push, and for that window. It works one time, for 24 hours, and only while that app is allowed. If a row met the window meanwhile, the button saves nothing and answers "that was done already". gizmod keeps the tokens in `GIZMOD_HOME`. If it cannot keep a token, the push goes without the button. The push says only what the data policy permits, as before.

`install` makes a launchd agent. For secrets under launchd, put the token of a 1Password service account in the Keychain, with the name `gizmod-op`. Then put a `.env` file of `op://` references in `GIZMOD_HOME`. The agent then starts gizmod through `op run`, and no secret goes to disk.

## Secrets

Put `{secret:<id>}` in a web address or a header:

```yaml
source: https://api.example.com/data?key={secret:example}
headers: {authorization: "Bearer {secret:example}"}
```

Obsidian keeps the value in its secret storage, not in a note. The permission card shows each secret. Gizmo does not keep a disk copy of an answer that used a secret or a body. The key of a [shared kind](#shared-kinds) is a secret too, in `share: {key: {secret: <id>}}`.

## Commands

| Command | What it does |
| --- | --- |
| Open this note as an app | Shows the note that is open as an app. If the app is open beside it, goes back to the app. |
| New app | Makes a note with only its `app` line, opens it as an app and opens its source beside it. |
| Open an app… | Lists all apps. Enter opens an app in this tab, and ⌘ Enter (Ctrl Enter) in the right sidebar. The ribbon button does the same. |
| New app from the gallery | Copies a gallery app and its components into your vault. |
| Insert panel | Adds a starter panel for a view to the app that is open. |
| New app from lines… | Reads lines that you paste into the fields and rows of a new kind, and makes an app for it. Refer to [New app from lines](#new-app-from-lines). |
| Make a list a kind | Changes a list that the open app saves into a kind that all apps can read. Refer to [Kinds](#kinds). |
| Import rows into a kind… | Reads a `.csv`, `.json` or `.ics` file into a kind, with one of its `import` ways. Refer to [Import rows from a file](#import-rows-from-a-file). |
| Embed an app's panels here | Puts a `gizmo` block at the cursor for the panels that you select. |
| Do… | Runs a capture line. A line that starts with `?` asks your kinds a question. Refer to [The ask line](#the-ask-line). |
| Next | Shows what needs you, one ask at a time. Refer to [Next](#next). |
| Copy capture link | Copies a link that runs a capture line. |
| Copy link to an app shortcut | Copies the link of a shortcut, with its key. |
| Share this app | Makes the app into Markdown that you can send. |
| Install an app from a link or text | Shows a preview, then installs an app. |
| Invite to a kind | In a shared kind note: makes its key the first time, then the link that invites someone. Refer to [Shared kinds](#shared-kinds). |
| Join a shared kind from an invite | Shows what an invite that you paste will make, then makes it on **Join**. |
| Make a guest page | In a shared kind note: makes an HTML page with its form, and a code, for a guest who adds rows without Gizmo. |
| Seal this kind's rows now | In a sealed kind note: makes a seal of its event logs. Refer to [Sealed records](#sealed-records). |
| Check this kind's seals | In a sealed kind note: checks each seal against the logs. |
| Make a sealed extract | In a sealed kind note: makes one HTML file with the rows, the logs and the seals, which checks itself in a browser. |
| Review and apply data policy | Applies the `Gizmo policy` note. |
| Show app activity | Shows the changes of the app that is open, or of all apps. |
| Backtest this app | Applies the rules of the app to its past data. |
| What if… | Shows the app as it would be at a time that has not come yet, with what-if rows. Refer to [What if](#what-if). |
| Open the automation map | Shows all apps and what they can do. |
| Save the automation map as a canvas | Saves the map as a canvas. |
| Which apps can change this note? | Opens the map for the note that is open. |
| `<App>: <label>` | Runs a shortcut. Gizmo adds one command for each shortcut. |

## Where Gizmo keeps your data

| What | Where |
| --- | --- |
| Rows that apps save | `<App> data.md` beside the app, as lists in its properties. Or the note in `store`. |
| Rows of a kind | `<Kind> data.md` beside the kind note. The note holds the logged rows. The event log holds all rows. |
| Notes that forms make | The folder of the `notes` block. |
| Event logs and checkpoints | `<App> data/log/` beside the data note (`<Kind> data/log/` for a kind). Each device has separate log files. |
| Activity | The plugin folder. Each device has separate files. |
| What each device sent of a shared kind | `share/<device>.json` in the plugin folder. |
| The key of a shared kind | Obsidian's secret storage, or `GIZMO_SECRET_<ID>` for gizmod. Never a note. |
| The people you accepted in a shared kind | `data.json` in the plugin folder. |
| What-if rows | A file of this device beside the event log of the rows, until **Keep** or **Discard**. Refer to [What if](#what-if). |
| Seals of a sealed kind | `<device>.seals` beside the event logs of the kind. Each device has a separate file. |
| The keys of each app at each time that you opened it with different keys | `definitions/<device>.json` in the plugin folder, for [Explain a figure](#explain-a-figure). |
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
npm run samples                        # write the gallery's sample rows for today
node test/live/smoke.mjs <empty-dir>   # live checks in an isolated Obsidian
uvx --from pymobiledevice3 python test/live/phone.py eval '<js>'   # run JS in Obsidian on a USB iPhone
```

To release, set the new version in `manifest.json`, `package.json` and `versions.json`, commit, then push an annotated tag of that version:

```sh
git tag -a 0.4.2 -F notes.md   # the release notes
git push origin main 0.4.2
```

The sample rows of the gallery (in the data notes of Spend, Renewal, Dose, Measurement, Trade and Chore, the bank, health and broker exports in `Inbox` and the trip of Trip planner) are written for a day by `scripts/samples.ts`. The repo keeps them for 2026-11-18, the day of the clock of the unit tests. The live checks write them for the day that they run. To write them for today in your copy of the gallery, run `npm run samples`, or `node scripts/samples.ts 2027-02-03 <folder>` for a different day or folder. The story stays the same from each day: a bill that is six days overdue on the 18th is six days overdue on any day.

The Release workflow checks that the versions agree, runs the lint and the tests, builds, and publishes the release with `main.js`, `manifest.json`, `styles.css` and `gizmod.mjs`. CI runs the build, the tests in three time zones and the lint on every push to `main`. Run the live checks on a Mac before you tag.

Gizmo has no runtime dependencies. The lint has its own folder, `tools/lint`, because its TypeScript rules run on TypeScript 6 and the build uses TypeScript 7. `npm run build` puts the gallery into `main.js`. The live checks start Obsidian with copies of `test/vault` and the gallery, so Obsidian must be on the computer. Run `npm run build` before the live checks.

| Folder | What it has |
| --- | --- |
| `src/` | The plugin. |
| `src/views/` | One file for each view: its keys, its checks, its examples and the code that draws it. |
| `src/sources/` | One file for each kind of source. |
| `scripts/gizmod/` | gizmod. |
| `gallery/` | The gallery apps and components. |
| `test/` | Unit and DOM tests. |
| `test/vault/` | A test vault with more example apps. |
| `test/live/` | Live checks that operate Obsidian. |
