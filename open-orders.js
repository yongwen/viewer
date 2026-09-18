// Display-only projection. Broker identifiers remain in private report evidence.
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const text = value => typeof value === 'string' ? value.slice(0, 2000) : '';
const number = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
const amount = value => number(value) === null ? 'Unknown' : String(number(value));
const terminal = new Set(['FILLED','CANCELED','CANCELLED','REPLACED','REJECTED','EXPIRED','FAILED']);
const validTime = value => Number.isFinite(Date.parse(value));
const evidenceTime = report => text(report?.brokerEvidence?.collectionWindow?.end || report?.brokerEvidence?.checkedAt
  || report?.brokerEvidence?.generatedAt || report?.generatedAt);

function savedOrder(order) {
  // Retain only display fields, even if an older export contains private IDs.
  return Object.fromEntries([
    ...['broker','account','symbol','action','price','duration','status','checkedAt'].map(key => [key,text(order[key])]),
    ...['quantity','filled','remaining'].map(key => [key,number(order[key])])
  ]);
}

export function openOrdersFromReports(reports, {previousSnapshot = null, retainedSnapshot = null, gtcState = null} = {}) {
  const orderedReports = reports.filter(r => r && r.brokerEvidence && Number.isFinite(Date.parse(r.generatedAt)))
    .sort((a,b) => Date.parse(b.generatedAt)-Date.parse(a.generatedAt));
  const report = orderedReports[0];
  let orders = [];
  const coverage = [], checkedTimes = [], sources = {};
  for (const [key, broker] of [['schwab','Schwab'],['robinhood','Robinhood']]) {
    let sourceReport = orderedReports.find(r => Array.isArray(r.brokerEvidence[key]?.orders));
    const savedSource = snapshot => snapshot?.sources?.[key] || (snapshot?.orders?.some(order => order?.broker === broker)
      ? {checkedAt:snapshot.checkedAt,reportGeneratedAt:snapshot.reportGeneratedAt} : null);
    const savedSnapshot = [retainedSnapshot,previousSnapshot].filter(snapshot => Array.isArray(snapshot?.orders) && savedSource(snapshot))
      .sort((a,b)=>(Date.parse(savedSource(b).checkedAt) || 0)-(Date.parse(savedSource(a).checkedAt) || 0))[0];
    const savedRows = (savedSnapshot?.orders || []).filter(order => order?.broker === broker);
    const previousSource = savedSource(savedSnapshot);
    if (previousSource && (!sourceReport || Date.parse(previousSource.checkedAt) > Date.parse(evidenceTime(sourceReport)))) {
      sources[key] = {checkedAt:text(previousSource.checkedAt), reportGeneratedAt:text(previousSource.reportGeneratedAt)};
      const retained = savedRows.filter(order => !terminal.has(String(order.status).toUpperCase())).map(savedOrder);
      orders.push(...retained);
      checkedTimes.push(previousSource.checkedAt, ...retained.map(order => order.checkedAt));
      coverage.push(`${broker}: retained ${retained.length} saved orders from ${text(previousSource.checkedAt) || 'an unknown check time'}; current order status and complete coverage are unverified.`);
      continue;
    }
    // This snapshot covers only Robinhood GTC orders. It cannot clear Schwab
    // evidence or establish that Day orders are absent.
    let gtcOnly = false;
    if (!sourceReport && key === 'robinhood' && Array.isArray(gtcState?.gtcOpenOrders) && validTime(gtcState.gtcOpenOrdersCheckedAt)) {
      gtcOnly = true;
      sourceReport = {generatedAt:gtcState.gtcOpenOrdersCheckedAt, brokerEvidence:{robinhood:{orders:gtcState.gtcOpenOrders
        .filter(order => String(order.broker).toLowerCase() === 'robinhood')
        .map(order => ({...order,status:order.status || order.state}))}}};
    }
    const evidence = sourceReport?.brokerEvidence || report?.brokerEvidence || {};
    const source = evidence[key];
    if (!source || !Array.isArray(source.orders)) {
      coverage.push(`${broker}: order evidence unavailable in this report.`);
      continue;
    }
    const checked = evidenceTime(sourceReport);
    sources[key] = {checkedAt:checked,reportGeneratedAt:sourceReport.generatedAt};
    if (Number.isFinite(Date.parse(checked))) checkedTimes.push(checked);
    if (gtcOnly) coverage.push('Robinhood: GTC-only saved state; Day orders and complete working-order coverage are unverified.');
    else if (sourceReport !== report) coverage.push(`${broker}: retained evidence from ${sourceReport.generatedAt}; the latest report did not refresh this broker.`);
    coverage.push(`${broker}: ${source.orders.length} saved orders. ${key === 'schwab'
      ? text(source.olderGtcCoverage) || 'Older GTC coverage is unverified.'
      : source.workingPaginationComplete === true || source.paginationComplete === true ? 'Working-order pagination completed.' : 'Complete working-order coverage is unverified.'}`);
    if (key === 'schwab' && Array.isArray(source.accounts)) {
      for (const account of source.accounts) coverage.push(`${text(account.account)}: ${amount(account.activeNodes)} active in queried window${account.possiblyTruncated ? '; response truncated' : ''}.`);
    }
    const seen = new Set();
    for (const current of source.orders) {
      let order = current;
      if (order && order.brokerOrderId) {
        const earlier = orderedReports.filter(r => Date.parse(r.generatedAt) < Date.parse(sourceReport.generatedAt))
          .map(r => ({report:r, order:r.brokerEvidence[key]?.orders?.find(o => o.brokerOrderId === order.brokerOrderId && o.account === order.account && o.symbol === order.symbol)}))
          .find(found => found.order && (found.order.side || found.order.legs?.length));
        if (earlier) {
          const retainedFields = ['side','status','direction','legs'].filter(field => order[field] == null && earlier.order[field] != null);
          if (retainedFields.length) {
            const priorTime = text(earlier.order.checkedAt || earlier.report.brokerEvidence.collectionWindow?.end || earlier.report.generatedAt);
            order = {...order, ...Object.fromEntries(retainedFields.map(field => [field, earlier.order[field]])), checkedAt:priorTime};
            if (Number.isFinite(Date.parse(priorTime))) checkedTimes.push(priorTime);
            coverage.push(`${broker} ${text(order.account)} ${text(order.symbol)}: retained ${retainedFields.join(', ')} from ${priorTime}; newer quantities and prices are used when supplied.`);
          }
        }
      }
      if (!order || terminal.has(String(order.status).toUpperCase())) continue;
      const identity = order.brokerOrderId ? `${order.account}:${order.brokerOrderId}` : null;
      if (identity && seen.has(identity)) continue;
      if (identity) seen.add(identity);
      const legs = (Array.isArray(order.legs) ? order.legs : []).map(leg => {
        const action = text(leg.instruction) || [leg.side,leg.position_effect || leg.positionEffect].filter(Boolean).join(' to ');
        const expiry = text(leg.expiration || leg.expiration_date);
        const strike = leg.strike ?? leg.strike_price;
        const kind = text(leg.optionType || leg.option_type);
        return [action.replaceAll('_',' ').toUpperCase(),
          leg.ratio_quantity != null ? `ratio ${amount(leg.ratio_quantity)}` : amount(leg.quantity),
          text(leg.underlyingSymbol || order.symbol), expiry,
          strike != null ? `$${amount(strike)} ${kind}` : ''].filter(Boolean).join(' ');
      });
      const quantity=number(order.quantity), filled=number(order.filledQuantity);
      const remaining=number(order.remainingQuantity) ?? (quantity !== null && filled !== null && quantity >= filled && filled >= 0 ? Number((quantity-filled).toPrecision(12)) : null);
      orders.push({broker, account:text(order.account), symbol:text(order.symbol),
        action:legs.length ? legs.join('\n') : `${text(order.side).toUpperCase()} ${text(order.symbol)}`,
        quantity, filled, remaining,
        price:[order.limitPrice != null ? `Limit $${amount(order.limitPrice)}` : '', order.stopPrice != null ? `Stop $${amount(order.stopPrice)}` : '', text(order.direction)].filter(Boolean).join(' · ') || 'Market / price unavailable',
        duration:['gtc','good_till_cancel'].includes(String(order.timeInForce).toLowerCase()) ? 'GTC' : ['gfd','day'].includes(String(order.timeInForce).toLowerCase()) ? 'Day' : text(order.timeInForce) || 'Unknown',
        status:text(order.status) || 'Unknown', checkedAt:text(order.checkedAt || checked)});
    }
  }
  if (!Object.keys(sources).length) return null;
  // A newer GTC-only refresh replaces that reservation list without discarding
  // retained Day orders or another broker's evidence.
  if (Array.isArray(gtcState?.gtcOpenOrders) && validTime(gtcState.gtcOpenOrdersCheckedAt)
    && Date.parse(gtcState.gtcOpenOrdersCheckedAt) > Date.parse(sources.robinhood?.checkedAt)) {
    const gtcSnapshot = openOrdersFromReports([], {gtcState});
    orders = orders.filter(order => order.broker !== 'Robinhood' || order.duration !== 'GTC');
    orders.push(...gtcSnapshot.orders);
    coverage.push(`Robinhood: GTC-only snapshot updated at ${gtcState.gtcOpenOrdersCheckedAt}; ${gtcSnapshot.orders.length} saved GTC orders.`);
  }
  // A complete, newer broker-specific zero is evidence of absence for that
  // instrument class. Positive counts cannot replace itemized order details.
  const cleared = {};
  for (const [field, kind, matches] of [
    ['openRobinhoodOptionOrders','option',order => /(?:^|\n)(?:BUY|SELL) TO (?:OPEN|CLOSE) /.test(order.action)],
    ['openRobinhoodEquityOrders','equity',order => /^(?:BUY|SELL)(?: [\d.]+)? [A-Za-z0-9.^/-]+$/.test(order.action)]
  ]) {
    const summary = orderedReports.find(r => r.brokerEvidence.fullSupportedPaginationChecked === true
      && Number.isInteger(r.brokerEvidence[field]) && r.brokerEvidence[field] >= 0);
    const checked = [summary?.brokerEvidence[field] === 0 ? evidenceTime(summary) : '',
      previousSnapshot?.cleared?.[kind],retainedSnapshot?.cleared?.[kind]]
      .filter(validTime).sort((a,b)=>Date.parse(b)-Date.parse(a))[0];
    if (!checked) continue;
    cleared[kind] = checked;
    const before = orders.length;
    orders = orders.filter(order => order.broker !== 'Robinhood' || !matches(order)
      || !(Date.parse(checked) >= Date.parse(order.checkedAt || sources.robinhood?.checkedAt)));
    if (orders.length !== before) coverage.push(`Robinhood: newer complete check at ${checked} reported 0 open ${kind} orders; older ${kind} rows were removed.`);
  }
  checkedTimes.push(...orders.map(order => order.checkedAt));
  return {version:1,reportGeneratedAt:report?.generatedAt || previousSnapshot?.reportGeneratedAt || retainedSnapshot?.reportGeneratedAt || gtcState?.gtcOpenOrdersCheckedAt || '',
    checkedAt:checkedTimes.filter(validTime).sort((a,b)=>Date.parse(a)-Date.parse(b))[0] || '',orders,coverage,sources,cleared};
}

