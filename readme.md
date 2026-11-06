# JudgeMint AI

**Autonomous hackathon evaluation & audit engine.**
Audits hackathon submissions for genuine technical implementation, legal compliance, and authentic PayPal API integration—eliminating "vaporware" and fake UI mockups. Features monetized priority audits via **PayPal Checkout**, verifiable cryptographic audit certificates, and automated prize disbursement via the **PayPal Payouts API**.

Built for the PayPal AI Hackathon on Node.js, Express, Tailwind CSS, and the PayPal REST/Toolkit APIs. Includes an in-memory audit engine with a comprehensive test suite designed to run seamlessly locally or deployed on Render.

---

## Quick Start

```bash
npm install
cp .env.example .env        # Add your sandbox credentials when ready (app runs in offline rules mode without them)
npm test                    # Runs the 38-test verification suite (0 failures)
npm start                   # http://localhost:3000

```

Then open `http://localhost:3000`, click **"Try a public example"**, and click **"Run audit"**.

---

## The 3-Minute Demo Flow

1. **Audit a Public Project** — Input a public GitHub repository link, demo video URL, and description. The multi-agent engine scans dependency files, checks for actual PayPal SDK implementation, and flags fake repos or prompt-injections.
2. **Monetized Priority Queue (PayPal Checkout)** — Users can pay a priority fee via the live PayPal Checkout button (or PayPal AI Toolkit) to instantly jump to the front of the processing queue and receive a cryptographically signed audit certificate.
3. **Certificate Verification** — Every issued certificate gets a unique serial number (e.g., `JM-63997E9A8617`). Anyone can visit `/verify/<serial>` to instantly validate its authenticity on the server.
4. **Judge Mode & Batch Payouts** — Organizers open Judge mode using the terminal Organizer key, import multiple participant repos, review AI scoring explanations ("Why this rank"), finalise the leaderboard, and disburse cash prizes instantly using the **PayPal Payouts API**.

---

## Environment Variables

| Variable | Purpose |
| --- | --- |
| `PORT` | Server port (defaults to `3000`). |
| `PAYPAL_CLIENT_ID` | PayPal Sandbox Client ID for checkout and payout transactions. |
| `PAYPAL_CLIENT_SECRET` | PayPal Sandbox Secret (keep private; never commit to GitHub). |
| `PAYPAL_API_BASE` | Optional PayPal API host (defaults to sandbox host). |
| `GITHUB_TOKEN` | Optional fine-grained, read-only token to avoid GitHub API rate limits during repo scans. |
| `LLM_API_KEY` | Optional Google AI Studio / OpenAI key for advanced AI qualitative scoring. Without it, robust heuristic scoring is used. |
| `PAYPAL_VIA` | Optional override (`rest` or `toolkit`) for payment routing. |

Nothing external is required to run the default demo. If a PayPal call fails, graceful fallbacks ensure the flow remains uninterrupted.

---

## Core Audit Pipeline

* **Tier 1: PayPal Fidelity Auditor** — Clones or fetches target repositories, scanning dependency files (`package.json`, `requirements.txt`) for active PayPal SDKs (`@paypal/checkout-server-sdk`, etc.) and checking for hardcoded mock stubs or name-dropping.
* **Tier 2: Video & Proof Analyzer** — Ingrams demo video URLs (e.g., YouTube) to verify that a live working PayPal sandbox checkout or API response is actually demonstrated.
* **Tier 3: Legal & Compliance Inspector** — Scans for open-source licenses (MIT, Apache) and checks dependency safety and hackathon rule alignment.
* **Cryptographic Certificates** — Issues tamper-proof audit certificates upon successful payment, tied directly to the audit verdict and transaction ID.

---

## Key API Endpoints

* `GET /api/health` — System status check (`"ok": true`) and sandbox connection status.
* `POST /api/audit` — Runs the multi-agent audit on a submitted project.
* `POST /api/checkout/create-order` & `capture-order` — Handles PayPal payment processing for priority audit certificates.
* `GET /verify/:serial` — Verifies cryptographic certificate signatures.
* `POST /api/competition` — Organizer route to create and manage multi-team competitions.
* `POST /api/payout` — Executes batch prize disbursement via the PayPal Payouts API.

---

## Technical Notes

* **Robust Testing:** Includes a rigorous 38-test suite covering SSRF guards, prompt-injection defense, payment safeguards, and toolkit failovers.
* **Stateless & Portable:** Designed to start instantly in local testing or cloud deployments (Render) with zero heavy database overhead.
