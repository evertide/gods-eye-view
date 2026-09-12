/**
 * PDOK Locatieserver adapter — the Dutch national gazetteer (BAG/BRT/NWB).
 *
 * Why this sits AHEAD of Photon rather than beside it: Photon cannot resolve
 * Dutch motorways at all. Measured 2026-09-11, "A13" returned a road in
 * Newburyport, Massachusetts and "Rijksweg A13" returned the A15 near
 * Opheusden — the wrong motorway, in the right country, which is worse than a
 * miss. PDOK answers both with the A13 at Delft. For a user watching their own
 * motorway that is the difference between the feature working and not.
 *
 * Keyless, no signup, no quota published — it is open data on fair use, so
 * results are memoised and the caller is expected not to poll.
 */
import { normalizeToponym } from './toponym.js';

const PDOK_ENDPOINT = 'https://api.pdok.nl/bzk/locatieserver/search/v3_1/free';
const PDOK_TIMEOUT_MS = 6000;
const PDOK_ROWS = 5;
const PDOK_CACHE_MAX = 64;

/** PDOK `type` → the Google-style type vocabulary the callers already read. */
const PDOK_TYPE_TO_GOOGLE = Object.freeze({
  adres: ['street_address'],
  postcode: ['postal_code'],
  weg: ['route'],
  woonplaats: ['locality'],
  gemeente: ['administrative_area_level_2'],
  provincie: ['administrative_area_level_1'],
  waterschapsgrens: ['natural_feature'],
});

/**
 * Which type answers best depends on the QUERY, not on a fixed idea of
 * specificity. Asked for "Bergen op Zoom" the town is the answer and the
 * street `Bergen op Zoomstraat 29` is not, even though an address is the more
 * precise record; asked for "Grote Markt 1" the address is. The presence of
 * a bare house number in the query is what separates the two.
 */
const PDOK_RANK_PLACE = Object.freeze(['woonplaats', 'gemeente', 'weg', 'provincie', 'postcode', 'adres']);
const PDOK_RANK_ADDRESS = Object.freeze(['adres', 'postcode', 'weg', 'woonplaats', 'gemeente', 'provincie']);

/** `A13`, `N470` — a Dutch motorway or provincial road number. */
const DUTCH_ROAD = /^[an]\d{1,3}$/;

const pdokCache = new Map();

function trimPdokCache() {
  while (pdokCache.size > PDOK_CACHE_MAX) {
    pdokCache.delete(pdokCache.keys().next().value);
  }
}

/**
 * Request URL for one free-text lookup.
 * @param {string} query
 * @param {{rows?: number}} [options]
 * @returns {string}
 */
export function pdokSearchUrl(query, { rows = PDOK_ROWS } = {}) {
  const url = new URL(PDOK_ENDPOINT);
  url.searchParams.set('q', String(query ?? ''));
  url.searchParams.set('rows', String(rows));
  url.searchParams.set('fl', 'weergavenaam,type,centroide_ll');
  return url.toString();
}

/**
 * `POINT(lon lat)` → `{lat, lng}`; null when the WKT is absent or unparseable.
 * @param {string} wkt
 * @returns {?{lat: number, lng: number}}
 */
