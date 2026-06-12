#!/usr/bin/env node

import {
  ARCHIVE_API,
  DAY_MS,
  PROFILE_URL,
  USERNAME,
  fetchPosts,
} from "./truth-posts.mjs";

const DEFAULT_DAYS = 7;

function parseArguments(argv) {
  const options = { days: DEFAULT_DAYS, format: "text" };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--json") {
      options.format = "json";
    } else if (argument === "--days") {
      const value = Number(argv[index + 1]);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error("--days must be a positive number.");
      }
      options.days = value;
      index += 1;
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  return options;
}

function printHelp() {
  console.log(`Usage: npm run read -- [options]

Options:
  --days NUMBER  Rolling time window in days (default: 7)
  --json         Print JSON instead of readable text
  -h, --help     Show this help`);
}

function printText(posts, cutoff) {
  console.log(
    `${posts.length} text post${posts.length === 1 ? "" : "s"} since ${cutoff.toISOString()}\n`,
  );

  for (const post of posts) {
    console.log(`[${post.createdAt}]`);
    console.log(post.text);
    console.log(post.url);
    console.log("\n---\n");
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const now = new Date();
  const cutoff = new Date(now.getTime() - options.days * DAY_MS);
  const posts = await fetchPosts(cutoff, now);

  if (options.format === "json") {
    console.log(
      JSON.stringify(
        {
          account: `@${USERNAME}`,
          profileUrl: PROFILE_URL,
          source: ARCHIVE_API,
          cutoff: cutoff.toISOString(),
          fetchedAt: now.toISOString(),
          count: posts.length,
          posts,
        },
        null,
        2,
      ),
    );
  } else {
    printText(posts, cutoff);
  }
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
