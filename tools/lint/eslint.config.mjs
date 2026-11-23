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
]);
