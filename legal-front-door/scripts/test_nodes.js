// Runs the GENERATED Code-node scripts from the workflow JSON with mocked n8n globals,
// to check the logic end to end without n8n or a model.
//   node scripts/test_nodes.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const wf = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'n8n', 'legal-front-door.workflow.json'), 'utf8'));
const code = (name) => wf.nodes.find((n) => n.name === name).parameters.jsCode;

function runNode(jsCode, nodes, input) {
  const $ = (name) => ({ first: () => ({ json: nodes[name] }) });
  const $input = { first: () => ({ json: input }) };
  return new Function('$', '$input', jsCode)($, $input)[0].json;
}

const config = { ollamaUrl: 'http://x', model: 'qwen2.5:7b', notionDatabaseId: 'db123' };

function run(form, modelJson) {
  const nodes = { Config: config, 'Legal request form': form };
  const req = runNode(code('Rule checks'), nodes, form);
  nodes['Rule checks'] = req;
  const res = modelJson === null ? { error: { message: 'ECONNREFUSED' } }
    : { message: { content: typeof modelJson === 'string' ? modelJson : JSON.stringify(modelJson) }, total_duration: 2.5e9 };
  return { req, out: runNode(code('Decide route'), nodes, res) };
}

const form = (text, extra = {}) => ({ 'Your email': 'a@b.fr', 'Your team': 'Sales', 'Your request': text, ...extra });
const m = (category, risk, needs_expert, confidence) => ({ category, risk, needs_expert, confidence, summary: 'test' });

// 1. Routine NDA → approved template answer
let { req, out } = run(form('Can I use the standard NDA? They accept it as is.'), m('nda_standard', 'low', false, 0.95));
assert.equal(out.route, 'auto_answer');
assert.match(out.userMessage, /approved template/);
assert.equal(req.ollamaBody.format.properties.category.enum.length, 15);
assert.match(req.ollamaBody.messages[0].content, /- nda_standard:/);

// 2. Mediator mentioned → urgent even if the model says low risk
({ out } = run(form("Elle va saisir le médiateur de l'assurance"), m('member_complaint', 'low', true, 0.9)));
assert.equal(out.route, 'urgent');
assert.match(out.reasons.join(), /Mediator/);

// 3. Low confidence → human triage
({ out } = run(form('question about stuff'), m('contract_review', 'low', true, 0.4)));
assert.equal(out.route, 'human_triage');

// 4. Garbage model output → human triage, never auto-answer
({ out } = run(form('Can I use the standard NDA?'), 'not json at all'));
assert.equal(out.route, 'human_triage');
assert.match(out.reasons.join(), /rejected/);

// 5. Model unreachable → human triage
({ out } = run(form('Can I use the standard NDA?'), null));
assert.equal(out.route, 'human_triage');

// 6. Hallucinated category → rejected
({ out } = run(form('x'), m('tax_advice', 'low', false, 0.99)));
assert.equal(out.route, 'human_triage');

// 7. Auto-answer category but needs an expert → owner queue
({ out } = run(form('They sent their own NDA with a penalty clause'), m('nda_standard', 'low', true, 0.9)));
assert.equal(out.route, 'owner_queue');
assert.equal(out.owner, 'Commercial Legal');

// 8. Health data shared with a partner → red flag blocks any template answer, risk at least medium
({ out } = run(form('Envoyer les données de remboursement à un partenaire opticien'), m('ai_use', 'low', false, 0.9)));
assert.equal(out.route, 'owner_queue');
assert.equal(out.risk, 'medium');

// 9. Data incident category is always urgent and carries the 72h note
({ out } = run(form('Lost a laptop with member files'), m('privacy_incident', 'medium', true, 0.9)));
assert.equal(out.route, 'urgent');
assert.match(out.userMessage, /72 hours/);

// 10. Notion payload shape
assert.equal(out.notionBody.parent.database_id, 'db123');
assert.equal(out.notionBody.properties.Route.select.name, 'Urgent escalation');
assert.equal(out.notionBody.properties['Model ms'].number, 2500);

// 11. Short deadline is flagged and caps the SLA date
const soon = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
({ req, out } = run(form('Review the landing page', { 'Deadline (optional)': soon }), m('marketing_review', 'low', true, 0.9)));
assert.ok(req.flags.some((f) => f.id === 'short_deadline'));
assert.equal(out.slaDue <= soon, true);

console.log('All 11 node tests passed.');
