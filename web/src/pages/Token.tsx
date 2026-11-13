import { useState } from 'react'
import { IExternal, IX } from '../components/Icons'
import { Avatar, CopyCA, Empty, ErrorNote, Ext, Link, Loading, ModePill, SOLSCAN, SafeImg, SectionHead, Stat } from '../components/ui'
import { api, signInUrl, type Buybacks, type XMoneyCoinPayout } from '../lib/api'
import { ago, dateTime, mcap, usd } from '../lib/format'
import { amt, at, sol } from '../lib/site'
import type { Mode } from '../lib/types'
import { useData } from '../lib/useData'

export function Token({ mint }: { mint: string }) {
  const d = useData(() => api.token(mint), [mint], 30_000)
  const me = useData(() => api.me().catch(() => null), [mint])
  if (d.loading && !d.data) return <div className="page"><Loading /></div>
  if (!d.data) return <div className="page">{d.status === 404 ? <Empty title="Not a Cashtags coin">This address was not launched here.</Empty> : <ErrorNote error={d.error ?? 'unknown'} />}</div>
  const t = d.data.token
  const mine = me.data?.user.id === t.creator.id
  return (
    <div className="page">
      <section className="ct-token-head">
        <SafeImg src={t.image} label={t.symbol} size={96} radius={20} />
        <div className="grow">
          <div className="row-gap"><h1 className="ct-token-sym">${t.symbol}</h1><ModePill mode={t.mode} native={t.nativeHolders} />{t.quote && <Ext href={SOLSCAN('token', t.quote.mint)} className="pill">Paired with {pairLabel(t.quote)}</Ext>}{t.venue === 'float' && <Ext href={t.links.float ?? '#'} className="pill">On Float</Ext>}{t.graduated && <span className="pill">Graduated</span>}</div>
          <div className="ct-token-name">{t.name}</div>
          <div className="muted small row-gap">
            {t.launchedBy
              ? <span>For <Link to={`/x/${t.creator.handle}`} className="u">{at(t.creator.handle)}</Link> · launched by <Link to={`/x/${t.launchedBy.handle}`} className="u">{at(t.launchedBy.handle)}</Link></span>
              : <span>Launched by <Link to={`/x/${t.creator.handle}`} className="u">{at(t.creator.handle)}</Link></span>}
            {t.tweetUrl && <Ext href={t.tweetUrl} className="u">from this post <IExternal /></Ext>}
            <span title={dateTime(t.createdAt)}>{ago(t.createdAt)} ago</span>
          </div>
        </div>
      </section>

      <section className="ct-trade card">
        <CopyCA value={t.mint} />
        <div className="ct-trade-btns">
          <Ext href={t.links.fomo} className="btn white sm">Trade on FOMO</Ext>
          {t.venue === 'float' ? <Ext href={t.links.float ?? '#'} className="btn ghost sm">Float</Ext> : <Ext href={t.links.pump} className="btn ghost sm">Pumpfun</Ext>}
          <Ext href={t.links.x} className="btn ghost sm"><IX size={12} /> ${t.symbol} on X</Ext>
        </div>
      </section>

      <section className="stat-grid ct-stats">
        <Stat label="Market cap" value={mcap(t.marketCapUsd)} />
        <Stat label="Fees earned" value={usd(t.feesUsd)} />
        {<Stat label="Paid to the creator" value={amt(t.creatorPaid, t.unit)} sub={t.creatorOwed > 0 ? `${amt(t.creatorOwed, t.unit)} waiting` : undefined} />}
        {t.nativeHolders && t.quote ? <Stat label="Holder rewards" value="Paid by Pumpfun" sub="to every holder" /> : <Stat label="Paid to holders" value={sol(t.holdersPaidSol)} sub={t.nativeHolders ? (t.holdersPendingSol >= 0.0001 ? `${sol(t.holdersPendingSol)} waiting, paid by Pumpfun` : 'paid by Pumpfun') : t.holdersPendingSol >= 0.0001 ? `${sol(t.holdersPendingSol)} in the next drop` : t.airdrops ? `${t.airdrops} ${t.airdrops === 1 ? 'drop' : 'drops'}` : undefined} />}
      </section>

      {d.data.buybacks && <BuybacksSection b={d.data.buybacks} symbol={t.symbol} />}
      {d.data.xmoney?.length > 0 && <XMoneySection list={d.data.xmoney} wallet={d.data.xmoneyWallet} />}

      <section className="two-col">
        <div>
          <div className="ct-center-head"><SectionHead title="Payouts" /></div>
          {d.data.activity.length ? (
            <div className="stack">
              {d.data.activity.map((o) => (
                <div key={o.signature + o.kind} className="row">
                  <div className="row-main">
                    <div className="amount sm">{amt(o.amount, o.unit)}</div>
                    <div className="muted small">{o.kind === 'airdrop' ? `airdropped to ${o.recipients} holders` : o.destination?.startsWith('xmoney:') ? `sent to @${t.creator.handle}'s X Money via Peer` : `paid to @${t.creator.handle}`}</div>
                  </div>
                  <div className="row-side muted small"><span>{ago(o.time)}</span><Ext href={SOLSCAN('tx', o.signature)} className="tx">tx <IExternal /></Ext></div>
                </div>
              ))}
            </div>
          ) : t.nativeHolders ? (
            <Empty title="Paid to holders by Pumpfun">Creator rewards from every trade go straight to this token's holders.</Empty>
          ) : t.ownCreator && d.data.buybacks ? (
            <Empty title="Buybacks & burns">This coin's creator rewards buy it back and burn it: see Buybacks & burns above.</Empty>
          ) : t.ownCreator ? (
            <Empty title="Paid to the creator wallet">Creator rewards from every trade go to the creator wallet below and are claimed on Pumpfun.</Empty>
          ) : t.mode === 'holders' ? (
            <Empty title="No payouts yet">Creator rewards are collected every few minutes and airdropped to holders as they build up.</Empty>
          ) : <Empty title="No payouts yet">Fees are collected every few minutes and paid out as they build up.</Empty>}
        </div>
        <div>
          <div className="ct-center-head"><SectionHead title="Where the fees go" /></div>
          <div className="card stack">
            <p className="muted small" style={{ margin: 0 }}>
              {t.venue === 'float'
                ? `This token launched on Float, which splits its trading fees: holders earn Float's holder rewards, and the creator share (5% of the fee) is ${t.mode === 'holders' && !t.quote ? 'airdropped in SOL to the wallets holding it' : `paid to @${t.creator.handle}${t.quote ? ` in ${pairLabel(t.quote)}` : ''}`}.`
                : t.launchedBy && !t.quote
                ? `This coin was launched for @${t.creator.handle}: creator rewards from every trade are theirs, paid to their X Money automatically once they reach 0.1 SOL.`
                : t.ownCreator && d.data.buybacks
                ? `This coin's creator rewards buy $${t.symbol} back and burn it, every 5 to 30 minutes. Every round is listed above with its buy and burn transactions.`
                : t.ownCreator
                ? 'This coin\'s Pumpfun creator is the wallet below: creator rewards from every trade go to it, claimed on Pumpfun.'
                : t.nativeHolders
                ? 'This coin launched with Pumpfun holder rewards: Pumpfun pays the creator rewards from every trade to its holders. That is permanent.'
                : t.quote && t.mode !== 'holders'
                ? `This coin is paired with ${pairLabel(t.quote)}: creator rewards from every trade are paid in ${t.unit} to @${t.creator.handle}, who claims them by signing in with X or has them paid out automatically.`
                : t.mode === 'holders'
                ? 'Creator rewards from every trade are airdropped in SOL to the wallets holding this coin, in proportion to what they hold.'
                : `Creator rewards from every trade go to @${t.creator.handle}, who claims them by signing in with X or has them paid out automatically.`}
            </p>
            {t.nativeHolders || t.ownCreator || t.quote ? null : mine ? <ModeSwitch mint={t.mint} mode={t.mode} onDone={d.reload} /> : (
              <p className="muted small" style={{ margin: 0 }}>Only {at(t.creator.handle)} can change this. {!me.data && <a className="u" href={signInUrl(`/t/${t.mint}`)}>Is it yours? Sign in</a>}</p>
            )}
            {!t.nativeHolders && <div className="kv small"><span className="muted">{t.ownCreator ? 'Creator wallet' : 'Fee wallet'}</span><Ext href={SOLSCAN('account', t.feeWallet)} className="mono u">{t.feeWallet.slice(0, 6)}…{t.feeWallet.slice(-6)}</Ext></div>}
            {t.launchTx && <div className="kv small"><span className="muted">Launch</span><Ext href={SOLSCAN('tx', t.launchTx)} className="mono u">{t.launchTx.slice(0, 10)}…</Ext></div>}
          </div>
          <div className="card stack ct-creator-card">
            <div className="row-gap"><Avatar src={t.creator.avatar} size={40} label={t.creator.handle} /><div><div className="cc-name">{t.creator.name}</div><Link to={`/x/${t.creator.handle}`} className="muted small u">{at(t.creator.handle)}</Link></div></div>
          </div>
        </div>
      </section>
    </div>
  )
}

