// Shared by all pages: registers sw.js and waits until it controls the page.
// manifest.json does not exist as a file: sw.js reads it out of zip/5l69cr5dp7.zip.
export const MANIFEST = new URL('5l69cr5dp7/manifest.json', location.href).href;

export async function ready() {
    const status = document.getElementById('status') ?? {};

    if (!('serviceWorker' in navigator)) {
        status.textContent = 'Service Workers not supported (need https or localhost)';
        throw new Error('no service worker');
    }

    await navigator.serviceWorker.register('./sw.js', { scope: './' });
    await navigator.serviceWorker.ready;
    // First visit: wait until the worker controls this page, or its fetches bypass it.
    if (!navigator.serviceWorker.controller) {
        await new Promise((resolve) =>
            navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }),
        );
    }

    status.textContent = 'service worker active';
    return MANIFEST;
}
