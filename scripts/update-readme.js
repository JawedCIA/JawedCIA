#!/usr/bin/env node

/**
 * update-readme.js
 *
 * Fetches public repositories for the configured GitHub user, filters and
 * sorts them, and updates the README.md between the markers:
 *
 *   <!-- REPOS:START -->
 *   ...generated content...
 *   <!-- REPOS:END -->
 *
 * Design notes:
 * - Uses GitHub REST API v3 (no third-party dependencies required).
 * - Skips forks, archived repos, and the profile repository itself.
 * - Sorts by most recently pushed to surface active work.
 * - Handles pagination in case of >100 public repos.
 * - Idempotent: if nothing has changed, the workflow will skip the commit.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const USERNAME = process.env.GITHUB_USERNAME;
const TOKEN = process.env.GITHUB_TOKEN;
const README_PATH = path.join(process.cwd(), 'README.md');
const MARKER_START = '<!-- REPOS:START -->';
const MARKER_END = '<!-- REPOS:END -->';
const MAX_REPOS_SHOWN = 12; // cap the list so the README stays scannable

if (!USERNAME) {
  console.error('GITHUB_USERNAME environment variable is required.');
  process.exit(1);
}

/**
 * Perform a single authenticated GET request against the GitHub API.
 */
function githubRequest(pathAndQuery) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path: pathAndQuery,
      method: 'GET',
      headers: {
        'User-Agent': `${USERNAME}-profile-updater`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    };

    if (TOKEN) {
      options.headers.Authorization = `Bearer ${TOKEN}`;
    }

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve({ data: JSON.parse(body), headers: res.headers });
          } catch (err) {
            reject(new Error(`Failed to parse JSON response: ${err.message}`));
          }
        } else {
          reject(new Error(`GitHub API ${res.statusCode}: ${body.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

/**
 * Fetch all public repos owned by the user, paginating through results.
 */
async function fetchAllRepos() {
  const collected = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const { data } = await githubRequest(
      `/users/${USERNAME}/repos?per_page=${perPage}&page=${page}&type=owner&sort=pushed`
    );

    if (!Array.isArray(data) || data.length === 0) break;

    collected.push(...data);

    if (data.length < perPage) break; // last page
    page += 1;

    if (page > 10) break; // safety limit: 1000 repos is more than enough
  }

  return collected;
}

/**
 * Fetch primary language and topics for a single repo. Topics are not always
 * present on the list endpoint, so we call the full repo endpoint when we
 * want richer data. Kept conservative to avoid rate-limit issues.
 */
async function enrichRepo(repo) {
  try {
    const { data } = await githubRequest(`/repos/${repo.full_name}`);
    return {
      ...repo,
      topics: data.topics || [],
      homepage: data.homepage || '',
    };
  } catch (err) {
    // If enrichment fails (rate limit, transient error), fall back to what we have.
    console.warn(`Enrichment failed for ${repo.full_name}: ${err.message}`);
    return { ...repo, topics: [], homepage: '' };
  }
}

/**
 * Format a single repo as a markdown block.
 */
function formatRepo(repo) {
  const name = `**[${repo.name}](${repo.html_url})**`;
  const description = repo.description
    ? repo.description.trim().replace(/\r?\n/g, ' ')
    : '_No description provided._';

  const parts = [];
  if (repo.language) parts.push(`\`${repo.language}\``);
  if (repo.topics && repo.topics.length > 0) {
    const shown = repo.topics.slice(0, 4).map((t) => `\`${t}\``).join(' ');
    parts.push(shown);
  }
  const techLine = parts.length > 0 ? parts.join(' · ') : '';

  const homepageLine = repo.homepage
    ? `Live: [${repo.homepage.replace(/^https?:\/\//, '')}](${repo.homepage})`
    : '';

  const lines = [
    `### ${name}`,
    '',
    description,
    '',
  ];

  if (techLine) lines.push(techLine, '');
  if (homepageLine) lines.push(homepageLine, '');

  return lines.join('\n');
}

/**
 * Build the markdown block for all filtered repos.
 */
function buildMarkdown(repos) {
  if (repos.length === 0) {
    return `_No public repositories to display yet._`;
  }

  const header = `_Auto-refreshed daily. Last updated: ${new Date()
    .toISOString()
    .split('T')[0]}._\n\n`;

  const body = repos.map(formatRepo).join('\n---\n\n');

  return header + body;
}

/**
 * Replace the content between the markers in README.md.
 * If the markers are missing, the script exits with a clear error rather
 * than silently corrupting the file.
 */
function updateReadme(newContent) {
  if (!fs.existsSync(README_PATH)) {
    throw new Error(`README.md not found at ${README_PATH}`);
  }

  const readme = fs.readFileSync(README_PATH, 'utf8');

  const startIdx = readme.indexOf(MARKER_START);
  const endIdx = readme.indexOf(MARKER_END);

  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    throw new Error(
      `Could not find markers ${MARKER_START} and ${MARKER_END} in README.md. ` +
      `Please add them before running this workflow.`
    );
  }

  const before = readme.slice(0, startIdx + MARKER_START.length);
  const after = readme.slice(endIdx);

  const updated = `${before}\n${newContent}\n${after}`;

  fs.writeFileSync(README_PATH, updated, 'utf8');
}

async function main() {
  console.log(`Fetching public repos for ${USERNAME}...`);

  const allRepos = await fetchAllRepos();
  console.log(`Retrieved ${allRepos.length} repos before filtering.`);

  const filtered = allRepos
    .filter((r) => !r.fork)
    .filter((r) => !r.archived)
    .filter((r) => !r.private)
    .filter((r) => r.name.toLowerCase() !== USERNAME.toLowerCase())
    .slice(0, MAX_REPOS_SHOWN);

  console.log(`After filtering: ${filtered.length} repos will be shown.`);

  // Enrich sequentially to be gentle on rate limits.
  const enriched = [];
  for (const repo of filtered) {
    enriched.push(await enrichRepo(repo));
  }

  const markdown = buildMarkdown(enriched);
  updateReadme(markdown);

  console.log('README.md updated successfully.');
}

main().catch((err) => {
  console.error('Failed to update README:', err.message);
  process.exit(1);
});
