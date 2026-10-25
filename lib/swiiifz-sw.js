// swiiifz — Service Worker core: serves files out of any zip file using HTTP
// Range requests, under virtual URLs that carry the zip's address:
//
//   request  <scope>swiiifz/<base64url(zip url)>/5l69cr5dp7/page-001/info.json
//   zip      https://any.host/any/path/archive.zip
//   entry    5l69cr5dp7/page-001/info.json
//
// The mapping is stateless (no registry), so it survives the worker being
// stopped and restarted. A request for the bare mount, <scope>swiiifz/<b64>/,
// returns {zip, entries} as JSON; lib/swiiifz.js uses it to find the manifest.
//
// Use it from a same-origin worker script (a worker can't be registered from
// another origin, but it can import one):
//
//   // sw.js
//   importScripts('https://cdn.example/swiiifz/lib/swiiifz-sw.js');
//
// Importing it installs the fetch listener; other listeners in the same worker
// keep working, since this one only answers <scope>swiiifz/… requests.
//
// Zips must be written with stored entries (zip -0 -X) for images; deflated
// entries (e.g. JSON) are inflated with DecompressionStream. No ZIP64.
// A zip on another origin must allow CORS for Range/If-Range and expose
// ETag and Content-Range.
//
// JSON and HTML entries have their absolute URLs rewritten to the mount: any
// "http(s)://<whatever>/<id>" (where <id> is the entry's top-level directory)
// becomes "<mount><id>", so a zip built with mkiiif -base https://a.example/x
// works wherever it is mounted.

(() => {
    const PREFIX = 'swiiifz/'; // virtual URLs live under <scope>swiiifz/
    const MAX_EOCD = 22 + 0xffff; // EOCD record + max comment length
    const LOCAL_SLACK = 1024; // guess for local-header extra field, saves a request
    const MAX_OPEN = 32; // LRU of open zip indexes

    const BASE = new URL(PREFIX, self.registration.scope).href; // e.g. "https://host/app/swiiifz/"

    /** zip url -> Promise<{ url, etag, entries: Map<name, entry> } | null> */
    const zips = new Map();

    self.addEventListener('install', () => self.skipWaiting());
    self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

    self.addEventListener('fetch', (event) => {
        const response = handle(event.request);
        if (response) event.respondWith(response);
    });

    /** Returns a Response promise for swiiifz URLs, undefined for anything else. */
    function handle(request) {
        if (request.method !== 'GET') return;
        const href = request.url.split(/[?#]/)[0];
        if (!href.startsWith(BASE)) return;

        // <b64>/<entry path>
        const rest = href.slice(BASE.length);
        const slash = rest.indexOf('/');
        if (slash <= 0) return;
        let zipUrl;
        try {
            zipUrl = decodeZipUrl(rest.slice(0, slash));
        } catch {
            return Promise.resolve(new Response('Bad swiiifz mount', { status: 400 }));
        }
        const mount = BASE + rest.slice(0, slash + 1);
        const path = decodeURIComponent(rest.slice(slash + 1));
        return serve(zipUrl, mount, path);
    }

    async function serve(zipUrl, mount, path) {
        for (let attempt = 0; attempt < 2; attempt++) {
            const zip = await open(zipUrl);
            if (!zip) return new Response(`Cannot open ${zipUrl}`, { status: 502 });
            if (path === '') return Response.json({ zip: zip.url, entries: [...zip.entries.keys()] });
            const entry = zip.entries.get(path) ?? zip.entries.get(path.replace(/\/$/, '') + '/index.html');
            if (!entry) return new Response('Not found in zip', { status: 404 });
            try {
                const body = rebase(await readEntry(zip, entry), entry, mount);
                return new Response(body, {
                    headers: {
                        'content-type': mime(entry.name),
                        'content-length': String(body.byteLength),
                        'x-served-from': `${zip.url}#${entry.name}`,
                    },
                });
            } catch (error) {
                if (!(error instanceof StaleZip)) throw error;
                zips.delete(zipUrl); // zip replaced on server: reopen and retry once
            }
        }
        return new Response('Zip changed while reading', { status: 503 });
    }

    function decodeZipUrl(segment) {
        const b64 = segment.replace(/-/g, '+').replace(/_/g, '/');
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        return new URL(new TextDecoder().decode(bytes)).href;
    }

    function open(url) {
        let promise = zips.get(url);
        if (promise) {
            zips.delete(url); // re-insert = most recently used
        } else {
            promise = openZip(url).catch((error) => {
                console.error(`[swiiifz] cannot open ${url}`, error);
                zips.delete(url); // don't cache failures: next request retries
                return null;
            });
        }
        zips.set(url, promise);
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
        console.info(`[swiiifz] opened ${url}: ${entries.size} entries`);
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

    const REBASE_TYPES = /\.(json|html?)$/i;
    const encoder = new TextEncoder();

    // Point absolute URLs ending in /<id> or /<id>/… (whatever base the zip was
    // built with) at the mount, so the viewer's follow-up requests come back here.
    // <id> is the entry's top-level directory; entries at the zip root are left alone.
    function rebase(body, entry, mount) {
        if (!REBASE_TYPES.test(entry.name)) return body;
        const slash = entry.name.indexOf('/');
        if (slash <= 0) return body;
        const id = entry.name.slice(0, slash);
        const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = new RegExp(`https?://[^"'\\s<>]*?/${escaped}(?=[/"'?#<\\s]|$)`, 'g');
        const text = new TextDecoder().decode(body);
        const rebased = text.replace(pattern, mount + id);
        return rebased === text ? body : encoder.encode(rebased);
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

    // For workers that want to call it from their own fetch listener.
    self.swiiifz = { handle };
})();
