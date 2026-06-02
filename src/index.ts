#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";
import axios from "axios";

const XAI_API_BASE = "https://api.x.ai/v1";
const DEFAULT_MODEL = "grok-imagine-image";

function handleApiError(error) {
  if (error.response) {
    const status = error.response.status;
    const detail = error.response.data?.error?.message ?? JSON.stringify(error.response.data);
    switch (status) {
      case 401: return "Error: Invalid API key. Check your XAI_API_KEY environment variable.";
      case 403: return "Error: Permission denied.";
      case 429: return "Error: Rate limit exceeded. Please wait before making more requests.";
      case 400: return "Error: Bad request — " + detail;
      default:  return "Error: API request failed (HTTP " + status + ") — " + detail;
    }
  }
  if (error.code === "ECONNABORTED") return "Error: Request timed out.";
  return "Error: " + (error instanceof Error ? error.message : String(error));
}

var AspectRatio;
(function(AspectRatio) {
  AspectRatio["SQUARE"]      = "1:1";
  AspectRatio["WIDE_16_9"]   = "16:9";
  AspectRatio["TALL_9_16"]   = "9:16";
  AspectRatio["STANDARD_4_3"]= "4:3";
  AspectRatio["PORTRAIT_3_4"]= "3:4";
  AspectRatio["PHOTO_3_2"]   = "3:2";
  AspectRatio["PORTRAIT_2_3"]= "2:3";
  AspectRatio["BANNER_2_1"]  = "2:1";
  AspectRatio["TALL_1_2"]    = "1:2";
  AspectRatio["AUTO"]        = "auto";
})(AspectRatio || (AspectRatio = {}));

var Resolution;
(function(Resolution) {
  Resolution["ONE_K"] = "1k";
  Resolution["TWO_K"] = "2k";
})(Resolution || (Resolution = {}));

function buildMcpServer() {
  const server = new McpServer({ name: "grok-imagine-mcp-server", version: "1.0.0" });

  const GenerateImageSchema = z.object({
    prompt: z.string().min(1).max(2000).describe("Text description of the image to generate"),
    n: z.number().int().min(1).max(10).default(1).describe("Number of images (1-10)"),
    aspect_ratio: z.nativeEnum(AspectRatio).default(AspectRatio.AUTO).describe("Aspect ratio: 1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3, 2:1, 1:2, auto"),
    resolution: z.nativeEnum(Resolution).optional().describe("Resolution: 1k or 2k"),
    response_format: z.enum(["url","b64_json"]).default("url").describe("Return as URL or base64"),
  }).strict();

  server.registerTool("grok_generate_image", {
    title: "Generate Image with Grok",
    description: "Generate images from a text prompt using xAI grok-imagine-image model.",
    inputSchema: GenerateImageSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (params) => {
    try {
      const apiKey = process.env.XAI_API_KEY;
      const body = { model: DEFAULT_MODEL, prompt: params.prompt, n: params.n, aspect_ratio: params.aspect_ratio, response_format: params.response_format === "b64_json" ? "b64_json" : "url" };
      if (params.resolution) body.resolution = params.resolution;
      const response = await axios.post(XAI_API_BASE + "/images/generations", body, { timeout: 120000, headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey } });
      const images = response.data.data.map((img, i) => ({ index: i, ...(img.url ? { url: img.url } : {}), ...(img.b64_json ? { b64_json: img.b64_json } : {}) }));
      const result = { images, model: DEFAULT_MODEL, count: images.length };
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: handleApiError(error) }] };
    }
  });

  const EditImageSchema = z.object({
    prompt: z.string().min(1).max(2000).describe("Edit instruction"),
    image_url: z.string().min(1).describe("Source image URL or base64 data URI"),
    aspect_ratio: z.nativeEnum(AspectRatio).optional().describe("Override output aspect ratio"),
    response_format: z.enum(["url","b64_json"]).default("url").describe("Return as URL or base64"),
  }).strict();

  server.registerTool("grok_edit_image", {
    title: "Edit Image with Grok",
    description: "Edit an existing image with a text instruction using xAI grok-imagine-image model.",
    inputSchema: EditImageSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (params) => {
    try {
      const apiKey = process.env.XAI_API_KEY;
      const body = { model: DEFAULT_MODEL, prompt: params.prompt, image: { url: params.image_url, type: "image_url" }, response_format: params.response_format === "b64_json" ? "b64_json" : "url" };
      if (params.aspect_ratio) body.aspect_ratio = params.aspect_ratio;
      const response = await axios.post(XAI_API_BASE + "/images/edits", body, { timeout: 120000, headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey } });
      const img = response.data.data[0];
      const result = { image: img.url ? { url: img.url } : { b64_json: img.b64_json }, model: DEFAULT_MODEL };
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: handleApiError(error) }] };
    }
  });

  return server;
}

async function main() {
  if (!process.env.XAI_API_KEY) {
    process.stderr.write("ERROR: XAI_API_KEY environment variable is required.\nGet your key at https://console.x.ai/\n");
    process.exit(1);
  }
  const port = parseInt(process.env.PORT ?? "3000", 10);
  const protectKey = process.env.API_KEY;
  const app = express();
  app.use(express.json());
  if (protectKey) {
    app.use("/mcp", (req, res, next) => {
      if (req.headers.authorization !== "Bearer " + protectKey) { res.status(401).json({ error: "Unauthorized" }); return; }
      next();
    });
  }
  app.get("/health", (_req, res) => res.json({ status: "ok", server: "grok-imagine-mcp-server" }));
  app.post("/mcp", async (req, res) => {
    const server = buildMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  app.listen(port, () => process.stderr.write("grok-imagine-mcp-server listening on http://localhost:" + port + "/mcp\n"));
}

main().catch((error) => {
  process.stderr.write("Server error: " + (error instanceof Error ? error.message : String(error)) + "\n");
  process.exit(1);
});
