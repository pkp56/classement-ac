'use strict';

const { gzipSync } = require('node:zlib');

// Skip gzip for tiny snapshots: framing overhead would cost more than it saves.
const MIN_GZIP_BYTES = 1024;

function encodeJsonPayload(payload) {
  const raw = Buffer.from(JSON.stringify(payload), 'utf8');
  if (raw.length < MIN_GZIP_BYTES) return { body: raw, encoding: null };

  const compressed = gzipSync(raw);
  return compressed.length < raw.length
    ? { body: compressed, encoding: 'gzip' }
    : { body: raw, encoding: null };
}

module.exports = { encodeJsonPayload, MIN_GZIP_BYTES };
