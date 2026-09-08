export const MAX_EXPORT_BYTES = 12 * 1024 * 1024;
export const REFRESH_INTERVAL_MS = 15 * 60 * 1000;
export const DEFAULT_REPORT_SOURCE = Object.freeze({ repository: "yongwen/trading-app", ref: "codex/cloud-workflow" });

const REPORT_FILES = Object.freeze([
  ["Chinese open report · 中文", "us-market-open-report"],
  ["Daily action plan", "daily-market-portfolio-action-plan"],
  ["Premarket agent", "premarket"],
  ["Intraday agent", "intraday"],
  ["Preclose agent", "preclose"],
  ["Postmarket agent", "postmarket"],
]);

export function githubReportLinks({ repository, ref } = DEFAULT_REPORT_SOURCE) {
  githubContentsUrl({ repository, ref, path: "reports/current" });
  if (ref.includes("\\") || ref.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("Enter a valid branch or commit without traversal segments.");
  }
  const source = [...repository.split("/"), "blob", ...ref.split("/")].map(encodeURIComponent).join("/");
  return REPORT_FILES.map(([label, filename]) => ({ label, href: `https://github.com/${source}/reports/current/${filename}.md` }));
}

export function createRefreshScheduler({ run, intervalMs = REFRESH_INTERVAL_MS, now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout, isVisible = () => true, onChange = () => {} }) {
  if (typeof run !== "function" || !Number.isFinite(intervalMs) || intervalMs <= 0) throw new Error("A refresh function and positive interval are required.");
  let active = false, checking = false, timer = null, epoch = 0;
  let nextAt = null, lastCheckedAt = null, lastSucceededAt = null, lastCheckSucceeded = null;
  const state = () => ({ active, checking, nextAt, lastCheckedAt, lastSucceededAt, lastCheckSucceeded, visible: isVisible() });
  const changed = () => onChange(state());
  function cancelTimer() { if (timer !== null) clearTimer(timer); timer = null; }
  function arm() {
    cancelTimer();
    if (!active || checking || !isVisible()) return;
    timer = setTimer(() => {
      timer = null;
      if (!isVisible()) { changed(); return; }
      void runNow();
    }, Math.max(0, nextAt - now()));
  }
  async function runNow() {
    if (!active || checking) return false;
    checking = true; cancelTimer();
    const current = epoch;
    changed();
    let succeeded = false;
    try { succeeded = await run() === true; } catch { succeeded = false; }
    finally {
      if (current === epoch && active) {
        checking = false;
        lastCheckedAt = now();
        lastCheckSucceeded = succeeded;
        if (succeeded) lastSucceededAt = lastCheckedAt;
        nextAt = lastCheckedAt + intervalMs;
        arm(); changed();
      }
    }
    return succeeded;
  }
  function start() {
    if (active) return;
    active = true; epoch += 1; nextAt = now();
    void runNow();
  }
  function stop() {
    active = false; checking = false; epoch += 1; cancelTimer();
    nextAt = null; lastCheckedAt = null; lastSucceededAt = null; lastCheckSucceeded = null;
    changed();
  }
  function visibilityChanged() {
    if (!active) return;
    if (!isVisible()) cancelTimer();
    else if (!checking && now() >= nextAt) { void runNow(); return; }
    else arm();
    changed();
  }
  return { start, stop, runNow, visibilityChanged, state };
}

export function githubContentsUrl({ repository, ref, path }) {
  if (typeof repository !== "string" || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository)
    || repository.split("/").some((part) => part === "." || part === "..")) {
    throw new Error("Enter a repository as owner/repository.");
  }
  if (typeof ref !== "string" || !ref.trim() || ref.length > 255 || /[\x00-\x20\x7f]/.test(ref)) {
    throw new Error("Enter a valid branch or commit.");
  }
  if (typeof path !== "string" || !path || path.length > 1024 || /[\x00-\x1f\x7f\\]/.test(path)
    || path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("Enter a relative export path without traversal segments.");
  }
  const parts = repository.split("/").map(encodeURIComponent);
  const url = new URL(`https://api.github.com/repos/${parts.join("/")}/contents/${path.split("/").map(encodeURIComponent).join("/")}`);
  url.searchParams.set("ref", ref);
  return url.href;
}

