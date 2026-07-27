/**
 * Preset eBay search URLs the live canary runs against.
 *
 * Every preset is chosen to reliably return many results (broad, high-volume
 * consumer categories). That property is what makes the canary's core assumption
 * valid:
 *
 *     A healthy results page that yields ZERO prices always means breakage,
 *     never a legitimately empty search.
 *
 * The presets intentionally span DIFFERENT URL param shapes (a bare keyword
 * search, a category-scoped search with a price ceiling, a buy-it-now search
 * with an explicit sort). That diversity is what lets the cross-preset check in
 * contract.mjs discriminate:
 *
 *   - All presets fail (regardless of shape)  -> eBay's SRP markup changed
 *     -> real selector drift -> escalate to the fixer.
 *   - Only presets sharing one param shape fail while differently-shaped presets
 *     stay healthy with prices -> that URL/param format drifted, not the script
 *     -> CANARY_MAINTENANCE (low priority, never a code fix).
 */

const BASE = 'https://www.ebay.com/sch/i.html';

export const PRESETS = [
	{
		// Bare keyword search: the simplest possible SRP URL shape.
		name: 'ebay_broad_nkw',
		url: `${BASE}?_nkw=laptop`,
	},
	{
		// Category-scoped (_sacat) with a price ceiling (_udhi). A different
		// param shape, and the price cap keeps the value distribution tight
		// enough that a nonsense mean is obvious.
		name: 'ebay_category_priced',
		url: `${BASE}?_nkw=headphones&_sacat=15052&_udhi=500`,
	},
	{
		// Buy-It-Now only (LH_BIN) with an explicit sort (_sop=15, price+shipping
		// lowest first). Fixed-price listings avoid auction prices that change
		// between the canary's own page loads.
		name: 'ebay_bin_sorted',
		url: `${BASE}?_nkw=running+shoes&LH_BIN=1&_sop=15`,
	},
];

/**
 * Minimum prices a healthy preset must yield.
 *
 * eBay pages ~60 listings per SRP, so 20 is comfortably below a healthy page
 * while still being far above what a partially-drifted selector would scrape.
 * Set too low, a selector matching one stray element would read as healthy.
 */
export const MIN_HEALTHY_PRICES = 20;

export default PRESETS;
