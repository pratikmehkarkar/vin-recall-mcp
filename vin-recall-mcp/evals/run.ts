import {
	checkRecallsOutputSchema,
	decodeVinOutputSchema,
	runCheckRecalls,
	runDecodeVin,
} from "../src/tools.ts";
import { z } from "zod";
import { cases } from "./cases.ts";

// Runtime shape returned by runDecodeVin/runCheckRecalls — matches the MCP
// CallToolResult contract loosely enough for eval assertions without
// pulling in the MCP SDK types (this file must stay Node-runnable, see the
// note in src/tools.ts about why the eval suite imports from there and not
// from src/index.ts).
interface ToolResult {
	isError?: boolean;
	content?: { type: "text"; text: string }[];
	structuredContent?: Record<string, unknown>;
}

const DecodeVinStructured = z.object(decodeVinOutputSchema);
const CheckRecallsStructured = z.object(checkRecallsOutputSchema);

function runToolCase(vin: string, tool: "decode_vin" | "check_recalls"): Promise<ToolResult> {
	return tool === "decode_vin" ? runDecodeVin(vin) : runCheckRecalls(vin);
}

async function main() {
	let passed = 0;
	let failed = 0;

	for (const testCase of cases) {
		const failures: string[] = [];

		// Spy on global fetch to prove "malformed VIN -> no network call" for
		// real, rather than inferring it from response speed.
		const originalFetch = globalThis.fetch;
		let fetchCallCount = 0;
		globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
			fetchCallCount++;
			return originalFetch(...args);
		}) as typeof fetch;

		let result: ToolResult;
		try {
			result = await runToolCase(testCase.vin, testCase.tool);
		} catch (err) {
			failures.push(
				`threw instead of returning a result: ${err instanceof Error ? err.message : String(err)}`,
			);
			result = {};
		} finally {
			globalThis.fetch = originalFetch;
		}

		const madeApiCall = fetchCallCount > 0;
		if (madeApiCall !== testCase.expectApiCall) {
			failures.push(
				`expected expectApiCall=${testCase.expectApiCall} but fetch was called ${fetchCallCount} time(s)`,
			);
		}

		const isError = result.isError === true;
		if (isError !== testCase.expectIsError) {
			failures.push(`expected isError=${testCase.expectIsError} but got isError=${isError}`);
		}

		const text = result.content?.[0]?.text ?? "";
		for (const expected of testCase.expectTextIncludes ?? []) {
			if (!text.includes(expected)) {
				failures.push(
					`expected text content to include ${JSON.stringify(expected)}, got: ${JSON.stringify(text)}`,
				);
			}
		}

		const structured = result.structuredContent ?? {};
		for (const [key, expected] of Object.entries(testCase.expectStructured ?? {})) {
			const actual = structured[key];
			if (actual !== expected) {
				failures.push(
					`expected structuredContent.${key} === ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
				);
			}
		}
		for (const [key, expectedSubstring] of Object.entries(
			testCase.expectStructuredIncludes ?? {},
		)) {
			const actual = structured[key];
			if (typeof actual !== "string" || !actual.includes(expectedSubstring)) {
				failures.push(
					`expected structuredContent.${key} to include ${JSON.stringify(expectedSubstring)}, got ${JSON.stringify(actual)}`,
				);
			}
		}
		for (const key of testCase.expectStructuredPresent ?? []) {
			if (!(key in structured) || structured[key] === undefined) {
				failures.push(`expected structuredContent.${key} to be present`);
			}
		}
		for (const key of testCase.expectStructuredAbsent ?? []) {
			if (key in structured && structured[key] !== undefined) {
				failures.push(
					`expected structuredContent.${key} to be absent, got ${JSON.stringify(structured[key])}`,
				);
			}
		}
		if (testCase.expectRecallCountAtLeast !== undefined) {
			const recallCount = structured.recallCount;
			if (
				typeof recallCount !== "number" ||
				recallCount < testCase.expectRecallCountAtLeast
			) {
				failures.push(
					`expected structuredContent.recallCount >= ${testCase.expectRecallCountAtLeast}, got ${JSON.stringify(recallCount)}`,
				);
			}
		}

		// If the tool claims success (not isError) and returned structured
		// content, that content must actually satisfy the same Zod schema the
		// real MCP tool registration declares as its outputSchema — this
		// catches drift between the handler's return shape and the schema an
		// MCP client would validate against, which none of the field-by-field
		// checks above would catch on their own.
		if (!isError && result.structuredContent) {
			const schema =
				testCase.tool === "decode_vin" ? DecodeVinStructured : CheckRecallsStructured;
			const parsed = schema.safeParse(result.structuredContent);
			if (!parsed.success) {
				failures.push(
					`structuredContent does not satisfy the tool's outputSchema: ${parsed.error.message}`,
				);
			}
		}

		if (failures.length === 0) {
			passed++;
			console.log(`PASS  ${testCase.id}`);
		} else {
			failed++;
			console.log(`FAIL  ${testCase.id}`);
			console.log(`      ${testCase.description}`);
			for (const failure of failures) {
				console.log(`      - ${failure}`);
			}
		}
	}

	console.log("");
	console.log(`${passed}/${cases.length} passed`);

	if (failed > 0) {
		process.exitCode = 1;
	}
}

main();
