import esbuild from "esbuild";
import { builtinModules } from "node:module";

const prod = process.argv[2] === "production";

/** src/gallery-notes.ts reads gallery/ from disk, which a plugin can't; its list is written into the bundle instead. */
const galleryNotes = {
  name: "gallery-notes",
  setup(build) {
    build.onLoad({ filter: /src[\\/]gallery-notes\.ts$/ }, async () => {
      const { default: notes } = await import(`./src/gallery-notes.ts?${Date.now()}`);
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
if (prod) {
  await ctx.rebuild();
  await ctx.dispose();
} else {
  await ctx.watch();
}
