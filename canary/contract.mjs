/**
 * The canary result contract consumed by the triage harness.
 *
 * This mirrors ai_job_discovery's `canaries/result.py` on purpose: the harness
 * reads this JSON as data and never imports either project, so both projects
 * must emit the SAME document shape. If you add a classification here, mirror it
 * in the harness's `triage/constants.py` and in the project's `[[project]]`
 * classification buckets.
 *
 * The harness parses the LAST valid top-level JSON object printed on stdout, so
 * logging around the result is safe but the result must be printed last.
 */

/** Why the script is (or is not) healthy, ordered by detection layer. */
export const Classification = Object.freeze({
	HEALTHY: 'HEALTHY',
	// Layer 1: cannot reach the Chrome debug instance over CDP.
	ENVIRONMENT_CDP_DOWN: 'ENVIRONMENT_CDP_DOWN',
	// Layer 2: eBay served a bot-wall / captcha / interstitial instead of results.
	ENVIRONMENT_BLOCKED: 'ENVIRONMENT_BLOCKED',
	// Layer 3: page loaded but the expected results river is missing.
	URL_OR_STRUCTURE_DRIFT: 'URL_OR_STRUCTURE_DRIFT',
	// Layer 4: river present but no price element parses into a number.
	SCRAPER_SELECTOR_DRIFT: 'SCRAPER_SELECTOR_DRIFT',
	// Layer 5: prices parse but the widget does not render sane statistics.
	RENDER_DRIFT: 'RENDER_DRIFT',
	// Cross-preset: one preset's URL/params drifted while others stay healthy.
	CANARY_MAINTENANCE: 'CANARY_MAINTENANCE',
});

/**
 * Intended response per classification. The harness reads these as hints only;
 * it owns the actual routing decision in plain code.
 */
export const ACTIONS = Object.freeze({
	[Classification.HEALTHY]: 'none',
	[Classification.ENVIRONMENT_CDP_DOWN]: 'tell_user_start_chrome', // never a code fix
	[Classification.ENVIRONMENT_BLOCKED]: 'tell_user_bot_wall', // never a code fix
	[Classification.URL_OR_STRUCTURE_DRIFT]: 'propose_fix',
	[Classification.SCRAPER_SELECTOR_DRIFT]: 'propose_fix',
	[Classification.RENDER_DRIFT]: 'propose_fix',
	[Classification.CANARY_MAINTENANCE]: 'low_priority_alert', // never a code fix
});

/** The precondition layers, checked in order. The first to fail classifies. */
export const Layer = Object.freeze({
	CDP: 'CDP', // 1
	BLOCK: 'BLOCK', // 2
	RESULTS_CONTAINER: 'RESULTS_CONTAINER', // 3
	PRICE_PARSE: 'PRICE_PARSE', // 4
	WIDGET_RENDER: 'WIDGET_RENDER', // 5
});

/** Maps the first failing layer to its classification. */
export const LAYER_CLASSIFICATION = Object.freeze({
	[Layer.CDP]: Classification.ENVIRONMENT_CDP_DOWN,
	[Layer.BLOCK]: Classification.ENVIRONMENT_BLOCKED,
	[Layer.RESULTS_CONTAINER]: Classification.URL_OR_STRUCTURE_DRIFT,
	[Layer.PRICE_PARSE]: Classification.SCRAPER_SELECTOR_DRIFT,
	[Layer.WIDGET_RENDER]: Classification.RENDER_DRIFT,
});

/** Layer order, earliest first. Used to pick the classifying layer. */
const LAYER_ORDER = [
	Layer.CDP,
	Layer.BLOCK,
	Layer.RESULTS_CONTAINER,
	Layer.PRICE_PARSE,
	Layer.WIDGET_RENDER,
];

/** Classifications that mean "the environment is wrong", never a code fix. */
const ENVIRONMENT = new Set([
	Classification.ENVIRONMENT_CDP_DOWN,
	Classification.ENVIRONMENT_BLOCKED,
]);

/**
 * Outcome of running the layered chain against a single preset URL.
 *
 * `item_count` is the generic count the harness reads; `job_count` is emitted as
 * an alias so the harness's existing ai_job_discovery-shaped readers keep working.
 */
