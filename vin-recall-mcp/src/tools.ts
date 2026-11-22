import { z } from "zod";

// Pure tool logic for decode_vin and check_recalls — no MCP/Workers-runtime
// imports here (no "agents/mcp", no "@modelcontextprotocol/sdk"), so this
// module can be imported directly under plain Node by the eval suite
// (evals/) without pulling in Workers-only globals like `cloudflare:workers`.
// src/index.ts wires these functions into MCP tool registrations.

export const NHTSA_FETCH_TIMEOUT_MS = 9000;
const NHTSA_FETCH_TIMEOUT_LABEL = `${NHTSA_FETCH_TIMEOUT_MS / 1000}s`;

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

type DecodedFields = Partial<Record<keyof typeof DECODE_FIELD_MAP, string>>;

export const decodeVinOutputSchema = {
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

const recallCampaignSchema = z.object({
	campaignNumber: z.string(),
	component: z.string().optional(),
	summary: z.string(),
	consequence: z.string().optional(),
	remedy: z.string().optional(),
	reportDate: z.string().optional(),
	parkIt: z.boolean().optional(),
	parkOutside: z.boolean().optional(),
});

export const checkRecallsOutputSchema = {
	vin: z.string(),
	checked: z.boolean(),
	make: z.string().optional(),
	model: z.string().optional(),
	year: z.string().optional(),
	recallCount: z.number().optional(),
	recalls: z.array(recallCampaignSchema).optional(),
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

function endWithPeriod(text: string): string {
	return /[.!?]$/.test(text) ? text : `${text}.`;
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

type DecodeOutcome =
	| { status: "error"; message: string }
	| { status: "not_found"; note: string }
	| { status: "found"; decoded: DecodedFields; errorCode?: string; errorText?: string };

// Shared by both tools: decode_vin exposes this directly, check_recalls uses
// it internally to turn a VIN into the make/model/year the recalls endpoint
// needs. Kept as a single implementation so both tools apply the exact same
// validation, timeout, and "no data" handling.
async function decodeVinFromNhtsa(normalizedVin: string): Promise<DecodeOutcome> {
	let data: NhtsaDecodeVinResponse;
	try {
		const response = await fetchWithTimeout(
			`https://vpic.nhtsa.dot.gov/api/vehicles/decodevin/${normalizedVin}?format=json`,
			NHTSA_FETCH_TIMEOUT_MS,
		);
		if (!response.ok) {
			return {
				status: "error",
				message: `NHTSA vPIC API returned an error (HTTP ${response.status}). Try again in a moment.`,
			};
		}
		data = (await response.json()) as NhtsaDecodeVinResponse;
	} catch (err) {
		const timedOut = err instanceof Error && err.name === "AbortError";
		return {
			status: "error",
			message: timedOut
				? `The NHTSA vPIC API is slow or unavailable right now (timed out after ${NHTSA_FETCH_TIMEOUT_LABEL}). Try again in a moment.`
				: "Could not reach the NHTSA vPIC API. Try again in a moment.",
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
		const reason = endWithPeriod(errorText ?? "NHTSA returned no decodable data for this VIN.");
		const note = `${reason} This can happen for pre-1981 vehicles (before the 17-character VIN standard), some foreign-market vehicles, or a mistyped VIN.`;
		return { status: "not_found", note };
	}

	const decoded: DecodedFields = {};
	for (const key of Object.keys(DECODE_FIELD_MAP) as (keyof typeof DECODE_FIELD_MAP)[]) {
		const value = values.get(DECODE_FIELD_MAP[key]);
		if (value) decoded[key] = value;
	}

	return { status: "found", decoded, errorCode, errorText };
}

interface NhtsaRecallRecord {
	NHTSACampaignNumber?: string | null;
	Component?: string | null;
	Summary?: string | null;
	Consequence?: string | null;
	Remedy?: string | null;
	ReportReceivedDate?: string | null;
	parkIt?: boolean;
	// NHTSA's own field name — note the capital "S" in "OutSide".
	parkOutSide?: boolean;
}

interface NhtsaRecallsResponse {
	Count?: number;
	results?: NhtsaRecallRecord[];
}

type RecallCampaign = z.infer<typeof recallCampaignSchema>;

// NHTSA's free-text fields often contain double spaces between sentences
// and stray newlines; collapse them so the text output reads cleanly.
function cleanText(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

// ReportReceivedDate is day-first (DD/MM/YYYY — e.g. "27/06/2019"), which a
// US reader or a model would easily misread as month-first ("06/03/2019" is
// 6 March, not June 3). Normalize to unambiguous ISO YYYY-MM-DD; anything
// that doesn't match the expected shape is passed through untouched rather
// than guessed at.
function normalizeReportDate(raw: string): string {
	const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(raw);
	if (!match) return raw;
	const [, day, month, year] = match;
	if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > 31) return raw;
	return `${year}-${month}-${day}`;
}

// Above this many campaigns, long free-text fields in the *text* content are
// shortened so the result stays a reasonable size for a model's context
// (a 2003 Honda Accord has 24 campaigns, ~40k chars untruncated). Campaigns
// are never dropped, and structuredContent always carries the full text.
const RECALL_COMPACT_THRESHOLD = 5;
const COMPACT_SUMMARY_CHARS = 400;
const COMPACT_CONSEQUENCE_CHARS = 250;
const COMPACT_REMEDY_CHARS = 200;

// Cut at the last word boundary before maxChars and mark with an ellipsis,
// so a shortened field never ends mid-word.
function shorten(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const cut = text.slice(0, maxChars);
	const lastSpace = cut.lastIndexOf(" ");
	const base = lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut;
	return `${base.replace(/[\s,;:.]+$/, "")}…`;
}

function formatCampaignBlock(campaign: RecallCampaign, index: number, compact: boolean): string {
	const fit = (text: string, maxChars: number) => (compact ? shorten(text, maxChars) : text);
	const lines = [
		`[${index + 1}] Campaign ${campaign.campaignNumber}${campaign.component ? ` — ${campaign.component}` : ""}`,
	];
	if (campaign.reportDate) lines.push(`Report date: ${campaign.reportDate}`);
	if (campaign.parkIt) lines.push("PARK IT: do not drive until the remedy is completed.");
	if (campaign.parkOutside)
		lines.push(
			"PARK OUTSIDE: park outside and away from structures until the remedy is completed.",
		);
	lines.push(`Summary: ${fit(campaign.summary, COMPACT_SUMMARY_CHARS)}`);
	if (campaign.consequence)
		lines.push(`Consequence: ${fit(campaign.consequence, COMPACT_CONSEQUENCE_CHARS)}`);
	if (campaign.remedy) lines.push(`Remedy: ${fit(campaign.remedy, COMPACT_REMEDY_CHARS)}`);
	return lines.join("\n");
}

// Builds the human/model-readable text content for a non-empty recall list.
// MCP clients (including Claude) primarily read the text content, so every
// campaign's details must appear here — not only in structuredContent.
function formatRecallsText(
	headline: string,
	disclaimer: string,
	recalls: RecallCampaign[],
): string {
	const compact = recalls.length > RECALL_COMPACT_THRESHOLD;
	const sections = [`${headline}\n${disclaimer}`];

	// Safety-critical flags go first so they can't get lost in a long list.
	const parkIt = recalls.filter((r) => r.parkIt).map((r) => r.campaignNumber);
	const parkOutside = recalls.filter((r) => r.parkOutside).map((r) => r.campaignNumber);
	const warnings: string[] = [];
	if (parkIt.length > 0) {
		warnings.push(
			`WARNING — PARK IT: NHTSA advises owners of affected vehicles not to drive them until the remedy is completed (campaign${parkIt.length === 1 ? "" : "s"} ${parkIt.join(", ")}).`,
		);
	}
	if (parkOutside.length > 0) {
		warnings.push(
			`WARNING — PARK OUTSIDE: NHTSA advises owners of affected vehicles to park outside and away from structures (fire risk) until the remedy is completed (campaign${parkOutside.length === 1 ? "" : "s"} ${parkOutside.join(", ")}).`,
		);
	}
	if (warnings.length > 0) {
		warnings.push(
			"Whether this specific VIN's remedy has already been completed can be checked at https://www.nhtsa.gov/recalls.",
		);
		sections.push(warnings.join("\n"));
	}

	recalls.forEach((campaign, i) => sections.push(formatCampaignBlock(campaign, i, compact)));

	if (compact) {
		sections.push(
			`Because this vehicle has ${recalls.length} campaigns, long summary/consequence/remedy text above is shortened (marked "…"). Full text is in the structured result and at https://www.nhtsa.gov/recalls.`,
		);
	}

	return sections.join("\n\n");
}

// The actual per-tool logic, extracted as standalone functions so both the
// MCP tool registration in index.ts and the eval suite (evals/) can call the
// exact same code path — the eval suite imports these directly rather than
// duplicating handler logic or requiring a running server.
export async function runDecodeVin(vin: string) {
	const normalizedVin = vin.trim().toUpperCase();

	if (!VIN_PATTERN.test(normalizedVin)) {
		return {
			isError: true,
			content: [
				{
					type: "text" as const,
					text: `"${vin}" is not a valid VIN: expected exactly 17 characters, letters and digits only, excluding I, O, and Q.`,
				},
			],
		};
	}

	const outcome = await decodeVinFromNhtsa(normalizedVin);

	if (outcome.status === "error") {
		return { isError: true, content: [{ type: "text" as const, text: outcome.message }] };
	}

	if (outcome.status === "not_found") {
		const summary = `No decode data found for VIN ${normalizedVin}.`;
		return {
			structuredContent: {
				found: false,
				vin: normalizedVin,
				summary,
				note: outcome.note,
			},
			content: [{ type: "text" as const, text: `${summary} ${outcome.note}` }],
		};
	}

	const { decoded, errorCode, errorText } = outcome;
	const headline = [decoded.year, decoded.make, decoded.model].filter(Boolean).join(" ");
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
		content: [{ type: "text" as const, text: note ? `${summary}\n\n${note}` : summary }],
	};
}

export async function runCheckRecalls(vin: string) {
	const normalizedVin = vin.trim().toUpperCase();

	if (!VIN_PATTERN.test(normalizedVin)) {
		return {
			isError: true,
			content: [
				{
					type: "text" as const,
					text: `"${vin}" is not a valid VIN: expected exactly 17 characters, letters and digits only, excluding I, O, and Q.`,
				},
			],
		};
	}

	const decodeOutcome = await decodeVinFromNhtsa(normalizedVin);

	if (decodeOutcome.status === "error") {
		return {
			isError: true,
			content: [
				{
					type: "text" as const,
					text: `Could not decode this VIN to look up recalls: ${decodeOutcome.message}`,
				},
			],
		};
	}

	if (decodeOutcome.status === "not_found") {
		const summary = `Could not check recalls for VIN ${normalizedVin}: the vehicle could not be decoded.`;
		return {
			structuredContent: {
				vin: normalizedVin,
				checked: false,
				summary,
				note: decodeOutcome.note,
			},
			content: [{ type: "text" as const, text: `${summary} ${decodeOutcome.note}` }],
		};
	}

	const { make, model, year } = decodeOutcome.decoded;
	if (!make || !model || !year) {
		const summary = `Could not check recalls for VIN ${normalizedVin}: NHTSA did not return a complete make/model/year for this vehicle.`;
		const note =
			"A recall lookup requires make, model, and year. Try decode_vin on this VIN to see what NHTSA did return.";
		return {
			structuredContent: { vin: normalizedVin, checked: false, summary, note },
			content: [{ type: "text" as const, text: `${summary} ${note}` }],
		};
	}

	const recallsUrl = new URL("https://api.nhtsa.gov/recalls/recallsByVehicle");
	recallsUrl.searchParams.set("make", make);
	recallsUrl.searchParams.set("model", model);
	recallsUrl.searchParams.set("modelYear", year);

	let recallsData: NhtsaRecallsResponse;
	try {
		const response = await fetchWithTimeout(recallsUrl.toString(), NHTSA_FETCH_TIMEOUT_MS);
		// NHTSA's recalls endpoint returns HTTP 400 both for a genuinely
		// empty "zero recall campaigns" result and for an unrecognized
		// make/model — the response body ({Count, results}) is the same
		// shape either way, so we parse the body for 200 and 400 alike and
		// only treat other statuses as real failures.
		if (!response.ok && response.status !== 400) {
			return {
				isError: true,
				content: [
					{
						type: "text" as const,
						text: `NHTSA recalls API returned an error (HTTP ${response.status}). Try again in a moment.`,
					},
				],
			};
		}
		recallsData = (await response.json()) as NhtsaRecallsResponse;
	} catch (err) {
		const timedOut = err instanceof Error && err.name === "AbortError";
		return {
			isError: true,
			content: [
				{
					type: "text" as const,
					text: timedOut
						? `The NHTSA recalls API is slow or unavailable right now (timed out after ${NHTSA_FETCH_TIMEOUT_LABEL}). Try again in a moment.`
						: "Could not reach the NHTSA recalls API. Try again in a moment.",
				},
			],
		};
	}

	const recalls = (recallsData.results ?? []).map((record) => {
		const campaign: RecallCampaign = {
			campaignNumber: isMeaningfulValue(record.NHTSACampaignNumber)
				? record.NHTSACampaignNumber.trim()
				: "UNKNOWN",
			summary: isMeaningfulValue(record.Summary)
				? cleanText(record.Summary)
				: "No summary provided by NHTSA.",
		};
		if (isMeaningfulValue(record.Component)) campaign.component = cleanText(record.Component);
		if (isMeaningfulValue(record.Consequence))
			campaign.consequence = cleanText(record.Consequence);
		if (isMeaningfulValue(record.Remedy)) campaign.remedy = cleanText(record.Remedy);
		if (isMeaningfulValue(record.ReportReceivedDate))
			campaign.reportDate = normalizeReportDate(record.ReportReceivedDate.trim());
		if (typeof record.parkIt === "boolean") campaign.parkIt = record.parkIt;
		if (typeof record.parkOutSide === "boolean") campaign.parkOutside = record.parkOutSide;
		return campaign;
	});

	const vehicleDesc = `${year} ${make} ${model}`;

	if (recalls.length === 0) {
		const summary = `No open recall campaigns found for this vehicle (${vehicleDesc}).`;
		return {
			structuredContent: {
				vin: normalizedVin,
				checked: true,
				make,
				model,
				year,
				recallCount: 0,
				recalls: [],
				summary,
			},
			content: [{ type: "text" as const, text: summary }],
		};
	}

	const summary = `${recalls.length} open recall campaign${recalls.length === 1 ? "" : "s"} found for this vehicle (${vehicleDesc}).`;
	const disclaimer =
		"These are campaigns issued for this make/model/year configuration, not confirmation that this specific VIN's vehicle was repaired.";

	return {
		structuredContent: {
			vin: normalizedVin,
			checked: true,
			make,
			model,
			year,
			recallCount: recalls.length,
			recalls,
			summary,
			note: disclaimer,
		},
		content: [{ type: "text" as const, text: formatRecallsText(summary, disclaimer, recalls) }],
	};
}
