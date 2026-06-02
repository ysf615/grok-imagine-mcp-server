#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { Request, Response } from "express";
import { z } from "zod";
import axios from "axios";

const XAI_API_BASE = "https://api.x.ai/v1";
const DEFAULT_MODEL = "grok-imagine-image";

function handleApiError(error: unknown): string {
  if (axios.isAxiosError(error)) {
    if (error.response) {
      const status = error.response.status;
      const detail = (error.response.data as { error?: { message?: string } })?.error?.message ?? JSON.stringify(error.response.data);
      switch (status) {
        case 401: return "Error: Invalid API key. Check your XAI_API_KEY environment variable.";
        case 403: return "Error: Permission denied.";
        case 429: return "Error: Rate limit exceeded. Please wait before making more requests.";
        case 400: return `Error: Bad request — ${detail}`;
        default:  return `Error: API request failed (HTTP ${status}) — ${detail}`;
      }
    }
    if (error.code === "ECONNABORTED") return "Error: Request timed out.";
  }
  return `Error: ${error instanceof Error ? error.message : String(error)}`;
}

const ASPECT_RATIOS = ["1:1","16:9","9:16","4:3","3:4","3:2","2:3","2:1","1:2","auto"] as const;
type AspectRatio = typeof ASPECT_RATIOS[number];
const RESOLUTIONS = ["1k","2k"] as const;
type Resolution = typeof RESOLUTIONS[number];

function buildMcpServer(): McpServer {
  const server = new McpServer({ name: "grok-imagine-mcp-server", version: "1.0.0" });

  const GenerateImageSchema = z.object({
    prompt: z.string().min(1).max(2000).describe("Text description of the image to generate"),
    n: z.number().int().min(1).max(10).default(1).describe("Number of images (1-10)"),
    aspect_ratio: z.enum(ASPECT_RATIOS).default("auto").describe("Aspect ratio: 1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3, 2:1, 1:2, auto"),
    resolution: z.enum(RESOLUTIONS).optional().describe("Resolution: 1k or 2k"),
    response_format: z.enum(["url","b64_json"]).default("url").describe("Return as URL or base64"),
  }).strict();

  type GenerateImageInput = z.infer<typeof GenerateImageSchema>;

  server.registerTool("grok_generate_image", {
    title: "Generate Image with Grok",
    description: "Generate images from a text prompt using xAI grok-imagine-image model.",
    inputSchema: GenerateImageSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (params: GenerateImageInput) => {
    try {
      const apiKey = process.env.XAI_API_KEY!;
      const body: Record<string, unknown> = {
        model: DEFAULT_MODEL,
        prompt: params.prompt,
        n: params.n,
        aspect_ratio: params.aspect_ratio,
        response_format: params.response_format,
      };
      if (params.resolution) body.resolution = params.resolution;
      const response = await axios.post(`${XAI_API_BASE}/images/generations`, body, {
        timeout: 120000,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      });
      const images = (response.data as { data: Array<{ url?: string; b64_json?: string }> }).data.map((img, i) => ({
        index: i,
        ...(img.url ? { url: img.url } : {}),
        ...(img.b64_json ? { b64_json: img.b64_json } : {}),
      }));
      const result = { images, model: DEFAULT_MODEL, count: images.length };
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }], structuredContent: result };
    } catch (error) {
      return { isError: true, content: [{ type: "text" as const, text: handleApiError(error) }] };
    }
  });

  const EditImageSchema = z.object({
    prompt: z.string().min(1).max(2000).describe("Edit instruction"),
    image_url: z.string().min(1).describe("Source image URL or base64 data URI"),
    aspect_ratio: z.enum(ASPECT_RATIOS).optional().describe("Override output aspect ratio"),
    response_format: z.enum(["url","b64_json"]).default("url").describe("Return as URL or base64"),
  }).strict();

  type EditImageInput = z.infer<typeof EditImageSchema>;

  server.registerTool("grok_edit_image", {
    title: "Edit Image with Grok",
    description: "Edit an existing image with a text instruction using xAI grok-imagine-image model.",
    inputSchema: EditImageSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (params: EditImageInput) => {
    try {
      const apiKey = process.env.XAI_API_KEY!;
      const body: Record<string, unknown> = {
        model: DEFAULT_MODEL,
        prompt: params.prompt,
        image: { url: params.image_url, type: "image_url" },
        response_format: params.response_format,
      };
      if (params.aspect_ratio) body.aspect_ratio = params.aspect_ratio;
      const response = await axios.post(`${XAI_API_BASE}/images/edits`, body, {
        timeout: 120000,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      });
      const img = (response.data as { data: Array<{ url?: string; b64_json?: string }> }).data[0];
      const result = { image: img.url ? { url: img.url } : { b64_json: img.b64_json }, model: DEFAULT_MODEL };
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }], structuredContent: result };
    } catch (error) {
      return { isError: true, content: [{ type: "text" as const, text: handleApiError(error) }] };
    }
  });

  return server;
}

async function main(): Promise<void> {
  if (!process.env.XAI_API_KEY) {
    process.stderr.write("ERROR: XAI_API_KEY environment variable is required.\n");
    process.exit(1);
  }
  const port = parseInt(process.env.PORT ?? "3000", 10);
  const protectKey = process.env.API_KEY;
  const app = express();
  app.use(express.json());

  if (protectKey) {
    app.use("/mcp", (req: Request, res: Response, next) => {
      if (req.headers.authorization !== `Bearer ${protectKey}`) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      next();
    });
  }

  app.get("/health", (_req: Request, res: Response) => res.json({ status: "ok" }));

  app.get("/.well-known/oauth-authorization-server", (_req: Request, res: Response) => {
    res.json({
      issuer: "https://grok-imagine-mcp-server-production.up.railway.app",
      response_types_supported: [],
      grant_types_supported: [],
      token_endpoint: "",
    });
  });

  app.get("/mcp", (_req: Request, res: Response) => {
    res.json({
      name: "grok-imagine-mcp-server",
      version: "1.0.0",
      protocol: "mcp",
      transport: "streamable-http",
      auth: "none",
    });
  });

  app.post("/mcp", async (req: Request, res: Response) => {
    const server = buildMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  app.listen(port, () => process.stderr.write(`grok-imagine-mcp-server listening on port ${port}\n`));
}

main().catch((error: unknown) => {
  process.stderr.write(`Server error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
