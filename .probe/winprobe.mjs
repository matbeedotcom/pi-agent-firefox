// List ALL X windows in the web-ext setup to identify the second
// "Live REPL Walk" window (id 4194325) that the probe's search matched.
import { execSync, spawn } from "node:child_process";
import { mkdirSync, symlinkSync } from "node:fs";
import path from "node:path";

const REPO = "/home/acidhax/dev/personal/firefox-acp-addon";
const FIREFOX = "/home/acidhax/Downloads/firefox-155.0.1/firefox/firefox";
const DISPLAY = ":98";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (c) => execSync(c, { encoding: "utf8", env: { ...process.env, DISPLAY }, stdio: "pipe" }).trim();

const work = `/tmp/winprobe-${Date.now()}`;
mkdirSync(path.join(work, "bin"), { recursive: true });
symlinkSync(FIREFOX, path.join(work, "bin", "firefox"));
mkdirSync(path.join(work, "webext"));

const xvfb = spawn("Xvfb", [DISPLAY, "-screen", "0", "1400x900x24"], { stdio: "ignore" });
await sleep(800);
const ff = spawn(
  "web-ext",
  ["run", "--source-dir", path.join(REPO, "firefox/dist"), "--start-url", "about:blank", "--no-reload"],
  { cwd: path.join(work, "webext"), env: { ...process.env, DISPLAY, PATH: `${path.join(work, "bin")}:/home/acidhax/.nvm/versions/node/v23.10.0/bin:${process.env.PATH}` }, stdio: "ignore" },
);
await sleep(25_000);

console.log("=== xdotool search name 'Live' ===");
try { console.log(sh(`xdotool search --name "Live"`)); } catch (e) { console.log("(none)"); }
console.log("=== xdotool search --onlyvisible (all names) ===");
try {
  for (const id of sh("xdotool search --onlyvisible --name \"\"").split("\n")) {
    if (!id.trim()) continue;
    try {
      const name = sh(`xdotool getwindowname ${id}`);
      const geom = sh(`xdotool getwindowgeometry --shell ${id}`).replace(/\r/g, "").split("\n").filter((l) => /^(X|Y|WIDTH|HEIGHT)=/.test(l)).join(" ");
      console.log(`id=${id} ${geom} name="${name}"`);
    } catch { /* gone */ }
  }
} catch (e) { console.log("(search failed)"); }
console.log("=== xwininfo -root -tree ===");
try { console.log(sh("xwininfo -root -tree").slice(0, 4000)); } catch (e) { console.log(String(e).slice(0, 500)); }

ff.kill("SIGTERM");
xvfb.kill();
