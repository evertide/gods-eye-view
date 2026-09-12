import test from 'node:test';
import assert from 'node:assert/strict';
import {
  pdokLabelAnswers, queryNamesAHouseNumber, shouldAskPdok,
  parseCentroid, normalizePdokDoc, selectPdokDoc, geocodePdokWithOutcome,
} from './pdokGeocoder.js';

const doc = (weergavenaam, type, ll = 'POINT(4.3873 51.9987)') =>
  ({ weergavenaam, type, centroide_ll: ll });

test('a whole-word match answers; a longer word merely containing it does not', () => {
  assert.equal(pdokLabelAnswers('A13, Delft', 'A13'), true);
  // The live false positive this rule exists for: PDOK scores this ABOVE
  // Rotterdam, so only word boundaries can separate them.
  assert.equal(pdokLabelAnswers('Los Angelesstraat, Almere', 'Los Angeles'), false);
});

test('every query token must be present, not just the first', () => {
  assert.equal(pdokLabelAnswers('Grote Markt 1, 4611NR Bergen op Zoom', 'Grote Markt 1 Bergen'), true);
  assert.equal(pdokLabelAnswers('Grote Markt, Bergen op Zoom', 'Grote Markt 1 Bergen'), false);
});

test('a bare house number is one; a road number is not', () => {
  assert.equal(queryNamesAHouseNumber('Grote Markt 1 Bergen op Zoom'), true);
  assert.equal(queryNamesAHouseNumber('Rijksweg A13'), false);
});

test('a place query takes the town, an address query takes the address', () => {
  // Both candidates answer the query as whole words, so only the type ranking
  // can separate them — which is the decision under test.
  const docs = [doc('Grote Markt 29, 4611NR Bergen op Zoom', 'adres'),
                doc('Bergen op Zoom, Bergen op Zoom, Noord-Brabant', 'woonplaats')];
  assert.equal(selectPdokDoc(docs, 'Bergen op Zoom').type, 'woonplaats');

  const addr = [doc('Grote Markt, Bergen op Zoom', 'weg'),
                doc('Grote Markt 1, 4611NR Bergen op Zoom', 'adres')];
  assert.equal(selectPdokDoc(addr, 'Grote Markt 1 Bergen op Zoom').type, 'adres');
});

test('nothing that fails the word test is ever selected', () => {
  assert.equal(selectPdokDoc([doc('Los Angelesstraat, Almere', 'weg')], 'Los Angeles'), null);
});

test('the gate opens for a road number and for a house number', () => {
  assert.equal(shouldAskPdok('A13'), true);
  assert.equal(shouldAskPdok('N470'), true);
  assert.equal(shouldAskPdok('Rijksweg A13'), true);
  assert.equal(shouldAskPdok('Grote Markt 1 Bergen op Zoom'), true);
});

test('the gate stays shut for bare place names, Dutch and foreign alike', () => {
  // Photon already resolves these. Letting PDOK answer them is what produced
  // "Hof van Brussel, Doetinchem" for Brussel — a whole-word match on a real
  // Dutch street, which the word-boundary rule cannot catch.
  for (const q of ['Rotterdam', 'Bergen op Zoom', 'Brussel', 'Bruxelles', 'Antwerpen', 'Brugge', 'Gent']) {
    assert.equal(shouldAskPdok(q), false, `gate must stay shut for ${q}`);
  }
});

test('a foreign road-shaped token does not open the gate', () => {
  assert.equal(shouldAskPdok('E19'), false);
  assert.equal(shouldAskPdok('Sixth Street'), false);
});

test('a centroid parses to lat/lng in the right order, and rubbish parses to null', () => {
  assert.deepEqual(parseCentroid('POINT(4.3873 51.9987)'), { lat: 51.9987, lng: 4.3873 });
  assert.equal(parseCentroid('POINT(999 999)'), null);
  assert.equal(parseCentroid(''), null);
});

test('a document without a usable centroid yields null, never a half-built place', () => {
  assert.equal(normalizePdokDoc(doc('A13, Delft', 'weg', 'geen punt')), null);
  const p = normalizePdokDoc(doc('A13, Delft', 'weg'));
  assert.equal(p.name, 'A13');
  assert.equal(p.label, 'A13, Delft');
  assert.deepEqual(p.types, ['route']);
  assert.equal(p.viewport, null);
});

test('an HTTP refusal is silence, an empty result is an answer', async () => {
  const refuse = async () => ({ ok: false, json: async () => ({}) });
  assert.deepEqual(await geocodePdokWithOutcome('Rotterdam refusal probe', { fetchImpl: refuse }),
    { place: null, answered: false });

  const empty = async () => ({ ok: true, json: async () => ({ response: { docs: [] } }) });
  assert.deepEqual(await geocodePdokWithOutcome('Tokyo empty probe', { fetchImpl: empty }),
    { place: null, answered: true });
});

test('a thrown request is silence too, so the next attempt really retries', async () => {
  let calls = 0;
  const boom = async () => { calls += 1; throw new Error('network down'); };
  assert.equal((await geocodePdokWithOutcome('Delft boom probe', { fetchImpl: boom })).answered, false);
  await geocodePdokWithOutcome('Delft boom probe', { fetchImpl: boom });
  assert.equal(calls, 2, 'an unanswered lookup must not be memoised');
});

test('an answered lookup is memoised, misses included', async () => {
  let calls = 0;
  const once = async () => {
    calls += 1;
    return { ok: true, json: async () => ({ response: { docs: [doc('A13, Delft', 'weg')] } }) };
  };
  const first = await geocodePdokWithOutcome('A13 memo probe', { fetchImpl: once });
  const second = await geocodePdokWithOutcome('A13 memo probe', { fetchImpl: once });
  assert.equal(calls, 1);
  assert.deepEqual(second.place, first.place);
});
