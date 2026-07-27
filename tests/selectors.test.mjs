/**
 * The regression gate.
 *
 * Runs the real userscript against a captured eBay SRP snapshot in jsdom and
 * asserts it still finds prices and renders sane statistics. This is what the
 * triage harness runs before it will propose an auto-fix: a "fix" that makes the
 * live page green but breaks price collection on known-good markup gets rejected
 * here rather than turning into a pull request.
 *
 * The broken-fixture test is the other half. A gate that cannot fail proves
 * nothing, so we assert drift is actually DETECTED, not just that the happy path
 * works.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MIN_HEALTHY_PRICES } from '../canary/presets.mjs';
import { classifyProbe } from '../canary/dom_probe.mjs';
import { Layer } from '../canary/contract.mjs';
import {
	BROKEN_FIXTURE,
	KNOWN_GOOD_FIXTURE,
	loadUserscript,
	probeHtml,
	readFixture,
} from './helpers.mjs';

const script = loadUserscript();

// On drift paths the widget never renders, so waiting out the full poll is dead
// time in a gate that runs on every fix verification.
const NO_WIDGET = { timeoutMs: 800 };

test('selectors parse out of the userscript source', () => {
	// The canary reads these from the script rather than keeping its own copy, so
	// a fixer's edit is picked up automatically. If this breaks, the canary is
	// silently probing the wrong thing.
	assert.ok(script.selectors.containers.length > 0);
	assert.ok(script.selectors.priceSelectors.length > 0);
	assert.ok(script.selectors.cardSelector.includes('li'));
	assert.equal(script.selectors.widgetId, 'aarg-price-widget');
});

test('known-good fixture yields a healthy reading', async () => {
	const probe = await probeHtml(readFixture(KNOWN_GOOD_FIXTURE), script);

	assert.ok(probe.container.found, 'results container not found in fixture');
	assert.ok(
		probe.price.parsed >= MIN_HEALTHY_PRICES,
		`only ${probe.price.parsed} prices parsed, need ${MIN_HEALTHY_PRICES}`,
	);
	assert.ok(probe.cardCount > 0, 'no cards found');

	const verdict = classifyProbe(probe, { Layer, minPrices: MIN_HEALTHY_PRICES });
	assert.equal(verdict.ok, true, verdict.reason);
});

test('widget renders sane statistics over the fixture', async () => {
	const probe = await probeHtml(readFixture(KNOWN_GOOD_FIXTURE), script);

	assert.ok(probe.widget.present, 'widget never rendered');
	assert.ok(probe.widget.sane, `widget stats implausible: ${probe.widget.subText}`);
	// kept <= total, and the sample is the size we actually scraped.
	assert.ok(probe.widget.total >= MIN_HEALTHY_PRICES);
	assert.ok(probe.widget.kept > 0);
	assert.ok(probe.widget.kept <= probe.widget.total);
	assert.match(probe.widget.meanText, /\d/);
});

test('broken price class is DETECTED as selector drift', async () => {
	const probe = await probeHtml(readFixture(BROKEN_FIXTURE), script, NO_WIDGET);

	assert.ok(probe.container.found, 'container should still be present');
	assert.ok(
		probe.price.parsed < MIN_HEALTHY_PRICES,
		'broken fixture still yielded prices; the gate cannot detect drift',
	);

	const verdict = classifyProbe(probe, { Layer, minPrices: MIN_HEALTHY_PRICES });
	assert.equal(verdict.ok, false);
	assert.equal(verdict.layer, Layer.PRICE_PARSE);
});

test('drift evidence names candidate replacement classes', async () => {
	// What makes an auto-fix possible: the fixer needs to see what the markup
	// moved TO, not merely that the old selector matched nothing.
	const probe = await probeHtml(readFixture(BROKEN_FIXTURE), script, NO_WIDGET);

	assert.ok(probe.dom_context, 'no evidence captured on failure');
	assert.ok(
		probe.dom_context.price_class_candidates.length > 0,
		'no candidate price classes captured',
	);
	assert.ok(
		probe.dom_context.price_class_candidates.some((c) => /price/i.test(c)),
		'candidates should include price-ish class names',
	);
	assert.ok(probe.dom_context.sample_card_html, 'no sample card captured');
});

test('missing results container classifies as structure drift', async () => {
	// Simulate eBay renaming the river container itself (layer 3, earlier than a
	// price-selector problem, and a different fix).
	let html = readFixture(KNOWN_GOOD_FIXTURE);
	for (const selector of script.selectors.containers) {
		// Pull the class/id tokens out of the selector ("ul.srp-results" -> the
		// class "srp-results"), not the whole selector string.
		for (const [, token] of selector.matchAll(/[.#]([A-Za-z0-9_-]+)/g)) {
			html = html.replaceAll(token, `${token}-gone`);
		}
	}

	const probe = await probeHtml(html, script, NO_WIDGET);
	const verdict = classifyProbe(probe, { Layer, minPrices: MIN_HEALTHY_PRICES });

	assert.equal(probe.container.found, false);
	assert.equal(verdict.layer, Layer.RESULTS_CONTAINER);
});

test('bot-wall page is classified as environment, never drift', async () => {
	// The safety property: a captcha interstitial produces the same "no prices"
	// symptom as real drift. If it classified as drift, the fixer would rewrite
	// working selectors to chase a page that was never broken.
	const html = `<!doctype html><html><body>
		<h1>Pardon Our Interruption</h1>
		<p>As you were browsing something about your browser made us think you were a bot.</p>
	</body></html>`;

	const probe = await probeHtml(html, script, NO_WIDGET);
	const verdict = classifyProbe(probe, { Layer, minPrices: MIN_HEALTHY_PRICES });

	assert.equal(probe.blocked, true);
	assert.equal(verdict.layer, Layer.BLOCK);
});
