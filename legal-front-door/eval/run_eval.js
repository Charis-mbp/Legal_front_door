// Measures the front door on the 40 labelled test requests, using the SAME code as the
// n8n workflow (n8n/src/core.js) and the same local model.
//
//   node eval/run_eval.js                       # qwen2.5:7b on http://localhost:11434
//   node eval/run_eval.js --model llama3.1:8b   # compare another local model
//   MISTRAL_API_KEY=... node eval/run_eval.js --provider mistral   # cloud comparison
//   node eval/run_eval.js --mock                # pipeline check only, NOT real metrics
//
// Writes eval/results-<model>.md and .json, so runs of different models sit side by side.
// Requires Node 18+.
const fs = require('fs');
const path = require('path');
const core = require('../n8n/src/core.js');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const opt = (name, def) => (args.includes(name) ? args[args.indexOf(name) + 1] : def);
const PROVIDER = opt('--provider', 'ollama');
const MODEL = opt('--model', PROVIDER === 'mistral' ? 'mistral-large-latest' : 'qwen2.5:7b');
const URL = opt('--url', PROVIDER === 'mistral' ? 'https://api.mistral.ai' : 'http://localhost:11434');
const MOCK = args.includes('--mock');
if (PROVIDER === 'mistral' && !MOCK && !process.env.MISTRAL_API_KEY) {
  console.error('Set MISTRAL_API_KEY first.');
  process.exit(1);
}