export function renderOpenOrders(snapshot, {account = '', now = Date.now()} = {}) {
  if (!snapshot || !Array.isArray(snapshot.orders)) return '<p class="open-orders-note">Open orders unavailable. Sync the latest report evidence; no orders are assumed absent.</p>';
  const rows = snapshot.orders.filter(order => !account || order.account === account);
  const instant = Date.parse(snapshot.checkedAt);
  const checked = Number.isFinite(instant) ? new Date(instant).toLocaleString('en-US',{timeZone:'America/New_York',timeZoneName:'short'}) : 'time unavailable';
  const stale = !Number.isFinite(instant) || now - instant > 15*60*1000;
  const headings = ['Broker / account','Action / option legs','Total / filled / remaining','Limit / stop','Duration / status'];
  return `<p class="open-orders-note">${rows.length} saved open orders · Checked ${escape(checked)}${stale ? ' · Older snapshot; refresh broker evidence before acting' : ''}. Saved report evidence; this screen does not contact or change broker orders.</p>`
    + (rows.length ? `<div class="open-orders-scroll"><table class="open-orders-table"><caption>Open orders${account ? ` · ${escape(account)}` : ' · all accounts'}</caption><thead><tr>${headings.map(h=>`<th scope="col">${h}</th>`).join('')}</tr></thead><tbody>${rows.map(o=>`<tr><td>${escape(o.broker)}<br>${escape(o.account)}</td><td>${escape(o.action).replaceAll('\n','<br>')}</td><td>${[o.quantity,o.filled,o.remaining].map(amount).join(' / ')}</td><td>${escape(o.price)}<small>Quoted units; option rolls are net.</small></td><td>${escape(o.duration)}<br>${escape(o.status)}</td></tr>`).join('')}</tbody></table></div>` : '<p>No saved open orders for this account scope. See coverage below.</p>')
    + `<details class="open-orders-coverage"><summary>Source coverage</summary>${(snapshot.coverage || []).map(note=>`<p>${escape(note)}</p>`).join('')}</details>`;
}

