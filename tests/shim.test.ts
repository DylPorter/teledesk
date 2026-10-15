/** Tests for the PATH shim: a claude script that teledesk owns, found by any process that
 * resolves the name claude through PATH — pre-existing tmux panes, sh -c, systemd user units —
 * rather than by the one shell that happened to read ~/.bashrc. The shim's whole job is to hand
 * the session to the teledesk code wrapper while stepping out of the way for its own children,
 * because a wrapper that spawns the name it just intercepted would otherwise recurse forever.
 * The behavioural tests run the real script under sh against fake teledesk and claude binaries
 * in a sandbox PATH, so what is asserted is what the shell actually execs. */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENV_GUARD } from "../src/desk/channel.js";
import { ENV_SESSION, ENV_SHIM, SHIM_MARKER, installShim, shimScript, uninstallShim } from "../src/desk/shim.js";
import { install, uninstall } from "../src/desk/install.js";
import { runClaude } from "../src/desk/launcher.js";

const tmp = () => mkdtempSync(join(tmpdir(), "ct-shim-"));

/** A sandbox PATH: `bin` holds the shim (as `claude`) and a fake `teledesk`; `real` holds the
 * real binary. Both fakes append what they were invoked with (argv + the two env vars) to $LOG. */
function sandbox(o: { teledesk?: boolean; shimPath?: string } = {}) {
  const t = tmp(), bin = join(t, "bin"), real = join(t, "real"), shim = o.shimPath ?? join(bin, "claude");
  mkdirSync(bin, { recursive: true }); mkdirSync(real, { recursive: true });
  const log = join(t, "log");
  // Single-quoted JS strings so the shell's ${VAR:-} stays literal; double-quoted echo so the
  // shell does expand them when the fake runs.
  const probe = (label: string) =>
    "#!/bin/sh\n" + 'echo "' + label + ' $* | TELEDESK=${TELEDESK:-} SHIM=${' + ENV_SHIM + ':-}" >> "$LOG"\n';
  writeFileSync(join(real, "claude"), probe("REAL"), { mode: 0o755 });
  chmodSync(join(real, "claude"), 0o755);
  if (o.teledesk !== false) { writeFileSync(join(bin, "teledesk"), probe("WRAP"), { mode: 0o755 }); chmodSync(join(bin, "teledesk"), 0o755); }
  writeFileSync(shim, shimScript(), { mode: 0o755 });
  chmodSync(shim, 0o755);
  // The sandbox PATH leads with the fakes, then the system dirs: libuv resolves the spawned file
  // against the CHILD's PATH, so without /usr/bin even `sh` itself would not be found.
  const path = `${bin}:${real}:/usr/bin:/bin`;
  const lines = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []);
  const run = (args: string[] = [], env: Record<string, string> = {}) => {
    const r = spawnSync("/usr/bin/sh", [shim, ...args], { encoding: "utf8", env: { PATH: path, LOG: log, HOME: t, ...env } });
    return { lines: lines(), code: r.status, out: `${r.stderr ?? ""}${r.stdout ?? ""}` };
  };
  /** Invoke it the way a process does: by bare name, resolved through PATH. */
  const runByName = (args: string[] = [], env: Record<string, string> = {}) => {
    const r = spawnSync("/usr/bin/sh", ["-c", `claude ${args.join(" ")}`], { encoding: "utf8", env: { PATH: path, LOG: log, HOME: t, ...env } });
    return { lines: lines(), code: r.status, out: `${r.stderr ?? ""}${r.stdout ?? ""}` };
  };
  return { t, bin, real, shim, run, runByName, log };
}

describe("shim script", () => {
  it("carries its marker, hands interactive runs to teledesk code, and names no absolute home path", () => {
    const s = shimScript();
    expect(s).toContain(SHIM_MARKER);
    expect(s).toContain("teledesk code");
    expect(s).toContain(ENV_SHIM);
    expect(s).toContain("TELEDESK");
    expect(s).not.toContain("/home/"); // generic: nothing about whoever installed it
    expect(s.startsWith("#!")).toBe(true);
  });

  it("guards on the same variable the channel server enforces", () => {
    // shim.ts doesn't import channel.ts (that would drag the MCP SDK into `teledesk install`),
    // so the two spellings of the session guard are pinned here instead of drifting apart.
    expect(ENV_SESSION).toBe(ENV_GUARD);
  });
});

