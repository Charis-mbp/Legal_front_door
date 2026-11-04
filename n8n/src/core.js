// Core logic shared by the n8n Code nodes (and tested in scripts/test_core.js).
// Pure functions only: no n8n globals here.

const RISK_ORDER = ['low', 'medium', 'high'];

function maxRisk(...levels) {
  let best = 0;
  for (const level of levels) {
    const i = RISK_ORDER.indexOf(level);
    if (i > best) best = i;
  }
  return RISK_ORDER[best];
}

function findCategory(playbook, id) {
  return playbook.categories.find((c) => c.id === id);
}

// Deterministic red-flag rules. They run before the model and can only raise risk.
function checkRules(playbook, text, deadline, now) {
  const flags = [];
  let minRisk = 'low';
  for (const rule of playbook.red_flag_rules) {
    if (new RegExp(rule.pattern, 'i').test(text)) {
      flags.push({ id: rule.id, label: rule.label });
      minRisk = maxRisk(minRisk, rule.min_risk);
    }
  }
  if (deadline) {
    const days = (new Date(deadline + 'T23:59:59') - now) / 86400000;
    if (days <= 2) flags.push({ id: 'short_deadline', label: 'Deadline within 2 days' });
  }
  return { flags, minRisk };
}

function buildSystemPrompt(playbook, template) {
  const list = playbook.categories.map((c) => `- ${c.id}: ${c.description}`).join('\n');
  return template.replace('{{CATEGORIES}}', list);
}

function buildOllamaBody(playbook, systemPrompt, model, team, text) {
  return {
    model,
    stream: false,
    options: { temperature: 0 },
    format: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: playbook.categories.map((c) => c.id) },
        risk: { type: 'string', enum: RISK_ORDER },
        needs_expert: { type: 'boolean' },
        confidence: { type: 'number' },
        summary: { type: 'string' },
      },
      required: ['category', 'risk', 'needs_expert', 'confidence', 'summary'],
    },
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Requester team: ${team}\nRequest:\n${text}` },
    ],
  };
}

// Never trust model output blindly: anything malformed means "send to a human".
function parseModelOutput(playbook, content) {
  try {
    const out = JSON.parse(content);
    if (!findCategory(playbook, out.category)) throw new Error(`unknown category "${out.category}"`);
    if (!RISK_ORDER.includes(out.risk)) throw new Error(`unknown risk "${out.risk}"`);
    const confidence = Math.max(0, Math.min(1, Number(out.confidence)));
    if (Number.isNaN(confidence)) throw new Error('confidence is not a number');
    return {
      ok: true,
      category: out.category,
      risk: out.risk,
      needsExpert: out.needs_expert !== false,
      confidence,
      summary: String(out.summary || '').slice(0, 300),
    };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

function addBusinessDays(date, days) {
  const d = new Date(date.getTime());
  let added = 0;
  while (added < days) {
    d.setDate(d.getDate() + 1);
    const wd = d.getDay();
    if (wd !== 0 && wd !== 6) added++;
  }
  return d.toISOString().slice(0, 10);
}

// The routing decision. The model proposes; these rules decide.
function decide(playbook, request, model) {
  const s = playbook.settings;
  const reasons = request.flags.map((f) => f.label);

  if (!model.ok) {
    return finish(playbook, request, {
      route: 'human_triage', category: 'other', risk: request.ruleMinRisk === 'high' ? 'high' : 'medium',
      owner: s.triage_owner, slaDays: s.triage_sla_days,
      reasons: [...reasons, `Model output rejected: ${model.error}`], summary: '',
    });
  }

  const cat = findCategory(playbook, model.category);
  const risk = maxRisk(model.risk, request.ruleMinRisk, cat.min_risk);
  const base = { category: cat.id, risk, owner: cat.owner, summary: model.summary, confidence: model.confidence };

  if (risk === 'high') {
    if (model.risk === 'high' && !reasons.length) reasons.push('Model rated the request high risk');
    if (cat.min_risk === 'high' && !reasons.length) reasons.push(`${cat.label} is always urgent`);
    return finish(playbook, request, { ...base, route: 'urgent', slaDays: 0, reasons });
  }
  if (cat.id === 'other' || model.confidence < s.confidence_threshold) {
    reasons.push(cat.id === 'other' ? 'Unclear or non-legal request' : `Low model confidence (${model.confidence})`);
    return finish(playbook, request, { ...base, route: 'human_triage', owner: s.triage_owner, slaDays: s.triage_sla_days, reasons });
  }
  if (cat.auto_answer && !model.needsExpert && request.flags.length === 0) {
    return finish(playbook, request, { ...base, route: 'auto_answer', slaDays: 0, answer: cat.auto_answer, reasons });
  }
  if (cat.auto_answer) reasons.push(model.needsExpert ? 'Goes beyond the standard answer' : 'Red flag blocks the standard answer');
  return finish(playbook, request, { ...base, route: 'owner_queue', slaDays: cat.sla_days, reasons });
}

function finish(playbook, request, d) {
  const cat = findCategory(playbook, d.category);
  let slaDue = addBusinessDays(new Date(request.receivedAt), d.slaDays);
  if (request.deadline && request.deadline < slaDue && d.route !== 'auto_answer') slaDue = request.deadline;
  const note = cat && cat.note ? cat.note : '';
  return { ...d, slaDue, note, userMessage: userMessage(request, d, slaDue, note) };
}

function userMessage(request, d, slaDue, note) {
  const ref = `Reference: ${request.ref}`;
  switch (d.route) {
    case 'auto_answer':
      return `Here is the standard answer from the Corporate playbook:\n\n${d.answer}\n\nThis answer comes from an approved template, not from the AI. If it doesn't cover your situation, submit a new request with more detail.\n\n${ref}`;
    case 'urgent':
      return `This looks urgent (${d.reasons.join('; ')}). ${d.owner} has been flagged and will contact you today. Please don't reply to the external party or take further action before you hear from them.${note ? '\n\n' + note : ''}\n\n${ref}`;
    case 'owner_queue':
      return `Thanks, your request has been sent to ${d.owner}. Expected first response by ${slaDue}.${note ? '\n\n' + note : ''}\n\n${ref}`;
    default:
      return `Thanks, Legal Ops will review your request and route it to the right person by ${slaDue}.\n\n${ref}`;
  }
}

