import type { ReactNode } from 'react'
import { Ext, Link } from '../components/ui'
import { X_HANDLE, tweetIntent } from '../lib/site'

/** The page's sections, in order: the contents list and each section's number come from here. */
const SECTIONS: [string, string][] = [["launch", "Launching a coin"], ["site", "Launching on the site"], ["pairs", "Pairs"], ["for", "Launching for someone"], ["float", "Launching on Float"], ["trading", "Trading"], ["fees", "Creator rewards"], ["holders", "Fees to holders"], ["payouts", "Getting paid"], ["payments", "Payments"], ["limits", "Limits"], ["risk", "Risk"]]
const Q = ({ id, title, children }: { id: string; title: string; children: ReactNode }) => {
  const n = SECTIONS.findIndex(([k]) => k === id) + 1
  return (
    <section id={id} className="ct-doc">
      <div className="ct-doc-head"><span className="ct-doc-n">{String(n).padStart(2, '0')}</span><h2>{title}</h2></div>
      <div className="ct-doc-body">{children}</div>
    </section>
  )
}

export function Docs() {
  return (
    <div className="page ct-docs">
      <header className="ct-docs-hero">
        <h1>How it works</h1>
        <p className="muted">Everything about launching from X or on the site, creator rewards, holders and payouts.</p>
      </header>
      <div className="ct-docs-grid">
      <nav className="ct-docs-toc" aria-label="On this page">
        {SECTIONS.map(([id, title], i) => <a key={id} href={`#${id}`}><span className="ct-doc-n sm">{String(i + 1).padStart(2, '0')}</span>{title}</a>)}
      </nav>
      <div className="ct-docs-main">
      <Q id="launch" title="Launching a coin">
        <p>Post on X and tag <span className="hl">@{X_HANDLE}</span> with a ticker. These all work:</p>
        <pre>{`@${X_HANDLE} $DOGE
@${X_HANDLE} launch $DOGE Doge Coin
@${X_HANDLE} "Space Cats" $SCAT
@${X_HANDLE} launch $FROG Frog Club`}</pre>
        <p>The ticker is 1 to 10 letters or numbers. The name is whatever else you write (up to 32 characters), or the ticker if you write nothing. Put the name in quotes to keep it exactly as typed.</p>
        <p>The logo is the picture attached to your post. With no picture, the picture of the post you are replying to is used, and otherwise the Cashtags logo.</p>
        <p>Launching is free: Cashtags pays the network costs. Every coin is a standard Pumpfun coin with an address ending in <span className="mono">cash</span>. The bot replies with the contract address and a link to the coin's page.</p>
        <p>The same ticker can be launched more than once. The address in the reply is how you know which coin is yours.</p>
        <p><Ext href={tweetIntent(`@${X_HANDLE} $`)} className="btn white sm">Launch on X</Ext></p>
      </Q>
      <Q id="site" title="Launching on the site">
        <p>You can also launch without posting. Open <Link to="/launch" className="u">Launch</Link>, sign in with X or with a Solana wallet, and fill in the cashtag, name, image, description and links.</p>
        <p>A launch on the site is paid from your own wallet: about 0.01 SOL, which is what Pumpfun charges to create a token. Your wallet signs one transaction and the token is live. Launching by posting on X stays free.</p>
        <p>You choose where the creator rewards go. <span className="hl">X Money</span> pays them to an X account's X Money in dollars (your own handle is filled in when you signed in with X, or enter someone else's to launch the token for them), and <span className="hl">Holders</span> gives them to the token's holders through Pumpfun holder rewards. You can pair the token with another token the same way a post can.</p>
        <p><strong>Dev buy.</strong> Enter an amount of SOL and your wallet buys your token in the launch transaction itself, before anyone else can trade it. A dev buy is available when the token is paired with SOL.</p>
        <p>A cashtag can be launched once every 24 hours, and a token's name, cashtag, image and links are permanent once it is live.</p>
        <p><Link to="/launch" className="btn white sm">Launch here</Link></p>
      </Q>
      <Q id="pairs" title="Pairs">
        <p>Every coin trades against SOL unless your post says otherwise. To pair it with another token, add <span className="hl">paired with</span> and that token's $CASHTAG or contract address:</p>
        <pre>{`@${X_HANDLE} launch $PILL paired with $PUMP
@${X_HANDLE} $FROG Frog Club pair with <contract address>`}</pre>
        <p>A $CASHTAG works for the tokens on Pumpfun's own pair list, such as $BONK, $PUMP, $PENGU and USDC. Any other Pumpfun coin works by its contract address. If Pumpfun cannot pair with the token, the bot replies with the reason and nothing launches.</p>
        <p>A paired coin earns its creator rewards in the pair token. With the default setting Pumpfun pays them to the coin's holders in that token. With <span className="hl">Fees to me</span> they are paid to you in that token, and you can withdraw them from your account page.</p>
      </Q>
      <Q id="for" title="Launching for someone">
        <p>You can launch a coin for another X account. Add <span className="hl">for @handle</span> to your post:</p>
        <pre>{`@${X_HANDLE} launch $GM for @yourfriend
@${X_HANDLE} $FROG Frog Club for @yourfriend`}</pre>
        <p>The coin belongs to that account: all of its creator rewards go to them, never to holders and never to you. The bot replies with the contract address and says who the coin is for.</p>
        <p>They do not have to do anything. Their creator rewards are paid to their <span className="hl">X Money</span> automatically, in dollars, through Peer: once their rewards reach 0.1 SOL, a buyer on Peer sends the dollars to their X Money, Peer checks the payment, and only then receives the USDC. This usually takes under a day. If nobody pays within 14 days (for example because X Money is not turned on for that account), the rewards come back to their balance, where they can sign in with X and withdraw them or pick another payout.</p>
        <p>The coin is tied to the account's permanent X id, not its handle, so a rename changes nothing. If they sign in, they can change how they are paid from their profile like any creator. Coins paired with another token earn in that token, which waits in their account until they sign in.</p>
        <p>The usual limits apply to you as the poster. The handle must be a real X account; if it is not found, the bot replies and nothing launches.</p>
      </Q>
      <Q id="float" title="Launching on Float">
        <p>Tokens can also launch on <span className="hl">Float</span>, which runs on Raydium LaunchLab and splits every trade's fee between holders, the creator and the Float ecosystem. Pick Float as your default under Launch on in your profile, or add <span className="hl">on Float</span> to a post:</p>
        <pre>{`@${X_HANDLE} launch $FROG on Float
@${X_HANDLE} $FROG Frog Club on Float paired with $USDC`}</pre>
        <p>A Float token pairs with SOL by default, or with USDC and other tokens on Float's pair list. Its holders earn Float's own holder rewards. The creator share is 5% of the trading fee: with Fees to me it is paid to you like any other creator rewards, and with Fees to holders it is airdropped to your holders in SOL. A cashtag that is already taken on Float cannot be launched there; the bot replies and you can launch it on Pumpfun instead.</p>
      </Q>
      <Q id="trading" title="Trading">
        <p>FOMO lets anyone trade Solana coins by tapping a cashtag on X, so your coin can be traded from the timeline. Because tickers are shared, the contract address is the reliable way to find the right coin: every coin page has buttons for FOMO, Pumpfun and a chart.</p>
      </Q>
      <Q id="fees" title="Creator rewards">
        <p>Pumpfun pays a creator reward on every trade of a coin. By default a Cashtags coin gives it to its holders through Pumpfun's holder rewards. If the X account that posted the launch chose <span className="hl">Fees to me</span>, the fee belongs to that account instead. Cashtags takes no cut either way.</p>
        <p>Each coin has its own fee wallet, which Pumpfun pays into. Every few minutes Cashtags collects the fees and books them to the creator or to the holders, depending on the coin's setting at that moment.</p>
      </Q>
      <Q id="holders" title="Fees to holders">
        <p>There are two ways to give creator rewards to holders.</p>
        <p><strong>At launch (the default):</strong> unless you choose otherwise, every coin you launch uses Pumpfun's own holder rewards: Pumpfun pays the creator rewards to the coin's holders directly, and the coin stays that way permanently. To keep the fees yourself, sign in on <Link to="/account" className="u">Profile</Link> and choose <span className="hl">Fees to me</span> before you post.</p>
        <p><strong>Later:</strong> a coin launched with Fees to me can be switched to holders at any time from its page or your account, and switched back. Cashtags then airdrops those fees in SOL, in proportion to how much of the coin each wallet holds. A drop goes out once at least 0.05 SOL has built up, or once a day if at least 0.01 SOL has. Wallets need at least 100,000 tokens (0.01% of the supply), the largest 100 holders are paid, and pools and other program accounts are never paid.</p>
        <p>A switch applies to fees from that moment on. Fees earned before it stay with the side they were earned under: switching to holders never takes what you had already earned.</p>
      </Q>
      <Q id="payouts" title="Getting paid">
        <p>Sign in with X on <Link to="/account" className="u">Profile</Link>. You can withdraw to any Solana wallet whenever you like (minimum 0.01 SOL), or set automatic payouts to a Solana wallet or your FOMO wallet once your fees reach a threshold you choose. Cashtags pays the network fee.</p>
        <p>Your fees are tied to your X account's permanent id, not your handle, so renaming your account changes nothing. They wait for you for as long as it takes.</p>
        <p><strong>X Money.</strong> Choose X Money payments and tick that X Money is turned on for your account. Once your creator rewards pass your threshold, they are paid to your X Money in dollars. The payment comes through Peer, a marketplace where people buy USDC: a buyer sends the dollars to your X Money, Peer checks that payment, and only then receives the USDC. This usually takes under a day. If nobody pays within 14 days, or you switch to another payout option, the unpaid part comes back to your balance in SOL. Coins paired with another token pay out in that token instead.</p>
      </Q>
      <Q id="payments" title="Payments">
        <p>Every payment Cashtags sends is public. The <Link to="/payments" className="u">Payments</Link> page lists each creator payout, holder airdrop and X Money payment with its token, its amount and its transaction, next to the totals paid so far.</p>
      </Q>
      <Q id="limits" title="Limits">
        <p>To keep the bot healthy: an X account needs at least 25 followers and to be 14 days old, can launch one token every 30 minutes, and each cashtag can be launched once every 24 hours: if someone launched $FROG today, $FROG is taken until tomorrow. A post that cannot launch yet waits in the queue rather than being dropped.</p>
      </Q>
      <Q id="risk" title="Risk">
        <p>Coins launched here are created by whoever posts them. Cashtags does not endorse any coin, and trading them can lose you everything you put in.</p>
      </Q>
      </div>
      </div>
    </div>
  )
}
