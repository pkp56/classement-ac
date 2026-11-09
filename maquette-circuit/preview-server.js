const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 8080);
const MOCKUP_DIR = __dirname;
const ASSETS_DIR = path.resolve(__dirname, '..', 'assets');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8'
};

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  let filePath;
  if (urlPath === '/' || urlPath === '/index.html') {
    filePath = path.join(MOCKUP_DIR, 'index.html');
  } else if (urlPath.startsWith('/assets/')) {
    const rel = path.normalize(urlPath.slice('/assets/'.length)).replace(/^(\.\.(\/|\\|$))+/, '');
    filePath = path.join(ASSETS_DIR, rel);
  } else {
    const rel = path.normalize(urlPath.replace(/^\/+/, '')).replace(/^(\.\.(\/|\\|$))+/, '');
    filePath = path.join(MOCKUP_DIR, rel);
  }

  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(buf);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Maquette Onglet Circuit en ligne sur 0.0.0.0:${PORT}`);
});
