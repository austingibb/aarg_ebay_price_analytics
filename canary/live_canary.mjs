/**
 * Live UI-drift canary for the eBay price analytics userscript.
 *
 * Layered checks, in order; the FIRST to fail classifies the run:
 *
 *   1. CDP reachable            -> ENVIRONMENT_CDP_DOWN   (start Chrome; never a code fix)
 *   2. eBay served real results -> ENVIRONMENT_BLOCKED    (bot-wall; never a code fix)
 *   3. results river present    -> URL_OR_STRUCTURE_DRIFT
 *   4. prices parse             -> SCRAPER_SELECTOR_DRIFT
 *   5. widget renders sane stats-> RENDER_DRIFT
 *
 * Prints ONE CanaryResult JSON document on stdout (last), which the triage
 * harness consumes as data. All logging goes to stderr so it can never be
 * mistaken for the result.
 *
 * Usage:
 *   node canary/live_canary.mjs [--cdp-url http://localhost:9222]
 */

import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright-core';

import {
	Classification,
	Layer,
	aggregate,
	canaryResult,
	presetResult,
} from './contract.mjs';
import { classifyProbe, probeDocument } from './dom_probe.mjs';
import { MIN_HEALTHY_PRICES, PRESETS } from './presets.mjs';
import { SCRIPT_FILENAME, loadScript } from './script_selectors.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');

const DEFAULT_CDP_URL = 'http://localhost:9222';
const GOTO_TIMEOUT_MS = 45_000;
const CONTAINER_TIMEOUT_MS = 20_000;
// The script polls for the river every 500ms for up to ~10s before giving up, so
// the canary must outwait that or it would report drift on a merely slow page.
const WIDGET_TIMEOUT_MS = 20_000;

const log = (...args) => console.error('[canary]', ...args);

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

function gitHead() {
	try {
		return execFileSync('git', ['rev-parse', 'HEAD'], {
			cwd: REPO_ROOT,
			encoding: 'utf8',
		}).trim();
	} catch {
		return null;
	}
}

/** Layer 1: is the Chrome debug instance reachable over CDP? */
async function checkCdp(cdpUrl) {
	const versionUrl = `${cdpUrl.replace(/\/$/, '')}/json/version`;
	try {
		const resp = await fetch(versionUrl, { signal: AbortSignal.timeout(5000) });
		if (!resp.ok) return { ok: false, evidence: { cdp_url: cdpUrl, status: resp.status } };
		const body = await resp.json();
		return { ok: true, evidence: { cdp_url: cdpUrl, browser: body.Browser } };
	} catch (err) {
		return { ok: false, evidence: { cdp_url: cdpUrl, exception: String(err).slice(0, 300) } };
	}
}

