/*
 * Tests for the staleness classifier.
 *
 * The failure this guards against is silent: when the scheduled build stops
 * running, data.json keeps rendering confident, plausible, wrong numbers and
 * the page looks completely healthy. So the interesting cases here are the
 * boundaries between "fine" and "say something", the states that have no
 * timestamp at all, and the migration that must not quietly discard an
 * existing user's sync history.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const {
  classifyFreshness,
  worstLevel,
  isConcerning,
  migrateSyncMeta,
  parseGeneratedAt,
  describeAgeHours,
  latestSource,
} = require(path.join(__dirname, '..', 'docs', 'app.js'));

const NOW = new Date('2026-03-01T12:00:00Z');

/** A timestamp `hours` before NOW. */
function ago(hours) {
  return new Date(NOW.getTime() - hours * 3600000).toISOString();
}

/* ------------------------------------------------------------ classification */

test('level is driven by the ratio of age to expected cadence', () => {
  const daily = { now: NOW, cadenceHours: 24 };

  assert.equal(classifyFreshness({ at: ago(1), ...daily }).level, 'fresh');
  assert.equal(classifyFreshness({ at: ago(11), ...daily }).level, 'fresh');
  assert.equal(classifyFreshness({ at: ago(13), ...daily }).level, 'aging');
  assert.equal(classifyFreshness({ at: ago(23), ...daily }).level, 'aging');
  assert.equal(classifyFreshness({ at: ago(25), ...daily }).level, 'stale');
  assert.equal(classifyFreshness({ at: ago(71), ...daily }).level, 'stale');
  assert.equal(classifyFreshness({ at: ago(73), ...daily }).level, 'critical');
});

test('boundaries are exact and half-open', () => {
  const daily = { now: NOW, cadenceHours: 24 };
  // 0.5, 1.0 and 3.0 belong to the *worse* side, so a source that is exactly
  // one full cadence late already counts as stale rather than merely aging.
  assert.equal(classifyFreshness({ at: ago(12), ...daily }).level, 'aging');
  assert.equal(classifyFreshness({ at: ago(24), ...daily }).level, 'stale');
  assert.equal(classifyFreshness({ at: ago(72), ...daily }).level, 'critical');
});

test('the same ages classify differently under a slower cadence', () => {
  // A three-day-old holdings entry is unremarkable; a three-day-old daily
  // build is not. One classifier, two cadences.
  const age = ago(72);
  assert.equal(classifyFreshness({ at: age, now: NOW, cadenceHours: 24 }).level, 'critical');
  assert.equal(classifyFreshness({ at: age, now: NOW, cadenceHours: 92 * 24 }).level, 'fresh');
});

test('a future timestamp is clamped rather than treated as very fresh', () => {
  const future = new Date(NOW.getTime() + 5 * 3600000).toISOString();
  const result = classifyFreshness({ at: future, now: NOW, cadenceHours: 24 });
  assert.equal(result.level, 'fresh');
  assert.equal(result.ageHours, 0, 'clock skew must not produce a negative age');
  assert.equal(result.ratio, 0);
});

test('a missing timestamp is "never", not "fresh"', () => {
  for (const missing of [null, undefined, '']) {
    const result = classifyFreshness({ at: missing, now: NOW, cadenceHours: 24 });
    assert.equal(result.level, 'never');
    assert.equal(result.ageHours, null);
  }
});

test('an unparseable timestamp is broken, not silently ignored', () => {
  const result = classifyFreshness({ at: 'not a date', now: NOW, cadenceHours: 24 });
  assert.equal(result.level, 'broken');
  assert.match(result.reason, /unreadable/i);
});

test('an explicit broken reason wins over any timestamp', () => {
  const result = classifyFreshness({
    at: ago(0),
    now: NOW,
    cadenceHours: 24,
    brokenReason: 'data.json has no generatedAt',
  });
  assert.equal(result.level, 'broken');
  assert.equal(result.reason, 'data.json has no generatedAt');
});

test('a non-positive cadence falls back to the daily default', () => {
  for (const bad of [0, -5, NaN, undefined, 'x']) {
    const result = classifyFreshness({ at: ago(25), now: NOW, cadenceHours: bad });
    assert.equal(result.level, 'stale', `cadence ${String(bad)} should default to 24h`);
  }
});

test('a Date instance is accepted as well as an ISO string', () => {
  const asDate = new Date(NOW.getTime() - 25 * 3600000);
  assert.equal(classifyFreshness({ at: asDate, now: NOW, cadenceHours: 24 }).level, 'stale');
});

test('classify tolerates being called with no options at all', () => {
  assert.equal(classifyFreshness().level, 'never');
  assert.equal(classifyFreshness(null).level, 'never');
});

/* -------------------------------------------------------------- aggregation */

