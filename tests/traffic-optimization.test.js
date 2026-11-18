'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const path = require('node:path');
const { createGunzip, gunzipSync } = require('node:zlib');

async function reservePort() {
  const server = http.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

function request(port, requestPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: requestPath, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
  });
}

test('Les réponses texte sont compressées et le flux SSE compressé reste immédiat', async t => {
  const port = await reservePort();
  const child = spawn(process.execPath, ['app.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      BACKEND_URL: 'http://127.0.0.1:1',
      LIVE_TIMING_ENABLED: '1',
      LIVE_MIRROR_FILE: 'off',
      AC_LISTEN_PORT: '0',
      AC_PLUGIN_PORT: '0'
    },
    stdio: ['ignore', 'pipe', 'ignore']
  });
  t.after(() => child.kill());
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server startup timeout')), 10000);
    child.stdout.on('data', chunk => {
      if (String(chunk).includes('démarré')) { clearTimeout(timeout); resolve(); }
    });
    child.on('exit', code => { clearTimeout(timeout); reject(new Error('Server exited ' + code)); });
  });

  const redirect = await request(port, '/index.html');
  assert.equal(redirect.status, 301);
  assert.equal(redirect.headers.location, '/');
  // Le shell HTML conservé sur /admin permet de tester la compression sans base de données.
  const htmlResponse = await request(port, '/admin', { 'accept-encoding': 'gzip' });
  assert.equal(htmlResponse.status, 200);
  assert.equal(htmlResponse.headers['content-encoding'], 'gzip');
  assert.match(htmlResponse.headers.vary || '', /Accept-Encoding/i);
  const html = gunzipSync(htmlResponse.body).toString('utf8');
  assert.match(html, /--intro-image/);
  assert.ok(htmlResponse.body.length < Buffer.byteLength(html));

  const dataResponse = await request(port, '/data/data.json', { 'accept-encoding': 'gzip' });
  assert.equal(dataResponse.status, 200);
  assert.equal(dataResponse.headers['content-encoding'], 'gzip');
  const data = gunzipSync(dataResponse.body);
  assert.ok(data.length > dataResponse.body.length * 3, 'JSON transfer should be materially smaller');

  for (const imagePath of ['/intro.webp', '/hero-gdsp.webp', '/assets/lvl1-elite.webp', '/assets/lvl2-confirme.webp', '/assets/lvl3-inter.webp', '/assets/lvl4-debut.webp']) {
    const imageResponse = await request(port, imagePath);
    assert.equal(imageResponse.status, 200, imagePath);
    assert.match(imageResponse.headers['content-type'], /image\/webp/);
    assert.equal(imageResponse.headers['content-encoding'], undefined, 'WebP should not be compressed again');
  }
  const siteScript = await request(port, '/site.js?v=98');
  assert.match(siteScript.body.toString('utf8'), /hero-gdsp\.webp/);
  assert.match(siteScript.body.toString('utf8'), /lvl3-inter\.webp/);

  const live = await new Promise((resolve, reject) => {
    let settled = false;
    let text = '';
    let req;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (req) req.destroy();
      reject(new Error('SSE event was not flushed'));
    }, 5000);
    req = http.get({
      hostname: '127.0.0.1', port, path: '/api/live/stream',
      headers: { 'accept-encoding': 'gzip' }
    }, res => {
      if (res.statusCode !== 200) {
        settled = true;
        clearTimeout(timer);
        res.resume();
        return reject(new Error('SSE status ' + res.statusCode));
      }
      const decoder = createGunzip();
      const finish = error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) {
          req.destroy();
          decoder.destroy();
          return reject(error);
        }
        resolve({ headers: res.headers, text });
        req.destroy();
        decoder.destroy();
      };
      res.on('error', error => finish(error));
      decoder.on('error', error => finish(error));
      decoder.on('data', chunk => {
        text += chunk.toString('utf8');
        if (text.includes('event: snapshot\n')) finish();
      });
      res.pipe(decoder);
    });
    req.on('error', error => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } });
  });
  assert.equal(live.headers['content-encoding'], 'gzip');
  assert.match(live.headers['content-type'], /text\/event-stream/);
  assert.match(live.headers['cache-control'], /no-store/);
  assert.match(live.text, /retry: 3000/);
  assert.match(live.text, /event: snapshot/);
});
