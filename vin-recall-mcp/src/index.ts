import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import {
	checkRecallsOutputSchema,
	decodeVinOutputSchema,
	runCheckRecalls,
	runDecodeVin,
} from "./tools";

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
			async ({ vin }) => runDecodeVin(vin),
		);

		this.server.registerTool(
			"check_recalls",
			{
				title: "Check Vehicle Recalls",
				description:
					"List open safety recall campaigns for a vehicle by VIN, using the NHTSA " +
					"Recalls database. Decodes the VIN internally to get make/model/year, then " +
					"looks up campaigns for that vehicle configuration. Important: results are " +
					"recall campaigns issued for the make/model/year configuration — this does " +
					"NOT confirm whether this specific VIN's vehicle was actually repaired at a " +
					"dealer. Always describe results as 'open recall campaigns for this vehicle,' " +
					"never as whether the car 'is' or 'isn't' fixed.",
				inputSchema: {
					vin: z
						.string()
						.describe(
							"A 17-character US vehicle VIN (letters and digits, excluding I, O, and Q). " +
								"The VIN is decoded internally to determine make/model/year for the recall lookup.",
						),
				},
				outputSchema: checkRecallsOutputSchema,
			},
			async ({ vin }) => runCheckRecalls(vin),
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
