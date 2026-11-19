// npm run setup-supabase: saves your Supabase project's URL and secret key to
// .env.local. The key is typed at a hidden prompt, so it never appears on screen,
// in the terminal history, or in a chat. The script never prints either value.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const FILE = ".env.local";
const NAMES = ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];

const rl = createInterface({ input: process.stdin, output: process.stdout });
let muted = false;
// While `muted`, swallow what is typed or pasted but keep the prompt itself.
const writeToOutput = rl._writeToOutput.bind(rl);
rl._writeToOutput = (text) => {
  if (!muted || text.startsWith("Secret key")) writeToOutput(text);
};
const lines = rl[Symbol.asyncIterator]();
async function ask(question) {
  rl.setPrompt(question);
  rl.prompt();
  const next = await lines.next();
  return next.value ?? "";
}

console.log("Supabase > your project > Project Settings > API keys.");
console.log(
  "The URL is the Project URL. The key is the SECRET key (service role), not the publishable one.\n",
);

// Accept the Project URL, or any address copied from the same page (like the
// one ending in /rest/v1/): only the project's base address is kept.
let url = "";
try {
  const parsed = new URL(
    (await ask("Project URL (https://xxxx.supabase.co): ")).trim(),
  );
  if (
    parsed.protocol === "https:" &&
    /^[a-z0-9-]+\.supabase\.co$/.test(parsed.hostname)
  ) {
    url = parsed.origin;
  }
} catch {
  // Not a URL at all: handled below.
}
if (!url) {
  console.error(
    "That doesn't look like a Supabase project URL. Nothing was saved.",
  );
  rl.close();
  process.exit(1);
}
muted = true;
const key = (await ask("Secret key (hidden as you paste): ")).trim();
muted = false;
process.stdout.write("\n");
rl.close();
if (key.startsWith("http")) {
  console.error(
    "That's a web address, not a key (it's probably still on your clipboard). Copy the SECRET key from Project Settings > API keys and run this again. Nothing was saved.",
  );
  process.exit(1);
}
if (key.startsWith("sb_publishable_")) {
  console.error(
    "That's the publishable key. This app needs the SECRET key (it starts with sb_secret_). Nothing was saved.",
  );
  process.exit(1);
}
if (!key.startsWith("sb_secret_") && !key.startsWith("eyJ")) {
  console.error(
    "That doesn't look like a Supabase secret key (it should start with sb_secret_). Nothing was saved.",
  );
  process.exit(1);
}
if (key.length < 20) {
  console.error("That key looks too short. Nothing was saved.");
  process.exit(1);
}

const kept = existsSync(FILE)
  ? readFileSync(FILE, "utf8")
      .split("\n")
      .filter((line) => line && !NAMES.some((n) => line.startsWith(`${n}=`)))
  : [];
writeFileSync(
  FILE,
  [...kept, `${NAMES[0]}=${url.replace(/\/$/, "")}`, `${NAMES[1]}=${key}`].join(
    "\n",
  ) + "\n",
);
console.log(
  `Saved to ${FILE}. Run "npm run env:check" to see the names (values stay masked).`,
);
