export const ARCHIVE_API =
  "https://rollcall.com/wp-json/factbase/v1/twitter";
export const TRUMPS_TRUTH_URL = "https://trumpstruth.org/";
export const PROFILE_URL = "https://truthsocial.com/@realDonaldTrump";
export const USERNAME = "realDonaldTrump";
export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;

const MAX_PAGES = 50;
const TRUMPS_TRUTH_MAX_PAGES = 5;

function dateOnly(date) {
  return date.toISOString().slice(0, 10);
}

function isTextPost(item) {
  const text = item?.text?.trim();
  if (!text || item.platform !== "Truth Social") {
    return false;
  }

  return (
    !/^\[(?:video|photo|image|audio)\]$/i.test(text) &&
    !/^RT\s+@/i.test(text)
  );
}

function cleanText(text) {
  return text
    .replace(/\\r\\n|\\n|\\r/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeHtml(html) {
  return cleanText(
    html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>\s*<p[^>]*>/gi, "\n\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, "\"")
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&#(\d+);/g, (_, number) =>
        String.fromCodePoint(Number(number)),
      )
      .replace(/&#x([\da-f]+);/gi, (_, number) =>
        String.fromCodePoint(Number.parseInt(number, 16)),
      ),
  );
}

function easternDateToIso(value) {
  const match = value.match(
    /^([A-Z][a-z]+) (\d{1,2}), (\d{4}), (\d{1,2}):(\d{2}) (AM|PM)$/,
  );
  if (!match) {
    throw new Error(`Unexpected Trump's Truth date: ${value}`);
  }

  const months = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  const [, monthName, day, year, hourValue, minute, meridiem] = match;
  const month = months.indexOf(monthName);
  let hour = Number(hourValue) % 12;
  if (meridiem === "PM") {
    hour += 12;
  }

  const targetUtc = Date.UTC(
    Number(year),
    month,
    Number(day),
    hour,
    Number(minute),
  );
  let instant = targetUtc;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const parts = Object.fromEntries(
      formatter
        .formatToParts(new Date(instant))
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, Number(part.value)]),
    );
    const renderedUtc = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
    );
    instant += targetUtc - renderedUtc;
  }

  return new Date(instant).toISOString();
}

function normalizePost(item) {
  return {
    id: String(item.id || item.document_id),
    createdAt: item.date,
    text: cleanText(item.text),
    url:
      item.post_url ||
      `https://truthsocial.com/@${USERNAME}/posts/${item.id}`,
    deleted: Boolean(item.deleted_flag),
    deletedAt: item.social?.deleted_date || null,
  };
}

export function parseTrumpsTruthHtml(html) {
  const chunks = html.split(
    /(?=<div class="status"\s+data-status-url="https:\/\/trumpstruth\.org\/statuses\/)/,
  );
  const posts = [];

  for (const chunk of chunks) {
    const originalUrl = chunk.match(
      /href="https:\/\/truthsocial\.com\/@realDonaldTrump\/(\d+)"[^>]*class="status__external-link"/,
    );
    const timestamp = chunk.match(
      /class="status-info__meta-item">([A-Z][a-z]+ \d{1,2}, \d{4}, \d{1,2}:\d{2} (?:AM|PM))<\/a>/,
    );
    const content = chunk.match(
      /<div class="status__content">([\s\S]*?)<\/div>/,
    );

    if (!originalUrl || !timestamp || !content) {
      continue;
    }

    const text = decodeHtml(content[1]);
    const item = {
      id: originalUrl[1],
      createdAt: easternDateToIso(timestamp[1]),
      text,
      url: `https://truthsocial.com/@${USERNAME}/posts/${originalUrl[1]}`,
      deleted: false,
      deletedAt: null,
    };
    if (isTextPost({ text: item.text, platform: "Truth Social" })) {
      posts.push(item);
    }
  }

  return posts;
}

export async function fetchTrumpsTruthPosts(cutoff, now = new Date()) {
  const posts = [];
  const sourceUrl =
    process.env.DJT_TRUMPS_TRUTH_URL || TRUMPS_TRUTH_URL;
  let url = new URL(sourceUrl);
  url.searchParams.set("sort", "desc");
  url.searchParams.set("per_page", "100");
  url.searchParams.set("removed", "include");

  for (let page = 0; page < TRUMPS_TRUTH_MAX_PAGES; page += 1) {
    const response = await fetch(url, {
      headers: {
        Accept: "text/html",
        "User-Agent": "djt-truth-reader/1.0",
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(`Trump's Truth request failed with HTTP ${response.status}.`);
    }

    const html = await response.text();
    const batch = parseTrumpsTruthHtml(html);
    posts.push(...batch);

    const oldest = batch.at(-1);
    if (!oldest || new Date(oldest.createdAt) < cutoff) {
      break;
    }

    const nextPage = html.match(
      /<a href="([^"]+)" class="button button--xsmall">Next Page/,
    );
    if (!nextPage) {
      break;
    }
    url = new URL(decodeHtml(nextPage[1]), sourceUrl);
  }

  const seen = new Set();
  return posts
    .filter(
      (post) =>
        new Date(post.createdAt) >= cutoff &&
        new Date(post.createdAt) <= now &&
        !seen.has(post.id) &&
        seen.add(post.id),
    )
    .sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt));
}

async function requestPage(page, cutoff, now, deletedOnly) {
  const url = new URL(process.env.DJT_ROLL_CALL_URL || ARCHIVE_API);
  url.searchParams.set("platform", "truth social");
  url.searchParams.set("dateFilter", "custom");
  url.searchParams.set("start_date", dateOnly(cutoff));
  url.searchParams.set("end_date", dateOnly(now));
  url.searchParams.set("sort", "date");
  url.searchParams.set("sort_order", "desc");
  url.searchParams.set("format", "json");
  url.searchParams.set("page", String(page));
  if (deletedOnly) {
    url.searchParams.set("deleted", "true");
  }

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "djt-truth-reader/1.0",
    },
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(`Archive request failed with HTTP ${response.status}.`);
  }

  const body = await response.json();
  if (!Array.isArray(body.data) || !body.meta) {
    throw new Error("The archive returned an unexpected response.");
  }
  return body;
}

export async function fetchPosts(
  cutoff,
  now = new Date(),
  { deletedOnly = false } = {},
) {
  const firstPage = await requestPage(1, cutoff, now, deletedOnly);
  const pageCount = Math.min(firstPage.meta.page_count, MAX_PAGES);
  const remainingPages = await Promise.all(
    Array.from({ length: Math.max(0, pageCount - 1) }, (_, index) =>
      requestPage(index + 2, cutoff, now, deletedOnly),
    ),
  );
  const items = [
    ...firstPage.data,
    ...remainingPages.flatMap((response) => response.data),
  ];

  const seen = new Set();
  return items
    .filter(isTextPost)
    .map(normalizePost)
    .filter((post) => {
      if (
        seen.has(post.id) ||
        new Date(post.createdAt) < cutoff ||
        new Date(post.createdAt) > now
      ) {
        return false;
      }
      seen.add(post.id);
      return true;
    })
    .sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt));
}