test('worstLevel picks the most severe level present', () => {
  assert.equal(worstLevel(['fresh', 'aging']), 'aging');
  assert.equal(worstLevel(['aging', 'critical', 'stale']), 'critical');
  assert.equal(worstLevel(['stale', 'broken']), 'broken');
  assert.equal(worstLevel(['fresh', 'never']), 'never');
});

test('worstLevel of nothing is fresh', () => {
  assert.equal(worstLevel([]), 'fresh');
  assert.equal(worstLevel(null), 'fresh');
  assert.equal(worstLevel(undefined), 'fresh');
});

test('worstLevel ignores unknown levels rather than throwing', () => {
  assert.equal(worstLevel(['fresh', 'bogus']), 'fresh');
});

test('only stale, critical and broken raise a warning', () => {
  assert.equal(isConcerning('fresh'), false);
  assert.equal(isConcerning('aging'), false, 'aging is informational, not a warning');
  assert.equal(isConcerning('stale'), true);
  assert.equal(isConcerning('critical'), true);
  assert.equal(isConcerning('broken'), true);
});

/* ---------------------------------------------------------------- migration */

test('migration lifts the legacy single-source record into the map', () => {
  const legacy = { at: ago(10), source: 'Fidelity' };
  const sources = migrateSyncMeta(legacy, {});
  assert.deepEqual(Object.keys(sources), ['Fidelity']);
  assert.equal(sources.Fidelity.at, legacy.at);
  assert.equal(sources.Fidelity.via, 'legacy');
});

test('migration never moves a source backwards in time', () => {
  const legacy = { at: ago(100), source: 'Fidelity' };
  const existing = { Fidelity: { at: ago(2), label: 'Fidelity', via: 'sync' } };
  const sources = migrateSyncMeta(legacy, existing);
  assert.equal(sources.Fidelity.at, existing.Fidelity.at, 'newer record must survive');
  assert.equal(sources.Fidelity.via, 'sync');
});

test('migration replaces an older record with a newer legacy one', () => {
  const legacy = { at: ago(2), source: 'Fidelity' };
  const existing = { Fidelity: { at: ago(100), label: 'Fidelity', via: 'sync' } };
  assert.equal(migrateSyncMeta(legacy, existing).Fidelity.at, legacy.at);
});

test('an unreadable existing timestamp loses to the legacy record', () => {
  // Comparing dates with < silently returns false when either side is NaN,
  // which would strand the user on a record that can never be classified.
  const legacy = { at: ago(5), source: 'Fidelity' };
  const existing = { Fidelity: { at: 'corrupt', label: 'Fidelity', via: 'sync' } };
  assert.equal(migrateSyncMeta(legacy, existing).Fidelity.at, legacy.at);
});

test('an unreadable legacy timestamp is dropped rather than stored', () => {
  const sources = migrateSyncMeta({ at: 'corrupt', source: 'Fidelity' }, {});
  assert.deepEqual(sources, {});
});

test('migration collapses per-file CSV labels onto one source', () => {
  const sources = migrateSyncMeta({ at: ago(3), source: 'CSV import — march.csv' }, {});
  assert.deepEqual(Object.keys(sources), ['CSV import']);
  assert.equal(sources['CSV import'].label, 'CSV import — march.csv',
    'the full label is still shown to the user');
});

test('a legacy record with no source name is still preserved', () => {
  const sources = migrateSyncMeta({ at: ago(3), source: null }, {});
  assert.deepEqual(Object.keys(sources), ['Previous sync']);
});

test('migration leaves unrelated sources untouched and does not mutate input', () => {
  const existing = { SnapTrade: { at: ago(1), label: 'SnapTrade', via: 'sync' } };
  const snapshot = JSON.parse(JSON.stringify(existing));
  const sources = migrateSyncMeta({ at: ago(4), source: 'Fidelity' }, existing);
  assert.deepEqual(Object.keys(sources).sort(), ['Fidelity', 'SnapTrade']);
  assert.deepEqual(existing, snapshot, 'the caller\'s object must not be mutated');
});

test('migration with nothing to migrate is a no-op', () => {
  assert.deepEqual(migrateSyncMeta(null, null), {});
  assert.deepEqual(migrateSyncMeta({ at: null, source: null }, {}), {});
});

/* ------------------------------------------------------------ newest source */

test('latestSource picks the most recently updated record', () => {
  const sources = {
    'CSV import': { at: ago(200 * 24), label: 'CSV import — march.csv', via: 'sync' },
    'Manual entry': { at: ago(1), label: 'Manual entry', via: 'sync' },
    SnapTrade: { at: ago(50 * 24), label: 'SnapTrade', via: 'sync' },
  };
  const newest = latestSource(sources);
  assert.equal(newest.id, 'Manual entry');
  assert.equal(newest.record.label, 'Manual entry');
});

