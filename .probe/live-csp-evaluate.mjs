/** Real Firefox CSP regression. Uses an isolated temporary extension/profile.
 * Run: node .probe/live-csp-evaluate.mjs (requires Firefox, web-ext, Xvfb, xdotool).
 * PI_CSP_RICH_PERMISSION=1 exercises the real sidebar permission dialog.
 * PI_CSP_REDDIT=1 adds a read-only live Reddit check.
 */
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, mkdir, cp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const rich = process.env.PI_CSP_RICH_PERMISSION === '1';
const work = await mkdtemp(path.join(tmpdir(), 'pi-csp-'));
const extension = path.join(work, 'extension');
await mkdir(extension);
if (rich) {
  await cp('firefox/dist/sidebar', path.join(extension, 'sidebar'), { recursive: true });
  const html = await readFile(path.join(extension, 'sidebar/index.html'), 'utf8');
  await writeFile(path.join(extension, 'sidebar/index.html'), html.replace('<title>Pi</title>', '<title>CSP evaluation probe</title>'));
}
let finish;
const done = new Promise(resolve => { finish = resolve; });
let showPrompt;
const promptReady = new Promise(resolve => { showPrompt = resolve; });
const server = createServer((req, res) => {
  if (req.url === '/prompt') { res.end('ok'); showPrompt(); return; }
  if (req.url === '/result') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => { res.end('ok'); finish(JSON.parse(body)); });
    return;
  }
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; object-src 'none'");
  res.setHeader('Content-Type', req.url === '/fixture.js' ? 'text/javascript' : 'text/html');
  res.end(req.url === '/fixture.js'
    ? 'window.pageOnly = 41;'
    : '<!doctype html><title>Strict CSP fixture</title><script src="/fixture.js"></script><h1>Before</h1>' + (req.url === '/child' ? '' : '<iframe src="/child"></iframe>'));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
