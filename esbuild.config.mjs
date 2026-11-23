import esbuild from "esbuild";
import { builtinModules } from "node:module";

const prod = process.argv[2] === "production";

/** scripts/gallery-notes.ts reads gallery/ from disk, which a plugin can't; its list is written into the bundle instead. */
const galleryNotes = {
  name: "gallery-notes",
  setup(build) {
    build.onLoad({ filter: /scripts[\\/]gallery-notes\.ts$/ }, async () => {
      const { default: notes } = await import(`./scripts/gallery-notes.ts?${Date.now()}`);
      return { contents: `export default ${JSON.stringify(notes)};`, loader: "js" };
    });
  },
};

const ctx = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*", ...builtinModules],
  format: "cjs",
  target: "es2022",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  minify: prod,
  outfile: "main.js",
  plugins: [galleryNotes],
});
/** gizmod: the same engine on Node, with the vault read from disk; yaml is bundled into it only. */
const daemon = await esbuild.context({
  entryPoints: ["scripts/gizmod/gizmod.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  outfile: process.env.GIZMOD_OUT ?? "gizmod.mjs",
  // yaml is CommonJS and requires Node's own modules, which an ES module bundle has no require for.
  banner: { js: 'import { createRequire as gizmodRequire } from "node:module"; const require = gizmodRequire(import.meta.url);' },
  plugins: [galleryNotes],
});
if (prod) {
  await Promise.all([ctx.rebuild(), daemon.rebuild()]);
  await Promise.all([ctx.dispose(), daemon.dispose()]);
} else {
  await Promise.all([ctx.watch(), daemon.watch()]);
}