export function presetResult({
	name,
	url,
	healthy,
	itemCount = 0,
	failedLayer = null,
	classification = Classification.HEALTHY,
	evidence = {},
}) {
	return {
		name,
		url,
		healthy,
		item_count: itemCount,
		job_count: itemCount,
		failed_layer: failedLayer,
		classification,
		evidence,
	};
}

/** Pick the earliest (lowest-numbered) layer out of a list of failed layers. */
export function earliestLayer(layers) {
	for (const layer of LAYER_ORDER) {
		if (layers.includes(layer)) return layer;
	}
	return null;
}

/**
 * Decide the overall classification from per-preset outcomes.
 *
 * The cross-preset rule is what separates "the site changed" from "one of our
 * preset URLs went stale". Presets are deliberately built with DIFFERENT URL
 * param shapes (see presets.mjs), so:
 *
 *   - every preset failed              -> the markup/site changed  -> escalate
 *   - some failed, others still healthy with items -> that preset's URL drifted
 *     -> CANARY_MAINTENANCE (low priority, never a code fix)
 *
 * An environment failure short-circuits both: if we could not reach Chrome or
 * were served a bot-wall, we learned nothing about the code.
 */
export function aggregate(presets, { lastKnownGoodCommit = null } = {}) {
	if (presets.length === 0) {
		return canaryResult({
			classification: Classification.ENVIRONMENT_CDP_DOWN,
			healthy: false,
			escalate: true,
			summary: 'No presets ran; the canary could not reach a usable browser.',
			presets,
			lastKnownGoodCommit,
		});
	}

	const failed = presets.filter((p) => !p.healthy);

	if (failed.length === 0) {
		return canaryResult({
			classification: Classification.HEALTHY,
			healthy: true,
			escalate: false,
			summary: `All ${presets.length} presets healthy.`,
			presets,
			lastKnownGoodCommit,
		});
	}

	// Environment problems win outright: they tell us nothing about the code, so
	// they must never be reported as drift and never reach the fixer.
	const environmental = failed.find((p) => ENVIRONMENT.has(p.classification));
	if (environmental) {
		return canaryResult({
			classification: environmental.classification,
			healthy: false,
			escalate: true,
			summary: `${environmental.name}: ${environmental.classification} — environment problem, not a code change.`,
			presets,
			lastKnownGoodCommit,
		});
	}

	// Some presets still returned real items, so the script and the site markup
	// are fine; the failing preset's own URL/params are what drifted.
	const healthyWithItems = presets.filter((p) => p.healthy && p.item_count > 0);
	if (healthyWithItems.length > 0) {
		return canaryResult({
			classification: Classification.CANARY_MAINTENANCE,
			healthy: false,
			escalate: false,
			summary:
				`${failed.length} of ${presets.length} presets failed while ` +
				`${healthyWithItems.length} stayed healthy with items; the failing ` +
				`preset URL(s) drifted, not the scraper.`,
			presets,
			lastKnownGoodCommit,
		});
	}

	// Everything failed: classify on the earliest layer that broke, because a
	// missing river makes the price check meaningless.
	const layer = earliestLayer(failed.map((p) => p.failed_layer).filter(Boolean));
	const classification = LAYER_CLASSIFICATION[layer] ?? Classification.SCRAPER_SELECTOR_DRIFT;
	return canaryResult({
		classification,
		healthy: false,
		escalate: true,
		summary:
			`All ${presets.length} presets failed; earliest failing layer is ` +
			`${layer ?? 'unknown'} -> ${classification}.`,
		presets,
		lastKnownGoodCommit,
	});
}

/** The aggregate document the harness consumes. */
export function canaryResult({
	classification,
	healthy,
	escalate,
	summary,
	presets = [],
	lastKnownGoodCommit = null,
}) {
	return {
		classification,
		healthy,
		escalate,
		summary,
		action: ACTIONS[classification] ?? 'none',
		failed_presets: presets.filter((p) => !p.healthy).map((p) => p.name),
		presets,
		last_known_good_commit: lastKnownGoodCommit,
		checked_at: new Date().toISOString(),
	};
}
