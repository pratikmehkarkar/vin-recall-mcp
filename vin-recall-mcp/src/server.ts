import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { z } from "zod";
import {
	checkRecallsOutputSchema,
	decodeVinOutputSchema,
	runCheckRecalls,
	runDecodeVin,
} from "./tools.ts";

// Node/Express Streamable HTTP entry point — replaces the Cloudflare
// Agents SDK's McpAgent/Durable Object wrapper (see git history for the
// prior src/index.ts). Tool logic in tools.ts is completely unaffected by
// this migration; only the transport wrapper changed.
//
// Runs in stateless mode (sessionIdGenerator: undefined): a fresh McpServer
// + StreamableHTTPServerTransport pair per request, matching the MCP SDK's
// own reference implementation (examples/server/simpleStatelessStreamableHttp).
// This fits the "stateless server, no bindings, no persistence" requirement
// this project already committed to under Cloudflare Workers just as well —
// these are read-only NHTSA lookups with no session state to track.
function buildServer(): McpServer {
	const server = new McpServer({
		name: "VIN Recall MCP",
		version: "1.0.0",
	});

	server.registerTool(
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
			// Both tools are pure read-only lookups against public NHTSA data —
			// without explicit annotations the MCP SDK defaults to
			// destructiveHint: true / idempotentHint: false, which would
			// misrepresent a harmless VIN lookup to clients that use these
			// hints to decide whether to prompt for confirmation.
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		async ({ vin }) => runDecodeVin(vin),
	);

	server.registerTool(
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
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		async ({ vin }) => runCheckRecalls(vin),
	);

	return server;
}

// createMcpExpressApp() (from the SDK) pre-applies express.json() body
// parsing and, since we bind to 127.0.0.1 below, DNS-rebinding protection
// on the Host header — both are relevant now that this runs as a real
// standalone HTTP process instead of behind Cloudflare's edge.
const app = createMcpExpressApp();

app.post("/mcp", async (req, res) => {
	const server = buildServer();
	try {
		const transport = new StreamableHTTPServerTransport({
			sessionIdGenerator: undefined,
		});
		await server.connect(transport);
		await transport.handleRequest(req, res, req.body);
		res.on("close", () => {
			transport.close();
			server.close();
		});
	} catch (err) {
		console.error("Error handling MCP request:", err);
		if (!res.headersSent) {
			res.status(500).json({
				jsonrpc: "2.0",
				error: { code: -32603, message: "Internal server error" },
				id: null,
			});
		}
	}
});

// Stateless mode has no session to resume/cancel, so GET (SSE resume) and
// DELETE (session teardown) aren't meaningful here — mirrors the SDK's own
// stateless example.
app.get("/mcp", (_req, res) => {
	res.status(405).json({
		jsonrpc: "2.0",
		error: { code: -32000, message: "Method not allowed." },
		id: null,
	});
});

app.delete("/mcp", (_req, res) => {
	res.status(405).json({
		jsonrpc: "2.0",
		error: { code: -32000, message: "Method not allowed." },
		id: null,
	});
});

app.use((_req, res) => {
	res.status(404).send("Not found");
});

const PORT = Number(process.env.PORT) || 8787;
const HOST = "127.0.0.1";
app.listen(PORT, HOST, () => {
	console.log(`VIN Recall MCP server listening on http://${HOST}:${PORT}/mcp`);
});
