// Eval cases for decode_vin and check_recalls. Each case hits the real NHTSA
// APIs (no mocking of NHTSA itself — the point is to prove the tool logic
// survives NHTSA's actual response shapes and quirks, not a fake of them).
// Only `fetch` call *count* is spied on, to prove the "malformed VIN never
// reaches the network" requirement — response bodies are always real.

export interface EvalCase {
	id: string;
	description: string;
	tool: "decode_vin" | "check_recalls";
	vin: string;
	// Whether this case is expected to make at least one real fetch call.
	// false only for input that should be rejected by validation before any
	// network request — proves "no API call made" for malformed VINs.
	expectApiCall: boolean;
	expectIsError: boolean;
	// Substrings the text content must include (case-sensitive).
	expectTextIncludes?: string[];
	// Exact-match checks against top-level structuredContent keys.
	expectStructured?: Record<string, unknown>;
	// Substring checks against string-valued structuredContent keys.
	expectStructuredIncludes?: Record<string, string>;
	// Keys that must be present on structuredContent (any value, incl. undefined-but-set).
	expectStructuredPresent?: string[];
	// Keys that must be absent (or undefined) on structuredContent.
	expectStructuredAbsent?: string[];
	// For check_recalls: minimum number of recall campaigns expected.
	expectRecallCountAtLeast?: number;
	// For check_recalls: every campaign in structuredContent.recalls must
	// also appear in the *text* content (campaign number + the opening of its
	// summary) — clients like Claude mainly read text, so a campaign that
	// only exists in structuredContent is effectively invisible to the model.
	expectEveryCampaignInText?: boolean;
	// Upper bound on text content length, to keep long recall lists a
	// reasonable size for a model's context.
	expectTextMaxLength?: number;
}