/** X Money payouts that took this coin's creator rewards: status and every step's transaction. */
function XMoneySection({ list, wallet }: { list: XMoneyCoinPayout[]; wallet: string | null }) {
  const usd = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  return (
    <section className="stack">
      <div className="ct-center-head"><SectionHead title="X Money payouts" /></div>
      <p className="muted small" style={{ margin: 0 }}>This coin's creator rewards are paid in dollars to the creator's X Money through Peer: a buyer sends the dollars to their X Money, Peer checks the payment, and only then receives our USDC.</p>
      <div className="stack">
        {list.map((p) => (
          <div key={p.id} className="row">
            <div className="row-main">
              <div className="amount sm">{sol(p.sol)}{p.usd > 0 ? ` · ${usd(p.usd * (p.totalSol ? p.sol / p.totalSol : 1))}` : ''}</div>
              <div className="muted small">{p.status}{p.paidUsd > 0 && !p.done ? ` · ${usd(p.paidUsd)} paid so far` : ''}</div>
            </div>
            <div className="row-side muted small">
              <span title={dateTime(p.time)}>{ago(p.time)}</span>
              {p.collectTxs.map((s, i) => <Ext key={s} href={SOLSCAN('tx', s)} className="tx">{p.collectTxs.length > 1 ? `collect ${i + 1}` : 'collect'} <IExternal /></Ext>)}
              {p.bridgeTx && <Ext href={SOLSCAN('tx', p.bridgeTx)} className="tx">bridge <IExternal /></Ext>}
              {p.peerOrder && wallet && <Ext href={`https://basescan.org/address/${wallet}`} className="tx">Peer order #{p.peerOrder} <IExternal /></Ext>}
              {p.creditTx && <Ext href={SOLSCAN('tx', p.creditTx)} className="tx">returned <IExternal /></Ext>}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

/** Buybacks + burns from the token's own creator rewards: totals, then every round with its buy and burn transactions. */
function BuybacksSection({ b, symbol }: { b: Buybacks; symbol: string }) {
  const n = (x: number) => x.toLocaleString('en-US', { maximumFractionDigits: 2 })
  return (
    <section className="stack">
      <div className="ct-center-head"><SectionHead title="Buybacks & burns" /></div>
      <p className="muted small" style={{ margin: 0 }}>Every 5 to 30 minutes (at random) this token's creator rewards buy ${symbol} back, and every token bought is burned.</p>
      <div className="stat-grid ct-stats">
        <Stat label="SOL spent on buybacks" value={sol(b.solSpent)} />
        <Stat label={`$${symbol} burned`} value={n(b.tokensBurned)} />
        <Stat label="Rounds" value={String(b.count)} />
      </div>
      {b.rounds.length ? (
        <div className="stack">
          {b.rounds.map((r) => (
            <div key={r.buyTx} className="row">
              <div className="row-main">
                <div className="amount sm">{n(r.tokens)} ${symbol} burned</div>
                <div className="muted small">bought with {sol(r.sol)}{r.burned ? '' : ', burn pending'}</div>
              </div>
              <div className="row-side muted small">
                <span title={dateTime(r.at)}>{ago(r.at)}</span>
                <Ext href={SOLSCAN('tx', r.buyTx)} className="tx">buy <IExternal /></Ext>
                {r.burnTx && <Ext href={SOLSCAN('tx', r.burnTx)} className="tx">burn <IExternal /></Ext>}
              </div>
            </div>
          ))}
        </div>
      ) : <Empty title="No buybacks yet">The first round runs within the hour.</Empty>}
    </section>
  )
}

/** The creator's switch. Fees already earned stay with the side they were earned under. */
export function ModeSwitch({ mint, mode, onDone }: { mint: string; mode: Mode; onDone: () => void }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const set = async (m: Mode) => {
    if (m === mode) return
    setBusy(true); setErr(null)
    try { await api.setMode(mint, m); onDone() } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <div className="stack">
      <div className="seg">
        <button type="button" className={`chip ${mode === 'creator' ? 'on' : ''}`} disabled={busy} onClick={() => set('creator')}>Fees to me</button>
        <button type="button" className={`chip ${mode === 'holders' ? 'on' : ''}`} disabled={busy} onClick={() => set('holders')}>Fees to holders</button>
      </div>
      <div className="muted tiny">Switching takes effect for fees from now on. What was already earned stays where it was earned.</div>
      {err && <div className="note error">{err}</div>}
    </div>
  )
}

/** "$BONK" for a ticker, or the shortened address a pair without metadata shows as. */
const pairLabel = (q: { symbol: string; mint: string }) => (/^[A-Za-z][A-Za-z0-9.]*$/.test(q.symbol) ? `$${q.symbol.toUpperCase()}` : q.symbol || `${q.mint.slice(0, 4)}…${q.mint.slice(-4)}`)