const accountKey = value => String(value || '').trim().toLowerCase();
export function ordersForHolding(snapshot, row, {group = false, accounts} = {}) {
  const symbol = String(row?.symbol || '').toUpperCase();
  if (!symbol || !Array.isArray(snapshot?.orders)) return [];
  const owners = new Set((accounts || row.allocationRows?.map(p=>p.account)
    || row.accountAllocations?.map(p=>p.account) || [row.account]).map(accountKey));
  return snapshot.orders.filter(order => {
    if (String(order.symbol || '').toUpperCase() !== symbol || !owners.has(accountKey(order.account))
      || terminal.has(String(order.status).toUpperCase()) || order.remaining === 0) return false;
    if (group || row.assetClass !== 'option') return true;
    // The saved display projection uses one canonical line per leg. Match the
    // full contract, not a strike substring or another account's underlying.
    return String(order.action || '').split('\n').some(line => {
      const contract = /(?:^|\s)([A-Za-z0-9.^/-]+) (\d{4}-\d{2}-\d{2}) \$(\d+(?:\.\d+)?) (put|call)$/i.exec(line);
      return contract && contract[1].toUpperCase() === symbol && contract[2] === row.expiration
        && Number(contract[3]) === Number(row.strike) && contract[4].toLowerCase() === String(row.optionType).toLowerCase();
    });
  });
}

