#!/usr/bin/env node

import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ARCHIVE_API,
  DAY_MS,
  PROFILE_URL,
  USERNAME,
  fetchPosts,
} from "./truth-posts.mjs";

const FETCH_DAYS = 3;
const README_POST_COUNT = 10;
const README_POSTS_START = "<!-- DJT_POSTS_START -->";
const README_POSTS_END = "<!-- DJT_POSTS_END -->";
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const outputPath = path.resolve(scriptDirectory, "..", "djt.json");
const readmePath = path.resolve(scriptDirectory, "..", "README.md");

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
  const entries = posts.slice(0, README_POST_COUNT).map((post) => {
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
_Latest ${Math.min(posts.length, README_POST_COUNT)}, newest first. Checked ${formatPostDate(updatedAt)}._

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
  const cutoff = new Date(now.getTime() - FETCH_DAYS * DAY_MS);
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
  const [freshPosts, deletedPosts] = await Promise.all([
    fetchPosts(cutoff, now),
    fetchPosts(oldestStoredDate, now, { deletedOnly: true }),
  ]);
  const observationsById = new Map();
  for (const post of [...freshPosts, ...deletedPosts]) {
    observationsById.set(post.id, post);
  }
  const posts = mergePosts(
    existingPosts,
    [...observationsById.values()],
    now.toISOString(),
    previousUpdatedAt,
  );
  const postsChanged =
    !existingDocument ||
    JSON.stringify(existingDocument.posts) !== JSON.stringify(posts);

  const updatedAt = postsChanged
    ? now.toISOString()
    : existingDocument.updatedAt;

  if (postsChanged) {
    const document = {
      account: `@${USERNAME}`,
      profileUrl: PROFILE_URL,
      source: ARCHIVE_API,
      fetchDays: FETCH_DAYS,
      updatedAt,
      count: posts.length,
      posts,
    };
    const temporaryPath = `${outputPath}.tmp`;

    await writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`);
    await rename(temporaryPath, outputPath);
  }

  const readmeChanged = await updateReadme(posts, updatedAt);
  console.log(
    `Fetched ${freshPosts.length} recent and ${deletedPosts.length} deleted; ` +
      `${postsChanged ? `merged ${posts.length}` : "no archive changes"}; ` +
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
