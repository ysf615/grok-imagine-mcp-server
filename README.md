# grok-imagine-mcp-server

MCP server that connects Claude to xAI **grok-imagine-image** for image generation and editing.

## Tools

- `grok_generate_image` — Generate images from a text prompt
- `grok_edit_image` — Edit an existing image with a text instruction

## Setup

```bash
npm install
npm run build
```

## Deploy on Railway

1. Fork or import this repo on [railway.app](https://railway.app)
2. Add environment variable: `XAI_API_KEY=your-key`
3. Railway gives you a URL like `https://your-app.up.railway.app`

## Connect to Claude

Add in Claude Desktop settings → Connectors:
```
https://your-app.up.railway.app/mcp
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| XAI_API_KEY | Yes | Your xAI API key from console.x.ai |
| PORT | No | HTTP port (default: 3000) |
| API_KEY | No | Bearer token to protect the /mcp endpoint |
