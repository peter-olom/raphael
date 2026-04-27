import assert from 'node:assert/strict';
import fs from 'node:fs';

const files = {
  index: fs.readFileSync('src/server/index.ts', 'utf8'),
  api: fs.readFileSync('src/server/routes/api.ts', 'utf8'),
  events: fs.readFileSync('src/server/routes/events.ts', 'utf8'),
  otlp: fs.readFileSync('src/server/routes/otlp.ts', 'utf8'),
  query: fs.readFileSync('src/server/routes/query.ts', 'utf8'),
  retention: fs.readFileSync('src/server/retention.ts', 'utf8'),
};

for (const [name, body] of Object.entries({ api: files.api, events: files.events, otlp: files.otlp, query: files.query })) {
  assert.equal(body.includes('pruneByRetention'), false, `${name} route must not call pruneByRetention`);
  assert.equal(body.includes('runRetentionOnce'), false, `${name} route must not call retention scheduler directly`);
}

assert.equal(files.index.includes('pruneByRetention'), false, 'index should start scheduler, not prune inline');
assert.match(files.index, /startRetentionScheduler\(\)/, 'server startup should start background scheduler');
assert.match(files.retention, /if \(running\)/, 'scheduler should guard overlapping runs');
assert.match(files.retention, /skippedOverlappingRuns\+\+/, 'scheduler should count skipped overlaps');
assert.match(files.retention, /setTimeout/, 'scheduler should use background timer');
assert.match(files.retention, /summary\.busy/, 'scheduler should track busy backoff telemetry');
assert.equal(files.retention.includes('VACUUM'), false, 'scheduler should not run VACUUM');

console.log('retention path smoke passed');
