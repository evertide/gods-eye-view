/**
 * Toponym normalisation shared by every keyless geocoder adapter.
 *
 * Lives in its own module so an adapter can use it without importing the
 * module that composes the adapters, which would be a cycle.
 * @param {string} text
 * @returns {string}
 */
export function normalizeToponym(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
