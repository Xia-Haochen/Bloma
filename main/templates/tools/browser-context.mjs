import { join, resolve, relative, isAbsolute } from 'node:path';
import { mkdirSync, realpathSync, readFileSync } from 'node:fs';
import { chromium } from 'playwright';
export async function connectApp() {
    const endpoint = new URL(process.env.BLOMA_DEBUG_CDP ?? '');
    if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1')
        throw Error('BROWSER_SCRIPT_OWNED_ENDPOINT_REQUIRED');
    const downloads = join(process.env.APP_DATA_DIR, 'browser-downloads');
    mkdirSync(downloads, { recursive: true });
    const browser = await chromium.connectOverCDP(endpoint.href, { isLocal: true, artifactsDir: downloads });
    const all=browser.contexts().flatMap(context=>context.pages()),pages=[]
    for(const page of all){
      if(!process.env.BLOMA_DEBUG_TARGET){if(page.url()===process.env.BLOMA_DEBUG_PAGE)pages.push(page);continue}
      const cdp=await page.context().newCDPSession(page)
      try{const{targetInfo}=await cdp.send('Target.getTargetInfo');if(targetInfo.targetId===process.env.BLOMA_DEBUG_TARGET)pages.push(page)}finally{await cdp.detach()}
    }
    if (pages.length !== 1) {
        await browser.close();
        throw Error('BROWSER_SCRIPT_PAGE_NOT_UNIQUE');
    }
    const page = pages[0];
    // CDP attaches an existing context, so Playwright cannot receive baseURL in
    // newContext(). Resolve relative navigation against the actual owned app;
    // retain the same Page, browser storage, assertions and absolute URL behavior.
    const base = new URL(page.url());
    if (['http:', 'https:'].includes(base.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) {
        const navigate = page.goto.bind(page);
        page.goto = (url, options) => navigate(typeof url === 'string' && !/^[a-z][a-z0-9+.-]*:/i.test(url)
            ? new URL(url, base).href : url, options);
    }
    page.setDefaultTimeout(5000);
    return { browser, page, context: page.context() };
}

/** Actual owned app facts. This observes product-created windows and reads the
 * current candidate's documents; it never logs in or creates a window for it. */
export function appExecutionContext(page, context) {
    return {
        get origin() { const url = new URL(page.url()); return ['http:', 'https:'].includes(url.protocol) ? url.origin : undefined; },
        get url() { return page.url(); },
        phase: process.env.BLOMA_NATIVE_TEST_PHASE,
        async waitForWindow(action, options = {}) {
            if (typeof action !== 'function') throw Error('APP_WINDOW_ACTION_REQUIRED');
            const window = context.waitForEvent('page', { timeout: 10000, ...options });
            window.catch(() => {});
            await action();
            const created = await window;
            await created.waitForLoadState('domcontentloaded');
            return created;
        },
        readProductFile(path) {
            if (!process.env.BLOMA_PRODUCT_ROOT || typeof path !== 'string' || isAbsolute(path)) throw Error('APP_PRODUCT_PATH_REQUIRED');
            const root = realpathSync(process.env.BLOMA_PRODUCT_ROOT), file = realpathSync(resolve(root, path)), rel = relative(root, file);
            if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) throw Error('APP_PRODUCT_PATH_OUTSIDE_CANDIDATE');
            return readFileSync(file, 'utf8');
        },
    };
}
