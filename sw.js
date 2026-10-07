// swiiifz — Service Worker that serves a static IIIF tree out of a zip file
// using HTTP Range requests. Paths are relative to the worker's scope, so the
// same file works at https://host/ and at https://user.github.io/repo/.
//
//   request  <scope>5l69cr5dp7/page-001/full/295,439/0/default.jpg
//   zip      <scope>zip/5l69cr5dp7.zip
//   entry    5l69cr5dp7/page-001/full/295,439/0/default.jpg
//
// Zips must be written with stored entries (zip -0 -X) for images; deflated
// entries (e.g. JSON) are inflated with DecompressionStream. No ZIP64.

const SCOPE = new URL(self.registration.scope).pathname; // e.g. "/swiiifz/"
const ZIP_DIR = 'zip'; // zips live in <scope>zip/<id>.zip
const MAX_EOCD = 22 + 0xffff; // EOCD record + max comment length
const LOCAL_SLACK = 1024; // guess for local-header extra field, saves a request
const MAX_OPEN = 32; // LRU of open zip indexes

/** id -> Promise<{ url, etag, entries: Map<name, entry> } | null> */
const zips = new Map();

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET') return;
    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return;
    if (!url.pathname.startsWith(SCOPE)) return;

    // Virtual paths are <scope><id>/<something>; everything else is a real file.
    const path = decodeURIComponent(url.pathname.slice(SCOPE.length));
    const slash = path.indexOf('/');
    if (slash <= 0) return;
    const id = path.slice(0, slash);
    if (id === ZIP_DIR) return; // never intercept the zips themselves

    event.respondWith(serve(id, path, request));
});

async function serve(id, path, request) {
    for (let attempt = 0; attempt < 2; attempt++) {
        const zip = await open(id);
        if (!zip) return fetch(request); // no zip for this id: plain network
        const entry = zip.entries.get(path) ?? zip.entries.get(path.replace(/\/$/, '') + '/index.html');
        if (!entry) return new Response('Not found in zip', { status: 404 });
        try {
            const body = await readEntry(zip, entry);
            return new Response(body, {
                headers: {
                    'content-type': mime(entry.name),
                    'content-length': String(body.byteLength),
                    'x-served-from': `${zip.url}#${entry.name}`,
                },
            });
        } catch (error) {
            if (!(error instanceof StaleZip)) throw error;
            zips.delete(id); // zip replaced on server: reopen and retry once
        }
    }
    return new Response('Zip changed while reading', { status: 503 });
}

function open(id) {
    let promise = zips.get(id);
    if (promise) {
        zips.delete(id); // re-insert = most recently used
    } else {
        promise = openZip(`${SCOPE}${ZIP_DIR}/${encodeURIComponent(id)}.zip`).catch((error) => {
            console.error(`[sw] cannot open zip for ${id}`, error);
            return null;
        });
    }
    zips.set(id, promise);
    while (zips.size > MAX_OPEN) zips.delete(zips.keys().next().value);
    return promise;
}

class StaleZip extends Error {}

async function range(url, start, end, etag) {
    const headers = { range: end === undefined ? `bytes=-${start}` : `bytes=${start}-${end}` };
    if (etag) headers['if-range'] = etag;
    const response = await fetch(url, { headers, cache: 'no-store' });
    if (response.status === 404) return null;
    if (response.status === 200 && etag) throw new StaleZip();
    if (response.status !== 206) throw new Error(`${url}: expected 206, got ${response.status}`);
    return response;
}

async function openZip(url) {
    // 1) tail of file -> End Of Central Directory record
    const tailResponse = await range(url, MAX_EOCD);
    if (!tailResponse) return null;
    const etag = tailResponse.headers.get('etag');
    const tail = new DataView(await tailResponse.arrayBuffer());
    let eocd = -1;
    for (let i = tail.byteLength - 22; i >= 0; i--) {
        if (tail.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error(`${url}: not a zip`);
    const count = tail.getUint16(eocd + 10, true);
    const cdSize = tail.getUint32(eocd + 12, true);
    const cdOffset = tail.getUint32(eocd + 16, true);
    if (count === 0xffff || cdOffset === 0xffffffff) throw new Error(`${url}: ZIP64 not supported`);

    // 2) central directory -> name -> {offset, size, method}
    const cdResponse = await range(url, cdOffset, cdOffset + cdSize - 1, etag);
    const cd = new DataView(await cdResponse.arrayBuffer());
    const decoder = new TextDecoder();
    const entries = new Map();
    for (let p = 0, n = 0; n < count; n++) {
        if (cd.getUint32(p, true) !== 0x02014b50) throw new Error(`${url}: bad central directory`);
        const nameLength = cd.getUint16(p + 28, true);
        const name = decoder.decode(new Uint8Array(cd.buffer, p + 46, nameLength));
        // skip directory entries, or "<id>/" would match one instead of <id>/index.html
        if (!name.endsWith('/')) entries.set(name, {
            name,
            method: cd.getUint16(p + 10, true),
            compressedSize: cd.getUint32(p + 20, true),
            localOffset: cd.getUint32(p + 42, true),
            nameLength,
        });
        p += 46 + nameLength + cd.getUint16(p + 30, true) + cd.getUint16(p + 32, true);
    }
    console.info(`[sw] opened ${url}: ${entries.size} entries`);
    return { url, etag, entries };
}

async function readEntry(zip, entry) {
    // 3) local header + data in one request (header's extra field length is unknown up front)
    const start = entry.localOffset;
    const guess = 30 + entry.nameLength + LOCAL_SLACK + entry.compressedSize;
    let buffer = await (await range(zip.url, start, start + guess - 1, zip.etag)).arrayBuffer();
    const header = new DataView(buffer);
    if (header.getUint32(0, true) !== 0x04034b50) throw new Error(`${zip.url}: bad local header`);
    const dataStart = 30 + header.getUint16(26, true) + header.getUint16(28, true);
    if (dataStart + entry.compressedSize > buffer.byteLength) {
        buffer = await (await range(zip.url, start + dataStart, start + dataStart + entry.compressedSize - 1, zip.etag)).arrayBuffer();
        return inflate(new Uint8Array(buffer), entry);
    }
    return inflate(new Uint8Array(buffer, dataStart, entry.compressedSize), entry);
}

async function inflate(data, entry) {
    if (entry.method === 0) return data;
    if (entry.method === 8) {
        const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        return new Uint8Array(await new Response(stream).arrayBuffer());
    }
    throw new Error(`${entry.name}: unsupported compression method ${entry.method}`);
}

function mime(name) {
    const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
    return {
        json: 'application/json',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        png: 'image/png',
        webp: 'image/webp',
        tif: 'image/tiff',
        jp2: 'image/jp2',
        html: 'text/html; charset=utf-8',
        txt: 'text/plain; charset=utf-8',
    }[ext] ?? 'application/octet-stream';
}