describe("shim behaviour", () => {
  it("an interactive session goes to the wrapper with the guard set", () => {
    const { run } = sandbox();
    const r = run(["--continue"]);
    expect(r.lines).toEqual(["WRAP code --continue | TELEDESK= SHIM=1"]);
  });

  it("found by name through PATH, not only by absolute path", () => {
    const { runByName } = sandbox();
    expect(runByName([]).lines).toEqual(["WRAP code | TELEDESK= SHIM=1"]);
  });

  it("hands every argument to the wrapper rather than guessing what is interactive", () => {
    // `teledesk code` owns the interactive/print/subcommand decision (launcher.ts interactive()).
    // Duplicating it here would be a second rule to drift; the shim's only fast paths are the
    // two guard variables below. This is what the rc function already does today.
    for (const args of [["--version"], ["-p", "summarise"], ["mcp", "list"], []]) {
      const r = sandbox().run(args);
      // `sh`'s $* collapses the separator, so an empty arg list logs "WRAP code", not two spaces.
      expect(r.lines, JSON.stringify(args)).toEqual([["WRAP", "code", ...args].join(" ") + " | TELEDESK= SHIM=1"]);
    }
  });

  it("never re-wraps: the guard the shim sets, and a desk session, both fall through to claude", () => {
    // `teledesk code` spawns `claude` again — ENV_SHIM on that child is what makes it the real
    // binary rather than the shim, so the hand-off can't loop.
    const wrapped = sandbox().run([], { [ENV_SHIM]: "1" });
    expect(wrapped.lines).toEqual(["REAL  | TELEDESK= SHIM=1"]);
    // A nested claude started inside a desk session is left plain.
    expect(sandbox().run([], { TELEDESK: "1" }).lines).toEqual(["REAL  | TELEDESK=1 SHIM="]);
  });

  it("resolves the real claude past itself: PATH containing only the shim still execs the fallback", () => {
    const t = tmp(), bin = join(t, "bin");
    mkdirSync(bin, { recursive: true });
    const shim = join(bin, "claude"), log = join(t, "log");
    writeFileSync(shim, shimScript(), { mode: 0o755 }); chmodSync(shim, 0o755);
    // PATH has the shim only (and no HOME): self-exclusion must not pick it, and nothing else
    // resolves → an honest complaint, never a loop.
    const r = spawnSync("/usr/bin/sh", [shim, "--version"], { encoding: "utf8", env: { PATH: `${bin}:/usr/bin:/bin`, LOG: log } });
    expect(existsSync(log) ? readFileSync(log, "utf8").trim() : "").toBe(""); // never ran itself
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toMatch(/claude/i);
  });

  it("a missing teledesk never bricks claude: the session still starts", () => {
    const { run } = sandbox({ teledesk: false });
    expect(run([]).lines).toEqual(["REAL  | TELEDESK= SHIM="]);
    expect(run(["-p", "hi"]).lines.at(-1)).toMatch(/^REAL -p hi/);
  });

  it("passes arguments through untouched, including ones that look like flags", () => {
    const { run } = sandbox();
    expect(run(["--resume", "abc-123", "--model", "opus"]).lines).toEqual(["WRAP code --resume abc-123 --model opus | TELEDESK= SHIM=1"]);
  });
});

describe("installShim / uninstallShim", () => {
  it("writes an executable ~/bin/claude with the marker, idempotently, and removes exactly that", () => {
    const home = tmp();
    const r = installShim(home);
    expect(r.changed).toContain(join(home, "bin", "claude"));
    expect(readFileSync(join(home, "bin", "claude"), "utf8")).toContain(SHIM_MARKER);
    expect(existsSync(join(home, "bin", "claude"))).toBe(true);
    expect(installShim(home).changed).toEqual([]); // second run writes nothing new
    expect(uninstallShim(home).changed).toContain(join(home, "bin", "claude"));
    expect(existsSync(join(home, "bin", "claude"))).toBe(false);
    expect(uninstallShim(home).changed).toEqual([]); // and removing twice is not an error
  });

  it("never overwrites a claude that isn't ours", () => {
    const home = tmp(), p = join(home, "bin", "claude");
    mkdirSync(join(home, "bin"), { recursive: true });
    writeFileSync(p, "#!/bin/sh\necho somebody else's claude\n");
    const r = installShim(home);
    expect(r.skipped).toContain(p);
    expect(readFileSync(p, "utf8")).toContain("somebody else's claude");
    expect(uninstallShim(home).changed).toEqual([]); // a foreign file is never deleted either
    expect(existsSync(p)).toBe(true);
  });

  it("install({shim:true}) does it too, and plain install leaves ~/bin alone", () => {
    const a = tmp();
    expect(install(a, { shim: true }).changed).toContain(join(a, "bin", "claude"));
    expect(uninstall(a).changed).toContain(join(a, "bin", "claude"));
    const b = tmp();
    expect(install(b).changed.some((f) => f.endsWith(join("bin", "claude")))).toBe(false);
    expect(existsSync(join(b, "bin", "claude"))).toBe(false);
  });
});

describe("launcher stays loop-proof", () => {
  /** Run runClaude with node as the "claude": the child writes the two variables it received. */
  const childSaw = async (desk: boolean, env: NodeJS.ProcessEnv): Promise<string> => {
    const marker = join(tmp(), "env");
    const probe = ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, (process.env.TELEDESK||"")+ "|" + (process.env.${ENV_SHIM}||""))`];
    expect(await runClaude({ args: probe, desk, claude: process.execPath, env })).toBe(0);
    return readFileSync(marker, "utf8");
  };

  it("sets the shim guard on the child so a PATH shim can't be re-entered", async () => {
    expect(await childSaw(false, {})).toBe("|1");
    expect(await childSaw(true, {})).toBe("1|1");
  });

  it("still strips TELEDESK on the plain path, even when inherited from a desk session", async () => {
    expect(await childSaw(false, { TELEDESK: "1" })).toBe("|1");
  });
});
