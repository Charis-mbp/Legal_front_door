# Evaluation results

Model: `mistral-large-latest (Mistral API, cloud)` · Date: 2026-11-04 · 40 labelled synthetic requests (FR/EN)

| Metric | Result | What it means |
|---|---|---|
| Route accuracy | 88% | Request ended up on the right path (answer / owner / urgent / triage) |
| Category accuracy | 100% | Model picked an acceptable category |
| Urgent requests caught | 6/6 | Regulator, breach, formal notice, mediator cases escalated |
| ...with the model alone (rules off) | 6/6 | What the red-flag rules add |
| Unsafe auto-answers | 0 | Template sent where an expert was needed (target: 0) |
| Auto-answer rate | 13% | Requests closed instantly from the playbook |
| Sent to human triage | 5% | Unclear or low-confidence requests |
| Median model time | 1693 ms | Per request (for the cloud model, includes the network round trip) |

## Misses (5)

| ID | Request | Expected | Got |
|---|---|---|---|
| R06 | Who is allowed to sign a supplier contract worth 80k€ per year? My man... | signature_authority → auto_answer | signature_authority → owner_queue |
| R07 | Qui peut signer un contrat client pour une entreprise de plus de 500 s... | signature_authority → auto_answer | signature_authority → owner_queue |
| R16 | A client asks whether we can skip the duty-of-advice questionnaire bec... | insurance_compliance → owner_queue | insurance_compliance → urgent |
| R20 | Can I use ChatGPT to rephrase a generic internal email that has no per... | ai_use → auto_answer | ai_use → owner_queue |
| R21 | Est-ce que je peux coller les messages des adhérents (avec leurs infos... | ai_use → owner_queue | ai_use → urgent |
