/**
 * Capture a known-good eBay SRP snapshot for the mock gate.
 *
 * The results river is NOT in eBay's initial HTML response -- it renders after
 * the shell (the userscript polls for exactly this reason). So the snapshot has
 * to come from a real browser AFTER prices exist: `page.content()` serializes
 * the post-JS DOM. Fetching the URL directly would save a shell with no
 * listings, and the mock gate would then pass while checking nothing.
 *
 * Two guards make a bad capture impossible to commit silently:
 *   1. the snapshot is validated through the SAME jsdom path the tests use, and
 *   2. nothing is written unless that validation finds >= MIN_HEALTHY_PRICES.
 *
 * Also emits a deliberately-broken variant (price classes renamed) so the gate
 * can prove it actually fails on drift. Generating it from the good snapshot
 * keeps the two in sync -- no second capture to go stale.
 *
 * Usage:
 *   npm run capture-fixture -- [--cdp-url http://localhost:9222]
 */

import { mkdirSync, writeFileSync } from 'node:fs';

import { chromium } from 'playwright-core';

import { MIN_HEALTHY_PRICES, PRESETS } from '../canary/presets.mjs';
import {
	BROKEN_FIXTURE,
	FIXTURE_DIR,
	KNOWN_GOOD_FIXTURE,
	loadUserscript,
	probeHtml,
} from '../tests/helpers.mjs';

const DEFAULT_CDP_URL = 'http://localhost:9222';

function parseArgs(argv) {
	const args = { cdpUrl: DEFAULT_CDP_URL };
	for (let i = 0; i < argv.length; i += 1) {
		if (argv[i] === '--cdp-url' && argv[i + 1]) {
			args.cdpUrl = argv[i + 1];
			i += 1;
		}
	}
	return args;
}

/**
 * Strip everything the probe does not read.
 *
 * The fixture is a DOM structure to run OUR script against, not a working copy
 * of eBay. Scripts would make the gate slow, nondeterministic, and dependent on
 * third-party code jsdom cannot run; CSS and comments are pure weight, since the
 * probe only queries selectors and reads textContent. Dropping them roughly
 * halves what gets committed and keeps a fixture refresh diff readable.
 */
function stripNoise(html) {
	return html
		.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
		.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '')
		.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
		.replace(/<!--[\s\S]*?-->/g, '');
}

/** Class tokens the script's price selectors depend on, e.g. s-card__price. */
function priceClassTokens(priceSelectors) {
	const tokens = new Set();
	for (const selector of priceSelectors) {
		for (const match of selector.matchAll(/\.([A-Za-z0-9_-]+)/g)) {
			// Skip state classes like POSITIVE that are not the price hook itself.
			if (/price/i.test(match[1])) tokens.add(match[1]);
		}
	}
	return [...tokens];
}

/** Rename every price class so the script's selectors can no longer match. */
function breakPriceClasses(html, priceSelectors) {
	let broken = html;
	for (const token of priceClassTokens(priceSelectors)) {
		broken = broken.replaceAll(token, `${token}-renamed`);
	}
	return broken;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const script = loadUserscript();
	const preset = PRESETS[0];

	console.log(`connecting to ${args.cdpUrl}`);
	const browser = await chromium.connectOverCDP(args.cdpUrl);
	let html;
	try {
		const context = browser.contexts()[0] ?? (await browser.newContext());
		const page = await context.newPage();
		try {
			console.log(`loading ${preset.url}`);
			await page.goto(preset.url, { waitUntil: 'domcontentloaded', timeout: 45_000 });

			// Wait for the river to actually render before serializing. This is the
			// whole point of capturing through a browser.
			const priceSelector = script.selectors.priceSelectors.join(', ');
			await page.waitForSelector(
				`${script.selectors.containers.join(', ')} ${priceSelector}`,
				{ timeout: 30_000 },
			);
			html = stripNoise(await page.content());
		} finally {
			await page.close().catch(() => {});
		}
	} finally {
		await browser.close().catch(() => {});
	}

	// Guard: validate through the same jsdom path the tests use, BEFORE writing.
	const probe = await probeHtml(html, script);
	if (probe.price.parsed < MIN_HEALTHY_PRICES) {
		console.error(
			`refusing to write fixture: only ${probe.price.parsed} parseable prices ` +
				`(need ${MIN_HEALTHY_PRICES}). The river probably had not rendered, or ` +
				'eBay served an interstitial.',
		);
		process.exitCode = 1;
		return;
	}
	if (!probe.widget.sane) {
		console.error(
			`refusing to write fixture: widget did not render sane stats (${probe.widget.subText}).`,
		);
		process.exitCode = 1;
		return;
	}

	const broken = breakPriceClasses(html, script.selectors.priceSelectors);
	const brokenProbe = await probeHtml(broken, script);
	if (brokenProbe.price.parsed >= MIN_HEALTHY_PRICES) {
		console.error(
			'refusing to write fixtures: the "broken" variant still yields prices, ' +
				'so the gate could not detect drift with it.',
		);
		process.exitCode = 1;
		return;
	}

	mkdirSync(FIXTURE_DIR, { recursive: true });
	writeFileSync(KNOWN_GOOD_FIXTURE, html, 'utf8');
	writeFileSync(BROKEN_FIXTURE, broken, 'utf8');

	console.log(
		`wrote fixtures: ${probe.price.parsed} prices via "${probe.price.selector}", ` +
			`widget "${probe.widget.subText}"`,
	);
	console.log(`  ${KNOWN_GOOD_FIXTURE}`);
	console.log(`  ${BROKEN_FIXTURE} (${brokenProbe.price.parsed} prices)`);
}

main().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