export const cases: EvalCase[] = [
	{
		id: "decode-modern-good",
		description: "Known-good modern VIN (2024 Mazda CX-5) decodes cleanly with no caveat note",
		tool: "decode_vin",
		vin: "JM3KFBCM1R0123456",
		expectApiCall: true,
		expectIsError: false,
		expectStructured: { found: true, make: "MAZDA", model: "CX-5", year: "2024" },
		expectStructuredIncludes: { bodyClass: "Sport Utility" },
		expectStructuredAbsent: ["note"],
	},
	{
		id: "decode-tesla-partial",
		description:
			"Tesla VIN decodes with make/model/year correct but NHTSA's own Error Code is non-clean, so the manufacturer-submitted/partial-data note must be attached",
		tool: "decode_vin",
		vin: "5YJ3E1EA1KF317000",
		expectApiCall: true,
		expectIsError: false,
		expectStructured: { found: true, make: "TESLA", model: "Model 3", year: "2019" },
		expectStructuredPresent: ["note"],
	},
	{
		id: "decode-truck",
		description: "Truck VIN (2011 Ford F-150) decodes with correct make/model/bodyClass",
		tool: "decode_vin",
		vin: "1FTFW1ET5BFC10312",
		expectApiCall: true,
		expectIsError: false,
		expectStructured: { found: true, make: "FORD", model: "F-150", year: "2011" },
		expectStructuredIncludes: { bodyClass: "Pickup" },
	},
	{
		id: "decode-motorcycle",
		description:
			"Motorcycle VIN (2007 Harley-Davidson Street Glide) decodes cleanly; fields that don't apply to motorcycles (e.g. Drive Type) are correctly absent without triggering a partial-data note",
		tool: "decode_vin",
		vin: "1HD1KB4177Y602188",
		expectApiCall: true,
		expectIsError: false,
		expectStructured: {
			found: true,
			make: "HARLEY-DAVIDSON",
			model: "Street Glide",
			year: "2007",
		},
		expectStructuredIncludes: { bodyClass: "Motorcycle" },
		expectStructuredAbsent: ["note", "driveType"],
	},
	{
		id: "decode-malformed-wrong-length",
		description:
			"Malformed VIN (wrong length) is rejected by input validation with zero network calls",
		tool: "decode_vin",
		vin: "SHORT123",
		expectApiCall: false,
		expectIsError: true,
		expectTextIncludes: ["not a valid VIN"],
	},
	{
		id: "decode-malformed-pre1980-length",
		description:
			"A real pre-1980 VIN (e.g. this 1969 Mustang-style VIN) is shorter than the 17-character standard introduced in 1981, so it is caught by length validation the same as any other malformed VIN — it never reaches NHTSA at all. This is the realistic manifestation of the epic's 'pre-1980 VIN' case: pre-1980 VINs cannot be well-formed 17-character VINs by definition.",
		tool: "decode_vin",
		vin: "9F02F100001",
		expectApiCall: false,
		expectIsError: true,
		expectTextIncludes: ["not a valid VIN"],
	},
	{
		id: "decode-well-formed-not-found",
		description:
			"Well-formed but undecodable VIN (nonsense manufacturer prefix) returns a clean not-found result surfacing NHTSA's own error text, not a crash or empty object",
		tool: "decode_vin",
		vin: "11111111111111111",
		expectApiCall: true,
		expectIsError: false,
		expectStructured: { found: false },
		expectTextIncludes: ["No decode data found", "Manufacturer is not registered"],
	},
	{
		id: "recalls-known-recalls",
		description:
			"VIN for a vehicle configuration (2003 Honda Accord, 24 campaigns) with real open NHTSA recall campaigns returns every campaign's details (number, component, summary, report date) in the text content — not just a count — plus the VIN-is-not-repair-confirmation disclaimer, shortened to a reasonable length without dropping campaigns. Report dates are normalized from NHTSA's day-first DD/MM/YYYY to ISO (06/03/2019 -> 2019-03-06).",
		tool: "check_recalls",
		vin: "1HGCM82633A004352",
		expectApiCall: true,
		expectIsError: false,
		expectStructured: { checked: true, make: "HONDA", model: "Accord", year: "2003" },
		expectRecallCountAtLeast: 20,
		expectTextIncludes: [
			"open recall campaign",
			"not confirmation that this specific VIN",
			"Campaign 19V182000 — AIR BAGS:FRONTAL:DRIVER SIDE:INFLATOR MODULE",
			"Summary: Honda (American Honda Motor Co.) is recalling",
			"Report date: 2019-03-06",
			"is shortened",
		],
		expectEveryCampaignInText: true,
		expectTextMaxLength: 25000,
	},
	{
		id: "recalls-park-it-warning",
		description:
			"VIN for a vehicle configuration (2006 Ford Ranger) with Takata 'do not drive' campaigns surfaces a PARK IT warning at the top of the text content, before the per-campaign list",
		tool: "check_recalls",
		vin: "1FTYR10U26PA12345",
		expectApiCall: true,
		expectIsError: false,
		expectStructured: { checked: true, make: "FORD", model: "Ranger", year: "2006" },
		expectRecallCountAtLeast: 1,
		expectTextIncludes: ["WARNING — PARK IT", "18V022000", "PARK IT: do not drive"],
		expectEveryCampaignInText: true,
		expectTextMaxLength: 25000,
	},
	{
		id: "recalls-park-outside-warning",
		description:
			"VIN for a vehicle configuration (2019 Hyundai Tucson) with an ABS-module fire-risk campaign (20V543000) surfaces a PARK OUTSIDE warning at the top of the text content and on the campaign block itself. Single campaign, so text is not shortened.",
		tool: "check_recalls",
		vin: "KM8J33A47KU012345",
		expectApiCall: true,
		expectIsError: false,
		expectStructured: { checked: true, make: "HYUNDAI", model: "Tucson", year: "2019" },
		expectRecallCountAtLeast: 1,
		expectTextIncludes: [
			"WARNING — PARK OUTSIDE",
			"20V543000",
			"PARK OUTSIDE: park outside and away from structures",
			"Report date: 2020-09-04",
		],
		expectEveryCampaignInText: true,
		expectTextMaxLength: 25000,
	},
	{
		id: "recalls-zero-recalls",
		description:
			"VIN for a vehicle configuration (2024 Mazda CX-5) with zero open NHTSA recall campaigns returns an explicit 'no recalls found' result, never a bare empty array",
		tool: "check_recalls",
		vin: "JM3KFBCM1R0123456",
		expectApiCall: true,
		expectIsError: false,
		expectStructured: {
			checked: true,
			recallCount: 0,
			make: "MAZDA",
			model: "CX-5",
			year: "2024",
		},
		expectTextIncludes: ["No open recall campaigns found"],
	},
];