test('a stale historical source does not warn once a newer one exists', () => {
  // Holdings are one flat symbol -> shares map, so an old CSV import that was
  // long since superseded by hand edits describes nothing on screen. Warning
  // about it would be a permanent, undismissable false positive.
  const sources = {
    'CSV import': { at: ago(200 * 24), label: 'CSV import — march.csv', via: 'sync' },
    'Manual entry': { at: ago(1), label: 'Manual entry', via: 'sync' },
  };
  const newest = latestSource(sources);
  const level = classifyFreshness({
    at: newest.record.at, now: NOW, cadenceHours: 92 * 24,
  }).level;
  assert.equal(isConcerning(level), false);
});

test('latestSource ignores records with unreadable timestamps', () => {
  const sources = {
    Broken: { at: 'corrupt', label: 'Broken', via: 'sync' },
    Good: { at: ago(5), label: 'Good', via: 'sync' },
  };
  assert.equal(latestSource(sources).id, 'Good');
});

test('latestSource returns null when there is nothing usable', () => {
  assert.equal(latestSource({}), null);
  assert.equal(latestSource(null), null);
  assert.equal(latestSource(undefined), null);
  assert.equal(latestSource({ Broken: { at: 'corrupt' } }), null);
  assert.equal(latestSource({ Empty: { label: 'Empty' } }), null);
});

/* ------------------------------------------------------- generatedAt parsing */

test('generatedAt parses the ISO form', () => {
  const parsed = parseGeneratedAt('2026-03-01T12:00:00Z');
  assert.equal(parsed.getTime(), NOW.getTime());
});

test('generatedAt parses the Python build\'s local MM/DD/YYYY form', () => {
  // build.py writes a local-time string, not ISO. Parsing it is
  // implementation-defined, so this must work regardless of engine support.
  const parsed = parseGeneratedAt('03/01/2026 07:30:00');
  assert.ok(parsed instanceof Date && !Number.isNaN(parsed.getTime()));
  assert.equal(parsed.getFullYear(), 2026);
  assert.equal(parsed.getMonth(), 2, 'March is month index 2');
  assert.equal(parsed.getDate(), 1);
  assert.equal(parsed.getHours(), 7);
  assert.equal(parsed.getMinutes(), 30);
});

test('generatedAt tolerates a single-digit month and a missing seconds field', () => {
  const parsed = parseGeneratedAt('3/1/2026 7:05');
  assert.equal(parsed.getMonth(), 2);
  assert.equal(parsed.getDate(), 1);
  assert.equal(parsed.getHours(), 7);
  assert.equal(parsed.getSeconds(), 0);
});

test('generatedAt returns null for missing or junk values', () => {
  for (const bad of [null, undefined, '', '   ', 'sometime last week']) {
    assert.equal(parseGeneratedAt(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test('generatedAt passes a Date straight through', () => {
  assert.equal(parseGeneratedAt(NOW), NOW);
});

test('a stale MM/DD/YYYY build is classified as stale end to end', () => {
  // The whole point of the pair: parse the real on-disk format, then judge it.
  const built = parseGeneratedAt('02/25/2026 06:00:00');
  const result = classifyFreshness({ at: built, now: NOW, cadenceHours: 24 });
  assert.equal(result.level, 'critical');
});

test('a present but unparseable build time must not degrade to a silent state', () => {
  // parseGeneratedAt returns null for junk. Feeding that null straight into
  // classifyFreshness yields "never", which does not warn — so a build.py
  // format change would render as perfectly healthy. The caller must convert a
  // failed parse of a *present* value into an explicit broken reason.
  const raw = 'sometime last Tuesday';
  const parsed = parseGeneratedAt(raw);
  assert.equal(parsed, null);
  assert.equal(isConcerning(classifyFreshness({ at: parsed, now: NOW }).level), false,
    'guarding the trap this test exists to prevent');

  const guarded = classifyFreshness({
    at: parsed,
    now: NOW,
    brokenReason: parsed ? null : `data.json has an unreadable build time (${raw}).`,
  });
  assert.equal(guarded.level, 'broken');
  assert.equal(isConcerning(guarded.level), true);
});

/* ------------------------------------------------------------- age wording */

test('age wording scales with magnitude', () => {
  assert.equal(describeAgeHours(0.2), 'just now');
  assert.equal(describeAgeHours(1.5), 'an hour ago');
  assert.equal(describeAgeHours(30), '30 hours ago');
  assert.equal(describeAgeHours(24 * 5), '5 days ago');
  assert.equal(describeAgeHours(24 * 21), '3 weeks ago');
  assert.equal(describeAgeHours(24 * 90), '3 months ago');
});

test('age wording handles an unknown age', () => {
  assert.equal(describeAgeHours(null), 'unknown');
  assert.equal(describeAgeHours(undefined), 'unknown');
});
