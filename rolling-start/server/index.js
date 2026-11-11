'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const encoder = require('../lib/csp-encoder');
const { buildPackage, buildLocalTestPackBuffer } = require('../scripts/build-zip');

const ROOT = path.resolve(__dirname, '..');
const CSP_SCRIPT_PATH = path.join(ROOT, 'csp', 'gdsp_rolling_start.lua');
const ZIP_PATH = path.join(ROOT, 'packages', 'GDSP_RollingStart.zip');
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.lua': 'text/plain; charset=utf-8',
  '.zip': 'application/zip',
};

function getRawLuaScript() {
  return fs.readFileSync(CSP_SCRIPT_PATH, 'utf8');
}

function buildScriptQueryUrl(baseOrigin, cfg) {
  const cleanOrigin = String(baseOrigin || '').replace(/\/+$/, '');
  const sanitized = encoder.sanitizeConfig(cfg);
  const params = new URLSearchParams();
  for (const [k, defVal] of Object.entries(encoder.CFG_DEFAULTS)) {
    if (String(sanitized[k]) !== String(defVal)) {
      params.set(k, String(sanitized[k]));
    }
  }
  const qs = params.toString();
  return `${cleanOrigin}/csp/rolling_start.lua${qs ? `?${qs}` : ''}`;
}

function readJsonBody(req, maxBytes = 262144) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('Request payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, data, headOnly = false) {
  const body = Buffer.from(JSON.stringify(data), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
  });
  res.end(headOnly ? undefined : body);
}

function sendFile(res, filePath, extraHeaders = {}, headOnly = false) {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  const buf = fs.readFileSync(filePath);
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': buf.length,
    ...extraHeaders,
  });
  res.end(headOnly ? undefined : buf);
}

function createHandler() {
  return async (req, res) => {
    try {
      const parsed = new URL(req.url || '/', 'http://localhost');
      const pathname = parsed.pathname;
      const isHead = req.method === 'HEAD';
      const isGetOrHead = req.method === 'GET' || isHead;

      if (isGetOrHead && pathname === '/api/health') {
        return sendJson(res, 200, {
          ok: true,
          service: 'gdsp-rolling-start',
          scriptExists: fs.existsSync(CSP_SCRIPT_PATH),
          zipExists: fs.existsSync(ZIP_PATH),
        }, isHead);
      }

      if (isGetOrHead && pathname === '/api/presets') {
        return sendJson(res, 200, {
          defaults: encoder.CFG_DEFAULTS,
          presets: encoder.PRESETS,
        }, isHead);
      }

      if (req.method === 'POST' && pathname === '/api/generate') {
        const body = await readJsonBody(req);
        const cfg = encoder.sanitizeConfig(body.config || body);
        const proto = req.headers['x-forwarded-proto'] || 'http';
        const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3080';
        const origin = `${proto}://${host}`;
        const customUrl = typeof body.scriptUrl === 'string' && body.scriptUrl.trim()
          ? body.scriptUrl.trim()
          : `${origin}/csp/rolling_start.lua`;
        const urlWithQuery = buildScriptQueryUrl(customUrl.replace(/\/csp\/rolling_start\.lua.*$/, ''), cfg);

        const iniSnippet = encoder.buildCspExtraOptionsIni(cfg, {
          scriptUrl: customUrl,
          compact: body.compactIni === true,
        });
        const compactIni = encoder.buildCspExtraOptionsIni(cfg, {
          scriptUrl: customUrl,
          compact: true,
        });
        const motdResult = encoder.buildMotdPayload({
          welcomeText: body.welcomeText || 'GDSP — Depart Lance Actif. Respectez votre file et le limiteur.',
          iniText: compactIni,
        });

        return sendJson(res, 200, {
          config: cfg,
          scriptUrl: customUrl,
          scriptUrlWithOverrides: urlWithQuery,
          iniSnippet,
          compactIni,
          ...motdResult,
        });
      }

      if (req.method === 'POST' && pathname === '/api/decode-motd') {
        try {
          const body = await readJsonBody(req);
          const decoded = encoder.decodeCspPayload((body && body.motd) || '');
          return sendJson(res, 200, { ok: true, ...decoded });
        } catch (err) {
          return sendJson(res, 400, { ok: false, error: err.message });
        }
      }

      if (isGetOrHead && pathname === '/csp/rolling_start.lua') {
        const queryObj = Object.fromEntries(parsed.searchParams.entries());
        const out = encoder.injectQueryOverrides(getRawLuaScript(), queryObj);
        const buf = Buffer.from(out, 'utf8');
        res.writeHead(200, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Length': buf.length,
          'Cache-Control': 'no-cache',
        });
        return res.end(isHead ? undefined : buf);
      }

      if (isGetOrHead && pathname === '/cm-app/GDSP_RollingStart.zip') {
        if (!fs.existsSync(ZIP_PATH)) {
          buildPackage();
        }
        return sendFile(res, ZIP_PATH, {
          'Content-Disposition': 'attachment; filename="GDSP_RollingStart.zip"',
          'Access-Control-Allow-Origin': '*',
        }, isHead);
      }

      if (isGetOrHead && pathname === '/cm-app/GDSP_LocalTestPack.zip') {
        const queryObj = Object.fromEntries(parsed.searchParams.entries());
        const packZip = buildLocalTestPackBuffer(queryObj);

        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Length': packZip.length,
          'Content-Disposition': 'attachment; filename="GDSP_LocalTestPack.zip"',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache',
        });
        return res.end(isHead ? undefined : packZip);
      }

      if (isGetOrHead) {
        const relPath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
        const resolved = path.resolve(PUBLIC_DIR, relPath);
        if (resolved.startsWith(PUBLIC_DIR + path.sep) && fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
          return sendFile(res, resolved, {}, isHead);
        }
        return sendFile(res, path.join(PUBLIC_DIR, 'index.html'), {}, isHead);
      }

      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('Method Not Allowed');
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
  };
}

function createServer() {
  return http.createServer(createHandler());
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3080);
  const host = process.env.HOST || '0.0.0.0';
  if (!fs.existsSync(ZIP_PATH)) {
    buildPackage();
  }
  const server = createServer();
  server.listen(port, host, () => {
    console.log(`GDSP Rolling Start server listening on http://${host}:${port}`);
  });
}

module.exports = { createServer, createHandler, buildScriptQueryUrl };
