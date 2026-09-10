import { describe, expect, test } from "bun:test";
import {
  isChatGptBackendPath,
  quickChatUpstreamUrl,
  relayQuickChatRequest,
} from "../src/quick-chat-relay";

describe("Quick Chat backend path", () => {
  test("accepts only ChatGPT backend paths", () => {
    expect(isChatGptBackendPath("/backend-api")).toBe(true);
    expect(isChatGptBackendPath("/backend-api/f/conversation")).toBe(true);
    expect(isChatGptBackendPath("/backend-api/models")).toBe(true);
    expect(isChatGptBackendPath("/v1/responses")).toBe(false);
    expect(isChatGptBackendPath("/backend-api-evil/f/conversation")).toBe(false);
  });

  test("preserves path and query while replacing only the origin", () => {
    expect(quickChatUpstreamUrl("http://localhost:8000/backend-api/f/conversation?foo=bar"))
      .toBe("https://chatgpt.com/backend-api/f/conversation?foo=bar");
  });
});

describe("Quick Chat relay", () => {
  test("forwards auth and body without forwarding hop-by-hop headers", async () => {
    let forwarded: Request | undefined;
    const response = await relayQuickChatRequest(
      new Request("http://localhost:8000/backend-api/f/conversation", {
        method: "POST",
        headers: {
          authorization: "Bearer test-secret",
          "content-type": "application/json",
          connection: "keep-alive",
          "x-test": "yes",
        },
        body: JSON.stringify({ action: "next", messages: [{ content: { parts: ["hello"] } }] }),
      }),
      async request => {
        forwarded = request;
        return new Response("data: [DONE]\n\n", {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
            "x-upstream": "yes",
          },
        });
      },
    );

    expect(forwarded).toBeDefined();
    expect(forwarded!.url).toBe("https://chatgpt.com/backend-api/f/conversation");
    expect(forwarded!.headers.get("authorization")).toBe("Bearer test-secret");
    expect(forwarded!.headers.get("connection")).toBeNull();
    expect(forwarded!.headers.get("x-test")).toBe("yes");
    expect(await forwarded!.text()).toContain("hello");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("data: [DONE]\n\n");
    expect(response.headers.get("x-upstream")).toBe("yes");
  });

  test("refuses unrelated paths before calling upstream", async () => {
    let calls = 0;
    const response = await relayQuickChatRequest(
      new Request("http://localhost:8000/v1/responses", { method: "POST", body: "{}" }),
      async () => {
        calls += 1;
        return new Response("unexpected");
      },
    );
    expect(response.status).toBe(404);
    expect(calls).toBe(0);
  });
});
