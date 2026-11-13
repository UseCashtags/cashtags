import { IExternal, IX } from '../components/Icons'
import { Avatar, Empty, ErrorNote, Ext, Loading, SectionHead, Stat, TokenTile } from '../components/ui'
import { api } from '../lib/api'
import { at, isXHandle, sol } from '../lib/site'
import { useData } from '../lib/useData'

export function Creator({ handle }: { handle: string }) {
  const d = useData(() => api.creator(handle), [handle], 60_000)
  if (d.loading && !d.data) return <div className="page"><Loading /></div>
  if (!d.data) return <div className="page">{d.status === 404 ? <Empty title={`No cashtags from @${handle} yet`}>Tag the bot on X with a $CASHTAG to launch one.</Empty> : <ErrorNote error={d.error ?? 'unknown'} />}</div>
  const { creator, tokens } = d.data
  return (
    <div className="page">
      <section className="profile-head row-gap ct-profile-center">
        <Avatar src={creator.avatar} size={72} label={creator.handle} />
        <div>
          <h1>{isXHandle(creator.handle) ? creator.name : at(creator.handle)}</h1>
          {isXHandle(creator.handle)
            ? <Ext href={`https://x.com/${creator.handle}`} className="muted u"><IX size={12} /> @{creator.handle} <IExternal /></Ext>
            : <Ext href={`https://solscan.io/account/${creator.handle}`} className="muted u mono">{at(creator.handle)} <IExternal /></Ext>}
        </div>
      </section>
      <section className="stat-grid ct-stats">
        <Stat label="Cashtags" value={tokens.length} />
        <Stat label="Fees earned" value={sol(d.data.earnedSol)} />
        <Stat label="Paid out" value={sol(d.data.paidSol)} />
        <Stat label="Fees to holders" value={tokens.filter((t) => t.mode === 'holders').length} />
      </section>
      <div className="ct-center-head"><SectionHead title="Cashtags" /></div>
      <div className="ct-grid wide">{tokens.map((t) => <TokenTile key={t.mint} t={t} />)}</div>
    </div>
  )
}