export function parseCentroid(wkt) {
  const m = /^POINT\(\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\)$/.exec(String(wkt ?? '').trim());
  if (!m) return null;
  const lng = Number(m[1]);
  const lat = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

/**
 * Does `label` answer `query`?
 *
 * Every token of the query must appear in the label as a WHOLE word. Substring
 * matching is not enough and the failure it causes is not hypothetical: PDOK
 * answers "Los Angeles" with "Los Angelesstraat, Almere" — scoring 12.02 where
 * Rotterdam scores 9.28, so score cannot separate them either. "angeles" is not
 * a whole word in "angelesstraat", so the whole-word rule rejects it and the
 * query falls through to Photon, which knows about California.
 * @param {string} label - PDOK `weergavenaam`.
 * @param {string} query - The user's raw query.
 * @returns {boolean}
 */
export function pdokLabelAnswers(label, query) {
  const tokens = normalizeToponym(query).split(' ').filter(Boolean);
  if (!tokens.length) return false;
  const haystack = ` ${normalizeToponym(label)} `;
  return tokens.every((t) => haystack.includes(` ${t} `));
}

/**
 * One PDOK document → the place shape every caller already consumes.
 * @param {object} doc
 * @returns {?{lat:number, lng:number, name:string, label:string, types:string[], viewport:?object}}
 */
export function normalizePdokDoc(doc) {
  const point = parseCentroid(doc?.centroide_ll);
  if (!point) return null;
  const label = String(doc.weergavenaam || '');
  return {
    lat: point.lat,
    lng: point.lng,
    name: label.split(',')[0].trim() || label,
    label,
    types: PDOK_TYPE_TO_GOOGLE[doc.type] || [],
    // PDOK's free endpoint returns a centroid, never an extent. Null is the
    // documented "no viewport" value, so the camera keeps its own framing
    // instead of being handed a box this source cannot honestly supply.
    viewport: null,
  };
}

/**
 * Pick the document that answers the query, preferring the most specific type.
 * @param {object[]} docs
 * @param {string} query
 * @returns {?object}
 */
export function selectPdokDoc(docs, query) {
  const answering = (docs || []).filter((d) => pdokLabelAnswers(d?.weergavenaam, query));
  if (!answering.length) return null;
  const order = queryNamesAHouseNumber(query) ? PDOK_RANK_ADDRESS : PDOK_RANK_PLACE;
  const rank = (d) => {
    const i = order.indexOf(d?.type);
    return i === -1 ? order.length : i;
  };
  // Stable: equal ranks keep PDOK's own relevance order.
  return answering.reduce((best, d) => (rank(d) < rank(best) ? d : best), answering[0]);
}

/**
 * Does the query carry a bare house number, e.g. "Grote Markt 1"?
 * A road number like `A13` is one token of letters and digits, not a bare
 * number, so it does not count — which is why "Rijksweg A13" resolves to the
 * motorway and not to `Rijksweg A13 200`.
 * @param {string} query
 * @returns {boolean}
 */
export function queryNamesAHouseNumber(query) {
  return normalizeToponym(query).split(' ').some((t) => /^\d{1,5}[a-z]?$/.test(t));
}

/**
 * Is this lookup worth asking a Dutch-only gazetteer about?
 *
 * Only for the two query shapes PDOK was measured to answer better than the
 * global source: a Dutch road number, and a street with a house number.
 *
 * Photon already resolves Dutch towns correctly, so sending bare place names
 * here buys nothing and costs correctness. Asked for "Brussel" PDOK answers
 * "Hof van Brussel, Doetinchem" — a real Dutch street in which "Brussel" is a
 * whole word, so the word-boundary rule cannot catch it. "Antwerpen", "Brugge"
 * and "Bruxelles" all fail the same way. Narrow beats clever: ask only where
 * the gap was actually measured.
 * @param {string} query
 * @returns {boolean}
 */
export function shouldAskPdok(query) {
  return normalizeToponym(query).split(' ').some(
    (t) => DUTCH_ROAD.test(t) || /^\d{1,5}[a-z]?$/.test(t),
  );
}

/**
 * Geocode through PDOK. Never throws.
 *
 * `answered:false` means the request itself did not come back, which the caller
 * must not cache as a miss; `place:null` with `answered:true` is a real "this
 * is not a Dutch place", and the caller should try the global source next.
 * @param {string} query
 * @param {{fetchImpl?: Function}} [options]
 * @returns {Promise<{place: ?object, answered: boolean}>}
 */
export async function geocodePdokWithOutcome(query, { fetchImpl = fetch } = {}) {
  const trimmed = String(query ?? '').trim();
  if (!trimmed) return { place: null, answered: true };
  if (pdokCache.has(trimmed)) return { place: pdokCache.get(trimmed), answered: true };

  let docs;
  try {
    const response = await fetchImpl(pdokSearchUrl(trimmed), {
      signal: AbortSignal.timeout(PDOK_TIMEOUT_MS),
    });
    if (!response.ok) return { place: null, answered: false };
    docs = (await response.json())?.response?.docs || [];
  } catch {
    return { place: null, answered: false };
  }

  const place = normalizePdokDoc(selectPdokDoc(docs, trimmed));
  pdokCache.set(trimmed, place);
  trimPdokCache();
  return { place, answered: true };
}
