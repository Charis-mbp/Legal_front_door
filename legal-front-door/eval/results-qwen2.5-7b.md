# Evaluation results

Model: `qwen2.5:7b (Ollama, local)` · Date: 2026-11-04 · 40 labelled synthetic requests (FR/EN)

| Metric | Result | What it means |
|---|---|---|
| Route accuracy | 95% | Request ended up on the right path (answer / owner / urgent / triage) |
| Category accuracy | 93% | Model picked an acceptable category |
| Urgent requests caught | 6/6 | Regulator, breach, formal notice, mediator cases escalated |
| ...with the model alone (rules off) | 4/6 | What the red-flag rules add |
| Unsafe auto-answers | 0 | Template sent where an expert was needed (target: 0) |
| Auto-answer rate | 15% | Requests closed instantly from the playbook |
| Sent to human triage | 8% | Unclear or low-confidence requests |
| Median model time | 20629 ms | Per request, on the local machine |

## Misses (3)

| ID | Request | Expected | Got |
|---|---|---|---|
| R20 | Can I use ChatGPT to rephrase a generic internal email that has no per... | ai_use → auto_answer | other → human_triage |
| R21 | Est-ce que je peux coller les messages des adhérents (avec leurs infos... | ai_use → owner_queue | privacy_new_processing → owner_queue |
| R37 | Où se trouve la politique de télétravail à jour ?... | template_request → auto_answer | employment → owner_queue |
