import { ASKS_DEP } from "../deps.ts";
import type { SourceDef } from "./types.ts";

/**
 * `source: asks`: what every allowed app asks of the person now, oldest first, one row each:
 * `{app, text, due, line, path}`. Vault-wide, as `view: alerts` is; empty in the past and in a try.
 */
export const asksSource: SourceDef = {
  id: "asks",
  matches: (source) => source === "asks",
  permissions: () => [],
  deps: () => [ASKS_DEP],
  load: (_p, _files, layer) => layer.asks?.() ?? [],
};
