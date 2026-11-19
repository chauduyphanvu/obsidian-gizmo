import { getAllTags, requestUrl, type App, type TFile } from "obsidian";
import type { FileInfo, Host } from "./datalayer.ts";

function info(f: TFile): FileInfo {
  return { path: f.path, basename: f.basename, mtime: f.stat.mtime, ctime: f.stat.ctime };
}

export function obsidianHost(app: App): Host {
  const file = (path: string) => app.vault.getFileByPath(path);
  return {
    async fetch(url, headers) {
      const res = await requestUrl({ url, headers, throw: false });
      return { status: res.status, text: res.text, contentType: res.headers["content-type"] ?? "" };
    },
    markdownFiles: () => app.vault.getMarkdownFiles().map(info),
    fileInfo(path) {
      const f = file(path);
      return f && f.extension === "md" ? info(f) : undefined;
    },
    frontmatter(path) {
      const f = file(path);
      return f ? app.metadataCache.getFileCache(f)?.frontmatter : undefined;
    },
    tags(path) {
      const f = file(path);
      const cache = f ? app.metadataCache.getFileCache(f) : null;
      return (cache && getAllTags(cache)) ?? [];
    },
    secret: (id) => app.secretStorage.getSecret(id),
    now: () => Date.now(),
    // A short timer rather than requestAnimationFrame, which stops while the window is hidden.
    schedule: (cb) => { window.setTimeout(cb, 30); },
  };
}
