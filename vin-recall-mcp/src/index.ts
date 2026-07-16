import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";

const NHTSA_FETCH_TIMEOUT_MS = 9000;

// Standard VIN alphabet excludes I, O, and Q (too easily confused with 1, 0, D).
const VIN_PATTERN = /^[A-HJ-NPR-Z0-9]{17}$/;

interface NhtsaDecodeVariable {
	Variable: string;
	Value: string | null;
}

interface NhtsaDecodeVinResponse {
	Results?: NhtsaDecodeVariable[];
}

// Maps our clean output keys to the NHTSA "Variable" label they come from.
const DECODE_FIELD_MAP = {
	make: "Make",
	model: "Model",
	year: "Model Year",
	bodyClass: "Body Class",
	engineCylinders: "Engine Number of Cylinders",
	fuelType: "Fuel Type - Primary",
	driveType: "Drive Type",
	plantCountry: "Plant Country",
} as const;

const decodeVinOutputSchema = {
	found: z.boolean(),
	vin: z.string(),
	make: z.string().optional(),
	model: z.string().optional(),
	year: z.string().optional(),
	bodyClass: z.string().optional(),
	engineCylinders: z.string().optional(),
	fuelType: z.string().optional(),
	driveType: z.string().optional(),
	plantCountry: z.string().optional(),
	summary: z.string(),
	note: z.string().optional(),
};

// NHTSA marks "no data for this field" as an empty string or the literal
// string "Not Applicable" rather than omitting the field, so both need to be
// filtered out to get a clean object.
function isMeaningfulValue(value: string | null | undefined): value is string {
	if (!value) return false;
	const trimmed = value.trim();
	return trimmed !== "" && trimmed.toLowerCase() !== "not applicable";
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetch(url, { signal: controller.signal });
	} finally {
		clearTimeout(timer);
	}
}

// Define our MCP agent with tools
export class MyMCP extends McpAgent {
	server = new McpServer({
		name: "VIN Recall MCP",
		version: "1.0.0",
	});

	async init() {
		this.server.registerTool(
			"decode_vin",
			{
				title: "Decode VIN",
				description:
					"Decode a 17-character US vehicle VIN into make, model, year, body class, " +
					"engine cylinders, fuel type, drive type, and assembly plant country, using " +
					"the NHTSA vPIC database. Covers US-market vehicles built from 1981 onward " +
					"(the 17-character VIN standard); pre-1981 and some foreign-market vehicles " +
					"may return partial or no data. Decoded fields are manufacturer-submitted and " +
					"individual fields may be missing even for a successfully decoded VIN.",
				inputSchema: {
					vin: z
						.string()
						.describe(
							"A 17-character US vehicle VIN (letters and digits, excluding I, O, and Q).",
						),
				},
				outputSchema: decodeVinOutputSchema,
			},
			async ({ vin }) => {
				const normalizedVin = vin.trim().toUpperCase();

				if (!VIN_PATTERN.test(normalizedVin)) {
					return {
						isError: true,
						content: [
							{
								type: "text",
								text: `"${vin}" is not a valid VIN: expected exactly 17 characters, letters and digits only, excluding I, O, and Q.`,
							},
						],
					};
				}

				let data: NhtsaDecodeVinResponse;
				try {
					const response = await fetchWithTimeout(
						`https://vpic.nhtsa.dot.gov/api/vehicles/decodevin/${normalizedVin}?format=json`,
						NHTSA_FETCH_TIMEOUT_MS,
					);
					if (!response.ok) {
						return {
							isError: true,
							content: [
								{
									type: "text",
									text: `NHTSA vPIC API returned an error (HTTP ${response.status}). Try again in a moment.`,
								},
							],
						};
					}
					data = await response.json();
				} catch (err) {
					const timedOut = err instanceof Error && err.name === "AbortError";
					return {
						isError: true,
						content: [
							{
								type: "text",
								text: timedOut
									? "The NHTSA vPIC API is slow or unavailable right now (timed out after 9s). Try again in a moment."
									: "Could not reach the NHTSA vPIC API. Try again in a moment.",
							},
						],
					};
				}

				const values = new Map<string, string>();
				for (const result of data.Results ?? []) {
					if (isMeaningfulValue(result.Value)) {
						values.set(result.Variable, result.Value.trim());
					}
				}

				const errorCode = values.get("Error Code");
				const errorText = values.get("Error Text");
				const make = values.get(DECODE_FIELD_MAP.make);

				if (!make) {
					const reason = errorText ?? "NHTSA returned no decodable data for this VIN.";
					const reasonSentence = /[.!?]$/.test(reason) ? reason : `${reason}.`;
					const note = `${reasonSentence} This can happen for pre-1981 vehicles (before the 17-character VIN standard), some foreign-market vehicles, or a mistyped VIN.`;
					const summary = `No decode data found for VIN ${normalizedVin}.`;
					return {
						structuredContent: {
							found: false,
							vin: normalizedVin,
							summary,
							note,
						},
						content: [{ type: "text", text: `${summary} ${note}` }],
					};
				}

				const decoded: Partial<Record<keyof typeof DECODE_FIELD_MAP, string>> = {};
				for (const key of Object.keys(
					DECODE_FIELD_MAP,
				) as (keyof typeof DECODE_FIELD_MAP)[]) {
					const value = values.get(DECODE_FIELD_MAP[key]);
					if (value) decoded[key] = value;
				}

				const headline = [decoded.year, decoded.make, decoded.model]
					.filter(Boolean)
					.join(" ");
				const details = [
					decoded.bodyClass,
					decoded.engineCylinders ? `${decoded.engineCylinders}-cyl` : undefined,
					decoded.fuelType,
					decoded.driveType,
				].filter(Boolean);

				let summary = headline || `VIN ${normalizedVin}`;
				if (details.length > 0) summary += ` — ${details.join(", ")}`;
				if (decoded.plantCountry) summary += ` (built in ${decoded.plantCountry})`;

				// Error Code "0" means NHTSA considers this a clean decode; any other
				// code is a warning about the VIN or the decode, not a hard failure.
				const isCleanDecode = errorCode === "0";
				const note = isCleanDecode
					? undefined
					: `Decoded fields are manufacturer-submitted and may be incomplete${
							errorText ? ` (NHTSA note: ${errorText})` : ""
						}.`;

				return {
					structuredContent: {
						found: true,
						vin: normalizedVin,
						...decoded,
						summary,
						...(note ? { note } : {}),
					},
					content: [{ type: "text", text: note ? `${summary}\n\n${note}` : summary }],
				};
			},
		);
	}
}

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const url = new URL(request.url);

		if (url.pathname === "/mcp") {
			return MyMCP.serve("/mcp").fetch(request, env, ctx);
		}

		return new Response("Not found", { status: 404 });
	},
};
