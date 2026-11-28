/**
 * What a Gizmo link does, on any host that opens one (Obsidian's obsidian://gizmo, the app's
 * gizmo://open): an install or invite link only opens its window, which writes nothing until the
 * person says so; an activity link opens the activity log, which changes nothing; a link carrying a
 * line and naming no app is a capture line; any other runs a shortcut, as background.runUri checks.
 */
export interface LinkHandlers {
  install(link: string): void;
  invite(text: string): void;
  activity(entryId: string): void;
  capture(params: Record<string, string>): void;
  run(params: Record<string, string>): void;
}

export function routeLink(params: Record<string, string>, h: LinkHandlers): void {
  if (typeof params.install === "string") return h.install(params.install);
  if (typeof params.invite === "string") return h.invite(params.invite);
  if (typeof params.activity === "string") return h.activity(params.activity);
  // One naming an app fills its form, even a field called line.
  if (typeof params.line === "string" && params.app === undefined) return h.capture({ ...params });
  h.run({ ...params });
}
