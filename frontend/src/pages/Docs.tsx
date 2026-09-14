import { Card, Label } from '../components/ui'

const sections = [
  {
    title: 'What is Chronix?',
    body: 'Chronix is a prediction market where participants stake on how history will remember an event — a decade, a policy, a technology, a cultural moment. Unlike short-horizon prediction markets, resolution windows are long: 3, 5, 10 years, or permanent (re-checked periodically forever).',
  },
  {
    title: 'Wallet-only identity',
    body: 'There are no usernames, emails, or passwords. Identity is your wallet address, authenticated via Sign-In-With-Ethereum (SIWE). Connect MetaMask, Rainbow, Zerion, or any WalletConnect v2 wallet, then sign a one-time message to prove control of the address — no password is ever transmitted or stored.',
  },
  {
    title: 'Escrow model',
    body: 'Staked USDC is held on-chain by ChronixEscrow on Base Sepolia, never by Chronix\' servers. The GenLayer Intelligent Contract handles adjudication and ledger accounting only — it never custodies funds itself. Ledger fields are zeroed before any payout is credited, and a trusted relayer bridges confirmed deposits and settlement outcomes between the two chains. Exit paths exist for settlement, disputes, timeout-reclaim, and pre-participation cancellation.',
  },
  {
    title: 'Adjudication model',
    body: 'After a market\'s resolution horizon passes, the contract itself performs a nondeterministic web-fetch across independent sources — news, academic, government, market, social, and primary — never trusting a participant\'s submitted summary as fact. A weighted consensus across the validator set produces a verdict: YES, NO, or undetermined if consensus can\'t be reached.',
  },
  {
    title: 'Evidence, not opinion',
    body: 'Anyone can submit an evidence pointer (a URL) during a market\'s lifetime. The contract fetches and evaluates the underlying source at adjudication time — pointers are indexed, not trusted blindly. This is why the Evidence Ledger shows submissions as a public record, not as a running vote.',
  },
  {
    title: 'Payouts',
    body: 'Once a verdict settles, winning positions can claim their payout directly from the contract. If adjudication stalls beyond a timeout window, a counterparty-recovery path lets participants reclaim their stake rather than have funds stuck indefinitely.',
  },
]

export default function Docs() {
  return (
    <div className="max-w-3xl mx-auto flex flex-col gap-6">
      <div>
        <Label>Documentation</Label>
        <h1 className="font-headline text-headline-lg text-primary mt-1">How Chronix works</h1>
      </div>
      {sections.map((s) => (
        <Card key={s.title} className="p-4">
          <h2 className="font-headline text-headline-md text-primary mb-2">{s.title}</h2>
          <p className="text-body-sm text-on-surface-variant leading-relaxed">{s.body}</p>
        </Card>
      ))}
    </div>
  )
}
