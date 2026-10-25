// swiiifz — page side. Registers the Service Worker and mounts zip files so
// viewers can load IIIF straight out of them:
//
//   import { open } from 'https://cdn.example/swiiifz/lib/swiiifz.js';
//
//   const zip = await open('https://any.host/archive.zip');   // sw: './sw.js' by default
//   Mirador.viewer({ id: 'viewer', windows: [{ manifestId: zip.manifest }] });
//
// The module itself can be loaded from anywhere; the worker script must be on
// the page's origin (a one-line sw.js that imports lib/swiiifz-sw.js).

const PREFIX = 'swiiifz/'; // must match lib/swiiifz-sw.js

const registrations = new Map(); // sw url -> Promise<scope>

/**
 * Register the swiiifz Service Worker and wait until it controls this page.
 * Resolves to the worker's scope URL. Called by open(); safe to call repeatedly.
 */
export function register(sw = './sw.js', { scope } = {}) {
    const url = new URL(sw, location.href).href;
    let promise = registrations.get(url);
    if (!promise) {
        promise = registerWorker(url, scope);
        registrations.set(url, promise);
    }
    return promise;
}

async function registerWorker(url, scope) {
    if (!('serviceWorker' in navigator)) throw new Error('Service Workers not supported (need https or localhost)');
    const registration = await navigator.serviceWorker.register(url, scope ? { scope } : undefined);
    await navigator.serviceWorker.ready;
    // First visit: wait until the worker controls this page, or its fetches bypass it.
    if (!navigator.serviceWorker.controller) {
        await new Promise((resolve) =>
            navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }),
        );
    }
    return registration.scope;
}

/** The virtual base URL for a zip under the worker's scope: <scope>swiiifz/<base64url(zip)>/ */
export function mount(zipUrl, scope) {
    const bytes = new TextEncoder().encode(new URL(zipUrl, location.href).href);
    const b64 = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return new URL(`${PREFIX}${b64}/`, scope).href;
}

/**
 * Mount a zip and list it.
 *   options.sw        worker script url (default './sw.js', relative to the page)
 *   options.scope     worker scope (default: the script's directory)
 *   options.manifest  entry path of the manifest, if the default guess is wrong
 * Resolves to { zip, base, entries, manifest, url(path) }:
 *   base      virtual URL of the zip root (ends with '/')
 *   entries   entry names in the zip
 *   manifest  virtual URL of the manifest (manifest.json at the root, else the
 *             shallowest <dir>/manifest.json), or null if there is none
 *   url(p)    virtual URL of entry p
 */
export async function open(zipUrl, { sw = './sw.js', scope, manifest } = {}) {
    const zip = new URL(zipUrl, location.href).href;
    const base = mount(zip, await register(sw, { scope }));
    const response = await fetch(base);
    if (!response.ok) throw new Error(`swiiifz: ${zip}: ${response.status} ${await response.text()}`);
    const { entries } = await response.json();

    const url = (path) => new URL(path.split('/').map(encodeURIComponent).join('/'), base).href;
    const path = manifest ?? findManifest(entries);
    return { zip, base, entries, manifest: path ? url(path) : null, url };
}

function findManifest(entries) {
    return entries
        .filter((name) => name === 'manifest.json' || name.endsWith('/manifest.json'))
        .sort((a, b) => a.split('/').length - b.split('/').length)[0];
}
