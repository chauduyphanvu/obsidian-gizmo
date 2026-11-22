# Gizmo

**Tired of installing a new Obsidian plugin for every tracker, board, chart, and form?**

Replace a dozen single-purpose plugins with one. Gizmo turns ordinary Markdown notes into personal apps — with buttons, forms, charts, boards, calendars, timelines, and five new views for **Obsidian Bases** — without writing code or locking your data in a hidden database.

Desktop & mobile · Plain Markdown · Zero runtime dependencies · No AI · No telemetry · MIT

[**Install in Obsidian**](obsidian://show-plugin?id=gizmo) · [14 ready-made apps](#what-you-can-make) · [Bases views](#use-it-everywhere) · [Install](#install) · [Reference](docs/reference.md)

## Start in 30 seconds — no YAML required

1. **Copy a ready-made app.** Run **Gizmo: New app from the gallery** to install any of 14 working apps (Budget, Medication log, Project board, Bills & renewals, Household chores, Trip planner, Vitals, Decision journal, and more).
2. **Add five views to Obsidian Bases.** Open any `.base` file and pick a **Gizmo** view — board, calendar (or year heatmap), timeline, chart, or number. No app note needed.
3. **Or make your own in three lines.** Use a reusable kit like the one below, or type a question such as `? spend food per week since sep` in **Gizmo: Do…** and let Gizmo generate the panel for you.

```yaml
---
app: Log how long I practise and see this week against the last and the trend toward my goal
use: "[[Tracker kit]]"
with: {what: practice, unit: minutes, goal: 30}
---
```

These three lines make this app:

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/chauduyphanvu/obsidian-gizmo/main/docs/images/practice-dark.webp">
  <img src="docs/images/practice-light.webp" alt="The Practice app: the latest session of 35 minutes, this week's average against last week, a line to log minutes, a chart of each session against a dashed goal of 30 minutes, and the entries">
</picture>

## What you can make

The gallery ships with 14 apps ready to use. Run **Gizmo: New app from the gallery** to copy any of them into your vault.

<table>
  <tr>
    <td width="50%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/chauduyphanvu/obsidian-gizmo/main/docs/images/budget-dark.webp">
        <img src="docs/images/budget-light.webp" alt="Budget: where the month lands against a limit of $2,500 with an even-pace mark, what is spent and what is still to come, a line to add what you spend, and the bills still to pay this month">
      </picture>
      <b>Budget.</b> Where the month will land against your limit, with each bill and bank charge in it.
    </td>
    <td width="50%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/chauduyphanvu/obsidian-gizmo/main/docs/images/medication-dark.webp">
        <img src="docs/images/medication-light.webp" alt="Medication log: the doses today, the next dose and the days on time, a button for each medication, today's doses with one taken and one due, and the top of a calendar of the year">
      </picture>
      <b>Medication log.</b> A button for each medication, the doses due and missed, a refill countdown, and a summary for the doctor.
    </td>
  </tr>
  <tr>
    <td width="50%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/chauduyphanvu/obsidian-gizmo/main/docs/images/board-dark.webp">
        <img src="docs/images/board-light.webp" alt="Project board: a line to add a project, projects in columns by status and a timeline of their dates">
      </picture>
      <b>Project board.</b> Projects in columns by status, and their dates on a timeline.
    </td>
    <td width="50%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/chauduyphanvu/obsidian-gizmo/main/docs/images/decisions-dark.webp">
        <img src="docs/images/decisions-light.webp" alt="Decision journal: the decisions ready to score with their alert on, the percentage of correct decisions, a line to write a decision and a table to score them">
      </picture>
      <b>Decision journal.</b> Write a decision now, give it a score later, and see how many were correct.
    </td>
  </tr>
</table>

Also included in the gallery: **Bills and renewals**, **Vitals**, **Practice**, **Household chores**, **Book finder**, **Task inbox**, **Trip planner**, **Trades**, **Aurora watch**, and **Read later**, built on six shared kinds (**Spend**, **Renewal**, **Dose**, **Measurement**, **Trade**, and **Chore**).

## One plugin instead of a dozen

- **Each new app is a note, not another plugin.** Budget, medication log, project board, habit tracker, chore rota, trip planner — all run on Gizmo with one mental model and one settings screen.
- **Readable, validated properties — no JavaScript.** No scripts, no React, and no fragile CSS snippets. When a key has a typo, Gizmo explains the fix in plain words.
- **An answer, not a cluttered dashboard.** Gizmo lays out each app in one calm editorial column: headline figure, pace meter, single-line quick add, charts, date-grouped ledgers, and a 30-day time rail.
- **Your data stays in your vault.** Stored in plain Markdown notes that Obsidian Bases and Dataview can read, backed by per-device append-only event logs so iCloud, Syncthing, and Obsidian Sync don't clobber concurrent edits.
- **Undo and permissions built in.** Every app asks before it reads, fetches, sends, or writes. **Try it first** runs any app on copies of your notes, and every action can be undone.
- **Save from anywhere.** A hotkey, a one-line prompt (`spend 14.5 food lunch`), an inline `;;` line, a phone shortcut, or a URL can save data without opening the app.

| | Gizmo (1 plugin) | A stack of single-purpose plugins *(Dataview, Meta Bind, Tracker, Buttons, Kanban, Calendar…)* |
| --- | --- | --- |
| **Starting point** | 14 ready-made apps + `?` Ask generates panels for you | Wire queries, inputs, buttons, and CSS by hand |
| **Mobile experience** | Built for desktop & phone (44 px touch targets, side sheets) | Varies by plugin and custom CSS |
| **Multi-device safety** | Per-device event logs, conflict preservation, full Undo | Direct file edits with no unified undo |
| **Planning & forecasting** | Planned rows, **What if…** previews, 30-day Time Rail | Current state only |
| **Real-world data** | Bank / broker / health CSV import & reconciliation | Manual entry or external scripts |
| **Security** | Static permission cards, sandboxed **Try it first**, data policy | Arbitrary JS / unrestricted plugin access |
| **Obsidian Bases** | Adds Board, Calendar, Timeline, Chart, and Number views | Requires separate view plugins |

## Use it everywhere

- **Five views for Obsidian Bases:** Open any `.base` file, add a view, and pick **Gizmo Board**, **Calendar** (month grid or year heatmap), **Timeline**, **Chart**, or **Number** — with undoable card moves and no app note required.
- **Embeds inside any note:** Drop a `gizmo` code block into a daily note to place live buttons, meters, or charts right beside your writing.
- **Quick capture & shortcuts:** Log from anywhere with **Gizmo: Do…**, pin live metrics to the status bar, trigger apps from Apple Shortcuts / Raycast / Alfred, or run `gizmod` in the background while Obsidian is closed.

<table>
  <tr>
    <td width="50%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/chauduyphanvu/obsidian-gizmo/main/docs/images/today-dark.webp">
        <img src="docs/images/today-light.webp" alt="A note with the doses today, a medication button and a water meter inside its text">
      </picture>
      <b>Inside a note.</b> A <code>gizmo</code> code block puts live panels right inside a plain note.
    </td>
    <td width="50%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/chauduyphanvu/obsidian-gizmo/main/docs/images/capture-dark.webp">
        <img src="docs/images/capture-light.webp" alt="The Do… window over Budget with the line spend 14.5 food lunch and a preview of the row that it will save to Spend">
      </picture>
      <b>From one line.</b> <b>Gizmo: Do…</b> saves <code>spend 14.5 food lunch</code> and previews the row first.
    </td>
  </tr>
</table>

## Plan, reconcile, ask, and simulate

Gizmo goes beyond passive trackers when your data connects across apps and time.

<table>
  <tr>
    <td width="50%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/chauduyphanvu/obsidian-gizmo/main/docs/images/bank-dark.webp">
        <img src="docs/images/bank-light.webp" alt="The card of charges from the bank in Budget: 14 rows from a file to check, 10 that pair with rows you logged and 4 only in the file, each with Accept and Not mine, and Accept all">
      </picture>
      <b>Check the bank.</b> Drop a bank CSV export into <code>Inbox/Bank</code>. Charges pair against what you logged and settle planned bills.
    </td>
    <td width="50%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/chauduyphanvu/obsidian-gizmo/main/docs/images/whatif-dark.webp">
        <img src="docs/images/whatif-light.webp" alt="Budget in What if… as of the end of the month: a concert of 400 added as a what-if row, a banner that says the alert of The month lands at would go on, Keep as planned and Discard, and the month at $2,590.58, over the limit of $2,500">
      </picture>
      <b>What if…</b> Preview a $400 concert against your monthly budget and alerts before spending. Nothing real changes until you click <b>Keep as planned</b>.
    </td>
  </tr>
  <tr>
    <td width="50%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/chauduyphanvu/obsidian-gizmo/main/docs/images/ask-dark.webp">
        <img src="docs/images/ask-light.webp" alt="The Do… window with the line ? spend food per week since sep: a bar chart of the food spent each week, the YAML of the panel, and Add to an app…, Copy YAML and Copy embed">
      </picture>
      <b>Ask (<code>?</code>).</b> Type <code>? spend food per week since sep</code> to draw the answer live and save it directly into an app or embed.
    </td>
    <td width="50%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/chauduyphanvu/obsidian-gizmo/main/docs/images/next-dark.webp">
        <img src="docs/images/next-light.webp" alt="The Next window over Budget: 65 home FASTNET INTERNET, planned Sun Nov 22, 09:00: did it happen? with Skip, Dismiss and It happened">
      </picture>
      <b>Next.</b> One focused prompt at a time for overdue bills, missed doses, bank files waiting to review, and new shared contributors.
    </td>
  </tr>
</table>

### One kind, many apps

A **kind** is a note with `kind` and `fields` whose rows belong to your vault, not to a single app. This is the gallery's Spend kind (shortened):

```yaml
---
kind: spend
shortcut: spend
fields:
  amount: {type: number, label: Spent, format: "$0,0.00"}
  category: [food, home, transport, fun, travel, other]
  note: text
import:
  bank: {folder: Inbox/Bank, at: Posted Date, amount: "-Amount", note: Description, where: {Amount: "< 0"}}
---
```

Apps read the rows with `source: "[[Spend]]"` and add rows with `save: "[[Spend]]"`. **Budget**, **Bills and renewals**, and **Trip planner** all share Spend, so every bill and trip cost automatically counts toward your monthly budget.

- **Planned, logged, and imported rows:** Plan recurring bills or doses with `@every month from 2026-12-01 until 2027-12-01`. Logging a matching row (or accepting a bank charge) settles the planned row automatically — even flagging when a subscription went up in price. Refer to [Kinds](docs/reference.md#kinds) and [Match and reconcile](docs/reference.md#match-and-reconcile).
- **What if…:** Run **Gizmo: What if…** or type `what if spend 900 travel flight @2026-12-03` in **Do…** to jump ahead in time, see which alerts would fire, and either **Keep as planned** or **Discard**. Refer to [What if](docs/reference.md#what-if).
- **The ask line (`?`):** Start a line in **Gizmo: Do…** with `?` (such as `? spend by category this month`) to chart or tabulate any kind live without saving anything, then click **Add to an app…**, **Copy YAML**, or **Copy embed**. Refer to [The ask line](docs/reference.md#the-ask-line).
- **Next:** Click the status bar counter (e.g., "3 to do") or run **Gizmo: Next** to clear planned rows whose time passed, waiting imports, or missed rhythms with `Enter`, `s` (skip), or `x` (dismiss). Refer to [Next](docs/reference.md#next).

## Share a kind — even with people who don't use Obsidian

Two or more people can share a kind — such as household chores or a medication log — each in their own vault, sealed end-to-end through an [ntfy](https://ntfy.sh) server (public or self-hosted). Add `share` to the kind note (gallery notes like Chore and Dose include this line commented out with `#`):

```yaml
share: {relay: "https://ntfy.sh", key: {secret: chore-key}}
```

Run **Gizmo: Invite to a kind** to generate a key in Obsidian's secret storage and an `obsidian://gizmo?invite=…` link to send privately. Nothing leaves your vault until you select **Allow**, and rows from new writers wait in **Next** for your approval.

<table>
  <tr>
    <td width="40%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/chauduyphanvu/obsidian-gizmo/main/docs/images/guest-dark.webp">
        <img src="docs/images/guest-light.webp" alt="A guest page for Chore on a phone: it is for Sitter, each row goes to Alex sealed through ntfy.sh, and a form with Chore, Who, Area, Note and When">
      </picture>
    </td>
    <td width="60%">
      <b>Write-only guest pages.</b> Run <b>Gizmo: Make a guest page</b> to create a single standalone HTML file and a code. A sitter, partner, or caregiver opens it on their phone — no Obsidian and no account needed — and logs entries directly to your vault. The page cannot read any of your existing rows, and you can revoke it with one click on the automation map.
      <br><br>
      Refer to <a href="docs/reference.md#shared-kinds">Shared kinds</a>, and to <a href="#network-and-files">Network and files</a> for what the relay sees.
    </td>
  </tr>
</table>

## You stay in control

<table>
  <tr>
    <td width="50%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/chauduyphanvu/obsidian-gizmo/main/docs/images/permission-dark.webp">
        <img src="docs/images/permission-light.webp" alt="A permission card that lists what the Book finder app asks for, with Allow, Try it first and Edit source">
      </picture>
      <b>Permission first.</b> Each app lists everything it reads, fetches, sends, or writes before running. <b>Try it first</b> runs it on temporary copies of your notes.
    </td>
    <td width="50%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/chauduyphanvu/obsidian-gizmo/main/docs/images/map-dark.webp">
        <img src="docs/images/map-light.webp" alt="The automation map: Budget reads and changes the rows of Spend and answers two shortcuts, and the Chore kind below it uses a saved secret and shares its rows through ntfy.sh">
      </picture>
      <b>One automation map.</b> Audit every app's permissions and every shared kind contributor in one place (or export it as a Canvas). Revoke access with one click.
    </td>
  </tr>
</table>

A `Gizmo policy` note defines which folders or tags are private and which destinations may receive them. The activity log undoes any change, and **As of…** / the 30-day **Time Rail** lets you view an app at any past point.

## Install

Gizmo 0.4.0 works with Obsidian 1.11.4 or later, on desktop and mobile.

### From Obsidian Community Plugins (recommended)

1. Open [**Gizmo in Obsidian**](obsidian://show-plugin?id=gizmo), or go to **Settings → Community plugins → Browse** and search for **Gizmo**.
2. Select **Install**, then **Enable**.
3. Run **Gizmo: New app from the gallery** to copy a ready-made app, run **Gizmo: New app** to build your own, or open any `.base` file to use Gizmo's Bases views.

<details>
<summary>Manual installation from GitHub Releases</summary>

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/chauduyphanvu/obsidian-gizmo/releases/latest).
2. Place the three files in `.obsidian/plugins/gizmo` inside your vault.
3. In **Settings → Community plugins**, enable **Gizmo**.

</details>

## Network and files

Gizmo has no telemetry, no account, and no update check. In Obsidian, it reads and writes only the files of your vault and its own plugin folder. It makes network requests only in these cases:

- **A note names a web address**: a `source`, a feed, an image in a cell, or a request that sends data. The app does so only after you allow it, and the permission card names each address. The automation map lists them all.
- **Install an app from a link or text** downloads the app from the address that you give, for example a GitHub Gist.
- **A shared kind** sends its rows to the ntfy server in its `share` key, and reads the rows of the others from there. It does so only when the note has `share`, its secret holds the key, and you selected **Allow** on the kind note. No gallery note shares anything until you remove the `#` before its `share` line.

These gallery apps use public services:

| App | Service |
| --- | --- |
| Aurora watch | NOAA Space Weather Prediction Center |
| Book finder | Open Library |
| Read later | NPR and BBC news feeds |
| Trip planner | Frankfurter (exchange rates) and Open-Meteo (weather) |
| Trades | Yahoo Finance |

**What the relay sees.** Gizmo seals each row with the key of the kind before it leaves your device. The relay sees the sealed text, its size, when it comes and goes, the address of the device that sends or reads it, and a topic made from the key. It cannot read a row, its fields, the name of the kind, or your name, and it cannot change a message. A guest page loads nothing from the web, and it can reach only the relay.

**The limits of sharing.**

- Each person with the key can read every row and add rows. Its writer can add, change, and take back a row; nobody else can, so a row that someone else wrote shows as theirs, and **Not mine** sets it aside in your vault. The invite link holds the key, so send it only to the people you share with.
- **Remove** stops the rows of one key, in your vault only. It does not take back what that person read, and they still have the key of the kind.
- To shut someone out, give `key` a new secret, run **Invite to a kind** to make a new key, and invite the others again.
- The public ntfy.sh keeps a message for about 12 hours. A vault that is offline longer catches up later, from the summaries that each vault sends every hour.

Refer to [What the relay and others can see](docs/reference.md#what-the-relay-and-others-can-see).

**Where your data is.**

| What | Where |
| --- | --- |
| Rows that an app saves | `<App> data.md` beside the app, and a log of each change in `<App> data/log/`. |
| Rows of a kind | `<Kind> data.md` beside the kind note holds the logged rows. `<Kind> data/log/` holds the rows of all lines, in files that each device writes. |
| What-if rows | A `.branch` file of this device in that log folder, until **Keep as planned** or **Discard**. |
| The key of a shared kind | Obsidian's secret storage, never a note. |
| A guest page | `<Kind> guest page (<name>).html` beside the kind note. Its code stays in the browser that uses it. |
| What each device sent of a shared kind, the people you accepted, permissions, activity, and settings | The plugin folder. |

### gizmod

`gizmod` is optional, and it is not part of the plugin. It is a separate Node.js program in each release, and it runs only if you start it. It works outside Obsidian:

- It reads and writes the vault folder on disk while Obsidian is closed.
- It keeps its state in `~/.config/gizmod`.
- `gizmod install` adds a launchd agent (macOS) that starts it at each login and writes a log to `~/Library/Logs`. `gizmod uninstall` removes the agent.
- It answers HTTP on port 7468, on this computer and on its Tailscale address, so that a phone shortcut can run an app. A request without the key of that shortcut does nothing.
- It sends alerts to your phone through [ntfy](https://ntfy.sh) only if you set `GIZMOD_NTFY_URL`.
- It sends and reads the rows of a shared kind through its relay only if you allowed that kind in Obsidian and give gizmod its key in `GIZMO_SECRET_<ID>`.

## Learn more

The [reference](docs/reference.md) has the full details: how to write an app, all keys, views and sources, kinds and shared kinds, permissions, links, devices, `gizmod`, all commands, and development.

```sh
npm install && npm run build && npm test
```
