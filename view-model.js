// Display-only helpers; never mutate saved records or infer missing targets.
export const COLUMNS = Object.freeze([
  ['symbol','Ticker'], ['quantity','Position'], ['price','Quote'], ['changePercent','Change'],
  ['strikeDeltaPercent','Strike%',true], ['dte','DTE'], ['optionIv','IV',true], ['optionDelta','Delta',true], ['extrinsicValue','Extrinsic',true],
  ['avgCost','Avg cost'], ['effectiveAvgCost','Eff. cost',true], ['marketValue','Total value'], ['planValue','Plan value'], ['planDrift','Drift'],
  ['unrealizedPnl','P&L total'], ['pnlPercent','P&L %'], ['dailyPnl','P&L daily'], ['portfolioPercent','Portfolio %'], ['sector','Sector'], ['account','Account'],
].map(([key,label,extra=false])=>Object.freeze({key,label,extra})));
export const OPTION_SORT_KEYS = new Set(['strikeDeltaPercent','dte','optionIv','optionDelta','extrinsicValue','effectiveAvgCost']);
const finite = value => Number.isFinite(value) ? value : null;
function validDate(value) {
  return typeof value==='string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString().slice(0,10)===value;
}
export function newYorkDate(now=new Date()) {
  return new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
}
export function daysToExpiry(row, today=newYorkDate()) {
  if(row.assetClass!=='option' || !validDate(row.expiration) || !validDate(today)) return null;
  return Math.max(0,Math.round((Date.parse(row.expiration)-Date.parse(today))/86400000));
}
export function positionDisplay(row,{total=null,complete=false,today=newYorkDate()}={}) {
  const option=row.assetClass==='option', excluded=row.includedInPortfolioValue===false;
  const planValue=!option&&!excluded ? finite(row.planValue) : null;
  const marketValue=excluded?null:finite(row.marketValue), basis=finite(row.costBasis);
  const unrealizedPnl=row.pnlStatus==='not-applicable'?null:finite(row.unrealizedPnl);
  return {...row,planValue,marketValue,unrealizedPnl,
    planDrift:planValue!==null&&marketValue!==null?marketValue-planValue:null,
    dte:daysToExpiry(row,today),
    pnlPercent:unrealizedPnl!==null&&basis!==null&&basis!==0?unrealizedPnl/Math.abs(basis)*100:null,
    portfolioPercent:complete&&Number.isFinite(total)&&total!==0&&marketValue!==null?marketValue/total*100:null,
    dailyPnl:excluded?null:finite(row.dailyPnl), changePercent:finite(row.changePercent),
    avgCost:row.isCash||row.quoteStatus==='manual-book-value'?null:finite(row.avgCost),
    effectiveAvgCost:option?finite(row.effectiveAvgCost):null,
    quantity:row.isCash?null:finite(row.quantity),price:finite(row.price),
    optionIv:option?finite(row.optionIv):null,optionDelta:option?finite(row.optionDelta):null,
    strikeDeltaPercent:option?finite(row.strikeDeltaPercent):null,extrinsicValue:option?finite(row.extrinsicValue):null,
  };
}
export function compareValues(a,b,descending=false) {
  if(a==null&&b==null)return 0;
  if(a==null)return 1;
  if(b==null)return -1;
  const delta=typeof a==='number'&&typeof b==='number'?a-b:String(a).localeCompare(String(b),undefined,{numeric:true});
  return descending?-delta:delta;
}
export function groupedHoldings(rows,{key='symbol',descending=false,search='',asset='',unpriced=false}={}) {
  const needle=search.trim().toLowerCase(), groups=new Map();
  for(const row of rows) {if(!groups.has(row.symbol))groups.set(row.symbol,[]);groups.get(row.symbol).push(row);}
  const identity = row => `${row.account}|${row.expiration||''}|${row.optionType||''}|${row.strike??''}|${row.id||row.positionId||''}`;
  const compareRows=(a,b)=>compareValues(a[key],b[key],descending)||identity(a).localeCompare(identity(b),undefined,{numeric:true});
  return [...groups].map(([symbol,group])=>{
    // Filters apply to positions. A context header does not assert stock ownership.
    const matched=group.filter(row=>(!asset||row.assetClass===asset)
      &&(!unpriced||(row.includedInPortfolioValue!==false&&!Number.isFinite(row.marketValue)))
      &&(!needle||[row.symbol,row.account,row.sector,row.assetClass,row.optionType,row.expiration,row.strike].some(v=>String(v??'').toLowerCase().includes(needle))));
    const parents=matched.filter(row=>row.assetClass!=='option').sort(compareRows);
    const options=matched.filter(row=>row.assetClass==='option').sort(compareRows);
    const candidates=OPTION_SORT_KEYS.has(key)?options:parents.length?parents:options;
    const sortValue=key==='symbol'?symbol:candidates.map(row=>row[key]).filter(v=>v!=null).sort((a,b)=>compareValues(a,b,descending))[0]??null;
    return {symbol,parents,options,sortValue,matchedCount:matched.length};
  }).filter(g=>g.matchedCount).sort((a,b)=>compareValues(a.sortValue,b.sortValue,descending)||a.symbol.localeCompare(b.symbol));
}
export function shortPutNotional(rows) {
  const puts=rows.filter(row=>row.assetClass==='option'&&String(row.optionType).toLowerCase()==='put'&&row.quantity<0);
  if(puts.some(row=>!Number.isFinite(row.strike)||!Number.isFinite(row.multiplier)))return null;
  return puts.reduce((sum,row)=>sum-row.quantity*row.strike*row.multiplier,0);
}
