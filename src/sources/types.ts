import type { AppFiles, DataLayer } from "../datalayer.ts";
import type { Panel } from "../spec.ts";

export interface LoadOpts {
  ttlMs: number;
  force?: boolean;
  now: Date;
}

/** One kind of source: how it is recognised, checked, permitted, watched and read. */
export interface SourceDef {
  id: string;
  /** Whether this kind handles the (already input-filled) source text. First match wins. */
  matches(source: string): boolean;
  /** Check-time problems with the panel's data keys for this kind. */
  validate?(p: Panel): string[];
  /** Permissions this source needs: [permission string, the key that asks]. */
  permissions(p: Panel, selfPath: string): [string, keyof Panel][];
  /** Dependency keys (url:…, notes:…, file:…) the data layer invalidates on. */
  deps(p: Panel, files: AppFiles): string[];
  /** The raw data, before the pipeline. */
  load(p: Panel, files: AppFiles, layer: DataLayer, opts: LoadOpts): Promise<unknown> | unknown;
}
