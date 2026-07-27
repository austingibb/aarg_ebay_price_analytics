/**
 * Price parsing and statistics, exercised through the DOM.
 *
 * The parsing helpers live inside the userscript's IIFE and are not importable,
 * so these drive them the only way a browser would: build a minimal SRP-shaped
 * page with known prices, let the script scrape it, and read the numbers back
 * off the rendered widget. That keeps the userscript unmodified and still pins
 * down currency parsing, thousands separators, and the IQR outlier filter.
 *
 * The synthetic page is built from the script's OWN selectors, so it cannot
 * drift away from what the script looks for.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadUserscript, runScriptOnHtml } from './helpers.mjs';

const script = loadUserscript();

/** Split "ul.srp-results" into its tag and class. */
function parseContainer(selector) {
	const [, tag = 'div', cls] = selector.match(/^([a-z]*)\.([A-Za-z0-9_-]+)/i) ?? [];
	return { tag: tag || 'div', cls };
}

/** First alternative of "li.s-card, li.s-item". */
function parseCard(selector) {
	const first = selector.split(',')[0].trim();
	const [, tag = 'li', cls] = first.match(/^([a-z]*)\.([A-Za-z0-9_-]+)/i) ?? [];
	return { tag: tag || 'li', cls };
}

/** Class name from the script's preferred price selector (".s-card__price"). */
function parsePriceClass(selector) {
	const [, cls] = selector.match(/\.([A-Za-z0-9_-]+)$/) ?? [];
	return cls;
}

const container = parseContainer(script.selectors.containers[0]);
const card = parseCard(script.selectors.cardSelector);
const priceClass = parsePriceClass(script.selectors.priceSelectors[0]);

/** Build a minimal SRP page containing exactly these price strings. */
function synthPage(priceTexts) {
	const cards = priceTexts
		.map(
			(text) =>
				`<${card.tag} class="${card.cls}">` +
				`<div class="${priceClass}">${text}</div>` +
				`</${card.tag}>`,
		)
		.join('\n');
	return (
		'<!doctype html><html><body>' +
		`<${container.tag} class="${container.cls}">${cards}</${container.tag}>` +
		'</body></html>'
	);
}

/** Run the script over synthetic prices and read the widget's numbers back. */
async function widgetStats(priceTexts) {
	const dom = await runScriptOnHtml(synthPage(priceTexts), script, { timeoutMs: 3000 });
	try {
		const widget = dom.window.document.getElementById(script.selectors.widgetId);
		if (!widget) return null;
		const text = widget.textContent || '';
		const mean = text.match(/([A-Z]{3})\s+([\d.]+)/);
		const counts = text.match(/(\d+)\s+of\s+(\d+)\s+listings/);
		return {
			currency: mean ? mean[1] : null,
			mean: mean ? Number(mean[2]) : NaN,
			kept: counts ? Number(counts[1]) : null,
			total: counts ? Number(counts[2]) : null,
			text,
		};
	} finally {
		dom.window.close();
	}
}

const repeat = (text, n) => Array.from({ length: n }, () => text);

test('parses plain dollar prices and averages them', async () => {
	const stats = await widgetStats(repeat('$100.00', 25));

	assert.ok(stats, 'widget did not render');
	assert.equal(stats.currency, 'USD');
	assert.equal(stats.mean, 100);
	assert.equal(stats.total, 25);
	assert.equal(stats.kept, 25);
});

test('strips thousands separators', async () => {
	// "$1,234.56" must parse as 1234.56, not 1.
	const stats = await widgetStats(repeat('$1,234.56', 25));

	assert.equal(stats.mean, 1234.56);
	assert.equal(stats.total, 25);
});

test('averages a spread of distinct prices', async () => {
	const values = Array.from({ length: 21 }, (_, i) => 90 + i); // 90..110, mean 100
	const stats = await widgetStats(values.map((v) => `$${v}.00`));

	assert.equal(stats.total, 21);
	assert.equal(stats.kept, 21, 'a tight, symmetric spread should have no outliers');
	assert.ok(Math.abs(stats.mean - 100) < 0.01, `mean was ${stats.mean}`);
});

test('IQR fences exclude an extreme outlier from the mean', async () => {
	// One absurd listing must not drag the average up -- the whole reason the
	// widget uses Tukey fences instead of a raw mean.
	const values = Array.from({ length: 20 }, (_, i) => 95 + i); // 95..114
	const stats = await widgetStats([...values, 100000].map((v) => `$${v}.00`));

	assert.equal(stats.total, 21);
	assert.ok(stats.kept < stats.total, 'outlier was not excluded');
	assert.ok(
		stats.mean < 200,
		`outlier leaked into the mean (${stats.mean}); fences are not filtering`,
	);
});

test('ignores unparseable price text', async () => {
	const stats = await widgetStats([...repeat('$50.00', 22), ...repeat('Best offer', 3)]);

	// The three non-prices are dropped before the statistics, not counted as 0.
	assert.equal(stats.total, 22);
	assert.equal(stats.mean, 50);
});

test('a widget with no usable prices is not treated as healthy', async () => {
	// Price ELEMENTS exist but none parse, so the script still renders the widget
	// -- with an em dash and "No prices found". This is why the canary checks the
	// numbers rather than the widget's presence: a presence check alone would
	// call this healthy and miss the drift entirely.
	const stats = await widgetStats(repeat('Best offer', 25));

	assert.ok(stats, 'widget should still render');
	assert.ok(Number.isNaN(stats.mean), `expected no mean, got ${stats.mean}`);
	assert.equal(stats.total, null);
	assert.match(stats.text, /No prices found/);
});

test('unparseable prices classify as parse drift, not render drift', async () => {
	// Layer order matters: the earlier failing layer is the one that classifies,
	// so this must point the fixer at price parsing rather than at the widget.
	const { classifyProbe } = await import('../canary/dom_probe.mjs');
	const { Layer } = await import('../canary/contract.mjs');
	const { probeHtml } = await import('./helpers.mjs');
	const { MIN_HEALTHY_PRICES } = await import('../canary/presets.mjs');

	const probe = await probeHtml(synthPage(repeat('Best offer', 25)), script, {
		timeoutMs: 800,
	});
	const verdict = classifyProbe(probe, { Layer, minPrices: MIN_HEALTHY_PRICES });

	assert.equal(probe.price.matched, 25, 'elements should match the selector');
	assert.equal(probe.price.parsed, 0, 'none should parse as a price');
	assert.equal(verdict.layer, Layer.PRICE_PARSE);
});
