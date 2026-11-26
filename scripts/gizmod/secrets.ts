/**
 * Where gizmod finds the value of a `{secret:<id>}`: its environment first (GIZMO_SECRET_<ID>, as
 * `op run` fills it), then, on macOS, the Keychain, under the service "gizmo" with the secret's id as
 * its account, where `gizmod secret set <id>` keeps one. A value never goes on a command line:
 * `security` is given it on its standard input.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { secretVar } from "../../src/datalayer.ts";

export { secretVar };

export const SECRET_SERVICE = "gizmo";
/** A secret's id, as Obsidian's secret storage and `share.key.secret` take one. */
const SECRET_ID = /^[a-z0-9-]+$/;
/** How long a value read from the Keychain is kept before it's read again; a secret not found is looked for each time. */
const KEEP_MS = 5 * 60_000;
const SECURITY = "/usr/bin/security";


/** `{secret:id}` filled from the environment, as `op run` gives it. */
export function secretFromEnv(id: string, env: NodeJS.ProcessEnv = process.env): string | null {
  return env[secretVar(id)] ?? null;
}

/** Why an id can't name a secret, if it can't. */
export function secretIdProblem(id: string): string | undefined {
  return SECRET_ID.test(id) ? undefined : `${id} can't name a secret: an id is lowercase letters, digits and dashes`;
}

/** What `security` did: its exit status and what it wrote. */
export type Security = (args: string[], input?: string) => { status: number | null; stdout: string; stderr: string };

const runSecurity: Security = (args, input) => {
  const r = spawnSync(SECURITY, args, { input, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

/**
 * A password as `security find-generic-password -g` prints it: in quotes when it's plain ASCII, else
 * in hex before an escaped copy. (`-w` prints the hex alone, which can't be told from a hex password.)
 */
export function passwordOf(printed: string): string | undefined {
  const line = printed.split("\n").find((l) => l.startsWith("password:"));
  if (!line) return undefined;
  const hex = /^password: 0x([0-9A-Fa-f]*)/.exec(line);
  if (hex) return Buffer.from(hex[1], "hex").toString("utf8");
  const plain = /^password: "(.*)"\s*$/.exec(line);
  return plain ? plain[1] : line.trim() === "password:" ? "" : undefined;
}

/** A word for `security -i`, which reads its commands a line at a time. */
const quoted = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

export interface KeychainOptions {
  /** Runs `security`; tests give their own. */
  security?: Security;
  /** A keychain file in place of the default one (tests use a throwaway one). */
  keychain?: string;
  now?: () => number;
  /** Whether there is a Keychain to use: macOS, with its `security`. */
  available?: boolean;
}

/** Secrets kept in the macOS Keychain under the service "gizmo". */
export class KeychainSecrets {
  readonly available: boolean;
  private security: Security;
  private keychain: string[];
  private now: () => number;
  private kept = new Map<string, { value: string; at: number }>();

  constructor(opts: KeychainOptions = {}) {
    this.available = opts.available ?? (process.platform === "darwin" && existsSync(SECURITY));
    this.security = opts.security ?? runSecurity;
    this.keychain = opts.keychain ? [opts.keychain] : [];
    this.now = opts.now ?? Date.now;
  }

  /** A secret's value, or null when the Keychain has none (or there is no Keychain). */
  get(id: string): string | null {
    if (!this.available || secretIdProblem(id)) return null;
    const had = this.kept.get(id);
    if (had && this.now() - had.at < KEEP_MS) return had.value;
    const r = this.security(["find-generic-password", "-s", SECRET_SERVICE, "-a", id, "-g", ...this.keychain]);
    const value = r.status === 0 ? passwordOf(r.stderr) : undefined;
    if (value === undefined) {
      this.kept.delete(id);
      return null;
    }
    this.kept.set(id, { value, at: this.now() });
    return value;
  }

  /** Keeps a secret, replacing what the Keychain had under its id; throws if it couldn't. */
  set(id: string, value: string): void {
    this.usable(id);
    if (/[\r\n]/.test(value)) throw new Error("a secret is one line: it has a line break");
    const r = this.security(["-i"], `add-generic-password -U -s ${SECRET_SERVICE} -a ${id} -l ${quoted(`Gizmo: ${id}`)} -w ${quoted(value)}${this.keychain.map((k) => ` ${quoted(k)}`).join("")}\n`);
    this.kept.delete(id);
    // `security -i` can say nothing of a command that failed: what was kept is read back.
    if (r.status !== 0 || this.get(id) !== value) throw new Error(`the Keychain didn't keep ${id}${r.stderr.trim() ? `: ${r.stderr.trim()}` : ""}`);
  }

  /** Takes a secret out of the Keychain; false when it had none. */
  delete(id: string): boolean {
    this.usable(id);
    this.kept.delete(id);
    return this.security(["delete-generic-password", "-s", SECRET_SERVICE, "-a", id, ...this.keychain]).status === 0;
  }

  private usable(id: string): void {
    const problem = secretIdProblem(id);
    if (problem) throw new Error(problem);
    if (!this.available) throw new Error("there's no Keychain here (it's macOS's): give gizmod the secret in its environment as " + secretVar(id));
  }
}

/** Where gizmod's secrets come from, in order, and what to say of one it can't find. */
export function gizmodSecrets(keychain: KeychainSecrets, env: NodeJS.ProcessEnv = process.env) {
  return {
    secret: (id: string) => secretFromEnv(id, env) ?? keychain.get(id),
    where: (id: string) => keychain.available
      ? `Keep it in the Keychain with \`node gizmod.mjs secret set ${id}\`, or set ${secretVar(id)} in gizmod's environment.`
      : `Set ${secretVar(id)} in gizmod's environment (its run script fills it through op run).`,
  };
}
