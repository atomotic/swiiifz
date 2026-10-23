# swiiifz

> **sw** · **iiif** · **z** = **S**ervice **W**orker · **IIIF** · **Z**ipped
> (pronounced *"swiff-zee"*)

**Static IIIF from a single zip file, served by a Service Worker.**

Demo: <https://atomotic.github.io/swiiifz/>

A IIIF Image API level 0 tree (one `info.json` and thousands of pre-cut tiles per
image) plus its Presentation manifest normally means thousands of small files to
upload, version and keep in sync. swiiifz keeps the whole tree inside **one
uncompressed zip** on any static host, and a ~190-line Service Worker turns it back
into ordinary IIIF URLs in the browser. It reads each file out of the zip with an
HTTP `Range` request.

The viewer and IIIF clients don't know the zip exists. They request
`…/5l69cr5dp7/page-001/info.json` or `…/page-001/0,0,512,512/512,512/0/default.jpg`
like any other IIIF resource, and the worker answers.

No server code, no build step on the host, no index file. You only need a host
that supports `Range` requests (GitHub Pages, S3, R2, nginx, Caddy, …).

The zip is **portable**: it doesn't matter which base URL it was built with. Copy
the `*.html` pages, `boot.js`, `viewer.css`, `sw.js` and `zip/` to any host and path (`https://example.org/`,
`https://example.org/some/dir/`, `http://localhost:8080/swiiifz/`) and it works
there without a rebuild.

## The demo

