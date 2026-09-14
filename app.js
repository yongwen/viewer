import { loadGithubPortfolio, loadGithubReport, REPORT_TYPES, parsePortfolioExport, githubContentsUrl, githubReportLinks, DEFAULT_REPORT_SOURCE, markedAllocation, scopeTotals, displayUnrealizedPnl, needsValuation, markEvidence, valuationPresentation, createRefreshScheduler, MAX_EXPORT_BYTES } from "./loader.js";
import { COLUMNS, OPTION_SORT_KEYS, positionDisplay, groupedHoldings, shortPutNotional, cashSectorValue, newYorkDate } from "./view-model.js";
import { renderReportMarkdown } from "./report-markdown.js";
import { pendingOrderText, pendingOrdersSource } from './open-orders.js';

const el = (id) => document.getElementById(id);
const currency = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 8 });
const compact = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 });
const dateFormat = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "America/New_York" });
const assetNames = { stock: "Stocks", etf: "ETFs", mutual_fund: "Mutual funds", mutualFund: "Mutual funds", option: "Options", cash: "Cash", cash_equivalent: "Cash equivalents", bond: "Bonds", index_future: "Futures", other: "Other" };
let portfolio = null;
let credentials = null;
let request = null;
let generation = 0;
let sourceName = "";
let selectedReport = null;
let reportRequest = null;
let reportGeneration = 0;
let sort = { key: "symbol", descending: false };
const expanded = new Set();
const wholeCurrency = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const refreshScheduler = createRefreshScheduler({ run: loadSavedExport,
  isVisible: () => document.visibilityState !== "hidden", onChange: renderRefreshStatus });

function node(tag, text, className) {
  const item = document.createElement(tag);
  if (text != null) item.textContent = String(text);
  if (className) item.className = className;
  return item;
}
function money(value) { return Number.isFinite(value) ? wholeCurrency.format(value) : "—"; }
function price(value) { return Number.isFinite(value) ? currency.format(value) : "—"; }
function signedMoney(value) { return Number.isFinite(value) ? `${value>0?'+':''}${money(value)}` : "—"; }
function percent(value) { return Number.isFinite(value) ? `${value>0?'+':''}${value.toFixed(2)}%` : "—"; }
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
  const shortLabels = ["开盘简报", "Action plan", "Premarket", "Intraday", "Preclose", "Postmarket"];
  const links = REPORT_TYPES.map(({ label, type }, index) => {
    const link = node("a", shortLabels[index]);
    link.title = `${label} · latest saved report; check the date inside`;
    link.href = `#report/${type}`;
    link.dataset.reportType = type;
    if (type === selectedReport) link.setAttribute("aria-current", "page");
    return link;
  });
  el("report-links").replaceChildren(...links);
  el("report-source").textContent = `${config.repository} · ${config.ref}`;
}