const ROUTE_LABELS = {
  auto_answer: 'Auto-answered', owner_queue: 'Owner queue', urgent: 'Urgent escalation', human_triage: 'Human triage',
};

function richText(value) {
  return [{ type: 'text', text: { content: String(value || '').slice(0, 1900) } }];
}

function notionBody(playbook, databaseId, request, d, meta) {
  const cat = findCategory(playbook, d.category);
  return {
    parent: { database_id: databaseId },
    properties: {
      Request: { title: richText(request.text.slice(0, 200)) },
      Reference: { rich_text: richText(request.ref) },
      Requester: { email: request.requester || null },
      Team: { select: { name: request.team || 'Unknown' } },
      Category: { select: { name: cat ? cat.label : 'Other / unclear' } },
      Risk: { select: { name: d.risk } },
      Route: { select: { name: ROUTE_LABELS[d.route] } },
      Owner: { select: { name: d.owner } },
      Status: { select: { name: d.route === 'auto_answer' ? 'Answered' : 'New' } },
      'Route check': { select: { name: 'Not reviewed' } },
      Confidence: { number: d.confidence ?? null },
      'Red flags': { rich_text: richText(request.flags.map((f) => f.label).join(', ')) },
      Reasons: { rich_text: richText(d.reasons.join('; ')) },
      'AI summary': { rich_text: richText(d.summary) },
      'Full request': { rich_text: richText(request.text) },
      Received: { date: { start: request.receivedAt } },
      'SLA due': { date: { start: d.slaDue } },
      'Model ms': { number: meta.modelMs ?? null },
      Model: { rich_text: richText(meta.model) },
    },
  };
}

if (typeof module !== 'undefined') {
  module.exports = { maxRisk, checkRules, buildSystemPrompt, buildOllamaBody, parseModelOutput, addBusinessDays, decide, notionBody, ROUTE_LABELS };
}