`zip/5l69cr5dp7.pdf` is *ARCHIVI & COMPUTER. Automazione e beni culturali*,
anno V, fascicolo 1/1995 (106 pages, Direzione generale Archivi). It was converted with
[`mkiiif`](https://github.com/atomotic/iiif/tree/main/cmd/mkiiif)
([blog post](https://literarymachin.es/mkiiif/)) into a IIIF Presentation 3
manifest plus level 0 tiles for every page, then zipped:

| | |
|---|---|
| source PDF | 13 MB |
| IIIF tree | 1910 files, 46 MB |
| `zip/5l69cr5dp7.zip` | **1 file**, 42 MB (stored, no compression) |

`index.html` links one page per viewer, each opening the same manifest through
the Service Worker: [triiiceratops](https://www.npmjs.com/package/triiiceratops)
(`triiiceratops.html`), [Mirador](https://projectmirador.org/) 4 (`mirador.html`),
[Universal Viewer](https://universalviewer.io/) 4 (`uv.html`),
[TIFY](https://tify.rocks/) (`tify.html`),
[Clover IIIF](https://samvera-labs.github.io/clover-iiif/) (`clover.html`) and
[Leaflet-IIIF](https://github.com/mejackreed/Leaflet-IIIF) (`leaflet.html`, Image API
only: the page reads the manifest itself and shows one page at a time).

Open DevTools → Network to watch it work. Every tile shows up twice: once as the
virtual request answered by the Service Worker (response header
`x-served-from: /swiiifz/zip/5l69cr5dp7.zip#<entry>`), and once as the `206 Partial Content`
request the worker sends to the zip.

## How it works

```
browser / viewer                 sw.js                               static host
────────────────                 ─────                               ───────────
GET 5l69cr5dp7/manifest.json ──► first request for id "5l69cr5dp7":
                                   Range: bytes=-65557          ──►  zip/5l69cr5dp7.zip
                                   find End Of Central Directory ◄──  206 (tail of file)
                                   Range: <central directory>   ──►
                                   build Map name → offset/size  ◄──  206
                                 read the entry:
                                   Range: <local header + data> ──►
◄──────────────────── 200 JSON ◄── slice out the bytes           ◄──  206

GET 5l69cr5dp7/page-001/…jpg ──► index already in memory:
                                   Range: <local header + data> ──►
◄──────────────────── 200 JPEG ◄──                               ◄──  206
```

1. **Routing.** The worker is registered with scope `./`. A same-origin GET for
   `<scope><id>/<path>` is treated as entry `<id>/<path>` inside
   `<scope>zip/<id>.zip`. Paths without a slash (`index.html`, `sw.js`) and
   anything under `zip/` go to the network unchanged. If no zip exists for an
   `<id>`, the request also falls through to the network. Because everything is
   relative to the scope, the same files work at a domain root or under
   `/swiiifz/` on GitHub Pages.
2. **Opening a zip** costs 2 requests. The first fetches the last 64 KB to find
   the End Of Central Directory record. The second fetches the central directory
   and parses it into a `Map`. The worker keeps up to 32 open zips in an LRU.
3. **Reading an entry** costs 1 request. The worker fetches the local file header
   and the data in one `Range`, guessing up to 1 KB for the header's extra field.
   A second request is needed only if that guess is too small.
4. **Consistency.** Every read after the first sends `If-Range: <etag>`. If the
   zip was replaced on the server, the host answers `200` instead of `206`. The
   worker then drops its index, reopens the zip and retries once, so it never
   splices bytes from two versions of the zip.
5. **Compression.** Entries should be *stored* (`zip -0`), because JPEG tiles
   don't compress further. Deflated entries still work: the worker inflates
   them with `DecompressionStream('deflate-raw')`.
6. **Portability.** IIIF ids are absolute URLs, so they carry the `-base` the zip
   was built with, and the viewer requests tiles at exactly those URLs. The
   worker only intercepts its own origin, so a zip built for
   `https://atomotic.github.io/swiiifz` would make a copy on another host fetch
   its tiles from GitHub Pages, where they don't exist as files. To avoid this,
   the worker rewrites JSON and HTML entries as it serves them: every
   `http(s)://<anything>/<id>` or `http(s)://<anything>/<id>/…` URL becomes
   `<scope><id>…`, where `<scope>` is the worker's own URL. The manifest,
   `info.json` files and the zip's own viewer page then point back at the host
   that is serving them. Tiles and other binary entries are served untouched.

Once a zip is open, each tile costs one HTTP request of about the tile's size, the
same as serving static tiles.

## Layout

```
index.html            landing page: what this is, links to the viewer pages
triiiceratops.html    the manifest in triiiceratops
mirador.html          the manifest in Mirador 4
uv.html               the manifest in Universal Viewer 4
tify.html             the manifest in TIFY
clover.html           the manifest in Clover IIIF
leaflet.html          the pages' image services in Leaflet-IIIF
boot.js               shared by the pages: registers sw.js, waits until it controls the page
viewer.css            shared layout of the viewer pages
sw.js                 the Service Worker (the whole idea is in this file)
zip/
  5l69cr5dp7.pdf      source document
  5l69cr5dp7.zip      IIIF tree: 5l69cr5dp7/{manifest.json,index.html,page-NNN/…}
justfile              build / serve recipes
Caddyfile             local server that mirrors the GitHub Pages layout (/swiiifz/)
.nojekyll             serve files as-is on GitHub Pages
```

## Build

Requirements: [`mkiiif`](https://github.com/atomotic/iiif/tree/main/cmd/mkiiif)
(see [mkiiif](https://literarymachin.es/mkiiif/) on literarymachin.es; it uses `mutool` to render
the PDF and `vips` ≥ 8.17.1 to cut the tiles), `zip`, and
[`just`](https://github.com/casey/just).

```sh
just build                                   # base https://atomotic.github.io/swiiifz
```

which runs:

```sh
mkiiif -source zip/5l69cr5dp7.pdf -id 5l69cr5dp7 -title "…" \
       -base https://atomotic.github.io/swiiifz -destination build -tiles
cd build && zip -0 -r -q -X -D ../zip/5l69cr5dp7.zip 5l69cr5dp7
```

Requirements for the zip:

- **The top-level folder is the id.** `<id>.zip` must contain `<id>/…`, so that entry
  names match URL paths below the scope.
- **`-base` can be any URL.** The worker rewrites it to its own scope at serve
  time (see [Portability](#how-it-works)), so the same zip works on every host.
  Pick the canonical public URL, so the ids are meaningful when the files are
  read outside the worker (e.g. with `unzip`).
- **`-0`**: store entries without compression, so a tile is a plain byte range.
- **`-X`**: leave out extra fields, so the local header is small and predictable.
- **`-D`**: leave out directory entries. This gives fewer entries and a smaller
  central directory.
- No ZIP64, so a zip must stay under 4 GB and 65535 entries. GitHub Pages also
  rejects files over 100 MB.

`build/` is a scratch directory and is git-ignored.

To add another document, drop `<newid>.zip` (built the same way) into `zip/` and
point a viewer at `<newid>/manifest.json`. `sw.js` needs no changes.

## Deploy elsewhere

Copy the `*.html` pages, `boot.js`, `viewer.css`, `sw.js` and `zip/` into any directory of a static site, e.g.

```sh
git clone --depth 1 https://github.com/atomotic/swiiifz /tmp/swiiifz
rsync -a --exclude .git /tmp/swiiifz/ /var/www/example.org/swiiifz/
```

and open `https://example.org/swiiifz/`. No rebuild is needed. The host must
answer `Range` requests with `206` and should send an `ETag`. Don't publish the
`.git` directory.

## Run locally

Service Workers need `https` or `localhost`, and the host must answer `Range`
requests with `206`. `python -m http.server` doesn't, so the recipe uses Caddy:

```sh
just serve                                   # http://localhost:8080/swiiifz/
```

The committed zip works locally as is: its `https://atomotic.github.io/swiiifz`
ids are rewritten to `http://localhost:8080/swiiifz/`.

## Trade-offs

Compared with publishing the 1910 files directly:

- **+** One file to upload, version, checksum, mirror or delete. No inode or
  file-count limits, and git and the host's CDN stay happy.
- **+** Swapping the zip is atomic: the `ETag`/`If-Range` check stops readers
  from mixing old and new bytes.
- **+** Portable: the same zip works on any host and path, with no rebuild.
- **−** Because of the rewrite, a manifest's `id` depends on where it's served
  from. Two copies of the same zip publish two different ids for the same object.
  Any absolute URL in a JSON or HTML entry that ends in `/<id>` or contains
  `/<id>/` is rewritten, even if it points at another site.
- **−** The first view costs 2 extra round trips plus the central directory
  (about 100 bytes per entry, roughly 190 KB here), plus the Service Worker's
  start-up time.
- **−** Only works in browsers with Service Workers. Other IIIF clients (harvesters,
  `curl`, server-side tools) see a zip, not a IIIF endpoint.
- **−** It's a demo. The worker doesn't cache responses yet, keeps the index only
  in memory (a worker restart re-reads it), and has no ZIP64 support.

## License

Code: MIT. The PDF and its derivatives belong to their respective rights holders
(Direzione generale Archivi) and are included only for demonstration.
