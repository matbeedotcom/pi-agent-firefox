/**
 * Focus debug: minimal Xvfb + plain Firefox (no add-on, no web-ext) + a test
 * page whose textarea echoes typed text and shows document.activeElement.
 * Logs getwindowfocus before/after windowfocus and after the click, to
 * isolate where typed keystrokes are lost.
 */
import { execSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import path from "node:path";

const FIREFOX = "/home/acidhax/Downloads/firefox-155.0.1/firefox/firefox";
const DISPLAY = ":99";
const ROUNDS = Number(process.env.ROUNDS ?? 3);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function sh(cmd) {
  return execSync(cmd, { encoding: "utf8", env: { ...process.env, DISPLAY }, stdio: "pipe" }).trim();
}
const focus = () => {
  try { return sh("xdotool getwindowfocus"); } catch { return "(none)"; }
};

const work = path.join(tmpdir(), `focus-debug-${Date.now()}`);
const pageDir = path.join(work, "page");
mkdirSync(pageDir, { recursive: true });
writeFileSync(
  path.join(pageDir, "t.html"),
  `<!doctype html><html><head><meta charset="utf-8"><title>FOCUSPROBE</title>
  <style>body{font:20px monospace;background:#fff;color:#000}
  #t{width:700px;height:120px;font:24px monospace;margin-top:40px}</style>
  </head><body>
  <h1>Focus probe</h1>
  <div id="ae">activeElement=(none)</div>
  <div id="out">typed=(none)</div>
  <textarea id="t" placeholder="type here"></textarea>
  <script>
    const t = document.getElementById('t');
    const ae = document.getElementById('ae');
    const out = document.getElementById('out');
    document.addEventListener('focusin', (e) => ae.textContent = 'activeElement=' + (e.target.id || e.target.tagName));
    document.addEventListener('focusout', () => ae.textContent = 'activeElement=(none)');
    t.addEventListener('input', () => out.textContent = 'typed=' + t.value);
  </script>
  </body></html>`,
);
const httpServer = createServer((req, res) => {
  const f = path.join(pageDir, req.url === "/" ? "t.html" : req.url);
  if (existsSync(f)) { res.writeHead(200, { "content-type": "text/html" }); res.end(readFileSync(f)); }
  else { res.writeHead(404); res.end("nf"); }
});
await new Promise((r) => httpServer.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${httpServer.address().port}/t.html`;

const xvfb = spawn("Xvfb", [DISPLAY, "-screen", "0", "1400x900x24"], { stdio: "ignore" });
await sleep(1_000);
sh("xdpyinfo");

// Profile with onboarding-skipping prefs (fresh HOME profiles show the
// "Welcome to Firefox" dialog, which swallows XTEST keystrokes).
const profDir = path.join(work, "profile");
mkdirSync(profDir, { recursive: true });
writeFileSync(
  path.join(profDir, "user.js"),
  [
    `user_pref("browser.startup.homepage_override.mstone", "ignore");`,
    `user_pref("startup.homepage_welcome_url", "");`,
    `user_pref("startup.homepage_welcome_url.additional", "");`,
    `user_pref("browser.shell.checkDefaultBrowser", false);`,
    `user_pref("datareporting.healthreport.uploadEnabled", false);`,
  ].join("\n"),
);
const ff = spawn(FIREFOX, [`-no-remote`, `-profile`, profDir, url], {
  env: { ...process.env, DISPLAY, HOME: work },
  stdio: "ignore",
});
await sleep(12_000); // let the window + page load

const win = sh(`xdotool search --onlyvisible --name "FOCUSPROBE" | head -1`);
console.log(`window=${win}`);
const geom = sh(`xdotool getwindowgeometry --shell ${win}`);
const wx = Number(geom.match(/X=(\d+)/)?.[1] ?? 0);
const wy = Number(geom.match(/Y=(\d+)/)?.[1] ?? 0);
console.log(`window at ${wx},${wy}`);
// Fallback: if the onboarding dialog appeared anyway, dismiss it with a
// click on its "Continue" button (harmless if absent: lands in the page).
execSync(`xdotool mousemove ${wx + 634} ${wy + 327} click 1`, { env: { ...process.env, DISPLAY }, stdio: "pipe" });
await sleep(1_000);

for (let round = 1; round <= ROUNDS; round++) {
  const f0 = focus();
  execSync(`xdotool windowfocus --sync ${win}`, { env: { ...process.env, DISPLAY }, stdio: "pipe" });
  const f1 = focus();
  // click the textarea center: window-relative (350, 330)
  execSync(`xdotool mousemove ${wx + 350} ${wy + 330} click 1`, { env: { ...process.env, DISPLAY }, stdio: "pipe" });
  const f2 = focus();
  execSync(`xdotool type --delay 20 "PROBE${round}"`, { env: { ...process.env, DISPLAY }, stdio: "pipe" });
  const f3 = focus();
  console.log(`round ${round}: focus before=${f0} afterWindowFocus=${f1} afterClick=${f2} afterType=${f3} (win=${win})`);
  await sleep(1_500);
  execSync(`import -window root "${work}/round${round}.png"`, { env: { ...process.env, DISPLAY }, stdio: "pipe" });
}

console.log(`screenshots: ${work}`);
ff.kill("SIGTERM");
xvfb.kill();
httpServer.close();
