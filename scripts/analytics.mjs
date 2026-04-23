#!/usr/bin/env node
// JellyTunes Analytics Dashboard
// Shows update check metrics from Cloudflare + GitHub download stats

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLOUDFLARE_API = 'https://api.oriaflow.dev/jellytunes/stats';
const GITHUB_REPO = 'tresnola-labs/jellytunes';

// ─── Color helpers (terminal colors without external deps) ───────────────────

const ESC = '\x1b';
const reset  = `${ESC}[0m`;
const bold   = `${ESC}[1m`;
const dim    = `${ESC}[2m`;
const cyan   = `${ESC}[36m`;
const green  = `${ESC}[32m`;
const yellow = `${ESC}[33m`;
const magenta = `${ESC}[35m`;
const red    = `${ESC}[31m`;

function c(color, text) { return `${color}${text}${reset}`; }

// ─── Help ────────────────────────────────────────────────────────────────────

const HELP = `
${bold}jtstats${reset} — JellyTunes Analytics Dashboard

${bold}USAGE${reset}
  jtstats [options]

${bold}OPTIONS${reset}
  ${cyan}--mode=<mode>${reset}      Output mode: dashboard (default), chart, raw
  ${cyan}--chart=<type>${reset}     Chart type when --mode=chart: ascii (default),
                 unicode, bars, columns, spark, heatmap
  ${cyan}--days=<n>${reset}          Number of days to fetch (default: 7)
  ${cyan}--help${reset}, ${cyan}--h${reset}      Show this help

${bold}EXAMPLES${reset}
  jtstats                  # Dashboard (last 7 days)
  jtstats --days=30        # Dashboard last 30 days
  jtstats --mode=chart     # ASCII chart
  jtstats --mode=chart --chart=unicode
  jtstats --mode=raw       # Raw JSON (CF stats + GitHub downloads)

${bold}ENV${reset}
  CLOUDFLARE_STATS_API_KEY  Your Cloudflare STATS_API_KEY

${bold}CHART TYPES${reset}
  ascii    Default, works everywhere
  unicode  Unicode block characters
  bars     Horizontal bars
  columns  Vertical columns
  spark    Minimal sparklines
  heatmap  Color heatmap (needs many rows)

${bold}DATA${reset}
  Update checks come from your Cloudflare Worker proxy.
  GitHub downloads are fetched automatically in dashboard and raw modes.
`.trim();

