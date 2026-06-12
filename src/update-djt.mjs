#!/usr/bin/env node

import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ARCHIVE_API,
  HOUR_MS,
  PROFILE_URL,
  TRUMPS_TRUTH_URL,
  USERNAME,
  fetchPosts,
  fetchTrumpsTruthPosts,
} from "./truth-posts.mjs";

const DEFAULT_OVERLAP_HOURS = 24;
const README_DAYS = 3;
const README_POSTS_START = "<!-- DJT_POSTS_START -->";
const README_POSTS_END = "<!-- DJT_POSTS_END -->";
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const outputPath = path.resolve(scriptDirectory, "..", "djt.json");
const readmePath = path.resolve(scriptDirectory, "..", "README.md");

function overlapHours() {
  const value = Number(
    process.env.DJT_OVERLAP_HOURS || DEFAULT_OVERLAP_HOURS,
  );
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("DJT_OVERLAP_HOURS must be a positive number.");
  }
  return value;
}

function validatePosts(posts) {
  if (!Array.isArray(posts)) {
    throw new Error("Existing djt.json must contain a posts array.");
  }

  for (const post of posts) {
    if (
      !post ||
      typeof post.id !== "string" ||
      typeof post.createdAt !== "string" ||
      typeof post.url !== "string" ||
      (!Array.isArray(post.versions) && typeof post.text !== "string")
    ) {
      throw new Error("Existing djt.json contains an invalid post.");
    }
  }
  return posts;
}

async function readExistingPosts() {
  try {
    const raw = await readFile(outputPath, "utf8");
    const document = JSON.parse(raw);
    const posts = validatePosts(
      Array.isArray(document) ? document : document.posts,
    );
    return {
      posts,
      previousUpdatedAt: Array.isArray(document)
        ? null
        : document.updatedAt || null,
      existingDocument: Array.isArray(document) ? null : document,
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return {
        posts: [],
        previousUpdatedAt: null,
        existingDocument: null,
      };
    }
    throw error;
  }
}

function normalizeExistingPost(post, previousUpdatedAt) {
  if (Array.isArray(post.versions)) {
    return {
      ...post,
      currentVersion: post.versions.length,
      deleted: Boolean(post.deleted),
      deletedAt: post.deletedAt || null,
      deletedDetectedAt: post.deletedDetectedAt || null,
    };
  }

  return {
    id: post.id,
    createdAt: post.createdAt,
    url: post.url,
    currentVersion: 1,
    deleted: Boolean(post.deleted),
    deletedAt: post.deletedAt || null,
    deletedDetectedAt: post.deletedDetectedAt || null,
    versions: [
      {
        version: 1,
        text: post.text,
        firstSeenAt: previousUpdatedAt || post.createdAt,
      },
    ],
  };
}

function createPost(post, detectedAt) {
  return {
    id: post.id,
    createdAt: post.createdAt,
    url: post.url,
    currentVersion: 1,
    deleted: post.deleted,
    deletedAt: post.deletedAt,
    deletedDetectedAt: post.deleted ? detectedAt : null,
    versions: [
      {
        version: 1,
        text: post.text,
        firstSeenAt: detectedAt,
      },
    ],
  };
}

function applyObservation(storedPost, observedPost, detectedAt) {
  const latestVersion = storedPost.versions.at(-1);
  if (latestVersion.text !== observedPost.text) {
    storedPost.versions.push({
      version: storedPost.versions.length + 1,
      text: observedPost.text,
      firstSeenAt: detectedAt,
    });
    storedPost.currentVersion = storedPost.versions.length;
  }

  storedPost.createdAt = observedPost.createdAt;
  storedPost.url = observedPost.url;

  if (observedPost.deleted) {
    storedPost.deleted = true;
    storedPost.deletedAt = observedPost.deletedAt || storedPost.deletedAt;
    storedPost.deletedDetectedAt ||= detectedAt;
  }
}

export function mergePosts(
  existingPosts,
  observedPosts,
  detectedAt,
  previousUpdatedAt = null,
) {
  const postsById = new Map();

  for (const post of existingPosts) {
    postsById.set(post.id, normalizeExistingPost(post, previousUpdatedAt));
  }
  for (const post of observedPosts) {
    const storedPost = postsById.get(post.id);
    if (storedPost) {
      applyObservation(storedPost, post, detectedAt);
    } else {
      postsById.set(post.id, createPost(post, detectedAt));
    }
  }

  return [...postsById.values()].sort(
    (left, right) => new Date(right.createdAt) - new Date(left.createdAt),
  );
}

export function selectObservations(
  existingPosts,
  rollCallPosts,
  fallbackPosts,
  deletedPosts,
) {
  const existingIds = new Set(existingPosts.map((post) => post.id));
  const observationsById = new Map();

  for (const post of rollCallPosts) {
    observationsById.set(post.id, post);
  }
  for (const post of fallbackPosts) {
    if (!observationsById.has(post.id) && !existingIds.has(post.id)) {
      observationsById.set(post.id, post);
    }
  }
  for (const post of deletedPosts) {
    observationsById.set(post.id, post);
  }

  return [...observationsById.values()];
}

function formatPostDate(date) {
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
    timeZoneName: "short",
  }).format(new Date(date));
}

function quoteMarkdown(text) {
  return text
    .replace(/<!--/g, "&lt;!--")
    .split("\n")
    .map((line) => {
      const cleanLine = line.trimEnd();
      return cleanLine ? `> ${cleanLine}` : ">";
    })
    .join("\n");
}

