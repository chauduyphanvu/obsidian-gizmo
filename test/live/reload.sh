#!/bin/sh
# Rebuilds the plugin, copies it into the isolated test vault and reloads it there.
set -e
cd "$(dirname "$0")/../.."
VAULT="$1"
export NOTE_APPS_TEST_VAULT="$VAULT"
npx tsc
node esbuild.config.mjs production
cp main.js manifest.json styles.css "$VAULT/.obsidian/plugins/note-apps/"
node test/live/cdp.mjs eval '(async () => { await app.plugins.disablePlugin("note-apps"); await app.plugins.enablePlugin("note-apps"); return "reloaded"; })()'
