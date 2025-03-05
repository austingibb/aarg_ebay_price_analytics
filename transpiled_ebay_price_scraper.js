// ==UserScript==
// @name         eBay Price Scraper and Converter
// @namespace    http://tampermonkey.net/
// @version      1.0
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

    function scrapeAndConvertPrice() {
        log(1, "Scraping price elements...");
        let priceElements = document.querySelectorAll(".s-item__price .POSITIVE");

        if (priceElements.length === 0) {
            log(1, "No price elements found.");
            return;
        }

        log(1, `Found ${priceElements.length} price elements.`);

        let total = 0;
        let count = 0;
        let currency = '';

        priceElements.forEach(priceElement => {
            let priceText = priceElement.textContent?.trim();
            if (!priceText) {
                log(1, "Empty price text, skipping...");
                return;
            }

            log(1, `Processing price: ${priceText}`);
            let parsedPrice = parsePriceText(priceText, currencyMap);
            if (parsedPrice) {
                log(1, `Parsed price: ${parsedPrice}`);
                // Expected format is "USD 12.34"
                const parts = parsedPrice.split(' ');
                if (parts.length === 2) {
                    currency = parts[0];
                    const priceNumber = parseFloat(parts[1]);
                    if (!isNaN(priceNumber)) {
                        total += priceNumber;
                        count++;
                    }
                }
            } else {
                log(1, `Failed to parse price: ${priceText}`);
            }
        });

        if (count > 0) {
            let average = total / count;
            alert(`Average price: ${currency} ${average.toFixed(2)}`);
        } else {
            alert("No valid prices found.");
        }
    }

    setTimeout(scrapeAndConvertPrice, 2000);
})();
