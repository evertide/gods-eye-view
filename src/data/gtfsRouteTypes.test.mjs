import test from 'node:test';
import assert from 'node:assert/strict';
import { gtfsRouteTypeToMode, parseRoutesTxt, splitCsvLine } from './gtfsRouteTypes.js';

test('the classic route types map to their modes, and an unknown one is not guessed', () => {
  assert.equal(gtfsRouteTypeToMode('0'), 'tram');
  assert.equal(gtfsRouteTypeToMode('1'), 'subway');
  assert.equal(gtfsRouteTypeToMode('2'), 'rail');
  assert.equal(gtfsRouteTypeToMode('3'), 'bus');
  assert.equal(gtfsRouteTypeToMode('4'), 'ferry');
  assert.equal(gtfsRouteTypeToMode('6'), 'unknown');
  assert.equal(gtfsRouteTypeToMode('8'), 'unknown');
});

test('extended route types are ranges, not values', () => {
  assert.equal(gtfsRouteTypeToMode('109'), 'rail');
  assert.equal(gtfsRouteTypeToMode('401'), 'subway');
  assert.equal(gtfsRouteTypeToMode('715'), 'bus');
  assert.equal(gtfsRouteTypeToMode('900'), 'tram');
  assert.equal(gtfsRouteTypeToMode('1200'), 'ferry');
  // Just outside each range must NOT inherit it.
  assert.equal(gtfsRouteTypeToMode('406'), 'unknown');
  assert.equal(gtfsRouteTypeToMode('1201'), 'unknown');
});

test('a non-numeric or negative type is unknown rather than a default', () => {
  for (const bad of ['', 'bus', '-1', '3.5', null, undefined]) {
    assert.equal(gtfsRouteTypeToMode(bad), 'unknown', `${bad} must not resolve`);
  }
});

test('quoted commas stay inside their field', () => {
  assert.deepEqual(splitCsvLine('a,"b,c",d'), ['a', 'b,c', 'd']);
  assert.deepEqual(splitCsvLine('a,b,c'), ['a', 'b', 'c']);
  assert.deepEqual(splitCsvLine('a,"say ""hi""",c'), ['a', 'say "hi"', 'c']);
});

test('columns are located by header, not by position', () => {
  // route_type before route_id: a positional parser silently inverts these.
  const table = parseRoutesTxt('route_type,agency_id,route_id\n1,RET,152915\n3,GVB,152351\n');
  assert.equal(table.get('152915'), 'subway');
  assert.equal(table.get('152351'), 'bus');
});

test('a real-shaped row parses, and a row missing either column is skipped', () => {
  const table = parseRoutesTxt([
    'route_id,agency_id,route_short_name,route_long_name,route_type',
    '152915,RET,E,"Den Haag Centraal, Slinge",1',
    ',RET,X,orphan,1',
    '152351,GVB,38,,3',
  ].join('\n'));
  assert.equal(table.get('152915'), 'subway', 'a quoted long name must not shift the type column');
  assert.equal(table.get('152351'), 'bus');
  assert.equal(table.size, 2, 'the row with no route_id is skipped, not defaulted');
});

test('a route whose type resolves to unknown is left out entirely', () => {
  // Absent from the table means "use the feed default", which is the correct
  // answer for a type this app has no colour for.
  const table = parseRoutesTxt('route_id,route_type\nA,6\nB,1\n');
  assert.equal(table.has('A'), false);
  assert.equal(table.get('B'), 'subway');
});

test('a header without the needed columns yields an empty table, not a throw', () => {
  assert.equal(parseRoutesTxt('foo,bar\n1,2\n').size, 0);
  assert.equal(parseRoutesTxt('').size, 0);
  assert.equal(parseRoutesTxt(null).size, 0);
});