const compactAccount = account => String(account || '')
  .replace(/^schwab\s+(\d+)$/i, 'S-$1')
  .replace(/^(?:hood|robinhood)\s+(br|ira)$/i, (_, suffix) => `H-${suffix.toUpperCase()}`);

function optionLeg(line) {
  const match = /^(BUY|SELL) TO (OPEN|CLOSE) (ratio )?(\d+(?:\.\d+)?|Unknown) ([A-Za-z0-9.^/-]+) (\d{4}-\d{2}-\d{2}) \$(\d+(?:\.\d+)?) (put|call)$/i.exec(line.trim());
  if (!match) return null;
  return {code:`${match[1][0]}T${match[2][0]}`.toUpperCase(), ratio:Boolean(match[3]), quantity:number(match[4]),
    symbol:match[5].toUpperCase(), contract:`${match[6]} $${amount(match[7])}${match[8][0].toUpperCase()}`, kind:match[8].toLowerCase()};
}

function remainingLegQuantity(order, leg) {
  const remaining = number(order.remaining);
  if (remaining === null || leg.quantity === null) return null;
  const total = leg.ratio ? 1 : number(order.quantity);
  return total > 0 ? Number((remaining * leg.quantity / total).toPrecision(12)) : null;
}

function compactPrice(order, {option = false, net = false} = {}) {
  const price = String(order.price || 'Price unavailable');
  const limit = /\bLimit \$(-?\d+(?:\.\d+)?)/i.exec(price);
  const stop = /\bStop \$(-?\d+(?:\.\d+)?)/i.exec(price);
  if (!limit && !stop) return price;
  // Single-option signs follow the quoted-price shorthand. A roll's sign is
  // its broker-reported net credit/debit, never inferred from one leg.
  const sign = !option ? '' : !net ? '+' : /\bcredit\b/i.test(price) ? '+' : /\bdebit\b/i.test(price) ? '-' : '';
  const quoted = limit ? `${sign}$${amount(option ? Math.abs(Number(limit[1])) : limit[1])}` : '';
  const trigger = stop ? `stop $${amount(stop[1])}` : '';
  return [quoted, trigger].filter(Boolean).join(' / ');
}

