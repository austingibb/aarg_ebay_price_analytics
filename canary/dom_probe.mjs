/**
 * The black-box probe, shared by the live canary and the mock gate.
 *
 * The userscript is a self-starting IIFE, so the canary does not call into it --
 * it drives the same DOM the script drives and reads what the script rendered.
 * That means zero refactoring of the userscript, and it means the mock gate
 * (jsdom + a saved SRP fixture) and the live canary (Playwright + real eBay)
 * exercise the SAME code path with only the DOM source differing.
 *
 * `probeDocument` is deliberately self-contained: it references nothing outside
 * its own body, and takes a SINGLE serializable options object. That lets
 * Playwright hand the function straight to page.evaluate (which runs it over the
 * debugger protocol, so eBay's Content-Security-Policy does not apply) instead
 * of rebuilding it in-page with `new Function`, which CSP would block.
 */

/**
 * Inspect a document for the script's drift surface and rendered output.
 *
 * @param {{containers: string[], priceSelectors: string[], cardSelector: string,
 *          widgetId: string, minPrices: number, captureHtml?: boolean,
 *          doc?: Document}} options - `doc` is supplied under jsdom; in a real
 *          page it is omitted and the page's own `document` is used.
 */
export function probeDocument(options) {
	const {
		containers,
		priceSelectors,
		cardSelector,
		widgetId,
		minPrices,
		captureHtml = false,
	} = options;
	const doc = options.doc || document;

	const truncate = (text, limit) =>
		typeof text === 'string' && text.length > limit ? text.slice(0, limit) : text;

	const looksLikePrice = (text) =>
		/\d/.test(text) && /[$€£¥]|\b(?:USD|EUR|GBP|JPY|CNY|C \$|AU \$)\b/.test(text);

	const result = {
		container: { found: false, selector: null, tried: containers },
		cardCount: 0,
		price: { selector: null, matched: 0, parsed: 0, tried: priceSelectors, samples: [] },
		widget: { present: false, meanText: null, subText: null, kept: null, total: null, sane: false },
		blocked: false,
	};

	// A bot-wall / captcha interstitial. Detected before anything else is judged,
	// because it produces exactly the same "no prices" symptom as real drift --
	// and treating it as drift would send a fixer to rewrite working selectors.
	const bodyText = (doc.body && doc.body.textContent) || '';
	const blockMarkers = [
		'Pardon Our Interruption',
		'Checking your browser',
		'unusual traffic',
		'verify you are a human',
		'Enter the characters you see below',
	];
	const href = (doc.defaultView && doc.defaultView.location && doc.defaultView.location.href) || '';
	result.blocked =
		blockMarkers.some((m) => bodyText.includes(m)) ||
		/splashui|captcha|challenge/i.test(href);

	// Layer 3: the results river.
	let root = null;
	for (const selector of containers) {
		const found = doc.querySelector(selector);
		if (found) {
			root = found;
			result.container.found = true;
			result.container.selector = selector;
			break;
		}
	}

	const captureEvidence = () => {
		// Candidate class names near the river, so a fixer can see what the markup
		// moved TO rather than only that the old selector missed.
		const candidates = new Set();
		const scope = root || doc.body;
		if (scope) {
			for (const el of scope.querySelectorAll('[class]')) {
				const cls = typeof el.className === 'string' ? el.className : '';
				if (/price/i.test(cls)) {
					for (const token of cls.split(/\s+/)) {
						if (/price/i.test(token)) candidates.add(token);
					}
				}
				if (candidates.size >= 40) break;
			}
		}
		const firstCard = scope ? scope.querySelector('li, [class*="card"], [class*="item"]') : null;
		const evidence = {
			title: doc.title || null,
			url: href || null,
			price_class_candidates: [...candidates],
			sample_card_html: firstCard ? truncate(firstCard.outerHTML, 4000) : null,
		};
		if (captureHtml && doc.documentElement) {
			evidence.page_html = truncate(doc.documentElement.outerHTML, 200000);
		}
		return evidence;
	};

	if (!root) {
		result.dom_context = captureEvidence();
		return result;
	}

	const cards = root.querySelectorAll(cardSelector);
	result.cardCount = cards.length;

	// Layer 4: prices. Mirrors the script's own card-relative walk, including the
	// aria-hidden skip -- sponsored placeholders sit outside the river and must
	// not count toward a healthy reading.
	for (const selector of priceSelectors) {
		let elements = [];
		if (cards.length > 0) {
			for (const card of cards) {
				if (card.closest('[aria-hidden="true"]')) continue;
				const price = card.querySelector(selector);
				if (price) elements.push(price);
			}
		} else {
			elements = [...root.querySelectorAll(selector)].filter(
				(el) => !el.closest('[aria-hidden="true"]'),
			);
		}
		if (elements.length > 0) {
			const texts = elements.map((el) => (el.textContent || '').trim()).filter(Boolean);
			result.price.selector = selector;
			result.price.matched = elements.length;
			result.price.parsed = texts.filter(looksLikePrice).length;
			result.price.samples = texts.slice(0, 5);
			break;
		}
	}

	// Layer 5: what the script actually rendered.
	const widget = doc.getElementById(widgetId);
	if (widget) {
		const text = widget.textContent || '';
		// The widget's money() renders "<CURRENCY> <amount>" (e.g. "USD 280.97"),
		// and an em dash when the value is NaN -- so a dash here is a real failure,
		// not a missing widget.
		const meanMatch = text.match(/(?:([A-Z]{3})\s+|([$€£¥])\s?)([\d,]+(?:\.\d+)?)/);
		const countMatch = text.match(/(\d+)\s+of\s+(\d+)\s+listings/);
		const meanValue = meanMatch ? Number(meanMatch[3].replace(/,/g, '')) : NaN;
		const kept = countMatch ? Number(countMatch[1]) : null;
		const total = countMatch ? Number(countMatch[2]) : null;

		result.widget = {
			present: true,
			meanText: meanMatch ? meanMatch[0] : null,
			subText: truncate(text, 300),
			kept,
			total,
			// "Rendered" is not enough: a widget showing $NaN over 0 listings is a
			// failure that a presence check alone would call healthy.
			sane:
				Number.isFinite(meanValue) &&
				meanValue > 0 &&
				total !== null &&
				total >= minPrices &&
				kept !== null &&
				kept > 0 &&
				kept <= total,
		};
	}

	if (result.price.parsed < minPrices || !result.widget.sane) {
		result.dom_context = captureEvidence();
	}
	return result;
}

