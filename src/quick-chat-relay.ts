import { spawnSync } from "node:child_process";

export const QUICK_CHAT_RELAY_HOST = "localhost";
export const QUICK_CHAT_RELAY_PORT = 8000;
export const QUICK_CHAT_BACKEND_BASE_URL = `http://${QUICK_CHAT_RELAY_HOST}:${QUICK_CHAT_RELAY_PORT}/backend-api`;
const CHATGPT_ORIGIN = "https://chatgpt.com";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
]);

export type QuickChatFetch = (request: Request) => Promise<Response>;

function endToEndHeaders(source: Headers): Headers {
  const headers = new Headers();
  for (const [name, value] of source) {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) headers.append(name, value);
  }
  headers.delete("content-length");
  return headers;
}

export function isChatGptBackendPath(pathname: string): boolean {
  return pathname === "/backend-api" || pathname.startsWith("/backend-api/");
}

export function quickChatUpstreamUrl(requestUrl: string): string {
  const incoming = new URL(requestUrl);
  if (!isChatGptBackendPath(incoming.pathname)) {
    throw new Error(`Quick Chat relay refuses non-ChatGPT backend path: ${incoming.pathname}`);
  }
  return new URL(`${incoming.pathname}${incoming.search}`, CHATGPT_ORIGIN).toString();
}

/**
 * Faithful HTTP relay for Codex desktop's embedded ChatGPT surface.
 *
 * Boundaries:
 * - request/response bodies are never logged
 * - Authorization/Cookie values are never logged
 * - no Access-Control-Allow-Origin is added
 * - only /backend-api and descendants are accepted
 */
export async function relayQuickChatRequest(
  request: Request,
  fetchUpstream: QuickChatFetch = fetch,
): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method === "CONNECT" || method === "TRACE") {
    return new Response("Method not allowed", { status: 405 });
  }

  let upstreamUrl: string;
  try {
    upstreamUrl = quickChatUpstreamUrl(request.url);
  } catch (error) {
    return new Response(error instanceof Error ? error.message : String(error), { status: 404 });
  }

  const headers = endToEndHeaders(request.headers);
  const body = method === "GET" || method === "HEAD"
    ? undefined
    : await request.arrayBuffer();

  const upstream = await fetchUpstream(new Request(upstreamUrl, {
    method,
    headers,
    ...(body !== undefined ? { body } : {}),
    signal: request.signal,
    // Never replay a credential-bearing request automatically to a redirect destination.
    redirect: "manual",
  }));

  const responseHeaders = endToEndHeaders(upstream.headers);
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

export interface QuickChatRelayServer {
  readonly port: number;
  stop(closeActiveConnections?: boolean): void;
}

export function startQuickChatRelay(
  fetchUpstream: QuickChatFetch = fetch,
): QuickChatRelayServer {
  const server = Bun.serve({
    hostname: QUICK_CHAT_RELAY_HOST,
    port: QUICK_CHAT_RELAY_PORT,
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/healthz") {
        return Response.json({
          status: "ok",
          service: "codex-chatgpt-web-quick-chat-relay",
          backend_base_url: QUICK_CHAT_BACKEND_BASE_URL,
        });
      }
      if (!isChatGptBackendPath(url.pathname)) return new Response("Not found", { status: 404 });
      try {
        return await relayQuickChatRequest(request, fetchUpstream);
      } catch (error) {
        // Omit request bodies, auth headers, cookies and query strings from diagnostics.
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[quick-chat] upstream failure path=${url.pathname}: ${message}`);
        return new Response("Quick Chat upstream unavailable", { status: 502 });
      }
    },
  });
  return server;
}

function launchMacCodex(): void {
  if (process.platform !== "darwin") {
    throw new Error("Quick Chat launch integration is currently implemented only for macOS");
  }
  const result = spawnSync(
    "open",
    [
      "--env",
      `CODEX_API_BASE_URL=${QUICK_CHAT_BACKEND_BASE_URL}`,
      "-b",
      "com.openai.codex",
    ],
    { stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Could not launch Codex desktop (open exited ${result.status ?? "unknown"})`);
  }
}

export async function runQuickChatCommand(args: string[]): Promise<void> {
  const action = args.shift() ?? "serve";
  if (args.length > 0) throw new Error(`Unknown quick-chat arguments: ${args.join(" ")}`);
  if (action !== "serve" && action !== "launch") {
    throw new Error("Quick Chat command must be: quick-chat <serve|launch>");
  }

  const relay = startQuickChatRelay();
  process.stdout.write(
    `Quick Chat relay listening on http://${QUICK_CHAT_RELAY_HOST}:${relay.port}/backend-api -> https://chatgpt.com/backend-api\n`,
  );

  if (action === "launch") {
    process.stdout.write(
      "Launching the Codex desktop bundle with CODEX_API_BASE_URL routed through the Quick Chat relay.\n",
    );
    launchMacCodex();
  } else {
    process.stdout.write(
      `To use it, fully quit Codex first, then launch:\nopen --env CODEX_API_BASE_URL=${QUICK_CHAT_BACKEND_BASE_URL} -b com.openai.codex\n`,
    );
  }

  await new Promise<void>(() => {});
}

if (import.meta.main) {
  await runQuickChatCommand(process.argv.slice(2));
}
