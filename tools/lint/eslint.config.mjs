// Obsidian's recommended rules over the whole repo, run from the repo root (`npm run lint`), as the
// community directory's review reads it: the plugin's source, its manifest and package files. The
// build output, the tests and the gallery's notes are left out, as the review leaves them out.
import { fileURLToPath } from "node:url";
import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

const root = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig([
  globalIgnores(["node_modules", "**/node_modules", "main.js", "gizmod.mjs", "esbuild.config.mjs", "test/**", "tools/**", "docs/**", "gallery/**"]),
  ...obsidianmd.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: root,
      },
    },
  },
  {
    // gizmod, the optional companion: a Node program that never loads in Obsidian. Node's modules,
    // its fetch and its timers are what it runs on, and it is told the vault's config folder.
    files: ["src/node/**"],
    rules: {
      "obsidianmd/no-nodejs-modules": "off",
      "obsidianmd/prefer-window-timers": "off",
      "obsidianmd/hardcoded-config-path": "off",
      "no-restricted-globals": "off",
    },
  },
  {
    // Read at build time only: esbuild writes the gallery's notes into the bundle in its place.
    files: ["src/gallery-notes.ts"],
    rules: { "obsidianmd/no-nodejs-modules": "off" },
  },
  {
    // Run by gizmod on Node as well as in the plugin, where there is no window.
    files: ["src/snapshots.ts"],
    rules: { "obsidianmd/prefer-window-timers": "off" },
  },
]);
