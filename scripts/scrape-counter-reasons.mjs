import { mkdir, writeFile } from "node:fs/promises";

const API_URL = "https://dota2.fandom.com/api.php";
const OUTPUT_PATH = new URL("../data/counter-reasons.json", import.meta.url);
const CATEGORY = "Category:Counters";
const REQUEST_DELAY_MS = 450;
const MAX_REASON_LENGTH = 280;
const patch = process.argv.find((argument) => argument.startsWith("--patch="))?.split("=")[1] || "unknown";

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function apiRequest(parameters) {
  const query = new URLSearchParams({
    ...parameters,
    format: "json",
    origin: "*",
  });
  const response = await fetch(`${API_URL}?${query}`, {
    headers: {
      Accept: "application/json",
      "User-Agent": "Draftor counter snapshot builder",
    },
  });

  if (!response.ok) {
    throw new Error(`Fandom API request failed: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

async function getCounterPages() {
  const pages = [];
  let continuation = null;

  do {
    const parameters = {
      action: "query",
      list: "categorymembers",
      cmtitle: CATEGORY,
      cmnamespace: "0",
      cmlimit: "max",
    };
    if (continuation) Object.assign(parameters, continuation);

    const payload = await apiRequest(parameters);
    pages.push(...(payload.query?.categorymembers || []));
    continuation = payload.continue || null;
    await sleep(REQUEST_DELAY_MS);
  } while (continuation);

  return pages
    .map((page) => page.title)
    .filter((title) => title.endsWith("/Counters"));
}

async function getWikitext(title) {
  const payload = await apiRequest({
    action: "query",
    formatversion: "2",
    prop: "revisions",
    rvprop: "content",
    rvslots: "main",
    titles: title,
  });
  const pages = Array.isArray(payload.query?.pages) ? payload.query.pages : Object.values(payload.query?.pages || {});
  const page = pages[0];
  return page?.revisions?.[0]?.slots?.main?.content || "";
}

function heroSlug(title) {
  return title
    .replace(/\/Counters$/i, "")
    .trim()
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function cleanWikitext(value) {
  return value
    .replace(/<!--.*?-->/gs, "")
    .replace(/\[\[(?:[^\]|]+\|)?([^\]]+)\]\]/g, "$1")
    .replace(/\[https?:\/\/[^\s\]]+\s+([^\]]+)\]/g, "$1")
    .replace(/\{\{([^{}]+)\}\}/g, (_, body) => {
      const parts = body.split("|").map((part) => part.trim());
      const template = parts.shift()?.toLowerCase() || "";
      if (["h", "hero", "hero icon", "a", "ability", "ability link", "i", "item", "item link"].includes(template)) {
        return parts.find((part) => part && !part.includes("=")) || "";
      }
      return parts.find((part) => part && !part.includes("=")) || "";
    })
    .replace(/\{(?:a|ability|i|item|h|hero)\|([^{}|]+)\}\}?/gi, "$1")
    .replace(/<ref[^>]*>.*?<\/ref>/gs, "")
    .replace(/<[^>]+>/g, "")
    .replace(/'{2,}/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function templateLabels(value, allowedTemplates) {
  const labels = [];
  for (const match of value.matchAll(/\{\{([^{}]+)\}\}/g)) {
    const parts = match[1].split("|").map((part) => part.trim());
    const template = parts.shift()?.toLowerCase() || "";
    if (!allowedTemplates.includes(template)) continue;
    const label = parts.find((part) => part && !part.includes("="));
    if (label) labels.push(label);
  }
  return [...new Set(labels)];
}

function heroLabel(value) {
  const match = value.match(/\{\{hero label\|([^|}]+)/i);
  return match?.[1]?.trim() || "";
}

function isGenericSection(text) {
  return /^(others|items|notes|general|strategy|situational)$/i.test(text);
}

function parseReasons(title, wikitext) {
  const lines = wikitext.split(/\r?\n/);
  const counters = [];
  let inBadAgainst = false;
  let currentCounter = null;

  for (const line of lines) {
    const labeledHero = heroLabel(line);
    if (inBadAgainst && labeledHero) {
      currentCounter = {
        hero: heroSlug(labeledHero),
        name: labeledHero,
        reasons: [],
      };
      counters.push(currentCounter);
      continue;
    }

    const heading = line.match(/^(={2,6})\s*(.*?)\s*\1\s*$/);
    if (heading) {
      const level = heading[1].length;
      const text = cleanWikitext(heading[2]);
      if (level <= 2) {
        inBadAgainst = /bad against|counters?/i.test(text);
        currentCounter = null;
      } else if (inBadAgainst && level === 3 && text) {
        if (isGenericSection(text)) {
          currentCounter = null;
          continue;
        }
        currentCounter = {
          hero: heroSlug(text),
          name: text,
          reasons: [],
        };
        counters.push(currentCounter);
      }
      continue;
    }

    if (!inBadAgainst || !currentCounter) continue;
    const bullet = line.match(/^\s*[*#]+\s+(.+)$/);
    if (!bullet) continue;

    const reason = cleanWikitext(bullet[1]);
    const heroLabels = templateLabels(bullet[1], ["h", "hero", "hero icon"]);
    const targetCounters = heroLabels.length
      ? heroLabels.map((label) => ({ hero: heroSlug(label), name: label, reasons: [] }))
      : currentCounter
        ? [currentCounter]
        : [];

    for (const counter of targetCounters) {
      const existing = counters.find((candidate) => candidate.hero === counter.hero);
      const target = existing || counter;
      if (!existing) counters.push(target);
      if (reason.length >= 20 && !target.reasons.includes(reason)) {
        target.reasons.push(reason.slice(0, MAX_REASON_LENGTH));
      }
    }
  }

  return counters
    .map((counter) => ({
      ...counter,
      reasons: counter.reasons.slice(0, 3),
    }))
    .filter((counter) => counter.hero && !isGenericSection(counter.name) && counter.reasons.length);
}

async function main() {
  console.log(`Collecting pages from ${CATEGORY}...`);
  const pages = await getCounterPages();
  const records = [];

  for (const [index, title] of pages.entries()) {
    console.log(`[${index + 1}/${pages.length}] ${title}`);
    const wikitext = await getWikitext(title);
    const counters = parseReasons(title, wikitext);
    records.push({
      enemyHero: heroSlug(title),
      source: `https://dota2.fandom.com/wiki/${encodeURIComponent(title.replaceAll(" ", "_"))}`,
      counters,
    });
    await sleep(REQUEST_DELAY_MS);
  }

  await mkdir(new URL("../data/", import.meta.url), { recursive: true });
  await writeFile(
    OUTPUT_PATH,
    `${JSON.stringify({ patch, source: "Dota 2 Wiki / Fandom", generated_at: new Date().toISOString(), records }, null, 2)}\n`,
  );
  console.log(`Wrote ${records.length} hero pages to ${OUTPUT_PATH.pathname}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