export function renderReadmePosts(posts, updatedAt) {
  const cutoff = new Date(
    new Date(updatedAt).getTime() - README_DAYS * 24 * HOUR_MS,
  );
  const recentPosts = posts.filter(
    (post) => new Date(post.createdAt) >= cutoff,
  );
  const entries = recentPosts.map((post) => {
    const latestVersion = post.versions.at(-1);
    const labels = [];
    if (post.deleted) {
      labels.push("**Deleted**");
    }
    if (post.versions.length > 1) {
      labels.push(`Edited, ${post.versions.length} versions archived`);
    }
    const annotation = labels.length > 0 ? `\n\n_${labels.join(" · ")}_` : "";

    return `### [${formatPostDate(post.createdAt)}](${post.url})

${quoteMarkdown(latestVersion.text)}${annotation}`;
  });

  return `${README_POSTS_START}
_Last ${README_DAYS} days, newest first. ${recentPosts.length} posts._

${entries.join("\n\n---\n\n")}
${README_POSTS_END}`;
}

async function updateReadme(posts, updatedAt) {
  const readme = await readFile(readmePath, "utf8");
  const startIndex = readme.indexOf(README_POSTS_START);
  const endIndex = readme.indexOf(README_POSTS_END);

  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    throw new Error("README.md is missing the generated post markers.");
  }

  const generated = renderReadmePosts(posts, updatedAt);
  const nextReadme =
    readme.slice(0, startIndex) +
    generated +
    readme.slice(endIndex + README_POSTS_END.length);

  if (nextReadme === readme) {
    return false;
  }

  const temporaryPath = `${readmePath}.tmp`;
  await writeFile(temporaryPath, nextReadme);
  await rename(temporaryPath, readmePath);
  return true;
}

async function main() {
  const now = new Date();
  const recentOverlapHours = overlapHours();
  const cutoff = new Date(
    now.getTime() - recentOverlapHours * HOUR_MS,
  );
  const {
    posts: existingPosts,
    previousUpdatedAt,
    existingDocument,
  } = await readExistingPosts();
  const oldestStoredDate = existingPosts.reduce(
    (oldest, post) =>
      new Date(post.createdAt) < oldest ? new Date(post.createdAt) : oldest,
    cutoff,
  );
  const [rollCallRecent, trumpsTruthRecent, rollCallDeleted] =
    await Promise.allSettled([
    fetchPosts(cutoff, now),
    fetchTrumpsTruthPosts(cutoff, now),
    fetchPosts(oldestStoredDate, now, { deletedOnly: true }),
  ]);
  if (
    rollCallRecent.status === "rejected" &&
    trumpsTruthRecent.status === "rejected"
  ) {
    throw new Error(
      `All recent sources failed. Roll Call: ${rollCallRecent.reason.message}; ` +
        `Trump's Truth: ${trumpsTruthRecent.reason.message}`,
    );
  }
  if (rollCallRecent.status === "rejected") {
    console.warn(
      `Warning: Roll Call recent feed failed: ${rollCallRecent.reason.message}`,
    );
  }
  if (trumpsTruthRecent.status === "rejected") {
    console.warn(
      `Warning: Trump's Truth recent feed failed: ${trumpsTruthRecent.reason.message}`,
    );
  }
  if (rollCallDeleted.status === "rejected") {
    console.warn(
      `Warning: Roll Call deletion audit failed: ${rollCallDeleted.reason.message}`,
    );
  }

  const freshPosts =
    rollCallRecent.status === "fulfilled" ? rollCallRecent.value : [];
  const fallbackPosts =
    trumpsTruthRecent.status === "fulfilled" ? trumpsTruthRecent.value : [];
  const deletedPosts =
    rollCallDeleted.status === "fulfilled" ? rollCallDeleted.value : [];
  const observations = selectObservations(
    existingPosts,
    freshPosts,
    fallbackPosts,
    deletedPosts,
  );
  const posts = mergePosts(
    existingPosts,
    observations,
    now.toISOString(),
    previousUpdatedAt,
  );
  const postsChanged =
    !existingDocument ||
    JSON.stringify(existingDocument.posts) !== JSON.stringify(posts);
  const settingsChanged =
    !existingDocument ||
    existingDocument.recentOverlapHours !== recentOverlapHours ||
    Object.hasOwn(existingDocument, "fetchDays") ||
    Object.hasOwn(existingDocument, "source") ||
    JSON.stringify(existingDocument.sources) !==
      JSON.stringify([ARCHIVE_API, TRUMPS_TRUTH_URL]);
  const archiveChanged = postsChanged || settingsChanged;

  const updatedAt = archiveChanged
    ? now.toISOString()
    : existingDocument.updatedAt;

  if (archiveChanged) {
    const document = {
      account: `@${USERNAME}`,
      profileUrl: PROFILE_URL,
      sources: [ARCHIVE_API, TRUMPS_TRUTH_URL],
      recentOverlapHours,
      updatedAt,
      count: posts.length,
      posts,
    };
    const temporaryPath = `${outputPath}.tmp`;

    await writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`);
    await rename(temporaryPath, outputPath);
  }

  const readmeChanged = await updateReadme(posts, now.toISOString());
  console.log(
    `Fetched Roll Call ${freshPosts.length}, Trump's Truth ${fallbackPosts.length}, ` +
      `and deleted ${deletedPosts.length}; ` +
      `${archiveChanged ? `merged ${posts.length}` : "no archive changes"}; ` +
      `${readmeChanged ? "updated README.md" : "README.md unchanged"}`,
  );
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  });
}
