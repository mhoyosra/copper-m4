// Turns a failed model call into a message a shopper can act on. Google's
// free tier answers with a quota error (429) once the day's requests are used
// up, or "high demand" (503) when a model is busy; saying so beats "something
// went wrong".

/** Everything we can read from an error, including the ones it wraps. */
function describe(
  error: unknown,
  depth = 0,
): { status: number | null; text: string } {
  if (depth > 4 || error === null || error === undefined) {
    return { status: null, text: "" };
  }
  if (typeof error !== "object") return { status: null, text: String(error) };
  const e = error as {
    statusCode?: unknown;
    status?: unknown;
    message?: unknown;
    responseBody?: unknown;
    lastError?: unknown;
    cause?: unknown;
  };
  const own = [e.message, e.responseBody]
    .filter((v): v is string => typeof v === "string")
    .join(" ");
  const code =
    typeof e.statusCode === "number"
      ? e.statusCode
      : typeof e.status === "number"
        ? e.status
        : null;
  // A retried call wraps the real error as `lastError`, or as `cause`.
  const inner = describe(e.lastError ?? e.cause, depth + 1);
  return { status: code ?? inner.status, text: `${own} ${inner.text}` };
}

export const QUOTA_MESSAGE =
  "Copper has used up its AI quota for now, so I can't answer right now. Please try again later (the daily limit resets overnight), or ask your instructor to check the AI key.";

export const BUSY_MESSAGE =
  "The AI service is very busy right now, so I couldn't answer. Please try again in a minute.";

export const GENERIC_MESSAGE =
  "Sorry, something went wrong on my end. Please try again.";

/** The message to show a shopper when answering failed. */
export function describeAiError(error: unknown): string {
  const { status, text } = describe(error);
  if (
    status === 429 ||
    /quota|rate.?limit|resource.?exhausted|too many requests/i.test(text)
  ) {
    return QUOTA_MESSAGE;
  }
  if (
    status === 503 ||
    /high demand|overloaded|unavailable|try again later/i.test(text)
  ) {
    return BUSY_MESSAGE;
  }
  return GENERIC_MESSAGE;
}
