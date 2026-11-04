// n8n Code node "Rule checks". Reads the form and config, runs the red-flag rules
// and prepares the request for the local model.
const config = $('Config').first().json;
const form = $('Legal request form').first().json;

const now = new Date();
const text = String(form['Your request'] || '').trim();
const deadline = form['Deadline (optional)'] || '';
const { flags, minRisk } = checkRules(PLAYBOOK, text, deadline, now);
const systemPrompt = buildSystemPrompt(PLAYBOOK, SYSTEM_PROMPT_TEMPLATE);

return [{
  json: {
    ref: 'REQ-' + now.getTime().toString(36).toUpperCase().slice(-6),
    receivedAt: now.toISOString(),
    requester: form['Your email'] || '',
    team: form['Your team'] || 'Unknown',
    text,
    deadline,
    flags,
    ruleMinRisk: minRisk,
    ollamaBody: buildOllamaBody(PLAYBOOK, systemPrompt, config.model, form['Your team'], text),
  },
}];
