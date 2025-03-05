export const currencyMap: Map<string, string> = new Map([
	['$','USD'],     // default assumption
	['€','EUR'],
	['£','GBP'],
	['¥','JPY'],
	['元','CNY'],    // or '¥' in many cases
	// plus textual keywords:
	['dollar','USD'],
	['usa','USD'],
	['euro','EUR'],
	// etc.
]);

export interface CurrencyToken {
	type: "currency";
	currency: string;
}

export interface NumberToken {
	type: "number";
	value: number;
}

export type EvaluatedToken = CurrencyToken | NumberToken;
export type FinalToken = [CurrencyToken, NumberToken];


export function parsePriceText(text: string, currencyMap: Map<string, string>): void {
	let result: string[] = text.split(" ");
	// process each token
	var evaluatedTokens: Array<EvaluatedToken> = result.map((element: string) => {
		return evaluateToken(element, currencyMap);
	});
	// Verify at least one of evaluatedTokens is a CurrencyToken type
	const currencyTokens = evaluatedTokens.filter(token => token.type === "currency") as CurrencyToken[];
	if (currencyTokens.length === 0) {
		throw new Error("No currency token found in the input text string");
	}

	// Ensure all CurrencyTokens agree
	const uniqueCurrencies = new Set(currencyTokens.map(token => token.currency));
	if (uniqueCurrencies.size > 1) {
		throw new Error("Malformed input text string, conflicting currency information");
	}

	// Assuming there's only one currency token, find the first number token
	const numberToken = evaluatedTokens.find(token => token.type === "number") as NumberToken;
	if (!numberToken) {
		throw new Error("No number token found in the input text string");
	}

	// Create the final token
	const finalToken: FinalToken = [currencyTokens[0], numberToken];
}

function evaluateToken(token: string, currencyMap: Map<string, string>): EvaluatedToken {
	const normalizedToken = token.toLowerCase();
	if (currencyMap.has(normalizedToken)) {
		return { type: "currency", currency: currencyMap.get(normalizedToken)! };
	} else {
		const numberValue: number = parseFloat(normalizedToken);
		if (!isNaN(numberValue)) {
			return { type: "number", value: numberValue };
		}
		throw new Error("Invalid token");
	}
}