export function parsePortfolioExport(text) {
  if (typeof text !== "string" || new TextEncoder().encode(text).byteLength > MAX_EXPORT_BYTES) {
    throw new Error("The export is too large. Use a portfolio-view.json export under 12 MB.");
  }
  let data;
  try { data = JSON.parse(text); } catch { throw new Error("The file is not valid JSON."); }
  if (!data || data.schemaVersion !== 1 || !Array.isArray(data.positions) || !Array.isArray(data.snapshots)
    || !Array.isArray(data.accounts) || !data.totals || typeof data.totals !== "object" || Array.isArray(data.totals)
    || !data.source || typeof data.source !== "object" || Array.isArray(data.source)) {
    throw new Error("This is not a supported portfolio export. Use portfolio-view.json (schema version 1), not the raw state.json.");
  }
  if (data.positions.length > 20000 || data.snapshots.length > 20000 || data.accounts.length > 1000) {
    throw new Error("The export contains too many records.");
  }
  for (const row of data.positions) {
    if (!row || typeof row !== "object" || typeof row.symbol !== "string" || typeof row.account !== "string") {
      throw new Error("The export contains an invalid holding record.");
    }
    for (const key of ["quantity", "multiplier", "price", "marketValue", "costBasis", "unrealizedPnl", "notionalValue",
      "avgCost", "effectiveAvgCost", "planValue", "planDrift", "dte", "previousClose", "changePercent", "dailyPnl",
      "optionIv", "optionDelta", "underlyingPrice", "strikeDeltaPercent", "extrinsicValue"]) {
      if (row[key] != null && (typeof row[key] !== "number" || !Number.isFinite(row[key]))) {
        throw new Error("The export contains an invalid numeric holding value.");
      }
    }
    if ((row.dte != null && (!Number.isInteger(row.dte) || row.dte < 0)) || (row.planValue != null && row.planValue < 0)
      || (row.previousClose != null && row.previousClose <= 0) || (row.optionIv != null && row.optionIv < 0)
      || (row.optionDelta != null && Math.abs(row.optionDelta) > 1) || (row.underlyingPrice != null && row.underlyingPrice <= 0)
      || (row.extrinsicValue != null && row.extrinsicValue < 0)) {
      throw new Error("The export contains an invalid numeric holding value.");
    }
  }
  if (data.accounts.some((row) => !row || typeof row !== "object" || typeof row.account !== "string")) {
    throw new Error("The export contains an invalid account record.");
  }
  for (const totals of [data.totals, ...data.accounts]) {
    for (const key of ["dailyPnl", "coveredDailyPnl", "dailyPnlPositionCount", "dailyPnlCoveredPositionCount"]) {
      if (totals[key] != null && (typeof totals[key] !== "number" || !Number.isFinite(totals[key]))) {
        throw new Error("The export contains an invalid aggregate value.");
      }
    }
  }
  if (data.marketData != null) {
    const market = data.marketData;
    if (typeof market !== "object" || Array.isArray(market)
      || (market.benchmarks != null && (typeof market.benchmarks !== "object" || Array.isArray(market.benchmarks)))) {
      throw new Error("The export contains invalid market data.");
    }
    for (const [key, record] of [["vix", market.vix], ["fearGreed", market.fearGreed],
      ...["QQQ", "SPY", "SOXX"].map((symbol) => [symbol, market.benchmarks?.[symbol]])]) {
      if (record == null) continue;
      if (typeof record !== "object" || Array.isArray(record)) throw new Error("The export contains invalid market data.");
      for (const field of ["value", "change", "changePercent"]) {
        if (record[field] != null && (typeof record[field] !== "number" || !Number.isFinite(record[field]))) {
          throw new Error("The export contains an invalid market value.");
        }
      }
      if (record.value != null && (record.value < 0 || (key === "fearGreed" && record.value > 100))) {
        throw new Error("The export contains an invalid market value.");
      }
    }
  }
  return data;
}

export async function loadGithubPortfolio(config, token, { signal, fetchImpl = fetch } = {}) {
  const url = githubContentsUrl(config);
  if (typeof token !== "string" || !token.trim() || /\s/.test(token)) throw new Error("Enter a valid read-only GitHub token.");
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET", cache: "no-store", credentials: "omit", redirect: "error", referrerPolicy: "no-referrer", signal,
      headers: { Accept: "application/vnd.github.raw+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" },
    });
  } catch (error) {
    if (error.name === "AbortError") throw error;
    throw new Error("Could not reach GitHub. Check your connection and retry.");
  }
  if (!response.ok) {
    const messages = {
      401: "GitHub did not accept this token. Connect again with a valid read-only token.",
      403: "GitHub denied this request. Check repository access, organization approval and API rate limits.",
      404: "The repository, branch or export was not found, or the token cannot read it.",
      429: "GitHub is rate limiting requests. Wait before refreshing.",
    };
    throw new Error(messages[response.status] || `GitHub could not load the export (HTTP ${response.status}).`);
  }
  const declaredSize = Number(response.headers.get("content-length"));
  if (declaredSize > MAX_EXPORT_BYTES) throw new Error("The export is too large. Use an export under 12 MB.");
  return parsePortfolioExport(await response.text());
}

