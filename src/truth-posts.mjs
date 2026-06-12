export const ARCHIVE_API =
  "https://rollcall.com/wp-json/factbase/v1/twitter";
export const PROFILE_URL = "https://truthsocial.com/@realDonaldTrump";
export const USERNAME = "realDonaldTrump";
export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;

const MAX_PAGES = 50;

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

async function requestPage(page, cutoff, now, deletedOnly) {
  const url = new URL(ARCHIVE_API);
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
