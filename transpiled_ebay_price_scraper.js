// ==UserScript==
// @name         eBay Price Scraper and Converter
// @namespace    http://tampermonkey.net/
// @version      1.1
// @description  Extracts, normalizes, and converts eBay prices to USD
// @author       Your Name
// @match        https://www.ebay.com/sch/*
// @grant        GM_xmlhttpRequest
// ==/UserScript==

(function() {
    'use strict';

    const LOG_LEVEL = 2; // 0: minimal, 1: basic, 2: debug

    function log(level, message) {
        if (level <= LOG_LEVEL) {
            console.log(message);
        }
    }

    log(1, "Tampermonkey script is running!");

    const currencyMap = new Map([
        ['$', 'USD'],
        ['€', 'EUR'],
        ['£', 'GBP'],
        ['¥', 'JPY'],
        ['元', 'CNY'],
        ['dollar', 'USD'],
        ['usa', 'USD'],
        ['euro', 'EUR']
    ]);

    function tokenPreprocess(token) {
        // Remove commas from the token
        token = token.replace(/,/g, '');

        // For each currency symbol, if the token starts or ends with it and is immediately adjacent to a valid number,
        // split the token into the currency symbol and the number.
        for (const symbol of currencyMap.keys()) {
            log(2, "Token: " + token + " - Checking symbol: " + symbol);
            // Check if token starts with the currency symbol.
            if (token.startsWith(symbol)) {
                log(2, "Token " + token + " starts with symbol: " + symbol);
                const numberPart = token.slice(symbol.length);
                const num = parseFloat(numberPart);
                if (!isNaN(num)) {
                    return [symbol, "" + num];
                }
            }
            // Check if token ends with the currency symbol.
            if (token.endsWith(symbol)) {
                log(2, "Token " + token + " ends with symbol: " + symbol);
                const numberPart = token.slice(0, token.length - symbol.length);
                const num = parseFloat(numberPart);
                if (!isNaN(num)) {
                    return [symbol, "" + num];
                }
            }
        }
        log(2, "Token " + token + " does not start or end with any currency symbol.");
        // If no splitting condition is met, return the token as a single-element array.
        return [token];
    }

    function evaluateToken(token, currencyMap) {
        if (currencyMap.has(token)) {
            log(2, "Token " + token + " is a currency symbol for " + currencyMap.get(token));
            return { type: "currency", currency: currencyMap.get(token) };
        }
        const numberValue = parseFloat(token);
        if (!isNaN(numberValue)) {
            log(2, "Token " + token + " is a number " + numberValue);
            return { type: "number", value: numberValue };
        }
        return null;
    }

    function normalizeToken(token) {
        var tokenNormalized = token.toLowerCase();
        tokenNormalized = tokenNormalized.trim();
        tokenNormalized = tokenNormalized.replace(",", '');
        return tokenNormalized;
    }

    function parsePriceText(text, currencyMap) {
        let tokens = text.split(/\s+/); // raw token strings
        tokens = tokens.map(token => normalizeToken(token)); // normalized token strings
        log(2, "Tokens normalized: " + tokens.join(";"));
        tokens = tokens.flatMap(token => tokenPreprocess(token)); // preprocessed token strings
        log(2, "Tokens pre-processed: " + tokens.join(";"));
        let evaluatedTokens = tokens.map(token => evaluateToken(token, currencyMap)).filter(token => token !== null);

        const currencyTokens = evaluatedTokens.filter(token => token.type === "currency");
        if (currencyTokens.length === 0) return null;

        const uniqueCurrencies = new Set(currencyTokens.map(token => token.currency));
        if (uniqueCurrencies.size > 1) return null;

        const numberToken = evaluatedTokens.find(token => token.type === "number");
        if (!numberToken) return null;

        return `${currencyTokens[0].currency} ${numberToken.value.toFixed(2)}`;
    }

    // The results river is the only region we want. Sponsored placeholders live in
    // `div.s-clipped[aria-hidden="true"]` outside this list, and the "Recently viewed
    // items" carousel below the river reuses `.s-card__price` — both must stay out of
    // the average.
    const RESULT_CONTAINERS = [
        "ul.srp-results",   // current markup (s-card)
        "#srp-river-results" // fallback if the ul class ever changes
    ];

    // Card-relative price selectors. Newest markup first, legacy selectors after,
    // so the script keeps working through A/B variants still serving s-item.
    const PRICE_SELECTORS = [
        ".s-card__price",
        ".s-item__price .POSITIVE",
        ".s-item__price"
    ];

    function findResultsRoot() {
        for (const selector of RESULT_CONTAINERS) {
            const root = document.querySelector(selector);
            if (root) {
                log(2, `Using results container: ${selector}`);
                return root;
            }
        }
        return null;
    }

    function collectPriceElements() {
        const root = findResultsRoot();
        if (!root) {
            log(1, "Results container not found.");
            return [];
        }

        for (const selector of PRICE_SELECTORS) {
            // One price per card: a card may also carry a struck-through "was" price
            // as a sibling span, which must not be counted.
            const cards = root.querySelectorAll("li.s-card, li.s-item");
            let elements = [];

            if (cards.length > 0) {
                cards.forEach(card => {
                    if (card.closest('[aria-hidden="true"]')) {
                        log(2, "Skipping aria-hidden (sponsored) card.");
                        return;
                    }
                    const price = card.querySelector(selector);
                    if (price) elements.push(price);
                });
            } else {
                elements = Array.from(root.querySelectorAll(selector))
                    .filter(el => !el.closest('[aria-hidden="true"]'));
            }

            if (elements.length > 0) {
                log(1, `Matched ${elements.length} prices via "${selector}".`);
                return elements;
            }
        }
        return [];
    }

    // ---------------------------------------------------------------- scraping

    function collectPrices() {
        const priceElements = collectPriceElements();
        const values = [];
        let currency = '';

        priceElements.forEach(priceElement => {
            const priceText = priceElement.textContent?.trim();
            if (!priceText) return;

            const parsedPrice = parsePriceText(priceText, currencyMap);
            if (!parsedPrice) {
                log(2, `Failed to parse price: ${priceText}`);
                return;
            }
            // Expected format is "USD 12.34"
            const parts = parsedPrice.split(' ');
            if (parts.length !== 2) return;
            const priceNumber = parseFloat(parts[1]);
            if (isNaN(priceNumber)) return;

            currency = parts[0];
            values.push(priceNumber);
        });

        log(1, `Collected ${values.length} prices.`);
        return { values, currency: currency || 'USD' };
    }

    // ------------------------------------------------------------------- stats

    function quantile(sorted, q) {
        if (sorted.length === 0) return NaN;
        const pos = (sorted.length - 1) * q;
        const lo = Math.floor(pos);
        const hi = Math.ceil(pos);
        return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
    }

    // Tukey fences. Chosen over fixed dollar thresholds so the cutoffs scale with
    // whatever is being searched — a $200 card and a $2000 card both get sane
    // defaults without the user setting numbers by hand.
    function iqrFences(values) {
        const sorted = [...values].sort((a, b) => a - b);
        const q1 = quantile(sorted, 0.25);
        const q3 = quantile(sorted, 0.75);
        const iqr = q3 - q1;
        return { lo: q1 - 1.5 * iqr, hi: q3 + 1.5 * iqr };
    }

    function computeStats(values, min, max) {
        const kept = values.filter(v => v >= min && v <= max);
        if (kept.length === 0) {
            return { mean: NaN, median: NaN, kept: 0, excluded: values.length };
        }
        const sorted = [...kept].sort((a, b) => a - b);
        return {
            mean: kept.reduce((s, v) => s + v, 0) / kept.length,
            median: quantile(sorted, 0.5),
            kept: kept.length,
            excluded: values.length - kept.length
        };
    }

    // ------------------------------------------------------------------ widget

    const WIDGET_ID = 'aarg-price-widget';

    const state = {
        values: [],
        currency: 'USD',
        dataMin: 0,
        dataMax: 0,
        min: 0,
        max: 0,
        collapsed: false
    };

    const els = {};

    function money(n) {
        if (isNaN(n)) return '—';
        return `${state.currency} ${n.toFixed(2)}`;
    }

    function styleEl(el, styles) {
        Object.assign(el.style, styles);
        return el;
    }

    function makeSlider(labelText, onInput) {
        const wrap = styleEl(document.createElement('div'), { marginTop: '10px' });

        const row = styleEl(document.createElement('div'), {
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'baseline',
            marginBottom: '2px'
        });
        const label = styleEl(document.createElement('span'), {
            fontSize: '11px',
            fontWeight: '600',
            color: '#767676',
            textTransform: 'uppercase',
            letterSpacing: '0.4px'
        });
        label.textContent = labelText;
        const readout = styleEl(document.createElement('span'), {
            fontSize: '12px',
            fontWeight: '700',
            color: '#111820',
            fontVariantNumeric: 'tabular-nums'
        });
        row.append(label, readout);

        const input = styleEl(document.createElement('input'), {
            width: '100%',
            margin: '0',
            accentColor: '#3665f3',
            cursor: 'pointer'
        });
        input.type = 'range';
        input.addEventListener('input', onInput);

        wrap.append(row, input);
        return { wrap, input, readout };
    }

    function makeButton(text, onClick) {
        const b = styleEl(document.createElement('button'), {
            flex: '1',
            padding: '6px 8px',
            fontSize: '12px',
            fontWeight: '600',
            color: '#3665f3',
            background: '#fff',
            border: '1px solid #3665f3',
            borderRadius: '16px',
            cursor: 'pointer',
            fontFamily: 'inherit'
        });
        b.type = 'button';
        b.textContent = text;
        b.addEventListener('click', onClick);
        return b;
    }

    function buildWidget() {
        const existing = document.getElementById(WIDGET_ID);
        if (existing) existing.remove();

        const root = styleEl(document.createElement('div'), {
            position: 'fixed',
            right: '16px',
            top: '90px',
            zIndex: '100000',
            width: '260px',
            boxSizing: 'border-box',
            padding: '12px 14px 14px',
            background: '#fff',
            color: '#111820',
            border: '1px solid #e5e5e5',
            borderRadius: '12px',
            boxShadow: '0 4px 16px rgba(0,0,0,0.16)',
            font: '400 13px/1.4 "Market Sans", Arial, sans-serif'
        });
        root.id = WIDGET_ID;

        // header ------------------------------------------------------------
        const head = styleEl(document.createElement('div'), {
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center'
        });
        const title = styleEl(document.createElement('span'), {
            fontSize: '12px',
            fontWeight: '700',
            textTransform: 'uppercase',
            letterSpacing: '0.5px',
            color: '#767676'
        });
        title.textContent = 'Price Analytics';
        const toggle = styleEl(document.createElement('button'), {
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
            fontSize: '16px',
            lineHeight: '1',
            color: '#767676',
            padding: '0 2px'
        });
        toggle.type = 'button';
        toggle.textContent = '–';
        toggle.setAttribute('aria-label', 'Collapse price analytics');
        toggle.addEventListener('click', () => {
            state.collapsed = !state.collapsed;
            els.body.style.display = state.collapsed ? 'none' : 'block';
            toggle.textContent = state.collapsed ? '+' : '–';
        });
        head.append(title, toggle);

        const body = document.createElement('div');

        // headline stat -------------------------------------------------------
        const mean = styleEl(document.createElement('div'), {
            fontSize: '26px',
            fontWeight: '700',
            margin: '6px 0 0',
            fontVariantNumeric: 'tabular-nums',
            letterSpacing: '-0.5px'
        });
        const sub = styleEl(document.createElement('div'), {
            fontSize: '12px',
            color: '#767676',
            marginBottom: '2px'
        });

        // sliders -------------------------------------------------------------
        const minS = makeSlider('Min price', () => {
            state.min = Number(minS.input.value);
            if (state.min > state.max) {
                state.max = state.min;
                maxS.input.value = String(state.max);
            }
            render();
        });
        const maxS = makeSlider('Max price', () => {
            state.max = Number(maxS.input.value);
            if (state.max < state.min) {
                state.min = state.max;
                minS.input.value = String(state.min);
            }
            render();
        });

        // actions -------------------------------------------------------------
        const actions = styleEl(document.createElement('div'), {
            display: 'flex',
            gap: '6px',
            marginTop: '12px'
        });
        actions.append(
            makeButton('Auto', () => { applyAutoBounds(); render(); }),
            makeButton('Reset', () => {
                state.min = state.dataMin;
                state.max = state.dataMax;
                syncSliders();
                render();
            }),
            makeButton('Rescan', () => refresh())
        );

        body.append(mean, sub, minS.wrap, maxS.wrap, actions);
        root.append(head, body);
        document.body.appendChild(root);

        Object.assign(els, { root, body, mean, sub, minS, maxS });
        positionWidget();
        return root;
    }

    // Sit just under the sticky global header rather than at a hardcoded offset,
    // since header height differs between signed-in/out and responsive widths.
    function positionWidget() {
        if (!els.root) return;
        const header = document.querySelector('#gh') || document.querySelector('.gh-header');
        let top = 16;
        if (header) {
            const rect = header.getBoundingClientRect();
            top = Math.max(16, rect.bottom + 12);
        }
        els.root.style.top = `${top}px`;
    }

    function syncSliders() {
        const { minS, maxS } = els;
        if (!minS) return;
        // step=1 against integer min/max keeps every thumb position on-grid. A
        // derived step (e.g. range/200) does not divide the range evenly, so the
        // browser silently snaps values off-target — which both skews the filter
        // and desyncs the thumb from the readout.
        [minS, maxS].forEach(s => {
            s.input.min = String(Math.floor(state.dataMin));
            s.input.max = String(Math.ceil(state.dataMax));
            s.input.step = '1';
        });
        minS.input.value = String(state.min);
        maxS.input.value = String(state.max);
    }

    function applyAutoBounds() {
        const { lo, hi } = iqrFences(state.values);
        state.min = Math.max(state.dataMin, Math.floor(lo));
        state.max = Math.min(state.dataMax, Math.ceil(hi));
        syncSliders();
    }

    function render() {
        const { mean, sub, minS, maxS } = els;
        if (!mean) return;

        const stats = computeStats(state.values, state.min, state.max);
        mean.textContent = money(stats.mean);
        sub.textContent = `median ${money(stats.median)} · ${stats.kept} of ` +
            `${state.values.length} listings · ${stats.excluded} excluded`;
        minS.readout.textContent = money(state.min);
        maxS.readout.textContent = money(state.max);
    }

    function refresh() {
        const { values, currency } = collectPrices();
        state.values = values;
        state.currency = currency;

        if (values.length === 0) {
            if (els.mean) {
                els.mean.textContent = '—';
                els.sub.textContent = 'No prices found on this page.';
            }
            return;
        }

        // Round outward to whole dollars so the bounds land on the slider's
        // integer grid; a raw float here shows up snapped in the thumb while
        // state keeps the unrounded value, and the two drift apart.
        state.dataMin = Math.floor(Math.min(...values));
        state.dataMax = Math.ceil(Math.max(...values));
        applyAutoBounds();
        render();
    }

    function initWidget() {
        buildWidget();
        refresh();

        let queued = false;
        const reposition = () => {
            if (queued) return;
            queued = true;
            requestAnimationFrame(() => { queued = false; positionWidget(); });
        };
        window.addEventListener('scroll', reposition, { passive: true });
        window.addEventListener('resize', reposition, { passive: true });
    }

    // The river renders after the shell, so a fixed delay is unreliable. Poll until
    // prices exist, then bail out rather than alerting on an empty page.
    const POLL_INTERVAL_MS = 500;
    const MAX_POLL_ATTEMPTS = 20; // ~10s

    function waitForResults(attempt = 0) {
        if (collectPriceElements().length > 0) {
            initWidget();
            return;
        }
        if (attempt >= MAX_POLL_ATTEMPTS) {
            log(1, "Gave up waiting for results to render.");
            return;
        }
        setTimeout(() => waitForResults(attempt + 1), POLL_INTERVAL_MS);
    }

    waitForResults();
})();
