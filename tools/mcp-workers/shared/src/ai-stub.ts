// Build-time stand-in for the optional "ai" (Vercel AI SDK) peer of the
// agents package. Only the agents chat/AI paths import it, which these MCP
// workers never use; esbuild still needs the specifier to resolve. Each
// worker aliases "ai" here in wrangler.jsonc.
export function jsonSchema(): never {
  throw new Error("the 'ai' package is stubbed out in mcp-workers; the agents AI chat path is unsupported");
}
