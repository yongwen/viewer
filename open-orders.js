// Display-only projection. Broker identifiers remain in private report evidence.
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const text = value => typeof value === 'string' ? value.slice(0, 2000) : '';
const number = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
const amount = value => number(value) === null ? 'Unknown' : String(number(value));
const terminal = new Set(['FILLED','CANCELED','CANCELLED','REPLACED','REJECTED','EXPIRED','FAILED']);

export function openOrdersFromReports(reports) {
  const report = reports.filter(r => r && r.brokerEvidence && Number.isFinite(Date.parse(r.generatedAt)))
    .sort((a,b) => Date.parse(b.generatedAt)-Date.parse(a.generatedAt))[0];
  if (!report) return null;
  const evidence = report.brokerEvidence;
  const orders = [], coverage = [];
  for (const [key, broker] of [['schwab','Schwab'],['robinhood','Robinhood']]) {
    const source = evidence[key];
    if (!source || !Array.isArray(source.orders)) {
      coverage.push(`${broker}: order evidence unavailable in this report.`);
      continue;
    }
    coverage.push(`${broker}: ${source.orders.length} saved orders. ${key === 'schwab'
      ? text(source.olderGtcCoverage) || 'Older GTC coverage is unverified.'
      : source.workingPaginationComplete === true ? 'Working-order pagination completed.' : 'Complete working-order coverage is unverified.'}`);
    if (key === 'schwab' && Array.isArray(source.accounts)) {
      for (const account of source.accounts) coverage.push(`${text(account.account)}: ${amount(account.activeNodes)} active in queried window${account.possiblyTruncated ? '; response truncated' : ''}.`);
    }
    const seen = new Set();
    for (const order of source.orders) {
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
      orders.push({broker, account:text(order.account), symbol:text(order.symbol),
        action:legs.length ? legs.join('\n') : `${text(order.side).toUpperCase()} ${text(order.symbol)}`,
        quantity:number(order.quantity), filled:number(order.filledQuantity), remaining:number(order.remainingQuantity),
        price:[order.limitPrice != null ? `Limit $${amount(order.limitPrice)}` : '', order.stopPrice != null ? `Stop $${amount(order.stopPrice)}` : '', text(order.direction)].filter(Boolean).join(' · ') || 'Market / price unavailable',
        duration:['gtc','good_till_cancel'].includes(String(order.timeInForce).toLowerCase()) ? 'GTC' : ['gfd','day'].includes(String(order.timeInForce).toLowerCase()) ? 'Day' : text(order.timeInForce) || 'Unknown',
        status:text(order.status) || 'Unknown', checkedAt:text(order.checkedAt || evidence.collectionWindow?.end || evidence.generatedAt)});
    }
  }
  return {version:1,reportGeneratedAt:report.generatedAt,checkedAt:text(evidence.collectionWindow?.end || evidence.generatedAt),orders,coverage};
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
