/**
 * Read the userscript's own selector constants out of its source.
 *
 * The canary deliberately does NOT keep its own copy of the selectors. If it
 * did, the copy would rot: a fix that updates the script would leave the canary
 * still probing the old markup, so verification would test the wrong thing and a
 * correct fix could never come back green.
 *
 * Reading them from the source instead means the canary always probes exactly
 * what the script currently declares -- including immediately after a fixer
 * edits it, which is what makes verify-on-worktree meaningful.
 */

import { readFileSync } from 'node:fs';

export const SCRIPT_FILENAME = 'transpiled_ebay_price_scraper.js';

/** Strip line comments so selector extraction is not confused by prose. */
function stripLineComments(text) {
	return text.replace(/\/\/[^\n]*/g, '');
}

/** All quoted string literals inside a `const NAME = [ ... ]` array. */
function arrayLiteral(source, name) {
	const match = source.match(new RegExp(`const\\s+${name}\\s*=\\s*\\[([\\s\\S]*?)\\]`));
	if (!match) return null;
	const body = stripLineComments(match[1]);
	const items = [...body.matchAll(/["'`]([^"'`]+)["'`]/g)].map((m) => m[1]);
	return items.length > 0 ? items : null;
}

/** A single quoted `const NAME = '...'` value. */
function stringLiteral(source, name) {
	const match = source.match(new RegExp(`const\\s+${name}\\s*=\\s*["'\`]([^"'\`]+)["'\`]`));
	return match ? match[1] : null;
}

/** The card selector passed to querySelectorAll when collecting one price per card. */
function cardSelector(source) {
	const match = stripLineComments(source).match(
		/const\s+cards\s*=\s*\w+\.querySelectorAll\(\s*["'`]([^"'`]+)["'`]\s*\)/,
	);
	return match ? match[1] : null;
}

/**
 * Parse the drift-prone surface out of the userscript source.
 *
 * Throws rather than falling back to defaults: if the script has been
 * restructured so these can no longer be found, that is a real problem the
 * operator must see, not something to paper over with stale constants.
 */
export function parseSelectors(source) {
	const containers = arrayLiteral(source, 'RESULT_CONTAINERS');
	const priceSelectors = arrayLiteral(source, 'PRICE_SELECTORS');
	const cards = cardSelector(source);
	const widgetId = stringLiteral(source, 'WIDGET_ID');

	const missing = [];
	if (!containers) missing.push('RESULT_CONTAINERS');
	if (!priceSelectors) missing.push('PRICE_SELECTORS');
	if (!cards) missing.push('cards querySelectorAll');
	if (!widgetId) missing.push('WIDGET_ID');
	if (missing.length > 0) {
		throw new Error(
			`could not read ${missing.join(', ')} from ${SCRIPT_FILENAME}; ` +
				'the script has been restructured and the canary needs updating',
		);
	}

	return { containers, priceSelectors, cardSelector: cards, widgetId };
}

export function loadScript(path) {
	const source = readFileSync(path, 'utf8');
	return { source, selectors: parseSelectors(source) };
}
