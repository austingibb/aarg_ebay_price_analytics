/**
 * Shared test/fixture helpers: load a saved SRP snapshot into jsdom, run the
 * userscript against it exactly as a browser would, and probe the result.
 *
 * Used by both the mock gate (tests/) and the fixture capture script, so the
 * thing the capture script validates is literally the thing the tests assert.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { JSDOM, VirtualConsole } from 'jsdom';

import { probeDocument } from '../canary/dom_probe.mjs';
import { MIN_HEALTHY_PRICES } from '../canary/presets.mjs';
import { SCRIPT_FILENAME, loadScript } from '../canary/script_selectors.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, '..');
export const FIXTURE_DIR = join(HERE, 'fixtures');

export const KNOWN_GOOD_FIXTURE = join(FIXTURE_DIR, 'srp-known-good.html');
export const BROKEN_FIXTURE = join(FIXTURE_DIR, 'srp-broken-price-class.html');

export function loadUserscript() {
	return loadScript(join(REPO_ROOT, SCRIPT_FILENAME));
}

export function readFixture(path) {
	return readFileSync(path, 'utf8');
}

/**
 * Run the userscript against an HTML snapshot in jsdom.
 *
 * `pretendToBeVisual` supplies requestAnimationFrame, which the widget's
 * reposition handler needs. Geometry (getBoundingClientRect) is all zeros under
 * jsdom, which only affects where the widget is positioned -- never the numbers
 * this gate checks.
 */
export async function runScriptOnHtml(html, script, { timeoutMs = 5000 } = {}) {
	// The userscript runs at LOG_LEVEL 2 and logs a line per token parsed. Left
	// connected, that floods test output and the capture script's stdout with
	// thousands of lines. Errors are still surfaced by the assertions.
	const virtualConsole = new VirtualConsole();

	const dom = new JSDOM(html, {
		runScripts: 'outside-only',
		pretendToBeVisual: true,
		url: 'https://www.ebay.com/sch/i.html?_nkw=laptop',
		virtualConsole,
	});

	dom.window.eval(script.source);

	// The script polls for the river every 500ms before rendering, so the widget
	// is not guaranteed to exist the instant eval returns.
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (dom.window.document.getElementById(script.selectors.widgetId)) break;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return dom;
}

/** Probe a jsdom document with the same probe the live canary uses. */
export function probeDom(dom, script, { minPrices = MIN_HEALTHY_PRICES } = {}) {
	return probeDocument({
		doc: dom.window.document,
		containers: script.selectors.containers,
		priceSelectors: script.selectors.priceSelectors,
		cardSelector: script.selectors.cardSelector,
		widgetId: script.selectors.widgetId,
		minPrices,
		captureHtml: false,
	});
}

/** Run the script over an HTML snapshot and return the probe reading. */
export async function probeHtml(html, script, options) {
	const dom = await runScriptOnHtml(html, script, options);
	try {
		return probeDom(dom, script, options);
	} finally {
		dom.window.close();
	}
}
