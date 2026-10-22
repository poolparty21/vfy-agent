# Agent Games — submission drafts

> Drafts for the **Creator Track** and **Wildcard** entries.
> Both tracks are 100,000 VFY each (50k / 30k / 20k for 1st / 2nd / 3rd),
> and the four tracks share a 400,000 VFY pool.
>
> The form: Dashboard → **Control room / Submissions → New submission**
> Fields: `Category` · `Title` · `Submission links` (add each one — crossposting
> earns bonus XP) · `Supporting context` (max 1000 chars).
> **Eligibility:** include `#AgentGames` in every entry, and tag `@ZKVProtocol`
> when posting on X.

---

## 1. Wildcard entry — our agent

**Category:** Wildcard

**Title:** `missi — a payment-approving agent that refuses to trust a proof it cannot check`

**Submission links**
- `https://github.com/poolparty21/vfy-agent` (the agent, end to end)
- `https://vfy-agent.hallo-alexa.workers.dev/agent` (the live public endpoint)
- `https://vfy-agent.hallo-alexa.workers.dev/proof-reference` (the live proof
  reference, re-verified on every request)

**Proof reference (the checkable claim)**

```
0x52f943ec94d2adc0ee2554efc8540a52cefedfc6366012f26466f4fb831930ab
```

That is a real, finalized zkVerify mainchain transaction — a Groth16 proof
submitted to `settlementGroth16Pallet.submitProof` in block **5664252**
(`0xbf30d6b584d00d3636fbbef26d596179ab7d9e9619fbbe8095466dceba32c3a9`),
extrinsic index 2. The chain acknowledged it with a `ProofVerified` event for
statement `0x25ba6951…91b463`, against the on-chain registered verification key
`0xeff0bb5f…3c24a10`.

**What it establishes.** The agent confirms a proof transaction really landed
on zkVerify's mainchain — it re-derives the transaction hash from the raw
extrinsic bytes with its own from-scratch BLAKE2b-256 and checks the block is
finalized. It does not trust the RPC's word for it.

**How to check it, without running anything:**
- Open `https://vfy-agent.hallo-alexa.workers.dev/proof-reference` — it
  re-runs that check live and reports `ok: true` with the re-derived hash.
- Or read it on a block explorer:
  `https://zkverify.subscan.io/extrinsic/0x52f943ec94d2adc0ee2554efc8540a52cefedfc6366012f26466f4fb831930ab`
- Or run it yourself from the repo: `node scripts/verify-proof-reference.mjs`

**Supporting context**

> **Problem.** A proof-trusting payment approver is only useful if it rejects
> proofs that verify but do not authorise. Most proofs verify perfectly and
> still point at the wrong condition.
>
> **What it does.** `missi` receives a signed payment condition and decides
> approve/reject. It checks all seven documented failure modes — key
> substitution, threshold, replay, expiry, recipient, transfer cap — and fails
> closed: a wrong approval costs twice a wrong rejection. It re-verifies the
> proof on zkVerify's mainchain and answers inside the live 15s window.
>
> **Key decisions.** HMAC-SHA256 is verified against the *raw* body; each
> response is signed with the same secret. The replay seen-set lives in D1, not
> KV, so concurrent tasks cannot both claim one.
>
> **zkVerify.** The checkable claim: "this proof verifies against the
> registered key". Ref:
> `0x52f943ec94d2adc0ee2554efc8540a52cefedfc6366012f26466f4fb831930ab`
> (finalized block 5664252); the live `/proof-reference` endpoint re-verifies
> it on demand.

---

## 2. Creator Track entry — the thread

**Category:** Creator Track

**Title:** `Can an AI agent back up what it says? Here is what would count as proof`

**Content ideas used:** #02 (can an agent back up what it says) + #03 (what
should an agent check before trusting another agent) + #06 (the agent I built)

**The post (X thread — post it, tag @ZKVProtocol, include #AgentGames):**

> **Can an AI agent back up what it says? Here is what would count as proof.**
>
> I built an agent that approves payments. The interesting part was not the
> proof — it was everything a proof does *not* settle.
>
> A proof can verify perfectly and still be the wrong proof. So the agent never
> asks "did this verify?" It asks seven questions:
>
> 1. Does the proof's key equal the *registered* condition key? (Verifying with
>    the key the submitter handed you proves nothing.)
> 2. Does the balance the proof discloses meet the minimum?
> 3. Has this proof reference already been accepted? (Replay.)
> 4. Is the condition still inside its expiry block?
> 5. Does the recipient in the proof match the condition's recipient?
> 6. Is the amount within the transfer cap?
> 7. Was the proof actually verified on chain — and finalised?
>
> Three lessons that changed the design:
>
> **Fail closed, but not blindly.** The scoring punishes a wrong approval twice
> as hard as a wrong rejection. So anything unparseable is a rejection — but
> the *reason* still matters, and the platform computes the public-inputs hash
> independently and rejects divergent proofs.
>
> **The window is shorter than the docs say.** The published limit is 60
> seconds. I measured the real one from a live envelope: 15. My first version
> spent 12 of those on an on-chain lookup that took 85. That is a timeout, and a
> timeout forfeits the task.
>
> **Verify the bytes, not the characters.** I hashed a hex *string* instead of
> the digest *bytes*. The output still looked like a valid UUID, so it passed
> every eyeball test and was wrong.
>
> The whole build — policy, from-scratch BLAKE2b-256 and keccak-256, the
> replay store — is public:
> `https://github.com/poolparty21/vfy-agent`
> Live endpoint: `https://vfy-agent.hallo-alexa.workers.dev/agent`
>
> The agent is "missi". It runs on zkVerify's mainchain.
>
> #AgentGames @ZKVProtocol

**Supporting context**

> A write-up of a real agent built for Agent Games: what it decides, how it
> fails closed under an asymmetric scoring model, and the three bugs worth
> stealing the lesson from — a 60s window that is really 15s, a subrequest cap
> that is really 50, and a hash of the wrong bytes. The agent, its policy and
> its proofs are public, so every claim in the thread can be checked against the
> repository and the live endpoint.

---

## Publishing checklist

- [ ] Post the thread on X with `#AgentGames` and tag `@ZKVProtocol`
- [ ] Crosspost the same piece (LinkedIn / Reddit / a dev blog) and **add each
      link** to the submission — crossposting earns bonus XP
- [ ] Wildcard: add the repo link **and** the public endpoint as two links
- [ ] Wildcard: supporting context must mention the problem, who it helps and
      what it does
- [ ] Keep the supporting context under 1000 characters
