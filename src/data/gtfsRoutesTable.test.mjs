import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchGtfsRouteModes } from './gtfsRoutesTable.js';

const ROUTES = 'route_id,agency_id,route_type\n152915,RET,1\n152351,GVB,3\n';

/**
 * Build a minimal ZIP holding one STORED (uncompressed) member, with a local
 * header whose extra field is a different length from the central directory's —
 * the case that makes a reader land mid-file if it trusts the wrong copy.
 */
function buildZip(name, content, { localExtra = 4, comment = '' } = {}) {
  const enc = new TextEncoder();
  const nameBytes = enc.encode(name);
  const data = enc.encode(content);
  const put = (arr, off, ...vals) => vals.forEach((v, i) => arr[off + i] = v);
  const u16 = (n) => [n & 0xff, (n >> 8) & 0xff];
  const u32 = (n) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];

  const local = [
    ...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
    ...u32(0), ...u32(data.length), ...u32(data.length),
    ...u16(nameBytes.length), ...u16(localExtra),
    ...nameBytes, ...new Array(localExtra).fill(0), ...data,
  ];
  const central = [
    ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
    ...u32(0), ...u32(data.length), ...u32(data.length),
    ...u16(nameBytes.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0),
    ...u32(0), ...nameBytes,
  ];
  const eocd = [
    ...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(1), ...u16(1),
    ...u32(central.length), ...u32(local.length), ...u16(comment.length),
    ...enc.encode(comment),
  ];
  void put;
  return new Uint8Array([...local, ...central, ...eocd]);
}

/** A fetch that honours Range over an in-memory buffer. */
function servingZip(zip, { rangeStatus = 206 } = {}) {
  const calls = [];
  const impl = async (url, init = {}) => {
    if (init.method === 'HEAD') {
      return { status: 200, headers: new Headers({ 'content-length': String(zip.length) }) };
    }
    const m = /bytes=(\d+)-(\d+)/.exec(init.headers?.Range || '');
    calls.push(init.headers?.Range);
    const slice = zip.slice(Number(m[1]), Number(m[2]) + 1);
    return { status: rangeStatus, arrayBuffer: async () => slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength) };
  };
  impl.calls = calls;
  return impl;
}

test('routes.txt is read out of the archive without downloading it whole', async () => {
  const zip = buildZip('routes.txt', ROUTES);
  const fetchImpl = servingZip(zip);
  const table = await fetchGtfsRouteModes('https://example.test/gtfs.zip', { fetchImpl });

  assert.equal(table.get('152915'), 'subway');
  assert.equal(table.get('152351'), 'bus');
  // Four ranged reads at most: tail, central directory, local header, member.
  assert.ok(fetchImpl.calls.length <= 4, `expected at most 4 ranged reads, got ${fetchImpl.calls.length}`);
});

test('a member nested in a folder is still found', async () => {
  const zip = buildZip('gtfs-nl/routes.txt', ROUTES);
  const table = await fetchGtfsRouteModes('https://example.test/gtfs.zip', { fetchImpl: servingZip(zip) });
  assert.equal(table.get('152915'), 'subway');
});

test("the local header's own extra length is what locates the data", async () => {
  // Central says extra=0, local says extra=64. Trusting the central copy here
  // starts the read 64 bytes early and the CSV parses to nothing.
  const table = await fetchGtfsRouteModes('https://example.test/gtfs.zip', {
    fetchImpl: servingZip(buildZip('routes.txt', ROUTES, { localExtra: 64 })),
  });
  assert.equal(table.get('152915'), 'subway');
});

test('an archive comment does not hide the end-of-directory record', async () => {
  const table = await fetchGtfsRouteModes('https://example.test/gtfs.zip', {
    fetchImpl: servingZip(buildZip('routes.txt', ROUTES, { comment: 'built by a tool that adds comments' })),
  });
  assert.equal(table.get('152351'), 'bus');
});

test('a server that ignores Range yields an empty table rather than garbage', async () => {
  const table = await fetchGtfsRouteModes('https://example.test/gtfs.zip', {
    fetchImpl: servingZip(buildZip('routes.txt', ROUTES), { rangeStatus: 200 }),
  });
  assert.equal(table.size, 0);
});

test('a missing member, a broken archive and a dead host all resolve to empty', async () => {
  const noMember = await fetchGtfsRouteModes('https://example.test/gtfs.zip', {
    fetchImpl: servingZip(buildZip('agency.txt', 'agency_id\nRET\n')),
  });
  assert.equal(noMember.size, 0);

  const notAZip = await fetchGtfsRouteModes('https://example.test/gtfs.zip', {
    fetchImpl: servingZip(new Uint8Array(200)),
  });
  assert.equal(notAZip.size, 0);

  const dead = await fetchGtfsRouteModes('https://example.test/gtfs.zip', {
    fetchImpl: async () => { throw new Error('network down'); },
  });
  assert.equal(dead.size, 0);
});
