import { loadGithubPortfolio, parsePortfolioExport, githubContentsUrl, githubReportLinks, DEFAULT_REPORT_SOURCE, markedAllocation, scopeTotals, displayUnrealizedPnl, needsValuation, markEvidence, valuationPresentation, createRefreshScheduler, MAX_EXPORT_BYTES } from "./loader.js";

const el = (id) => document.getElementById(id);
const currency = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 });
const compact = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 });
const dateFormat = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "America/New_York" });
const assetNames = { stock: "Stocks", etf: "ETFs", mutual_fund: "Mutual funds", mutualFund: "Mutual funds", option: "Options", cash: "Cash", cash_equivalent: "Cash equivalents", bond: "Bonds", index_future: "Futures", other: "Other" };
let portfolio = null;
let credentials = null;
let request = null;
let generation = 0;
let sourceName = "";
let sort = { key: "marketValue", descending: true };
const refreshScheduler = createRefreshScheduler({ run: loadSavedExport,
  isVisible: () => document.visibilityState !== "hidden", onChange: renderRefreshStatus });

function node(tag, text, className) {
  const item = document.createElement(tag);
  if (text != null) item.textContent = String(text);
  if (className) item.className = className;
  return item;
}
function money(value) { return Number.isFinite(value) ? currency.format(value) : "Unavailable"; }
function number(value) { return Number.isFinite(value) ? integer.format(value) : "—"; }
function time(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return "Unavailable";
  return `${dateFormat.format(new Date(value))} ET`;
}
function assetName(value) { return assetNames[value] || String(value || "Other").replaceAll("_", " "); }
function tone(value) { return Number.isFinite(value) ? (value < 0 ? "negative" : value > 0 ? "positive" : "") : "unavailable"; }
function status(message, error = false) { el("status").textContent = message; el("status").classList.toggle("error", error); }
function addOption(select, text, value) { const option = node("option", text); option.value = value; select.append(option); }
function renderReportLinks(config = DEFAULT_REPORT_SOURCE) {
  const links = githubReportLinks(config).map(({ label, href }) => {
    const link = node("a", label);
    link.href = href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    return link;
  });
  el("report-links").replaceChildren(...links);
  el("report-source").textContent = `${config.repository} · ${config.ref}`;
}
function renderRefreshStatus(state = refreshScheduler.state()) {
  if (!state.active) {
    el("refresh-status").textContent = portfolio ? "Local export · automatic refresh off" : "";
    return;
  }
  const last = state.lastCheckedAt === null ? "Not checked yet" : `Last checked ${time(new Date(state.lastCheckedAt).toISOString())}${state.lastCheckSucceeded ? "" : " (failed)"}`;
  const next = state.checking ? "Checking saved GitHub export…"
    : !state.visible ? "Checks paused while this tab is hidden"
      : `Next check ${time(new Date(state.nextAt).toISOString())}`;
  el("refresh-status").textContent = `Every 15 minutes · ${last} · ${next}`;
}
function clearData() {
  portfolio = null;
  sourceName = "";
  el("dashboard").hidden = true;
  for (const id of ["metrics", "allocation", "trend", "warnings", "holdings", "source-label", "source-detail", "updated", "quote-freshness", "refresh-status", "snapshot-count", "trend-note", "action-date", "action-text", "holdings-count"]) el(id).replaceChildren();
  el("account").replaceChildren(); addOption(el("account"), "All accounts", "");
  el("asset").replaceChildren(); addOption(el("asset"), "All asset classes", "");
  el("search").value = "";
  el("unpriced").checked = false;
  el("warnings").hidden = true;
  el("action-panel").hidden = true;
  renderReportLinks();
}
function beginRequest() {
  generation += 1;
  request?.abort();
  request = new AbortController();
  el("connect").disabled = true;
  el("refresh").disabled = true;
  el("disconnect").hidden = false;
  return { current: generation, signal: request.signal };
}
function finishRequest(current) {
  if (current !== generation) return;
  request = null;
  el("connect").disabled = false;
  el("refresh").disabled = false;
  el("disconnect").hidden = !portfolio && !credentials;
}
function display(data, source) {
  portfolio = data;
  sourceName = source;
  el("connection").hidden = true;
  el("dashboard").hidden = false;
  el("disconnect").hidden = false;
  el("refresh").hidden = !credentials;
  document.body.classList.add("connected");
  const previousAccount = el("account").value;
  const accounts = [...new Set(data.positions.map((row) => row.account))].sort();
  el("account").replaceChildren(); addOption(el("account"), "All accounts", "");
  for (const account of accounts) addOption(el("account"), account || "Unspecified account", account);
  if (accounts.includes(previousAccount)) el("account").value = previousAccount;
  const previousAsset = el("asset").value;
  const assets = [...new Set(data.positions.map((row) => row.assetClass || "other"))].sort();
  el("asset").replaceChildren(); addOption(el("asset"), "All asset classes", "");
  for (const asset of assets) addOption(el("asset"), assetName(asset), asset);
  if (assets.includes(previousAsset)) el("asset").value = previousAsset;
  el("source-label").textContent = sourceName;
  el("updated").textContent = `Exported ${time(data.generatedAt)}`;
  el("quote-freshness").textContent = `Saved quote timestamps: oldest ${time(data.source.quoteAsOf)} · newest ${time(data.source.newestQuoteAsOf)}. Individual mark dates appear below.`;
  el("source-detail").textContent = `State as of ${time(data.source.stateAsOf)} (${data.source.stateAsOfBasis || "basis unavailable"}) · Quotes as of ${time(data.source.quoteAsOf)} · Retrieved ${time(data.source.quotesRetrievedAt)}`;
  el("action-panel").hidden = !data.todayAction?.text;
  el("action-date").textContent = data.todayAction?.date || "Date unavailable";
  el("action-text").textContent = data.todayAction?.text || "";
  renderScope();
  renderTrend();
  renderRefreshStatus();
  renderReportLinks(credentials?.config);
}
async function loadSavedExport() {
  if (!credentials) return false;
  const { current, signal } = beginRequest();
  const active = credentials;
  status("Loading the latest saved export from GitHub…");
  try {
    const data = await loadGithubPortfolio(active.config, active.token, { signal });
    if (current !== generation) return false;
    display(data, `${active.config.repository} · ${active.config.ref}`);
    status("Connected. Checking GitHub every 15 minutes while this tab is visible. Quotes are collected by the cloud workflow; this page reads the saved export.");
    return true;
  } catch (error) {
    if (current !== generation || error.name === "AbortError") return false;
    status(`${error.message}${portfolio ? " The previous export remains on screen; it has not been refreshed." : ""}`, true);
    return false;
  } finally { finishRequest(current); }
}
el("connect-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const config = { repository: el("repository").value.trim(), ref: el("ref").value.trim(), path: el("path").value.trim() };
  let token = el("token").value.trim();
  el("token").value = "";
  try { githubContentsUrl(config); githubReportLinks(config); } catch (error) { token = ""; status(error.message, true); return; }
  refreshScheduler.stop();
  credentials = { config, token };
  token = "";
  clearData();
  refreshScheduler.start();
});
el("refresh").addEventListener("click", () => void refreshScheduler.runNow());
el("disconnect").addEventListener("click", () => {
  refreshScheduler.stop();
  generation += 1;
  request?.abort(); request = null;
  credentials = null;
  clearData();
  el("token").value = "";
  el("file").value = "";
  el("connection").hidden = false;
  el("disconnect").hidden = true;
  el("refresh").hidden = true;
  el("connect").disabled = false;
  el("refresh").disabled = false;
  document.body.classList.remove("connected");
  status("Disconnected. Portfolio records and the access token have been cleared from this page.");
});
el("file").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  refreshScheduler.stop();
  const { current } = beginRequest();
  credentials = null;
  el("token").value = "";
  clearData();
  status("Reading the local portfolio export…");
  try {
    if (file.size > MAX_EXPORT_BYTES) throw new Error("The export is too large. Use an export under 12 MB.");
    const data = parsePortfolioExport(await file.text());
    if (current !== generation) return;
    display(data, `Local file · ${file.name}`);
    status("Local export opened. This file has not been uploaded; reopen it to see a newer copy.");
  } catch (error) {
    if (current === generation) status(error.message, true);
  } finally {
    if (current === generation) el("file").value = "";
    finishRequest(current);
  }
});

