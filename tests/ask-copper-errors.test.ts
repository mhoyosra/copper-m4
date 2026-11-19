// @vitest-environment node
// When the model call fails, Ask Copper should say why in plain words (quota
// used up, service busy) instead of a vague "something went wrong".
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { finalValue } from "@/lib/ai/live";
import {
  BUSY_MESSAGE,
  describeAiError,
  GENERIC_MESSAGE,
  QUOTA_MESSAGE,
} from "@/lib/copper/assistant/errors";

let model: MockLanguageModelV4;
vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: () => () => model,
}));

describe("describeAiError", () => {
  it("recognises Google's quota error, bare or wrapped by the retry", () => {
    const quota = Object.assign(
      new Error("You exceeded your current quota, please check your plan"),
      { statusCode: 429 },
    );
    expect(describeAiError(quota)).toBe(QUOTA_MESSAGE);
    // The AI library wraps the real error after its retries.
    const wrapped = Object.assign(
      new Error("Failed after 3 attempts. Last error: quota exceeded"),
      { lastError: quota },
    );
    expect(describeAiError(wrapped)).toBe(QUOTA_MESSAGE);
    expect(describeAiError({ cause: { statusCode: 429 } })).toBe(QUOTA_MESSAGE);
    expect(
      describeAiError(
        new Error("Quota exceeded for metric: free_tier_requests"),
      ),
    ).toBe(QUOTA_MESSAGE);
  });

  it("recognises a busy model", () => {
    expect(
      describeAiError(
        Object.assign(
          new Error("This model is currently experiencing high demand."),
          {
            statusCode: 503,
          },
        ),
      ),
    ).toBe(BUSY_MESSAGE);
    expect(describeAiError(new Error("The model is overloaded"))).toBe(
      BUSY_MESSAGE,
    );
  });

  it("falls back to the generic message for anything else", () => {
    expect(describeAiError(new Error("Something odd"))).toBe(GENERIC_MESSAGE);
    expect(describeAiError(undefined)).toBe(GENERIC_MESSAGE);
    expect(describeAiError("boom")).toBe(GENERIC_MESSAGE);
    expect(describeAiError({ statusCode: 400, message: "bad request" })).toBe(
      GENERIC_MESSAGE,
    );
  });

  it("never leaks the raw error text to the shopper", () => {
    // A made-up key shaped like a real one. It is assembled here so the source
    // never contains a key-shaped string (secret scanners flag those).
    const fakeKey = ["AI", "zaSy", "x".repeat(35)].join("");
    const text = describeAiError(
      new Error(`quota exceeded for key ${fakeKey}`),
    );
    expect(text).not.toContain(fakeKey);
    expect(text).not.toMatch(/AIza/);
  });
});

describe("askCopper when the model call fails", () => {
  beforeEach(() => {
    vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "AIza-test-key");
    vi.spyOn(console, "info").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  async function replyWhenModelFailsWith(error: Error) {
    model = new MockLanguageModelV4({
      doStream: async () => {
        throw error;
      },
    });
    const { askCopper } = await import("@/lib/copper/assistant/ask");
    const result = await askCopper({
      messages: [{ role: "user", content: "hello" }],
      useTools: false,
    });
    return finalValue(result.progress);
  }

  it("says the quota is used up", async () => {
    const progress = await replyWhenModelFailsWith(
      new Error(
        "You exceeded your current quota, please check your plan and billing details.",
      ),
    );
    expect(progress.status).toBe("error");
    expect(progress.reply).toBe(QUOTA_MESSAGE);
  });

  it("says the service is busy", async () => {
    const progress = await replyWhenModelFailsWith(
      new Error("This model is currently experiencing high demand."),
    );
    expect(progress.reply).toBe(BUSY_MESSAGE);
  });

  it("keeps the generic message for other failures", async () => {
    const progress = await replyWhenModelFailsWith(
      new Error("Something odd happened"),
    );
    expect(progress.reply).toBe(GENERIC_MESSAGE);
  });
});
