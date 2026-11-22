# Gizmo

**Type a few properties. Your note becomes an app.**

Gizmo is a plugin for Obsidian. It changes a note into a small app with buttons, forms, charts, boards and calendars. Your data stays in your vault, in notes that you can read. You do not write code.

```yaml
---
app: Log my weight and watch the trend toward my goal
use: "[[Tracker kit]]"
with: {what: weight, unit: kg, goal: 75}
---
```

These three lines make this app:

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/chauduyphanvu/obsidian-gizmo/main/docs/images/weight-dark.webp">
  <img src="docs/images/weight-light.webp" alt="The Weight app: the latest weight, this week against last week, a line to log a weight, a chart of values against a goal line and the entries by week">
</picture>

## Why Gizmo

- **One plugin, many apps.** Each new app is a note, not a new plugin.
- **No code.** You type each key by hand. Gizmo examines the keys and shows each problem in clear words.
- **Your data stays in your vault.** Gizmo keeps it in Markdown notes that Bases and Dataview can read. There is no hidden database.
- **You give permission first.** An app tells you what it will read, download, send and change. It does not start until you select **Allow**.
- **Save from anywhere.** A hotkey, a line of text, a phone shortcut or a link can save data. The app does not have to be open.
- **Undo for your vault.** Gizmo keeps a log of each change that an app makes, and you can undo each one.

## What you can make

The gallery has apps that are ready to use. Run **Gizmo: New app from the gallery** to copy one into your vault.

<table>
  <tr>
    <td width="50%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/chauduyphanvu/obsidian-gizmo/main/docs/images/medication-dark.webp">
        <img src="docs/images/medication-light.webp" alt="Medication log: the doses today, a streak, a button for each dose and a calendar of the year">
      </picture>
      <b>Medication log.</b> One button for each dose, a streak and a calendar of the year.
    </td>
    <td width="50%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/chauduyphanvu/obsidian-gizmo/main/docs/images/budget-dark.webp">
        <img src="docs/images/budget-light.webp" alt="Budget: the month total against a limit with an even-pace mark, a line to add what you spend and a chart of each week by category">
      </picture>
      <b>Budget.</b> The month total against your limit, and each week by category.
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

The gallery also has Weight, Sleep, Household chores, Book finder, Task inbox, Trip planner, Watchlist, Aurora watch and Read later.

## Use it everywhere

<table>
  <tr>
    <td width="50%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/chauduyphanvu/obsidian-gizmo/main/docs/images/today-dark.webp">
        <img src="docs/images/today-light.webp" alt="A note with the doses today, a medication button and a water meter inside its text">
      </picture>
      <b>Inside a note.</b> A <code>gizmo</code> code block puts panels into the text of a note.
    </td>
    <td width="50%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/chauduyphanvu/obsidian-gizmo/main/docs/images/capture-dark.webp">
        <img src="docs/images/capture-light.webp" alt="The Do… window with the line spend 14.5 food lunch and a preview of the row that it will save">
      </picture>
      <b>From one line.</b> <b>Gizmo: Do…</b> saves <code>spend 14.5 food lunch</code> and shows the result first.
    </td>
  </tr>
</table>

Gizmo also adds board, calendar, timeline, chart and number views to Obsidian Bases. A value can stay in the status bar. A phone shortcut or a link can run an app, and `gizmod` does background work when Obsidian is closed.

## You stay in control

<table>
  <tr>
    <td width="50%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/chauduyphanvu/obsidian-gizmo/main/docs/images/permission-dark.webp">
        <img src="docs/images/permission-light.webp" alt="A permission card that lists what the Book finder app asks for, with Allow, Try it first and Edit source">
      </picture>
      <b>Permission first.</b> Each app asks before it starts. <b>Try it first</b> operates it on copies of your notes.
    </td>
    <td width="50%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/chauduyphanvu/obsidian-gizmo/main/docs/images/map-dark.webp">
        <img src="docs/images/map-light.webp" alt="The automation map: each app with what it reads, downloads, sends and changes">
      </picture>
      <b>One map.</b> See what each app reads, downloads, sends and changes. Remove a permission with one click.
    </td>
  </tr>
</table>

A `Gizmo policy` note tells which notes are private and where their data can go. The activity log can undo each change, and **As of…** shows an app at a past time.

## Network and files

Gizmo makes no network requests of its own. It has no telemetry, no account and no update check. In Obsidian, it reads and writes only the notes of your vault and its own plugin folder.

An app goes online only if its note names a web address: a `source`, a feed, an image in a cell, or a request that sends data. It does so only after you allow that app, and the permission card names each address. The automation map lists them all. These gallery apps use public services:

| App | Service |
| --- | --- |
| Aurora watch | NOAA Space Weather Prediction Center |
| Book finder | Open Library |
| Read later | NPR and BBC news feeds |
| Trip planner | Frankfurter (exchange rates) and Open-Meteo (weather) |
| Watchlist | Yahoo Finance |

**Install an app from a link or text** downloads the app from the address that you give, for example a GitHub Gist.

### gizmod

`gizmod` is optional, and it is not part of the plugin. It is a separate Node.js program in each release, and it runs only if you start it. It works outside Obsidian:

- It reads and writes the vault folder on disk while Obsidian is closed.
- It keeps its state in `~/.config/gizmod`.
- `gizmod install` adds a launchd agent (macOS) that starts it at each login and writes a log to `~/Library/Logs`. `gizmod uninstall` removes the agent.
- It answers HTTP on port 7468, on this computer and on its Tailscale address, so that a phone shortcut can run an app. A request without the key of that shortcut does nothing.
- It sends alerts to your phone through [ntfy](https://ntfy.sh) only if you set `GIZMOD_NTFY_URL`.

## Install

Gizmo 0.2.1 operates with Obsidian 1.11.4 or later, on desktop and on mobile.

1. Download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/chauduyphanvu/obsidian-gizmo/releases/latest).
2. Put the three files in the folder `.obsidian/plugins/gizmo` of your vault.
3. In **Settings → Community plugins**, set the **Gizmo** toggle to on.
4. Run **Gizmo: New app from the gallery**, or run **Gizmo: New app** to start your own app.

## Learn more

The [reference](docs/reference.md) has the full details: how to write an app, all keys, views and sources, permissions, links, devices, `gizmod` and development.

```sh
npm install && npm run build && npm test
```