function metric(label, value, detail, valueClass = "") {
  const item = node("div", null, "metric");
  item.append(node("p", label, "label"), node("p", value, `value ${valueClass}`), node("p", detail, "detail"));
  return item;
}
function scopedPositions() {
  const account = el("account").value;
  return portfolio.positions.filter((row) => !account || row.account === account);
}
function renderScope() {
  if (!portfolio) return;
  const positions = scopedPositions();
  const totals = scopeTotals(portfolio, el("account").value);
  const valuation = valuationPresentation(totals, positions);
  const complete = valuation.complete;
  const value = complete ? totals.portfolioValue : totals.coveredPortfolioValue;
  const pnl = displayUnrealizedPnl(positions, totals);
  el("metrics").replaceChildren(
    metric(valuation.label, money(value), complete ? "Signed holdings value · futures excluded" : "Partial valuation · see missing mark coverage", complete ? "" : "small-value"),
    metric("Recorded cash", totals.cashRecorded ? money(totals.cash) : "Not recorded", Number.isFinite(totals.cashEquivalentValue) ? `${money(totals.cashEquivalentValue)} in cash equivalents (separate)` : "Cash equivalents are shown separately", totals.cashRecorded ? "" : "small-value"),
    metric(Number.isFinite(totals.unrealizedPnl) ? "Unrealized P&L" : "Covered unrealized P&L", money(pnl), !Number.isFinite(pnl) ? "No holdings have usable marks and cost" : Number.isFinite(totals.unrealizedPnl) ? "Based on saved marks and recorded cost" : "Only holdings with usable marks and cost", tone(pnl)),
    metric("Valuation coverage", `${number(totals.valuedPositionCount)} / ${number(positions.filter((row) => row.includedInPortfolioValue !== false).length)}`, `${number(totals.missingPriceCount)} unpriced · ${number(valuation.lastKnownCount)} last-known · ${number(totals.futuresCount)} futures excluded`, "small-value"),
  );
  const messages = [];
  if (valuation.note) messages.push(valuation.note);
  if (!complete) messages.push(`${positions.filter(needsValuation).length} holdings have an unavailable value. Select “Unpriced only” below to see them. Missing or unusable prices are not treated as zero.`);
  const lastSessionDates = [...new Set(positions.filter(row => row.quoteStatus === "last-session").map(row => row.quoteSessionDate).filter(Boolean))];
  if (lastSessionDates.length) messages.push(`Last-session prices dated ${lastSessionDates.join(", ")} are included. Their original dates remain visible; these are not live quotes.`);
  if (positions.some((row) => row.quantity < 0)) messages.push("Short holdings retain negative quantities and signed values. Option market value is not assignment cash or maximum loss.");
  if (positions.some((row) => row.includedInPortfolioValue === false)) messages.push("Futures are excluded from portfolio value. Their notional exposure appears in the holding details when available.");
  const warnings = [...new Set([...(Array.isArray(portfolio.warnings) ? portfolio.warnings : []), ...(Array.isArray(totals.warnings) ? totals.warnings : [])].filter((item) => typeof item === "string"))];
  const warningBox = el("warnings"); warningBox.replaceChildren();
  for (const message of messages) warningBox.append(node("p", message));
  if (warnings.length) {
    const details = node("details"); details.append(node("summary", `${warnings.length} source note${warnings.length === 1 ? "" : "s"}`));
    const list = node("ul"); for (const warning of warnings) list.append(node("li", warning));
    details.append(list); warningBox.append(details);
  }
  warningBox.hidden = !messages.length && !warnings.length;
  const allocation = markedAllocation(positions);
  el("allocation").replaceChildren();
  if (!allocation.length || allocation.every((group) => group.grossValue === 0)) el("allocation").append(node("p", "No marked exposure is available for this scope.", "empty"));
  for (const group of allocation) {
    const row = node("div", null, "allocation-row");
    const line = node("div", null, "allocation-label");
    const amount = node("span", money(group.signedValue), "amount"); amount.append(node("span", `${(group.share * 100).toFixed(1)}%`, "pct"));
    line.append(node("span", assetName(group.assetClass)), amount);
    const track = node("div", null, "bar-track");
    const progress = node("progress"); progress.max = 1; progress.value = group.share; progress.setAttribute("aria-label", `${assetName(group.assetClass)}: ${(group.share * 100).toFixed(1)} percent of gross marked exposure`);
    track.append(progress); row.append(line, track); el("allocation").append(row);
  }
  renderHoldings();
}
function renderHoldings() {
  if (!portfolio) return;
  const scope = scopedPositions();
  const search = el("search").value.trim().toLowerCase();
  const asset = el("asset").value;
  const positions = scope.filter((row) => (!el("unpriced").checked || needsValuation(row)) && (!asset || (row.assetClass || "other") === asset)
    && (!search || [row.symbol, row.account, row.sector, row.assetClass, row.optionType].some((value) => String(value || "").toLowerCase().includes(search))));
  positions.sort((a, b) => {
    const left = a[sort.key], right = b[sort.key];
    if (left == null) return right == null ? 0 : 1;
    if (right == null) return -1;
    const delta = typeof left === "number" && typeof right === "number" ? left - right : String(left).localeCompare(String(right));
    return sort.descending ? -delta : delta;
  });
  el("holdings-count").textContent = `${positions.length} of ${scope.length} holdings in this account scope`;
  const tbody = el("holdings"); tbody.replaceChildren();
  if (!positions.length) {
    const tr = node("tr"), td = node("td", "No holdings match these filters.", "empty"); td.colSpan = 7; tr.append(td); tbody.append(tr); return;
  }
  for (const row of positions) {
    const tr = node("tr");
    const holding = node("td"); holding.append(node("div", row.symbol, "holding-symbol"));
    const detail = [assetName(row.assetClass)];
    if (row.optionType) detail.push(row.optionType);
    if (Number.isFinite(row.strike)) detail.push(`Strike ${money(row.strike)}`);
    if (row.expiration) detail.push(row.expiration);
    if (row.assetClass === "option" && Number.isFinite(row.multiplier)) detail.push(`×${number(row.multiplier)}`);
    if (row.sector) detail.push(row.sector);
    if (row.includedInPortfolioValue === false) detail.push(`Excluded · notional ${money(row.notionalValue)}`);
    holding.append(node("div", detail.join(" · "), "holding-detail"));
    if (Array.isArray(row.warnings) && row.warnings.length) holding.title = row.warnings.filter((item) => typeof item === "string").join("\n");
    const quantity = node("td", number(row.quantity), `number ${row.quantity < 0 ? "negative" : ""}`);
    const value = node("td", row.includedInPortfolioValue === false ? "Excluded" : money(row.marketValue), `number ${row.marketValue < 0 ? "negative" : ""}`);
    const evidence = node("td");
    const evidenceInfo = markEvidence(row);
    evidence.append(node("div", evidenceInfo.label, "quote-state"));
    const dated = evidenceInfo.date ? time(evidenceInfo.date)
      : evidenceInfo.session ? `Session ${evidenceInfo.session}` : "Unavailable";
    evidence.append(node("div", evidenceInfo.book ? "Bookkeeping value, not a market quote" : dated, "quote-time"));
    tr.append(holding, node("td", row.account || "Unspecified"), quantity, node("td", money(row.price), "number"), value, node("td", row.pnlStatus === "not-applicable" ? "Not applicable" : money(row.unrealizedPnl), `number ${tone(row.unrealizedPnl)}`), evidence);
    tbody.append(tr);
  }
}
function svgNode(tag, attributes, text) {
  const item = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attributes)) item.setAttribute(key, String(value));
  if (text != null) item.textContent = text;
  return item;
}
function renderTrend() {
  const snapshots = portfolio.snapshots.filter((row) => row && Number.isFinite(row.totalValue) && typeof row.date === "string" && Number.isFinite(Date.parse(row.date)))
    .sort((a, b) => a.date.localeCompare(b.date));
  el("snapshot-count").textContent = `${snapshots.length} saved points`;
  const trend = el("trend"); trend.replaceChildren();
  const omitted = portfolio.snapshots.length - snapshots.length;
  el("trend-note").textContent = `Historical snapshots are not independently revalidated. Changes include cash flows and bookkeeping.${omitted ? ` ${omitted} snapshot(s) without an available full valuation omitted.` : ""}`;
  if (!snapshots.length) { trend.append(node("p", "No saved snapshot valuations are available.", "empty")); return; }
  const width = 760, height = 176, left = 76, right = 18, top = 12, bottom = 26;
  const values = snapshots.map((row) => row.totalValue);
  let min = Math.min(...values), max = Math.max(...values);
  const padding = max === min ? Math.max(Math.abs(max) * .02, 1) : (max - min) * .12;
  min -= padding; max += padding;
  const x = (index) => left + (snapshots.length === 1 ? .5 : index / (snapshots.length - 1)) * (width - left - right);
  const y = (value) => top + (max - value) / (max - min) * (height - top - bottom);
  const svg = svgNode("svg", { viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": `${snapshots.length} saved portfolio valuations, from ${snapshots[0].date} at ${money(values[0])} to ${snapshots.at(-1).date} at ${money(values.at(-1))}.` });
  for (let step = 0; step < 3; step += 1) {
    const value = min + (max - min) * step / 2;
    svg.append(svgNode("line", { x1: left, x2: width - right, y1: y(value), y2: y(value), class: "chart-grid" }));
    svg.append(svgNode("text", { x: left - 10, y: y(value) + 3, "text-anchor": "end", class: "chart-label" }, compact.format(value)));
  }
  const points = snapshots.map((row, index) => `${x(index)},${y(row.totalValue)}`).join(" ");
  if (snapshots.length > 1) {
    svg.append(svgNode("polygon", { points: `${x(0)},${height - bottom} ${points} ${x(snapshots.length - 1)},${height - bottom}`, class: "chart-area" }));
    svg.append(svgNode("polyline", { points, class: "chart-line" }));
  }
  snapshots.forEach((row, index) => {
    const circle = svgNode("circle", { cx: x(index), cy: y(row.totalValue), r: snapshots.length > 100 ? 2 : 3, class: "chart-point" });
    circle.append(svgNode("title", {}, `${row.date}: ${money(row.totalValue)} · ${time(row.timestamp)}`)); svg.append(circle);
  });
  const labels = [...new Set([0, Math.floor((snapshots.length - 1) / 2), snapshots.length - 1])];
  for (const index of labels) svg.append(svgNode("text", { x: x(index), y: height - 5, "text-anchor": index === 0 && snapshots.length > 1 ? "start" : index === snapshots.length - 1 && snapshots.length > 1 ? "end" : "middle", class: "chart-label" }, snapshots[index].date.slice(0, 10)));
  trend.append(svg);
}
el("account").addEventListener("change", renderScope);
el("asset").addEventListener("change", renderHoldings);
el("unpriced").addEventListener("change", renderHoldings);
el("search").addEventListener("input", renderHoldings);
for (const button of document.querySelectorAll("[data-sort]")) {
  button.addEventListener("click", () => {
    const key = button.dataset.sort;
    sort = { key, descending: key === sort.key ? !sort.descending : !["symbol", "account"].includes(key) };
    for (const item of document.querySelectorAll("[data-sort]")) {
      const title = item.textContent.replace(/ [↑↓]$/, "");
      item.textContent = title + (item === button ? sort.descending ? " ↓" : " ↑" : "");
      if (item === button) item.parentElement.setAttribute("aria-sort", sort.descending ? "descending" : "ascending");
      else item.parentElement.removeAttribute("aria-sort");
    }
    renderHoldings();
  });
}
// A restored back/forward page must not revive a previous authenticated session.
window.addEventListener("pagehide", () => el("disconnect").click());
document.addEventListener("visibilitychange", () => refreshScheduler.visibilityChanged());
renderReportLinks();
