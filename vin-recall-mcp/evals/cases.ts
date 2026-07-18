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
			"VIN for a vehicle configuration (2003 Honda Accord) with real open NHTSA recall campaigns returns a non-empty list plus the VIN-is-not-repair-confirmation disclaimer",
		tool: "check_recalls",
		vin: "1HGCM82633A004352",
		expectApiCall: true,
		expectIsError: false,
		expectStructured: { checked: true, make: "HONDA", model: "Accord", year: "2003" },
		expectRecallCountAtLeast: 1,
		expectTextIncludes: ["open recall campaign", "not confirmation that this specific VIN"],
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