await writeFile(path.join(extension, 'manifest.json'), JSON.stringify({
  manifest_version: 3, name: 'Pi CSP regression', version: '1.0',
  permissions: ['tabs', 'webNavigation'], optional_permissions: ['userScripts'], host_permissions: ['<all_urls>'],
  background: { scripts: ['background.js'] },
  browser_specific_settings: { gecko: { id: 'pi-csp-probe@tests', strict_min_version: '153.0' } },
}));
await writeFile(path.join(extension, 'background.js'), 'browser.tabs.create({url: browser.runtime.getURL("runner.html")});');
await writeFile(path.join(extension, 'runner.html'), '<!doctype html><title>CSP runner</title><button id="run" autofocus>Enable and test</button><pre id="output"></pre><script src="runner.js"></script>');
await build({
  stdin: { contents: `
    import { evaluateInPage } from './firefox/src/background/page-evaluate.ts';
    import { requestBrowserToolPermission } from './firefox/src/page-evaluation-permission.ts';
    import { buildPermissionRequest } from './packages/protocol/src/permission.ts';
    const results = [];
    let promptCount = 0;
    let pendingRequest;
    let resolvePrompt;
    let sequence = 0;
    browser.runtime.onMessage.addListener((msg) => {
      if (msg.type === 'pi/action') return Promise.resolve({ status:{state:'connected'}, sessions:[], permissionRequests:pendingRequest?[pendingRequest]:[] });
      if (msg.type === 'pi/permission_response') { const resolve = resolvePrompt; pendingRequest = undefined; resolvePrompt = undefined; resolve?.({outcome:msg.optionId==='cancelled'?{outcome:'cancelled'}:{outcome:'selected',optionId:msg.optionId}}); return Promise.resolve({ok:true}); }
    });
    const approve = async () => {
      const request = buildPermissionRequest({sessionId:'probe', toolCallId:'eval-'+(++sequence), toolName:'browser_evaluate'});
      return requestBrowserToolPermission(request, (req) => {
        promptCount++;
        pendingRequest = req;
        return new Promise(resolve => { resolvePrompt = resolve; browser.runtime.sendMessage({type:'pi/permission_request', request:req}).then(() => fetch(${JSON.stringify(origin + '/prompt')})); });
      });
    };

    const check = (name, ok, detail) => { results.push({name, ok, detail}); document.querySelector('#output').textContent = JSON.stringify(results); };
    const start = () => {
      const grant = ${rich} ? Promise.resolve(true) : browser.permissions.request({permissions:['userScripts']});
      void (async () => {
        try {
          if (${rich}) {
            await browser.tabs.create({url:browser.runtime.getURL('sidebar/index.html')});
            await new Promise(r=>setTimeout(r,500));
          } else check('optional permission granted', await grant);
          const tab = await browser.tabs.create({url: ${JSON.stringify(origin)}, active:false});
          for (let i=0;i<100;i++) { if ((await browser.tabs.get(tab.id)).status === 'complete') break; await new Promise(r=>setTimeout(r,100)); }
          const run = async (expression, arg, frame=0) => {
            if (${rich}) {
              const approval = await approve();
              if(approval.outcome.outcome !== 'selected') throw Error('Permission denied');
            }
            return evaluateInPage(tab.id, frame, expression, arg, 5000);
          };
          check('page CSP actually denies Function', /EvalError|CSP/.test((await run("new Function('return 1')()")).error));
          const value = await run('async arg => { document.querySelector("h1").textContent = arg; return {n: window.pageOnly + 1, text: document.querySelector("h1").textContent}; }', 'After');
          check('globals, async, arguments and DOM mutation under CSP', value.value?.n === 42 && value.value?.text === 'After', value);
          const frames = await browser.webNavigation.getAllFrames({tabId:tab.id});
          const child = frames.find(f=>f.frameId !== 0);
          const frameValue = await run('document.querySelector("h1").textContent', undefined, child.frameId);
          check('requested child frame only', frameValue.value === 'Before', frameValue);
          const error = await run('(() => { window.runs = (window.runs || 0) + 1; throw new EvalError("blocked by CSP"); })()');
          check('expression errors do not retry', !!error.error && (await run('window.runs')).value === 1, error);
          check('syntax error is returned', !!(await run('(() =>')).error);
          await browser.tabs.update(tab.id, {url:${JSON.stringify(origin + '/next')}});
          for (let i=0;i<100;i++) { if ((await browser.tabs.get(tab.id)).status === 'complete') break; await new Promise(r=>setTimeout(r,100)); }
          check('evaluation after navigation', (await run('window.pageOnly')).value === 41);
          if (${process.env.PI_CSP_REDDIT === '1'}) {
            await browser.tabs.update(tab.id, {url:'https://www.reddit.com/'});
            for (let i=0;i<200;i++) { if ((await browser.tabs.get(tab.id)).status === 'complete') break; await new Promise(r=>setTimeout(r,100)); }
            const reddit = await run('({ host: location.hostname, title: document.title, links: document.querySelectorAll("a").length })');
            check('live Reddit DOM evaluation', reddit.value?.host === 'www.reddit.com' && typeof reddit.value?.links === 'number', reddit);
          }
          if (${rich}) check('one rich prompt, automatic continuation and no later prompts', promptCount === 1, {promptCount});
          await browser.permissions.remove({permissions:['userScripts']});
          try { await evaluateInPage(tab.id, 0, '1', undefined, 5000); check('permission revocation enforced', false); } catch (e) { check('permission revocation enforced', /page evaluation permission request/.test(String(e)), String(e)); }
        } catch (e) { check('probe completed', false, String(e)); }
        await fetch(${JSON.stringify(origin + '/result')}, {method:'POST', body:JSON.stringify(results)});
      })();
    };
    if (${rich}) start(); else document.querySelector('#run').onclick = start;
  `, resolveDir: process.cwd(), sourcefile: 'csp-runner.ts', loader: 'ts' },
  bundle: true, format: 'iife', platform: 'browser', outfile: path.join(extension, 'runner.js'),
});
const xvfb = spawn('Xvfb', ['-displayfd', '3', '-screen', '0', '1000x700x24'], {stdio:['ignore','ignore','pipe','pipe']});
const display = await new Promise(resolve => xvfb.stdio[3].once('data', data => resolve(':' + String(data).trim())));
const env = {...process.env, DISPLAY:display};
const firefox = process.env.PI_LIVE_FIREFOX ?? '/home/acidhax/Downloads/firefox-155.0.1/firefox/firefox';
const webExt = process.env.PI_WEB_EXT ?? '/home/acidhax/.nvm/versions/node/v23.10.0/bin/web-ext';
const ff = spawn(webExt, ['run','--source-dir',extension,'--firefox',firefox,'--no-reload'], {env, detached:true, stdio:['ignore','pipe','pipe']});
let log = '';
ff.stdout.on('data', d=>{log+=d;}); ff.stderr.on('data', d=>{log+=d;});
console.log(`Probe artifacts: ${work}; DISPLAY=${display}`);
let timer;
try {
  let window;
  for(let i=0;i<60;i++) {
    try { window=execFileSync('xdotool',['search','--name',rich ? 'CSP evaluation probe' : 'CSP runner'],{env,stdio:['ignore','pipe','ignore']}).toString().trim().split('\n')[0]; } catch {}
    if(window) break;
    await new Promise(r=>setTimeout(r,500));
  }
  if(!window) throw Error('Firefox runner did not open: '+log);
  execFileSync('xdotool',['windowfocus',window],{env});
  if (rich) await Promise.race([promptReady, new Promise((_, reject) => { timer = setTimeout(() => reject(Error("Permission prompt did not appear")), 15000); })]);
  clearTimeout(timer);
  await new Promise(r=>setTimeout(r,300));
  execFileSync('import',['-window','root',path.join(work,'rich-prompt.png')],{env});
  if (rich) {
    // The real sidebar's primary permission action (fixed 1000x700 test display).
    execFileSync('xdotool',['mousemove','454','425','click','1'],{env});
  } else {
    execFileSync('xdotool',['mousemove','60','120','click','1'],{env});
    execFileSync('xdotool',['key','Tab','Return'],{env});
  }
  await new Promise(r=>setTimeout(r,1500));
  execFileSync('import',['-window','root',path.join(work,'permission.png')],{env});
  // Firefox requires acknowledging the user-script checkbox before Allow.
  execFileSync('xdotool',['mousemove','476','169','click','1','mousemove','819','299','click','1'],{env});
  const results = await Promise.race([done, new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Probe timed out: '+log)),120000);})]);
  await writeFile(path.join(work,'results.json'),JSON.stringify(results,null,2));
  console.log(JSON.stringify(results,null,2));
  if(results.some(r=>!r.ok)) process.exitCode=1;
} finally {
  clearTimeout(timer);
  try { process.kill(-ff.pid,'SIGTERM'); } catch {}
  xvfb.kill(); server.close();
}
