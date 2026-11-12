/**
 * Measures layout overflow in a real browser, with no test dependencies.
 *
 * Headless Chrome's --screenshot silently crops a page that is wider than the
 * window, so an overflowing layout looks identical to a correct one. This
 * drives Chrome over the DevTools Protocol instead and asks the page directly
 * how wide it is and which elements stick out, which turns "it looks clipped"
 * into a number and a selector.
 *
 *   node scripts/measure-layout.mjs <url> [width] [height]
 *
 * Node 20+ provides WebSocket globally, so this needs nothing installed.
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const URL_ARG = process.argv[2] ?? 'http://localhost:3000/';
const WIDTH = Number(process.argv[3] ?? 430);
const HEIGHT = Number(process.argv[4] ?? 900);
const PORT = 9222;
const CHROME =
  process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const chrome = spawn(
  CHROME,
  [
    '--headless',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    `--remote-debugging-port=${PORT}`,
    `--window-size=${WIDTH},${HEIGHT}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const cleanup = () => chrome.kill();
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

async function targetWs() {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      /* chrome still starting */
    }
    await sleep(200);
  }
  throw new Error('Chrome DevTools endpoint never became available');
}

const ws = new WebSocket(await targetWs());
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});

let nextId = 1;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  const resolver = pending.get(msg.id);
  if (!resolver) return;
  pending.delete(msg.id);
  msg.error ? resolver.reject(new Error(msg.error.message)) : resolver.resolve(msg.result);
});

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

await send('Page.enable');
// Emulate a real device viewport; --window-size alone does not constrain layout.
await send('Emulation.setDeviceMetricsOverride', {
  width: WIDTH,
  height: HEIGHT,
  deviceScaleFactor: 1,
  mobile: WIDTH < 700,
});
await send('Page.navigate', { url: URL_ARG });
await sleep(6000); // let the investigation run and render

const { result } = await send('Runtime.evaluate', {
  returnByValue: true,
  expression: `(() => {
    const vw = document.documentElement.clientWidth;
    const offenders = [];
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (r.right > vw + 1) {
        offenders.push({
          sel: el.tagName.toLowerCase() + (el.className && typeof el.className === 'string'
            ? '.' + el.className.trim().split(/\\s+/).join('.') : ''),
          right: Math.round(r.right),
          width: Math.round(r.width),
          scrollWidth: el.scrollWidth,
        });
      }
    }
    return {
      viewport: vw,
      documentScrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      overflowPx: document.documentElement.scrollWidth - vw,
      offenders: offenders.slice(0, 12),
    };
  })()`,
});

console.log(JSON.stringify(result.value, null, 2));
ws.close();
chrome.kill();
process.exit(result.value.overflowPx > 1 ? 1 : 0);
