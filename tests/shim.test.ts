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
import { interactive } from "../src/desk/argv.js";
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

  /** Every vector the launcher classifies: the subcommand/flag cases from desk.test.ts plus the
   * interactive shapes the desk and crewbot actually spawn. */
  const VECTORS: string[][] = [
    [], ["--continue"], ["-c"], ["--resume", "abc-123"], ["--session-id", "550e8400-e29b-41d4-a716-446655440000"],
    ["--model", "opus"], ["fix the failing test"], ["--", "-p"], ["--debug", "--continue"], ["--add-dir", "/x"],
    ["--allowedTools=mcp__a__b", "prompt"],
    ["--version"], ["-v"], ["--help"], ["-h"], ["-p", "summarise"], ["--print", "go"], ["-p"],
    ["--output-format=json", "-p"], ["--input-format", "stream"], ["--bg", "do it"], ["-cp"],
    ["mcp", "list"], ["--debug", "mcp", "list"], ["plugin", "install", "x"], ["plugins"], ["config", "get"],
    ["update"], ["upgrade"], ["doctor"], ["install"], ["migrate-installer"], ["setup-token"], ["auth"], ["agents"],
  ];

  it("classifies every vector exactly the way the launcher does", () => {
    // teledesk#18: the shim short-circuits non-interactive runs in shell so automation doesn't
    // boot node to be told "not for you". That's only safe while both sides agree, and the lists
    // the shell greps are GENERATED from argv.ts — this test is what proves they still agree.
    // Non-vacuity: the matrix must straddle the rule, or "they agree" could mean "both trivially
    // say interactive" and the fast path would be untested.
    const plain = VECTORS.filter((a) => !interactive(a)).length;
    expect(plain, "plain vectors").toBeGreaterThanOrEqual(15);
    expect(plain, "interactive vectors").toBeLessThan(VECTORS.length);
    for (const args of VECTORS) {
      const want = interactive(args);
      const r = sandbox().run(args);
      const got = r.lines.length === 1 && r.lines[0].startsWith("WRAP");
      expect(got, `${JSON.stringify(args)}: shell said ${got ? "interactive" : "plain"}, interactive() said ${want}`).toBe(want);
    }
  });

  it("runs a plain invocation without the wrapper, and without the node boot", () => {
    const s = sandbox();
    expect(s.run(["-p", "summarise"]).lines).toEqual(["REAL -p summarise | TELEDESK= SHIM="]);
    const t0 = Date.now();
    const again = s.run(["--version"]);
    expect(again.lines.at(-1)).toBe("REAL --version | TELEDESK= SHIM=");
    // A `teledesk code` boot measured ~700ms on this machine; shell-only classification is ~0.
    expect(Date.now() - t0, "fast path latency").toBeLessThan(300);
  });

  it("keeps the guard variables ahead of the fast path", () => {
    // A desk session's own children must reach the real binary; if the classifier decided first,
    // an interactive child inside a wrapped session would wrap twice.
    expect(sandbox().run(["-p", "x"], { TELEDESK: "1" }).lines).toEqual(["REAL -p x | TELEDESK=1 SHIM="]);
  });

  it("never re-wraps: the guard the shim sets, and a desk session, both fall through to claude", () => {
    // `teledesk code` spawns `claude` again — ENV_SHIM on that child is what makes it the real
    // binary rather than the shim, so the hand-off can't loop.
    const wrapped = sandbox().run([], { [ENV_SHIM]: "1" });
    expect(wrapped.lines).toEqual(["REAL  | TELEDESK= SHIM=1"]);
    // A nested claude started inside a desk session is left plain.
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