export function scopeTotals(data, account = "") {
  if (!account) return data.totals;
  return data.accounts.find((row) => row.account === account) || {};
}

export function needsValuation(row) {
  return row.includedInPortfolioValue !== false && !Number.isFinite(row.marketValue);
}

export function markEvidence(row) {
  if (row.quoteStatus === "manual-book-value") return { label: "Recorded book value", date: null, book: true };
  const sources = [row.quoteProvider, row.quoteSource].filter((value) => typeof value === "string" && value.trim());
  const labels = sources.filter((value, index) => sources.findIndex((other) => other.toLowerCase() === value.toLowerCase()) === index);
  if (!labels.length) labels.push("Source unavailable");
  if (typeof row.quoteFeed === "string" && row.quoteFeed) labels.push(`${row.quoteFeed} feed`);
  if (typeof row.priceKind === "string" && row.priceKind) labels.push(row.priceKind === "nav" ? "NAV" : row.priceKind.replaceAll("-", " "));
  if (Number.isFinite(row.quoteDelayMinutes) && row.quoteDelayMinutes > 0) labels.push(`${row.quoteDelayMinutes} min delayed`);
  else if (row.quoteDelayed === true) labels.push("delayed");
  if (row.quoteStatus === "last-session") labels.push("last session");
  else if (row.quoteStatus === "last-known") labels.push("last-known · refresh unavailable");
  else if (row.quoteStatus !== "available") labels.push(`${String(row.quoteStatus || "missing").replaceAll("-", " ")} mark`);
  const session = /^\d{4}-\d{2}-\d{2}$/.test(row.quoteSessionDate || "") ? row.quoteSessionDate : null;
  return { label: labels.join(" · "), date: row.quoteAsOf || null, session, priceKind: row.priceKind || null, book: false };
}

export function valuationPresentation(totals, positions) {
  const complete = totals.valuationComplete === true && Number.isFinite(totals.portfolioValue);
  const indicativeCount = Number.isFinite(totals.indicativePositionCount) ? Math.max(0, totals.indicativePositionCount) : 0;
  const lastKnownCount = Number.isFinite(totals.lastKnownPositionCount) ? Math.max(0, totals.lastKnownPositionCount) : 0;
  const estimated = totals.valuationEstimated === true || indicativeCount > 0 || lastKnownCount > 0;
  const optionCount = positions.filter((row) => row.assetClass === "option" && row.quoteFeed === "indicative"
    && row.quantity !== 0 && row.includedInPortfolioValue !== false && Number.isFinite(row.marketValue)).length;
  const notes = [];
  if (indicativeCount > 0) notes.push(`${indicativeCount} indicative mark${indicativeCount === 1 ? " is" : "s are"} included, including ${optionCount} option mark${optionCount === 1 ? "" : "s"}.`);
  if (lastKnownCount > 0) notes.push(`${lastKnownCount} last-known mark${lastKnownCount === 1 ? " is" : "s are"} retained because a usable newer quote was unavailable. Original dates appear below; full value coverage does not mean fresh quotes.`);
  if (estimated) notes.push("Portfolio value is an estimate.");
  return { complete, estimated, lastKnownCount, label: complete ? estimated ? "Estimated portfolio value" : "Portfolio value" : "Covered portfolio value", note: notes.join(" ") || null };
}

export function displayUnrealizedPnl(positions, totals) {
  if (!positions.some((row) => row.includedInPortfolioValue !== false && Number.isFinite(row.unrealizedPnl))) return null;
  return Number.isFinite(totals.unrealizedPnl) ? totals.unrealizedPnl
    : Number.isFinite(totals.coveredUnrealizedPnl) ? totals.coveredUnrealizedPnl : null;
}

export function markedAllocation(positions) {
  const classes = new Map();
  for (const row of positions) {
    if (row.includedInPortfolioValue === false || !Number.isFinite(row.marketValue)) continue;
    const key = row.isCash || row.symbol === "Z-CASH" ? "cash"
      : row.isCashEquivalent || row.symbol === "Z-TBILL" ? "cash_equivalent"
        : (row.assetClass || "other");
    const group = classes.get(key) || { assetClass: key, signedValue: 0, grossValue: 0 };
    group.signedValue += row.marketValue;
    group.grossValue += Math.abs(row.marketValue);
    classes.set(key, group);
  }
  const grossTotal = [...classes.values()].reduce((sum, group) => sum + group.grossValue, 0);
  return [...classes.values()].sort((a, b) => b.grossValue - a.grossValue)
    .map((group) => ({ ...group, share: grossTotal > 0 ? group.grossValue / grossTotal : 0 }));
}