function compactOrder(order) {
  const lines = String(order.action || '').split('\n').filter(Boolean);
  const legs = lines.map(optionLeg);
  const account = compactAccount(order.account);
  if (legs.length && legs.every(Boolean)) {
    const opening = legs.find(leg => leg.code.endsWith('O'));
    const closing = legs.find(leg => leg.code.endsWith('C'));
    const quantity = opening && remainingLegQuantity(order, opening);
    const roll = legs.length === 2 && opening && closing
      && opening.code[0] !== closing.code[0] && opening.symbol === closing.symbol && opening.kind === closing.kind
      && opening.contract !== closing.contract && quantity > 0 && quantity === remainingLegQuantity(order, closing);
    const action = roll ? `roll${quantity === 1 ? '' : ` ${amount(quantity)}`} to ${opening.contract}`
      : legs.map(leg => `${leg.code} ${amount(remainingLegQuantity(order, leg))} ${leg.contract}`).join(' / ');
    return `${account}: ${action} at ${compactPrice(order, {option:true, net:legs.length > 1})}`;
  }
  const stock = lines.length === 1 && /^(BUY|SELL)(?:\s+(?:\d+(?:\.\d+)?|Unknown))?\s+([A-Za-z0-9.^/-]+)$/i.exec(lines[0]);
  if (stock && stock[2].toUpperCase() === String(order.symbol).toUpperCase()) {
    return `${account}: ${stock[1][0].toUpperCase()}${stock[1].slice(1).toLowerCase()} ${amount(order.remaining)} at ${compactPrice(order)}`;
  }
  return `${account}: ${lines.join(' / ')} · ${amount(order.remaining)} remaining · ${order.price}`;
}

export function pendingOrderText(snapshot, row, options = {}) {
  return ordersForHolding(snapshot, row, options).map(compactOrder).join('\n');
}

export function pendingOrderDetails(snapshot, row, options = {}) {
  return ordersForHolding(snapshot, row, options).map(order => {
    const checked = Date.parse(order.checkedAt || snapshot.checkedAt);
    const when = Number.isFinite(checked) ? new Date(checked).toLocaleString('en-US', {timeZone:'America/New_York',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'}) : 'time unknown';
    return `${order.account}: ${order.action}\n${amount(order.remaining)} remaining · ${order.price} · ${order.duration} · ${order.status}\nChecked ${when}`;
  }).join('\n\n');
}

export function pendingOrdersSource(snapshot, {now = Date.now()} = {}) {
  if (!Array.isArray(snapshot?.orders)) return 'Pending orders unavailable — sync saved broker evidence.';
  const at = Date.parse(snapshot.checkedAt);
  const checked = Number.isFinite(at) ? new Date(at).toLocaleString('en-US',{timeZone:'America/New_York',timeZoneName:'short'}) : 'time unknown';
  const stale = !Number.isFinite(at) || now - at > 15*60*1000;
  return `Pending orders: ${snapshot.orders.length} saved · checked ${checked}.${stale ? ' Older snapshot; current order status is unverified.' : ''} See each holding; a dash does not verify the absence of orders.`;
}