function showHelp() {
  console.log(HELP);
  process.exit(0);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function getApiKey() {
  const key = process.env.CLOUDFLARE_STATS_API_KEY;
  if (!key) {
    console.error(`${red}Error:${reset} CLOUDFLARE_STATS_API_KEY environment variable not set.`);
    console.error(`  ${yellow}export CLOUDFLARE_STATS_API_KEY=<your-key>${reset}`);
    process.exit(1);
  }
  return key;
}

function toDateStr(d) {
  return d.toISOString().slice(0, 10);
}

function dateRange(days = 7) {
  const to = toDateStr(new Date());
  const from = toDateStr(new Date(Date.now() - days * 24 * 60 * 60 * 1000));
  return { from, to };
}

// ─── Data Fetchers ──────────────────────────────────────────────────────────

async function fetchCloudflareStats({ from, to }) {
  const key = getApiKey();
  const url = `${CLOUDFLARE_API}?from=${from}&to=${to}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`Cloudflare API error ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

async function fetchGitHubDownloads() {
  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases`, {
    headers: { Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) {
    throw new Error(`GitHub API error ${res.status}`);
  }
  return res.json();
}

// ─── Aggregators ───────────────────────────────────────────────────────────

function aggregateByDate(data) {
  const agg = {};
  for (const [key, count] of Object.entries(data)) {
    const date = key.split(':')[0];
    agg[date] = (agg[date] ?? 0) + count;
  }
  return agg;
}

function aggregateByVersion(data) {
  const agg = {};
  for (const [key, count] of Object.entries(data)) {
    const version = key.split(':')[1];
    agg[version] = (agg[version] ?? 0) + count;
  }
  return agg;
}

function aggregateByPlatform(data) {
  const agg = {};
  for (const [key, count] of Object.entries(data)) {
    const platform = key.split(':')[2];
    agg[platform] = (agg[platform] ?? 0) + count;
  }
  return agg;
}

function aggregateByCountry(data) {
  const agg = {};
  for (const [key, count] of Object.entries(data)) {
    const country = key.split(':')[3];
    agg[country] = (agg[country] ?? 0) + count;
  }
  return agg;
}

function aggregateByDateVersion(data) {
  const agg = {};
  for (const [key, count] of Object.entries(data)) {
    const [date, version] = key.split(':');
    if (!agg[date]) agg[date] = {};
    agg[date][version] = (agg[date][version] ?? 0) + count;
  }
  return agg;
}

// ─── Formatters ─────────────────────────────────────────────────────────────

function bar(value, total, width = 38) {
  const filled = total > 0 ? Math.round((value / total) * width) : 0;
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  const block = '█'.repeat(filled);
  const empty = '░'.repeat(width - filled);
  const bar = `${cyan}${block}${dim}${empty}${reset}`;
  const num = `${green}${String(value).padStart(5)}${reset}`;
  const pctStr = `${dim}${String(pct).padStart(4)}%${reset}`;
  return `  ${bar} ${num} ${pctStr}`;
}

function section(label, entries, width = 38) {
  const total = entries.reduce((s, [, v]) => s + v, 0);
  const max = Math.max(...entries.map(([, v]) => v));

  console.log(`\n  ${cyan}${bold}${label}${reset}`);
  console.log(`  ${dim}${'─'.repeat(width + 16)}${reset}`);

  for (const [key, value] of entries) {
    const filled = max > 0 ? Math.round((value / max) * width) : 0;
    const block = `${cyan}${'█'.repeat(filled)}${reset}`;
    const empty = `${dim}${'░'.repeat(width - filled)}${reset}`;
    const num = `${green}${String(value).padStart(5)}${reset}`;
    const pct = max > 0 ? Math.round((value / max) * 100) : 0;
    const pctStr = `${dim}${String(pct).padStart(4)}%${reset}`;
    console.log(`  ${String(key).padEnd(12)} ${block}${empty} ${num} ${pctStr}`);
  }

  // Total row
  const filled = total > 0 ? width : 0;
  const block = `${green}${'█'.repeat(filled)}${reset}`;
  const empty = `${dim}${'░'.repeat(width - filled)}${reset}`;
  const num = `${green}${String(total).padStart(5)}${reset}`;
  console.log(`  ${dim}${'─'.repeat(width + 16)}${reset}`);
  console.log(`  ${bold}${String('TOTAL').padEnd(12)} ${block}${empty} ${num} ${dim}100%${reset}`);
}

function printDashboard(cfData, githubData, { from, to }) {
  const byDate     = aggregateByDate(cfData);
  const byVersion  = aggregateByVersion(cfData);
  const byPlatform = aggregateByPlatform(cfData);
  const byCountry  = aggregateByCountry(cfData);
  const totalCF    = Object.values(byDate).reduce((a, b) => a + b, 0);

  console.log(`\n${bold}${magenta}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${reset}`);
  console.log(`  ${cyan}${bold}📊  JellyTunes Analytics${reset}`);
  console.log(`  ${dim}📅  ${from} → ${to}${reset}`);
  console.log(`${magenta}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${reset}`);

  // ── Update Checks by Date ──
  section('📅 Update Checks by Date',
    Object.keys(byDate).sort().map(d => [d, byDate[d]]));

  // ── Update Checks by Version ──
  section('🏷️ Update Checks by Version',
    Object.entries(byVersion).sort((a, b) => b[1] - a[1]));

  // ── Update Checks by Platform ──
  section('💻 Update Checks by Platform',
    Object.entries(byPlatform).sort((a, b) => b[1] - a[1]));

  // ── Update Checks by Country ──
  console.log(`\n  ${cyan}${bold}🌍 Update Checks by Country (top 15)${reset}`);
  console.log(`  ${dim}${'─'.repeat(54)}${reset}`);
  const topCountries = Object.entries(byCountry)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15);
  const maxCountry = topCountries[0]?.[1] ?? 1;
  for (const [country, count] of topCountries) {
    const filled = Math.round((count / maxCountry) * 38);
    const block = `${cyan}${'█'.repeat(filled)}${reset}`;
    const empty = `${dim}${'░'.repeat(38 - filled)}${reset}`;
    const pct = Math.round((count / maxCountry) * 100);
    const num = `${green}${String(count).padStart(5)}${reset}`;
    const pctStr = `${dim}${String(pct).padStart(4)}%${reset}`;
    console.log(`  ${String(country).padEnd(12)} ${block}${empty} ${num} ${pctStr}`);
  }

  // ── GitHub Downloads ──
  if (githubData && githubData.length > 0) {
    console.log(`\n  ${cyan}${bold}📥 GitHub Downloads by Release${reset}`);
    console.log(`  ${dim}${'─'.repeat(54)}${reset}`);
    const releases = githubData.slice(0, 10).map(r => ({
      tag: r.tag_name,
      date: r.published_at.slice(0, 10),
      total: r.assets.reduce((s, a) => s + a.download_count, 0),
    }));
    const maxDL = Math.max(...releases.map(r => r.total), 1);
    for (const { tag, date, total } of releases) {
      const filled = Math.round((total / maxDL) * 38);
      const block = `${yellow}${'█'.repeat(filled)}${reset}`;
      const empty = `${dim}${'░'.repeat(38 - filled)}${reset}`;
      const label = `${tag} (${date})`;
      const num = `${green}${String(total).padStart(5)}${reset}`;
      console.log(`  ${String(label).padEnd(20)} ${block}${empty} ${num}`);
    }
  }

  console.log(`\n${magenta}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${reset}\n`);
}

// ─── chartli integration ────────────────────────────────────────────────────
// chartli uses whitespace-separated values (NOT CSV)

function buildChartliData(cfData) {
  const byDateVersion = aggregateByDateVersion(cfData);
  const dates = Object.keys(byDateVersion).sort();
  const versions = [...new Set(Object.values(byDateVersion).flatMap(d => Object.keys(d)))].sort();
  const lines = dates.map(date =>
    versions.map(v => byDateVersion[date]?.[v] ?? 0).join(' '),
  );
  return { dates, versions, lines };
}

async function printChartli(cfData, type = 'ascii') {
  const { dates, versions, lines } = buildChartliData(cfData);
  const tmpFile = join(__dirname, '.analytics-chartli-tmp.txt');
  const { writeFileSync } = await import('fs');

  writeFileSync(tmpFile, lines.join('\n'));

  const { execFileSync } = await import('child_process');
  try {
    const out = execFileSync(
      'chartli',
      [
        tmpFile, '-t', type,
        '-w', '60', '-h', '14',
        '--x-labels', dates.join(','),
        '--series-labels', versions.join(','),
      ],
      { encoding: 'utf8' },
    );
    console.log(out);
  } catch (e) {
    try {
      execFileSync('chartli', ['--version'], { encoding: 'utf8', stdio: 'pipe' });
    } catch {
      console.error(`${red}Error:${reset} chartli not installed. Run: ${yellow}npm i -g chartli${reset}`);
      process.exit(1);
    }
    console.error(`${red}chartli error:${reset}`, e.message);
    process.exit(1);
  } finally {
    try { writeFileSync(tmpFile, ''); } catch {}
  }
}

// ─── Raw JSON output ───────────────────────────────────────────────────────

function printRaw(cfData, githubData) {
  console.log(JSON.stringify({ cloudflare: cfData, github: githubData }, null, 2));
}

// ─── CLI ───────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flags = {};

for (const arg of args) {
  if (arg === '--help' || arg === '--h' || arg === '-h') {
    showHelp();
  } else if (arg.startsWith('--')) {
    const [k, v] = arg.slice(2).split('=');
    flags[k] = v ?? true;
  } else if (arg.startsWith('-')) {
    flags[arg.slice(1)] = true;
  }
}

const mode      = flags.mode  ?? 'dashboard';
const chartType = flags.chart ?? 'ascii';
const days      = parseInt(flags.days ?? '7', 10);
const { from, to } = dateRange(days);

(async () => {
  try {
    // Always fetch GitHub downloads in dashboard/raw modes
    const fetchGH = mode !== 'chart';

    const [cfResult, ghResult] = await Promise.allSettled([
      fetchCloudflareStats({ from, to }),
      fetchGH ? fetchGitHubDownloads() : Promise.resolve(null),
    ]);

    if (cfResult.status === 'rejected') {
      console.error(`${red}Cloudflare fetch failed:${reset}`, cfResult.reason.message);
      process.exit(1);
    }

    const cfData = cfResult.value;
    const ghData = fetchGH && ghResult.status === 'fulfilled' ? ghResult.value : null;

    if (mode === 'raw') {
      printRaw(cfData, ghData);
    } else if (mode === 'chart') {
      await printChartli(cfData, chartType);
    } else {
      printDashboard(cfData, ghData, { from, to });
    }
  } catch (err) {
    console.error(`${red}Error:${reset}`, err.message);
    process.exit(1);
  }
})();