const playbook = JSON.parse(fs.readFileSync(path.join(ROOT, 'playbook.json'), 'utf8'));
const prompt = core.buildSystemPrompt(playbook, fs.readFileSync(path.join(ROOT, 'prompts', 'classify_system.md'), 'utf8'));
const cases = fs.readFileSync(path.join(__dirname, 'dataset.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

async function classify(c) {
  if (MOCK) {
    // Fakes a perfect model from the labels: only checks that the plumbing works.
    return {
      content: JSON.stringify({
        category: c.expected_category, risk: c.expected_route === 'urgent' ? 'high' : 'low',
        needs_expert: c.expected_route !== 'auto_answer', confidence: c.expected_route === 'human_triage' ? 0.3 : 0.9, summary: 'mock',
      }),
      ms: 0,
    };
  }
  const body = core.buildOllamaBody(playbook, prompt, MODEL, c.team, c.text);
  // A dropped connection (Ollama restarting, laptop sleeping...) is retried, not counted as a miss.
  for (let attempt = 1; ; attempt++) {
    const t0 = Date.now();
    try {
      if (PROVIDER === 'mistral') return { content: await callMistral(body), ms: Date.now() - t0 };
      const res = await fetch(`${URL}/api/chat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        signal: AbortSignal.timeout(300000),
      });
      if (!res.ok) throw new Error(`Ollama returned ${res.status}: ${await res.text()}`);
      const data = await res.json();
      return { content: data.message && data.message.content, ms: Date.now() - t0 };
    } catch (e) {
      const why = e.cause ? `${e.message} (${e.cause.code || e.cause.message})` : e.message;
      if (attempt >= 4 || /returned 4\d\d/.test(why)) throw new Error(`${c.id}: ${why}`);
      console.error(`${c.id}: ${why}, retrying in ${attempt * 5}s...`);
      await new Promise((r) => setTimeout(r, attempt * 5000));
    }
  }
}

// Same prompt and same JSON schema as the local model, sent to Mistral's chat API.
async function callMistral(ollamaBody, attempt = 0) {
  const body = {
    model: MODEL,
    temperature: 0,
    messages: ollamaBody.messages,
    response_format: { type: 'json_schema', json_schema: { name: 'classification', schema: { ...ollamaBody.format, additionalProperties: false }, strict: true } },
  };
  const res = await fetch(`${URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.MISTRAL_API_KEY}` },
    body: JSON.stringify(body),
  });
  if (res.status === 429 && attempt < 8) {
    const retryAfter = Number(res.headers.get('retry-after')) * 1000 || 0;
    const wait = Math.max(retryAfter, 5000 * (attempt + 1));
    console.error(`  rate limited, waiting ${wait / 1000}s...`);
    await new Promise((r) => setTimeout(r, wait));
    return callMistral(ollamaBody, attempt + 1);
  }
  if (!res.ok) throw new Error(`Mistral returned ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices && data.choices[0].message.content;
}

const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : 'n/a');

async function main() {
  const now = new Date();
  const rows = [];
  for (const c of cases) {
    const deadline = c.deadline_in_days != null ? new Date(now.getTime() + c.deadline_in_days * 86400000).toISOString().slice(0, 10) : '';
    const { flags, minRisk } = core.checkRules(playbook, c.text, deadline, now);
    const request = { ref: c.id, receivedAt: now.toISOString(), team: c.team, text: c.text, deadline, flags, ruleMinRisk: minRisk };
    // Stay under Mistral's per-second rate limit (about 1 request/s on the basic tier).
    if (PROVIDER === 'mistral' && !MOCK) await new Promise((r) => setTimeout(r, Number(opt('--delay', 1500))));
    const { content, ms } = await classify(c);
    const model = core.parseModelOutput(playbook, content);
    const d = core.decide(playbook, request, model);
    // Same decision with the red-flag rules switched off: shows what the rules add.
    const noRules = core.decide(playbook, { ...request, flags: [], ruleMinRisk: 'low' }, model);
    const okCats = c.acceptable_categories || [c.expected_category];
    const okRoutes = c.acceptable_routes || [c.expected_route];
    rows.push({
      id: c.id, text: c.text, expected_category: c.expected_category, expected_route: c.expected_route,
      category: model.ok ? model.category : `INVALID (${model.error})`, confidence: model.ok ? model.confidence : null,
      route: d.route, route_without_rules: noRules.route, flags: flags.map((f) => f.id), ms,
      category_ok: model.ok && okCats.includes(model.category), route_ok: okRoutes.includes(d.route),
      unsafe_auto: d.route === 'auto_answer' && !okRoutes.includes('auto_answer'),
    });
    process.stdout.write(`${c.id} ${rows[rows.length - 1].route_ok ? 'ok ' : 'MISS'} ${d.route}\n`);
  }

  const urgent = rows.filter((r) => r.expected_route === 'urgent');
  const lat = rows.map((r) => r.ms).sort((a, b) => a - b);
  const m = {
    model: MOCK ? 'MOCK (labels fed back, not a real model)' : `${MODEL} (${PROVIDER === 'mistral' ? 'Mistral API, cloud' : 'Ollama, local'})`,
    date: now.toISOString().slice(0, 10),
    cases: rows.length,
    category_accuracy: pct(rows.filter((r) => r.category_ok).length, rows.length),
    route_accuracy: pct(rows.filter((r) => r.route_ok).length, rows.length),
    urgent_caught: `${urgent.filter((r) => r.route === 'urgent').length}/${urgent.length}`,
    urgent_caught_without_rules: `${urgent.filter((r) => r.route_without_rules === 'urgent').length}/${urgent.length}`,
    unsafe_auto_answers: rows.filter((r) => r.unsafe_auto).length,
    auto_answer_rate: pct(rows.filter((r) => r.route === 'auto_answer').length, rows.length),
    human_triage_rate: pct(rows.filter((r) => r.route === 'human_triage').length, rows.length),
    median_model_ms: lat[Math.floor(lat.length / 2)],
  };

  const misses = rows.filter((r) => !r.route_ok || !r.category_ok);
  const md = [
    `# Evaluation results${MOCK ? ' (MOCK RUN: pipeline check, not real metrics)' : ''}`,
    '',
    `Model: \`${m.model}\` · Date: ${m.date} · ${m.cases} labelled synthetic requests (FR/EN)`,
    '',
    '| Metric | Result | What it means |',
    '|---|---|---|',
    `| Route accuracy | ${m.route_accuracy} | Request ended up on the right path (answer / owner / urgent / triage) |`,
    `| Category accuracy | ${m.category_accuracy} | Model picked an acceptable category |`,
    `| Urgent requests caught | ${m.urgent_caught} | Regulator, breach, formal notice, mediator cases escalated |`,
    `| ...with the model alone (rules off) | ${m.urgent_caught_without_rules} | What the red-flag rules add |`,
    `| Unsafe auto-answers | ${m.unsafe_auto_answers} | Template sent where an expert was needed (target: 0) |`,
    `| Auto-answer rate | ${m.auto_answer_rate} | Requests closed instantly from the playbook |`,
    `| Sent to human triage | ${m.human_triage_rate} | Unclear or low-confidence requests |`,
    `| Median model time | ${m.median_model_ms} ms | Per request, on the local machine |`,
    '',
    `## Misses (${misses.length})`,
    '',
    misses.length ? '| ID | Request | Expected | Got |\n|---|---|---|---|\n' + misses.map((r) =>
      `| ${r.id} | ${r.text.slice(0, 70).replace(/\|/g, '/')}... | ${r.expected_category} → ${r.expected_route} | ${r.category} → ${r.route} |`).join('\n') : 'None.',
    '',
  ].join('\n');

  const slug = MOCK ? 'mock' : MODEL.replace(/[^a-z0-9.]+/gi, '-');
  fs.writeFileSync(path.join(__dirname, `results-${slug}.md`), md);
  fs.writeFileSync(path.join(__dirname, `results-${slug}.json`), JSON.stringify({ metrics: m, rows }, null, 2));
  console.log('\n' + md);
}

main().catch((e) => {
  console.error(e.message);
  if (/fetch failed|ECONNREFUSED/.test(String(e.cause || e))) console.error(`Is Ollama running at ${URL}? Try: ollama serve`);
  process.exit(1);
});
