'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { gunzipSync } = require('node:zlib');
const { encodeJsonPayload, MIN_GZIP_BYTES } = require('../tools/live-timing/payload');

test('les petits instantanés live restent non compressés', () => {
  const payload = { ok: true };
  const encoded = encodeJsonPayload(payload);
  assert.equal(encoded.encoding, null);
  assert.equal(encoded.body.toString('utf8'), JSON.stringify(payload));
});

test('les gros instantanés sont gzipés sans modifier leur contenu JSON', () => {
  const payload = {
    server: { name: 'GDSP', track: 'oesterreichring1979' },
    session: { type: 'race', name: 'Course' },
    cars: Array.from({ length: 40 }, (_, carId) => ({
      carId, name: `Pilote ${carId}`, team: 'Gentleman Drivers Project', model: 'Lola T290',
      laps: 12, lastLap: '1:58.907', bestLap: '1:57.123', speedKmh: 184, position: carId + 1
    })),
    events: Array.from({ length: 60 }, (_, i) => ({
      at: '2026-11-10T12:00:00.000Z', kind: 'lap', text: `Pilote ${i % 40} — tour 1:58.907`
    }))
  };
  const raw = Buffer.from(JSON.stringify(payload));
  assert.ok(raw.length >= MIN_GZIP_BYTES);
  const encoded = encodeJsonPayload(payload);
  assert.equal(encoded.encoding, 'gzip');
  assert.ok(encoded.body.length < raw.length);
  assert.deepEqual(JSON.parse(gunzipSync(encoded.body).toString('utf8')), payload);
});
