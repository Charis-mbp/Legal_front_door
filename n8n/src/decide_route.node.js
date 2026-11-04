// n8n Code node "Decide route". The model's answer is only a proposal:
// the playbook rules below decide the route, owner and deadline.
const config = $('Config').first().json;
const request = $('Rule checks').first().json;
const res = $input.first().json;

// Works with the HTTP call to Ollama (message.content) or an Information Extractor node (output).
const content = res && res.output ? JSON.stringify(res.output) : res && res.message && res.message.content;
const model = content
  ? parseModelOutput(PLAYBOOK, content)
  : { ok: false, error: res && res.error ? 'model unreachable' : 'empty model response' };

const decision = decide(PLAYBOOK, request, model);
const meta = {
  model: config.model,
  modelMs: res && res.total_duration ? Math.round(res.total_duration / 1e6) : null,
};

return [{
  json: {
    ...decision,
    ref: request.ref,
    userTitle: { auto_answer: 'Here is your answer', urgent: 'Escalated as urgent' }[decision.route] || 'Request received',
    notionBody: notionBody(PLAYBOOK, config.notionDatabaseId, request, decision, meta),
  },
}];