/**
 * Turn a probe reading into a layer verdict.
 *
 * Kept separate from probeDocument so it can run in Node (where the layer/
 * classification enums live) rather than inside the page.
 */
export function classifyProbe(probe, { Layer, minPrices }) {
	if (probe.blocked) {
		return { ok: false, layer: Layer.BLOCK, reason: 'bot-wall or captcha interstitial served' };
	}
	if (!probe.container.found) {
		return {
			ok: false,
			layer: Layer.RESULTS_CONTAINER,
			reason: `no results container matched any of ${probe.container.tried.join(', ')}`,
		};
	}
	if (probe.price.parsed < minPrices) {
		return {
			ok: false,
			layer: Layer.PRICE_PARSE,
			reason:
				`only ${probe.price.parsed} parseable prices (need ${minPrices}) from ` +
				`${probe.cardCount} cards; matched selector ` +
				`${probe.price.selector ?? 'none'}`,
		};
	}
	if (!probe.widget.present) {
		return {
			ok: false,
			layer: Layer.WIDGET_RENDER,
			reason: 'prices parsed but the analytics widget never rendered',
		};
	}
	if (!probe.widget.sane) {
		return {
			ok: false,
			layer: Layer.WIDGET_RENDER,
			reason: `widget rendered implausible stats: ${probe.widget.subText ?? '(no text)'}`,
		};
	}
	return { ok: true, layer: null, reason: 'healthy' };
}