function reportFromLocation() {
  const type = window.location.hash.replace(/^#report\//, "");
  return REPORT_TYPES.some(report => report.type === type) ? type : null;
}
function closeReport({ clearLocation = true, focusLink = false } = {}) {
  const previous = selectedReport;
  selectedReport = null;
  reportGeneration += 1;
  reportRequest?.abort(); reportRequest = null;
  el("report-reader").hidden = true;
  el("report-content").replaceChildren();
  el("report-meta").textContent = "";
  el("report-status").textContent = "";
  el("report-content").setAttribute("aria-busy", "false");
  document.body.classList.remove("reading-report");
  if (clearLocation && window.location.hash.startsWith("#report/")) {
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
  }
  renderReportLinks(credentials?.config);
  if (focusLink && previous) el("report-links").querySelector(`[data-report-type="${previous}"]`)?.focus();
}
async function openReport(type, { navigate = false, focus = false } = {}) {
  const definition = REPORT_TYPES.find(report => report.type === type);
  if (!definition || !portfolio) return;
  if (navigate) {
    const method = selectedReport ? "replaceState" : "pushState";
    window.history[method](null, "", `#report/${type}`);
  }
  selectedReport = type;
  const current = ++reportGeneration;
  reportRequest?.abort();
  const controller = new AbortController(); reportRequest = controller;
  const active = credentials;
  document.body.classList.add("reading-report");
  el("report-reader").hidden = false;
  el("report-title").textContent = definition.label;
  el("report-meta").textContent = "";
  el("report-content").replaceChildren();
  el("report-content").setAttribute("aria-busy", "true");
  el("report-status").textContent = active ? "Loading the latest saved cloud report…" : "Connect to GitHub to read cloud reports. A local portfolio export does not include report contents.";
  el("report-status").classList.remove("error");
  el("report-connect").hidden = !!active;
  el("report-refresh").disabled = true;
  renderReportLinks(active?.config);
  if (focus) el("report-title").focus({ preventScroll: true });
  el("report-reader").scrollIntoView({ block: "start" });
  try {
    if (!active) return;
    const report = await loadGithubReport(active.config, active.token, type, { signal: controller.signal });
    if (current !== reportGeneration || credentials !== active) return;
    el("report-content").innerHTML = renderReportMarkdown(report.markdown);
    el("report-meta").textContent = `Loaded ${time(new Date().toISOString())} · Check the market date in the report.`;
    el("report-status").textContent = report.markdown.trim() ? "" : "This cloud report is empty. Try another report type or refresh later.";
  } catch (error) {
    if (current !== reportGeneration || error.name === "AbortError") return;
    el("report-status").textContent = error.message;
    el("report-status").classList.add("error");
  } finally {
    if (current === reportGeneration) {
      reportRequest = null;
      el("report-content").setAttribute("aria-busy", "false");
      el("report-refresh").disabled = !credentials;
    }
  }
}
el("report-links").addEventListener("click", event => {
  const link = event.target.closest("[data-report-type]");
  if (!link || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  void openReport(link.dataset.reportType, { navigate: true, focus: true });
});
el("report-back").addEventListener("click", () => closeReport({ focusLink: true }));
el("report-refresh").addEventListener("click", () => void openReport(selectedReport));
el("report-connect").addEventListener("click", () => {
  el("connection").hidden = false;
  el("connection").scrollIntoView({ block: "start" });
  el("token").focus();
});
window.addEventListener("popstate", () => {
  const type = reportFromLocation();
  if (type) void openReport(type);
  else closeReport({ clearLocation: false });
});
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
function clearData({ preserveReportLocation = false } = {}) {
  closeReport({ clearLocation: !preserveReportLocation });
  portfolio = null;
  el('open-orders-content').replaceChildren();
  sourceName = "";
  expanded.clear();
  el("dashboard").hidden = true;
  el("account-control").hidden = true;
  for (const id of ["metrics", "benchmarks", "put-notional", "saved-summary", "coverage-summary", "visible-count", "table-total", "sort-status", "allocation", "trend", "warnings", "holdings", "source-label", "source-detail", "updated", "quote-freshness", "refresh-status", "snapshot-count", "trend-note", "action-date", "action-text", "holdings-count"]) el(id).replaceChildren();
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
  const firstLoad = !portfolio;
  portfolio = data;
  sourceName = source;
  el("connection").hidden = true;
  el("dashboard").hidden = false;
  el("disconnect").hidden = false;
  el("refresh").hidden = !credentials;
  el("account-control").hidden = false;
  if (firstLoad) [...new Set(data.positions.filter(row=>row.assetClass==='option').map(row=>row.symbol))].sort().slice(0,2).forEach(symbol=>expanded.add(symbol));
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
  el("saved-summary").textContent = `Saved ${time(data.generatedAt)} · saved quotes`;
  el("quote-freshness").textContent = `Saved quote timestamps: oldest ${time(data.source.quoteAsOf)} · newest ${time(data.source.newestQuoteAsOf)}. Individual mark dates appear below.`;
  el("source-detail").textContent = `State as of ${time(data.source.stateAsOf)} (${data.source.stateAsOfBasis || "basis unavailable"}) · Quotes as of ${time(data.source.quoteAsOf)} · Retrieved ${time(data.source.quotesRetrievedAt)}`;
  el("action-panel").hidden = !data.todayAction?.text;
  el("action-date").textContent = data.todayAction?.date || "Date unavailable";
  el("action-text").textContent = data.todayAction?.text || "";
  renderScope();
  renderTrend();
  renderRefreshStatus();
  renderReportLinks(credentials?.config);
  if (!selectedReport && reportFromLocation()) void openReport(reportFromLocation());
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
  clearData({ preserveReportLocation: true });
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
function marketMetric(label, record, fear=false) {
  const available=Number.isFinite(record?.value);
  const blocked = record?.reason === 'http-error' && [401,403,418,429].includes(record?.httpStatus);
  const missingDetail = blocked ? `${fear ? 'CNN' : 'Quote'} feed temporarily unavailable` : 'No verified saved reading';
  const item=metric(label,available?(fear?`${Math.round(record.value)}`:record.value.toFixed(2)):"Unavailable",available?`${record.status==='last-known'?'Last-known · ':''}${time(record.quoteAsOf)}`:missingDetail,available?'':'small-value unavailable');
  const officialLink=node('a',`${label} ↗`,'market-kpi-link');
  officialLink.href=fear?'https://www.cnn.com/markets/fear-and-greed':'https://www.cboe.com/tradable-products/vix';
  officialLink.target='_blank';officialLink.rel='noopener noreferrer';
  officialLink.setAttribute('aria-label',`${label} official page (opens a new tab)`);
  item.querySelector('.label').replaceChildren(officialLink);
  if(available && fear) {
    item.querySelector('.value').classList.add('fear-score');
    item.querySelector('.value').append(node('span',`/100 · ${record.rating||'Rating unavailable'}`,'fear-rating'));
    const meter=node('meter',null,'fear-meter');meter.min=0;meter.max=100;meter.value=record.value;meter.setAttribute('aria-label',`CNN Fear and Greed ${record.value} out of 100`);
    item.insertBefore(meter,item.querySelector('.detail'));
  } else if(available && Number.isFinite(record.change)) {
    item.querySelector('.detail').prepend(node('span',`${record.change>0?'+':''}${record.change.toFixed(2)} · `));
  }
  if(available && record?.sourceUrl && /^https:\/\//.test(record.sourceUrl)) {
    const link=node('a',String(record.source||'').toLowerCase()==='cnn'?'CNN':record.source||'Source');link.href=record.sourceUrl;link.target='_blank';link.rel='noopener noreferrer';
    item.querySelector('.detail').append(document.createTextNode(' · '),link);
  }
  return item;
}
function renderMarkets(positions) {
  const market=portfolio.marketData||{};
  el('metrics').append(marketMetric('VIX',market.vix),marketMetric('CNN Fear & Greed',market.fearGreed,true));
  el('benchmarks').replaceChildren(...['QQQ','SPY','SOXX'].map(symbol=>{
    const quote=market.benchmarks?.[symbol], span=node('span');
    span.append(node('b',symbol),document.createTextNode(` ${price(quote?.value)} `),node('span',percent(quote?.changePercent),tone(quote?.changePercent)));
    span.title=quote&&Number.isFinite(quote.value)?`${quote.status==='last-known'?'Last-known · ':''}${quote.source||'Source unavailable'} · ${time(quote.quoteAsOf)}`:'Saved benchmark quote unavailable';
    return span;
  }));
  el('put-notional').textContent=money(shortPutNotional(positions));
}
function scopedPositions() {
  const account = el("account").value;
  return portfolio.positions.filter((row) => !account || row.account === account);
}
function renderScope() {
  if (!portfolio) return;
  el('open-orders-content').textContent = pendingOrdersSource(portfolio.openOrders);
  const positions = scopedPositions();
  const totals = scopeTotals(portfolio, el("account").value);
  const valuation = valuationPresentation(totals, positions);
  const complete = valuation.complete;
  const value = complete ? totals.portfolioValue : totals.coveredPortfolioValue;
  const pnl = displayUnrealizedPnl(positions, totals);
  const pnlBasis=positions.filter(row=>Number.isFinite(row.unrealizedPnl)&&Number.isFinite(row.costBasis)).reduce((sum,row)=>sum+Math.abs(row.costBasis),0);
  const daily=Number.isFinite(totals.dailyPnl)?totals.dailyPnl:totals.coveredDailyPnl;
  const cashEquivalentValue=cashSectorValue(positions);
  el("metrics").replaceChildren(
    metric(valuation.label, money(value),complete?(el('account').value||'All accounts'):'Subtotal · incomplete',complete?'':'caution'),
    metric(Number.isFinite(totals.unrealizedPnl)?"Unrealized P&L":"Covered unrealized P&L",signedMoney(pnl),Number.isFinite(pnl)&&pnlBasis?`${percent(pnl/pnlBasis*100)} · recorded cost`:'Saved marks and cost required',tone(pnl)),
    metric(totals.dailyPnlComplete?'Daily P&L':Number.isFinite(daily)?'Covered daily P&L':'Daily P&L',signedMoney(daily),totals.dailyPnlComplete?'Saved session vs prior close':Number.isFinite(daily)?'Partial · eligible saved quotes':'Prior-close evidence unavailable',tone(daily)),
    metric('Cash equivalents',money(cashEquivalentValue),cashEquivalentValue===null?'Sector: cash · unavailable':'Sector: cash'),
  );
  renderMarkets(positions);
  el('coverage-summary').textContent=`· ${number(totals.valuedPositionCount)} / ${positions.filter(row=>row.includedInPortfolioValue!==false).length} valued${!complete?' · incomplete subtotal':''}${valuation.lastKnownCount?` · ${valuation.lastKnownCount} last-known`:''}`;
  el('coverage-summary').className=complete&&!valuation.lastKnownCount?'':'caution';
  el('data-details').classList.toggle('partial',!complete);
  el('data-details').classList.toggle('estimated',valuation.lastKnownCount>0);
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
let allocationPopup=null, allocationAnchor=null;
function hideAllocation() {
  allocationPopup?.remove();allocationPopup=null;
  allocationAnchor?.querySelector('.allocation-trigger')?.setAttribute('aria-expanded','false');
  allocationAnchor=null;
}
function showAllocation(tr,row) {
  hideAllocation();allocationAnchor=tr;
  const popup=node('div',null,'allocation-popup');popup.id='allocation-popup';popup.setAttribute('role','tooltip');
  popup.append(node('strong',`${row.symbol} · Account allocation`));
  const table=node('table'),head=node('thead'),header=node('tr');
  for(const label of ['Account',row.isCash||row.isCashEquivalent?'Balance':'Shares','Value'])header.append(node('th',label));
  head.append(header);table.append(head);const body=node('tbody');
  for(const part of row.allocationRows||[row]) {
    const line=node('tr');
    const value=Number.isFinite(part.marketValue)?currency.format(part.marketValue):'—';
    line.append(node('td',part.account||'Unallocated'),node('td',row.isCash||row.isCashEquivalent?value:number(part.quantity)),node('td',value));
    body.append(line);
  }
  table.append(body);popup.append(table);document.body.append(popup);allocationPopup=popup;
  tr.querySelector('.allocation-trigger')?.setAttribute('aria-expanded','true');
  const anchor=tr.querySelector('[data-column="quantity"]')||tr,box=anchor.getBoundingClientRect(),bounds=popup.getBoundingClientRect();
  popup.style.left=`${Math.max(8,Math.min(box.left,window.innerWidth-bounds.width-8))}px`;
  popup.style.top=`${Math.max(8,box.bottom+bounds.height+8>window.innerHeight?box.top-bounds.height-8:box.bottom+8)}px`;
}
document.addEventListener('keydown',event=>{if(event.key==='Escape')hideAllocation();});
document.addEventListener('pointerdown',event=>{if(allocationAnchor&&!allocationAnchor.contains(event.target))hideAllocation();});
window.addEventListener('scroll',hideAllocation,true);
window.addEventListener('resize',hideAllocation);

function renderHoldings() {
  if (!portfolio) return;
  hideAllocation();
  const scope = scopedPositions();
  const totals=scopeTotals(portfolio,el('account').value), valuation=valuationPresentation(totals,scope);
  const positions=scope.map(row=>({...positionDisplay(row,{total:totals.portfolioValue,complete:valuation.complete}),pendingOrder:pendingOrderText(portfolio.openOrders,row)}));
  const groups=groupedHoldings(positions,{...sort,search:el('search').value,asset:el('asset').value,unpriced:el('unpriced').checked});
  const visibleColumns=COLUMNS.filter(column=>!column.extra||el('option-columns').checked);
  const matched=groups.reduce((sum,g)=>sum+g.matchedCount,0);
  el('holdings-count').textContent=`${groups.reduce((sum,g)=>sum+g.parents.length,0)} holdings · ${matched} / ${scope.length} account positions`;
  el('visible-count').textContent=`${groups.length} ticker groups`;
  const sortLabel=COLUMNS.find(column=>column.key===sort.key)?.label||'Ticker';
  el('sort-status').textContent=`${sortLabel} ${sort.descending?'↓':'↑'} · ${sort.key==='dte'?(sort.descending?'latest':'nearest')+' expiry per ticker · ':''}groups stay together`;
  el('table-total').textContent=`${valuation.complete?'Portfolio total':'Covered subtotal'} ${money(valuation.complete?totals.portfolioValue:totals.coveredPortfolioValue)}`;
  const tbody = el("holdings"); tbody.replaceChildren();
  if (!groups.length) {
    const tr = node("tr"), td = node("td", "No holdings match these filters.", "empty"); td.colSpan=visibleColumns.length; tr.append(td); tbody.append(tr);
  }
  for(const group of groups) {
    const open=expanded.has(group.symbol)||(!group.parents.length&&Boolean(el('search').value||el('asset').value||el('unpriced').checked));
    const parentRows=group.parents.length?group.parents:[null];
    parentRows.forEach((row,index)=>{
      const tr=node('tr',null,'stock-row');tr.dataset.symbol=group.symbol;if(row)tr.dataset.rowId=row.id||row.positionId;
      const holding=node('td'), ticker=node('div',null,'ticker');
      if(index===0&&group.options.length) {
        const toggle=node('button',open?'▾':'▸','group-toggle');toggle.type='button';toggle.dataset.toggle=group.symbol;
        toggle.setAttribute('aria-label',`${open?'Collapse':'Expand'} ${group.symbol} options`);toggle.setAttribute('aria-expanded',String(open));ticker.append(toggle);
      } else ticker.append(node('span',null,'toggle-space'));
      ticker.append(node('span',group.symbol,'holding-symbol'));
      if(index===0&&group.options.length)ticker.append(node('span',`${group.options.length} opt`,'option-count'));
      holding.append(ticker,node('div',row?`${assetName(row.assetClass)}${row.includedInPortfolioValue===false?' · excluded futures notional '+money(row.notionalValue):''}`:'Options only','holding-detail'));
      tr.append(holding);
      if(row) {
        appendHoldingCells(tr,row);
        if(row.assetClass==='stock') {
          tr.addEventListener('mouseenter',()=>showAllocation(tr,row));
          tr.addEventListener('mouseleave',()=>{if(!tr.contains(document.activeElement))hideAllocation();});
        }
      }
      else {
        for(const column of COLUMNS.slice(1)) {
          const cell=node('td',column.key==='pendingOrder' ? pendingOrderText(portfolio.openOrders,{symbol:group.symbol}, {group:true,accounts:group.options.map(p=>p.account)}) || '—' : '—',column.extra?'option-col':'muted');
          cell.dataset.column=column.key;tr.append(cell);
        }
      }
      tbody.append(tr);
    });
    if(open) for(const row of group.options) {
      const tr=node('tr',null,'option-row');tr.dataset.symbol=group.symbol;tr.dataset.rowId=row.id||row.positionId;
      const holding=node('td'), contract=node('div',null,'option-contract');
      contract.append(node('span',String(row.optionType||'Option').toUpperCase(),'option-tag'),document.createTextNode(`${price(row.strike)} · ${row.expiration||'Expiry unavailable'}`));
      const detail=`IV ${Number.isFinite(row.optionIv)?(row.optionIv*100).toFixed(1)+'%':'—'} · Δ ${Number.isFinite(row.optionDelta)?row.optionDelta.toFixed(2):'—'} · ×${number(row.multiplier)}`;
      holding.append(contract,node('div',detail,'holding-detail inline-greeks'));tr.append(holding);appendHoldingCells(tr,row);tbody.append(tr);
    }
  }
  const optionSymbols=[...new Set(scope.filter(row=>row.assetClass==='option').map(row=>row.symbol))];
  el('expand-options').textContent=optionSymbols.length&&optionSymbols.every(symbol=>expanded.has(symbol))?'Collapse options':'Expand options';
  el('expand-options').disabled=!optionSymbols.length;
}
function appendHoldingCells(tr,row) {
  for(const column of COLUMNS.slice(1)) {
    const key=column.key, val=row[key];
    const td=node('td',null,column.extra?'option-col':'');td.dataset.column=key;
    if(key==='pendingOrder') {
      td.textContent=pendingOrderText(portfolio.openOrders,row)||'—';
      td.title='Saved broker orders matched to this holding and account. Pending trades have not changed the recorded position.';
    } else if(key==='price') {
      const evidence=markEvidence(row),details=node('details',null,'quote-details');
      details.append(node('summary',price(row.price)));
      const lines=[evidence.label,evidence.book?'Recorded balance':evidence.date?time(evidence.date):evidence.session?'Session '+evidence.session:'Quote time unavailable',...(row.warnings||[])];
      if(Number.isFinite(row.previousClose))lines.push(`Prior close ${price(row.previousClose)} · ${row.previousCloseSessionDate||'Session unavailable'}`);
      if(Number.isFinite(row.underlyingPrice))lines.push(`Underlying ${price(row.underlyingPrice)} · ${time(row.underlyingQuoteAsOf)}`);
      const body=node('div');lines.forEach(line=>body.append(node('p',line)));details.append(body);td.append(details);
      const shortDate=evidence.book?'Book value':evidence.session||((evidence.date&&Number.isFinite(Date.parse(evidence.date)))?newYorkDate(new Date(evidence.date)):'Unpriced');
      td.append(node('span',`${row.quoteStatus==='last-known'?'Last-known · ':row.quoteFeed==='indicative'?'Indicative · ':''}${shortDate}`,'quote-date'));
    } else if(['changePercent','strikeDeltaPercent','pnlPercent','portfolioPercent'].includes(key))td.textContent=key==='portfolioPercent'&&Number.isFinite(val)?`${val.toFixed(1)}%`:percent(val);
    else if(key==='optionIv')td.textContent=Number.isFinite(val)?`${(val*100).toFixed(1)}%`:'—';
    else if(key==='optionDelta')td.textContent=Number.isFinite(val)?val.toFixed(2):'—';
    else if(key==='quantity') {
      if(row.assetClass==='stock') {
        const button=node('button',row.isCash?(Number.isFinite(row.marketValue)?currency.format(row.marketValue):'—'):number(val),'allocation-trigger');button.type='button';
        button.setAttribute('aria-label',`${row.symbol} account allocation`);button.setAttribute('aria-expanded','false');button.setAttribute('aria-describedby','allocation-popup');
        button.addEventListener('focus',()=>showAllocation(tr,row));button.addEventListener('click',()=>showAllocation(tr,row));button.addEventListener('blur',hideAllocation);td.append(button);
      } else td.textContent=`${number(val)}${row.assetClass==='option'?' ct':''}`;
    }
    else if(key==='dte') {td.textContent=number(val);td.title=`Calendar days to expiry as of ${newYorkDate()} New York${row.expiration&&row.expiration<newYorkDate()?' · expired':''}`;}
    else if(['avgCost','effectiveAvgCost','extrinsicValue'].includes(key))td.textContent=price(val);
    else if(['unrealizedPnl','dailyPnl','planDrift'].includes(key))td.textContent=signedMoney(val);
    else if(key==='marketValue')td.textContent=row.includedInPortfolioValue===false?'Excluded':money(val);
    else if(key==='planValue') {td.textContent=money(val);if(row.planAllocationBasis)td.title=`Saved plan allocation: ${row.planAllocationBasis}`;}
    else td.textContent=val??'—';
    if(['changePercent','unrealizedPnl','pnlPercent','dailyPnl'].includes(key))td.classList.add(tone(val)||'neutral');
    if(key==='planDrift')td.classList.add(val>0?'drift-over':val<0?'drift-under':'neutral');
    if(key==='account'||key==='sector')td.classList.add('account-cell');
    tr.append(td);
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
  const width = Math.max(280,trend.clientWidth||760), height = 176, left = 64, right = 18, top = 12, bottom = 26;
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
  const labels = [...new Set(width<440?[0,snapshots.length-1]:[0, Math.floor((snapshots.length - 1) / 2), snapshots.length - 1])];
  for (const index of labels) svg.append(svgNode("text", { x: x(index), y: height - 5, "text-anchor": index === 0 && snapshots.length > 1 ? "start" : index === snapshots.length - 1 && snapshots.length > 1 ? "end" : "middle", class: "chart-label" }, snapshots[index].date.slice(0, 10)));
  trend.append(svg);
}
el("account").addEventListener("change", renderScope);
el("asset").addEventListener("change", renderHoldings);
el("unpriced").addEventListener("change", renderHoldings);
el("search").addEventListener("input", renderHoldings);
for(const column of COLUMNS) {
  const th=node('th',null,column.extra?'option-col':'');th.scope='col';th.dataset.column=column.key;
  const button=node('button',column.label);button.type='button';button.dataset.sort=column.key;
  const descriptions={planDrift:'Total value minus saved Plan value, in dollars. Positive is above plan; negative is below. Missing plan or quote stays unavailable.',planValue:'Saved target; account allocations share one target. Zero is valid; absent is unavailable.',dte:'Calendar days to expiration, calculated for today in New York. Sorting keeps options under their ticker.',dailyPnl:'Saved-session mark minus a verified previous-session close, multiplied by signed quantity and contract multiplier.'};
  if(descriptions[column.key])button.title=descriptions[column.key];
  button.append(node('span',column.key===sort.key?'↑':'↕','sort-mark'));th.setAttribute('aria-sort',column.key===sort.key?'ascending':'none');th.append(button);el('holding-columns').append(th);
  button.addEventListener("click", () => {
    const key = button.dataset.sort;
    sort = { key, descending: key === sort.key ? !sort.descending : false };
    if(OPTION_SORT_KEYS.has(key)&&portfolio)scopedPositions().filter(row=>row.assetClass==='option').forEach(row=>expanded.add(row.symbol));
    for (const item of document.querySelectorAll("[data-sort]")) {
      item.querySelector('.sort-mark').textContent=item===button?(sort.descending?'↓':'↑'):'↕';
      item.setAttribute('aria-label',`Sort by ${COLUMNS.find(column=>column.key===item.dataset.sort).label}, ${item===button&&!sort.descending?'descending':'ascending'}`);
      if (item === button) item.parentElement.setAttribute("aria-sort", sort.descending ? "descending" : "ascending");
      else item.parentElement.setAttribute('aria-sort','none');
    }
    renderHoldings();
  });
}
el('holdings').addEventListener('click',event=>{
  const button=event.target.closest('[data-toggle]');if(!button)return;
  const symbol=button.dataset.toggle;expanded.has(symbol)?expanded.delete(symbol):expanded.add(symbol);renderHoldings();
  [...el('holdings').querySelectorAll('[data-toggle]')].find(item=>item.dataset.toggle===symbol)?.focus({preventScroll:true});
});
el('expand-options').addEventListener('click',()=>{
  if(!portfolio)return;
  const symbols=[...new Set(scopedPositions().filter(row=>row.assetClass==='option').map(row=>row.symbol))];
  const collapse=symbols.every(symbol=>expanded.has(symbol));symbols.forEach(symbol=>collapse?expanded.delete(symbol):expanded.add(symbol));renderHoldings();
});
el('option-columns').addEventListener('change',()=>{document.body.classList.toggle('extended-columns',el('option-columns').checked);renderHoldings();});
el('history-details').addEventListener('toggle',()=>{if(portfolio&&el('history-details').open)renderTrend();});
let resizeTimer;
window.addEventListener('resize',()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{if(portfolio&&el('history-details').open)renderTrend();},100);});
// A restored back/forward page must not revive a previous authenticated session.
window.addEventListener("pagehide", () => el("disconnect").click());
document.addEventListener("visibilitychange", () => refreshScheduler.visibilityChanged());
renderReportLinks();