/** Run one preset through layers 2-5 and return a PresetResult. */
async function runPreset(context, preset, script, captureHtml) {
	const page = await context.newPage();
	try {
		try {
			await page.goto(preset.url, {
				waitUntil: 'domcontentloaded',
				timeout: GOTO_TIMEOUT_MS,
			});
		} catch (err) {
			return presetResult({
				name: preset.name,
				url: preset.url,
				healthy: false,
				failedLayer: Layer.BLOCK,
				classification: Classification.ENVIRONMENT_BLOCKED,
				evidence: { reason: 'navigation failed', exception: String(err).slice(0, 300) },
			});
		}

		// Give the river a chance to render before judging anything. A timeout
		// here is NOT itself a failure -- the probe decides -- but waiting first
		// keeps a slow page from reading as a missing container.
		const containerSelector = script.selectors.containers.join(', ');
		await page
			.waitForSelector(containerSelector, { timeout: CONTAINER_TIMEOUT_MS })
			.catch(() => log(`${preset.name}: no results container within timeout`));

		// Run the userscript exactly as Tampermonkey would: evaluate its source in
		// the page. It self-starts and polls for the river on its own.
		await page.evaluate(script.source).catch((err) => {
			log(`${preset.name}: userscript threw on injection: ${String(err).slice(0, 200)}`);
		});

		await page
			.waitForSelector(`#${script.selectors.widgetId}`, { timeout: WIDGET_TIMEOUT_MS })
			.catch(() => log(`${preset.name}: widget did not render within timeout`));

		const probe = await page.evaluate(probeDocument, {
			containers: script.selectors.containers,
			priceSelectors: script.selectors.priceSelectors,
			cardSelector: script.selectors.cardSelector,
			widgetId: script.selectors.widgetId,
			minPrices: MIN_HEALTHY_PRICES,
			captureHtml,
		});

		const verdict = classifyProbe(probe, { Layer, minPrices: MIN_HEALTHY_PRICES });
		const evidence = {
			attempted_url: preset.url,
			final_url: page.url(),
			expected_shape: {
				min_prices: MIN_HEALTHY_PRICES,
				containers: script.selectors.containers,
				price_selectors: script.selectors.priceSelectors,
			},
			actual_shape: {
				container_matched: probe.container.selector,
				card_count: probe.cardCount,
				price_selector_matched: probe.price.selector,
				prices_matched: probe.price.matched,
				prices_parsed: probe.price.parsed,
				price_samples: probe.price.samples,
				widget: probe.widget,
			},
			reason: verdict.reason,
		};
		if (probe.dom_context) evidence.dom_context = probe.dom_context;

		return presetResult({
			name: preset.name,
			url: preset.url,
			healthy: verdict.ok,
			itemCount: probe.price.parsed,
			failedLayer: verdict.layer,
			classification: verdict.ok
				? Classification.HEALTHY
				: {
						[Layer.BLOCK]: Classification.ENVIRONMENT_BLOCKED,
						[Layer.RESULTS_CONTAINER]: Classification.URL_OR_STRUCTURE_DRIFT,
						[Layer.PRICE_PARSE]: Classification.SCRAPER_SELECTOR_DRIFT,
						[Layer.WIDGET_RENDER]: Classification.RENDER_DRIFT,
					}[verdict.layer],
			evidence,
		});
	} finally {
		await page.close().catch(() => {});
	}
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const lastKnownGoodCommit = gitHead();

	let script;
	try {
		script = loadScript(join(REPO_ROOT, SCRIPT_FILENAME));
	} catch (err) {
		// The canary cannot read the script's selectors, so it cannot probe
		// anything meaningfully. Report it rather than guessing with stale copies.
		process.stdout.write(
			`${JSON.stringify(
				canaryResult({
					classification: Classification.CANARY_MAINTENANCE,
					healthy: false,
					escalate: false,
					summary: String(err.message ?? err),
					presets: [],
					lastKnownGoodCommit,
				}),
				null,
				2,
			)}\n`,
		);
		return;
	}

	const cdp = await checkCdp(args.cdpUrl);
	if (!cdp.ok) {
		process.stdout.write(
			`${JSON.stringify(
				canaryResult({
					classification: Classification.ENVIRONMENT_CDP_DOWN,
					healthy: false,
					escalate: true,
					summary:
						`CDP unreachable at ${args.cdpUrl}; cannot connect to the Chrome ` +
						'debug instance. Start Chrome with --remote-debugging-port.',
					presets: [
						presetResult({
							name: 'cdp',
							url: args.cdpUrl,
							healthy: false,
							failedLayer: Layer.CDP,
							classification: Classification.ENVIRONMENT_CDP_DOWN,
							evidence: cdp.evidence,
						}),
					],
					lastKnownGoodCommit,
				}),
				null,
				2,
			)}\n`,
		);
		return;
	}

	log(`connected: ${cdp.evidence.browser}`);
	const browser = await chromium.connectOverCDP(args.cdpUrl);
	const results = [];
	try {
		// Reuse the EXISTING browser context, not a fresh one: it carries the
		// user's real cookies and session, which is what keeps eBay from serving
		// a bot interstitial to an obviously-automated clean profile.
		const context = browser.contexts()[0] ?? (await browser.newContext());

		for (const [index, preset] of PRESETS.entries()) {
			log(`preset ${preset.name}`);
			// Full page HTML is captured only once. The fixer packet dedupes
			// repeats anyway, and one SRP page is already large.
			const result = await runPreset(context, preset, script, index === 0);
			log(`  -> ${result.healthy ? 'healthy' : result.classification} (${result.item_count} prices)`);
			results.push(result);
		}
	} finally {
		// close() on a CDP connection detaches the debugger; it does not close the
		// user's browser.
		await browser.close().catch(() => {});
	}

	const doc = aggregate(results, { lastKnownGoodCommit });
	process.stdout.write(`${JSON.stringify(doc, null, 2)}\n`);
}

main().catch((err) => {
	// Any unexpected throw still has to produce a parseable document, or the
	// harness sees "no JSON on stdout" and cannot tell what happened.
	process.stdout.write(
		`${JSON.stringify(
			canaryResult({
				classification: Classification.ENVIRONMENT_CDP_DOWN,
				healthy: false,
				escalate: true,
				summary: `canary crashed: ${String(err?.stack ?? err).slice(0, 500)}`,
				presets: [],
				lastKnownGoodCommit: null,
			}),
			null,
			2,
		)}\n`,
	);
	process.exitCode = 1;
});
