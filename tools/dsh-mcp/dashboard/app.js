const $ = selector => document.querySelector(selector);
const state = { runs: [], selected: null, run: null, tab: 'timeline', signature: null, busy: false, attempt: null };
const labels = { submitted: '排队中', working: '执行中', completed: '执行完成', failed: '失败', canceled: '已取消', pending: '待验收', passed: '验收通过' };
labels.interrupted = '中断待检查';
const time = value => new Date(value).toLocaleTimeString('zh-CN', { hour12: false });
const date = value => new Date(value).toLocaleString('zh-CN', { hour12: false });
const duration = run => run.duration_ms === null ? '—' : `${(run.duration_ms / 1000).toFixed(1)} s`;
const icons = () => window.lucide?.createIcons();
function node(tag, className, text) { const element = document.createElement(tag); if (className) element.className = className; if (text !== undefined) element.textContent = text; return element; }
function badge(status) { return node('span', `badge ${status}`, labels[status] || status); }
function matches(run) {
  const query = $('#search').value.toLowerCase();
  const filter = $('#filter').value;
  return `${run.task_id} ${run.objective}`.toLowerCase().includes(query) &&
    (filter === 'all' || filter === 'active' && ['submitted', 'working'].includes(run.status) ||
     filter === 'pending' && run.status === 'completed' && run.acceptance.verdict === 'pending' ||
     filter === 'failed' && (['failed', 'interrupted'].includes(run.status) || run.acceptance.verdict === 'failed') ||
     filter === 'passed' && run.acceptance.verdict === 'passed');
}
function renderList() {
  $('#total').textContent = state.runs.length;
  $('#active').textContent = state.runs.filter(run => ['working', 'submitted'].includes(run.status)).length;
  $('#pending').textContent = state.runs.filter(run => run.status === 'completed' && run.acceptance.verdict === 'pending').length;
  $('#failed').textContent = state.runs.filter(run => ['failed', 'interrupted'].includes(run.status) || run.acceptance.verdict === 'failed').length;
  const filtered = state.runs.filter(matches);
  $('#count').textContent = `${filtered.length} 项`;
  $('#tasks').replaceChildren();
  for (const run of filtered) {
    const button = node('button', `task-row${state.selected === run.run_id ? ' selected' : ''}`);
    const top = node('div', 'row-top');
    top.append(node('span', 'task-id', run.task_id), badge(run.status));
    const bottom = node('div', 'row-bottom');
    bottom.append(node('span', '', date(run.at)), node('span', '', duration(run)));
    button.append(top, node('p', 'task-desc', run.objective), bottom);
    button.onclick = () => { state.selected = run.run_id; state.attempt = null; state.signature = null; renderList(); void refreshDetail(); };
    $('#tasks').append(button);
  }
  if (!filtered.length) $('#tasks').append(node('div', 'no-results', state.runs.length ? '无匹配任务' : '暂无任务'));
}
function eventText(event) {
  if (event.detail) return [({ assigned: '派工', interrupted: '执行中断', retry_requested: '重新排队', resolved: '已关闭', cancel_requested: '申请取消', finished: '执行结束', verification: '验收记录' })[event.kind] || event.kind,
    [event.detail.assignment_id, event.detail.status, event.detail.reason, event.detail.message].filter(Boolean).join(' · ')];
  if (event.kind === 'submitted') return [`${event.delegated_by} → DeepSeek Harness`, '任务已提交'];
  if (event.kind === 'working') return ['启动 DSH', '执行进程已启动'];
  if (event.kind === 'result') return [labels[event.result.status], event.result.error ? `${event.result.error.stage} · ${event.result.error.code}: ${event.result.error.message}` : '协议通过，等待结果验收'];
  if (event.kind === 'verification') return [event.verification.verdict === 'passed' ? '验收通过' : '验收未通过', `${event.verification.reviewer} · ${event.verification.evidence.join('；')}`];
  if (event.kind === 'export') return ['Langfuse', event.status === 'sent' ? '追踪已发送' : event.message];
  const item = event.event || {};
  const tool = item.toolName || item.tool_name || item.detail?.tool || item.name;
  const title = tool ? `${item.type === 'tool_result' ? '工具返回' : '调用工具'} · ${tool}` : item.phase || item.type || event.kind;
  return [title, [item.turn && `轮次 ${item.turn}`, item.step && `步骤 ${item.step}`, item.reason?.kind, item.status,
    item.detail?.input?.description, item.usage && `${item.usage.totalTokens ?? '—'} tokens`].filter(Boolean).join(' · ')];
}
function renderTab() {
  const run = state.run;
  const target = $('#tab-content');
  target.replaceChildren();
  $('.tabs').querySelectorAll('button').forEach(button => button.classList.toggle('selected', button.dataset.tab === state.tab));
  if (state.tab === 'timeline') {
    const list = node('ol', 'timeline');
    for (const event of run.events) {
      const row = node('li');
      const [title, detail] = eventText(event);
      const description = node('div', 'event-title');
      description.append(node('strong', '', title), node('span', 'event-detail', detail));
      row.append(node('time', '', time(event.at)), node('span', 'marker'), description);
      list.append(row);
    }
    target.append(list);
  } else if (state.tab === 'result') {
    if (run.result?.error) target.append(node('p', 'error', JSON.stringify(run.result.error, null, 2)));
    target.append(node('pre', '', run.result?.final_text || '尚无返回结果'));
    if (run.result) target.append(node('p', 'result-meta', `Token: ${run.result.usage?.total_tokens ?? '未提供'} · 协议: ${run.result.protocol?.passed ? '通过' : '未通过'} · 会话: ${run.result.session_id || '—'}`));
  } else {
    const heading = node('div', 'verification-label'); heading.append(node('h2', '', '验收标准'), badge(run.acceptance.verdict)); target.append(heading);
    const list = node('ol', 'acceptance-list');
    for (const criterion of run.acceptance_criteria) list.append(node('li', '', criterion));
    target.append(list);
    if (run.acceptance.reviewer) target.append(node('p', 'evidence', `${run.acceptance.reviewer}：${run.acceptance.evidence.join('；')}`));
    const form = node('form', 'verification-form');
    const reviewerLabel = node('label', '', '验收人'); const reviewer = node('input'); reviewer.name = 'reviewer'; reviewer.required = true; reviewer.maxLength = 128; reviewer.value = run.acceptance.reviewer || '用户'; reviewerLabel.append(reviewer);
    const evidenceLabel = node('label', '', '检查证据'); const evidence = node('textarea'); evidence.name = 'evidence'; evidence.required = true; evidence.maxLength = 16000; evidenceLabel.append(evidence);
    const actions = node('div', 'verification-actions');
    const approve = node('button', 'command-button'); approve.type = 'submit'; approve.value = 'passed'; approve.innerHTML = '<i data-lucide="check"></i>验收通过'; approve.disabled = run.status !== 'completed' || run.stale;
    const reject = node('button', 'command-button reject'); reject.type = 'submit'; reject.value = 'failed'; reject.innerHTML = '<i data-lucide="x"></i>验收未通过'; reject.disabled = !['completed', 'failed', 'canceled'].includes(run.status) || run.stale;
    const error = node('p', 'error');
    actions.append(approve, reject); form.append(reviewerLabel, evidenceLabel, actions, error);
    form.onsubmit = async event => {
      event.preventDefault();
      try {
        const endpoint = run.ticket ? `/api/tickets/${run.ticket.id}/verification` : `/api/runs/${run.run_id}/verification`;
        const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-DSH-Request': 'dashboard' }, body: JSON.stringify({ ...(run.ticket ? { assignment_id: run.assignment?.id } : {}), verdict: event.submitter.value, reviewer: reviewer.value, evidence: evidence.value.split('\n').filter(line => line.trim()) }) });
        const reply = await response.json(); if (!response.ok) throw new Error(reply.error);
        state.signature = null; await refresh();
      } catch (err) { error.textContent = err.message; }
    };
    target.append(form);
  }
  icons();
}
async function refreshDetail() {
  if (!state.selected) return;
  const isTicket = state.selected.startsWith('ticket:');
  const response = await fetch(isTicket ? `/api/tickets/${state.selected.slice(7)}` : `/api/runs/${state.selected}`);
  if (!response.ok) throw new Error('无法读取任务详情');
  let run = await response.json();
  if (isTicket) {
    const ticket = run;
    const assignment = ticket.assignments.find(item => item.id === state.attempt) || ticket.assignments.at(-1);
    const traced = assignment?.run_id ? await (await fetch(`/api/runs/${assignment.run_id}`)).json() : null;
    run = { ...ticket.task, ticket, assignment, run_id: state.selected, at: ticket.created_at,
      delegated_by: ticket.task.metadata?.delegated_by || 'caller', parent_task_id: ticket.task.metadata?.parent_task_id,
      status: ticket.status, acceptance: assignment?.acceptance || { verdict: 'pending' },
      result: assignment?.result, duration_ms: assignment?.result?.duration_ms ?? null,
      trace_id: traced?.trace_id || '—', stale: assignment?.id !== ticket.current_assignment,
      events: [...ticket.events, ...(traced?.events || [])].sort((a, b) => a.at.localeCompare(b.at)) };
  }
  const signature = JSON.stringify([run.run_id, run.events.length, run.status, run.assignment?.id, run.acceptance]);
  state.run = run;
  if (signature === state.signature) return;
  state.signature = signature;
  $('#detail').replaceChildren($('#detail-template').content.cloneNode(true));
  $('#run-label').textContent = run.run_id;
  $('#task-title').textContent = run.task_id;
  $('#task-status').replaceWith(Object.assign(badge(run.status), { id: 'task-status' }));
  $('#objective').textContent = run.objective;
  $('#caller').textContent = run.delegated_by;
  for (const [key, value] of [['工作目录', run.working_directory], ['上级任务', run.parent_task_id || '—'], ['开始时间', date(run.at)], ['执行耗时', duration(run)], ['Trace ID', run.trace_id]]) {
    $('#metadata').append(node('dt', '', key), node('dd', '', value));
  }
  if (run.ticket) renderTicketControls(run);
  $('.tabs').querySelectorAll('button').forEach(button => { button.onclick = () => { state.tab = button.dataset.tab; renderTab(); }; });
  renderTab();
}
function renderTicketControls(run) {
  const target = $('#ticket-controls'), ticket = run.ticket;
  const attemptLabel = node('label', '', '派工记录 '), attempts = node('select');
  attempts.setAttribute('aria-label', '派工记录');
  for (const item of ticket.assignments) attempts.append(new Option(`#${item.number} · ${labels[item.status] || item.status}`, item.id));
  if (run.assignment) attempts.value = run.assignment.id;
  attempts.onchange = () => { state.attempt = attempts.value; state.signature = null; void refreshDetail(); };
  attemptLabel.append(attempts); target.append(attemptLabel);
  const actions = node('div', 'verification-actions'), error = node('p', 'error');
  async function action(name, body = {}) {
    try {
      const reply = await fetch(`/api/tickets/${ticket.id}/${name}`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-DSH-Request': 'dashboard' }, body: JSON.stringify(body) });
      const result = await reply.json(); if (!reply.ok) throw new Error(result.error);
      state.signature = null; state.attempt = null; await refresh();
    } catch (err) { error.textContent = err.message; }
  }
  if (['submitted', 'working'].includes(ticket.status)) {
    const cancel = node('button', 'command-button reject'); cancel.innerHTML = '<i data-lucide="square"></i>取消任务';
    cancel.disabled = Boolean(run.assignment?.cancel_requested);
    cancel.onclick = () => void action('cancel'); actions.append(cancel);
  } else if (run.assignment?.acceptance.verdict !== 'passed') {
    const form = node('form', 'retry-form');
    const review = node('input'); review.type = 'checkbox'; review.required = true;
    const reviewLabel = node('label', 'review-checkbox'); reviewLabel.append(review, document.createTextNode('已检查副作用，并确认旧执行进程已停止'));
    const reason = node('textarea'); reason.required = true; reason.placeholder = '检查证据与处理原因'; reason.setAttribute('aria-label', '重试检查证据'); reason.maxLength = 8000;
    const retry = node('button', 'command-button'); retry.type = 'submit'; retry.value = 'retry'; retry.innerHTML = '<i data-lucide="rotate-cw"></i>重新排队';
    actions.append(retry);
    if (ticket.status === 'interrupted') {
      const resolve = node('button', 'command-button reject'); resolve.type = 'submit'; resolve.value = 'resolve'; resolve.innerHTML = '<i data-lucide="archive"></i>关闭工单'; actions.append(resolve);
    }
    form.append(reviewLabel, reason, actions);
    form.onsubmit = event => { event.preventDefault(); void action(event.submitter.value, { assignment_id: ticket.current_assignment, side_effects_reviewed: review.checked, reason: reason.value }); };
    target.append(form, error); return;
  }
  target.append(actions, error);
}
async function refresh() {
  if (state.busy) return;
  state.busy = true;
  try {
    const [response, ticketResponse] = await Promise.all([fetch('/api/runs'), fetch('/api/tickets')]);
    if (!response.ok || !ticketResponse.ok) throw new Error('连接失败');
    const ticketData = await ticketResponse.json(), tickets = ticketData.tickets;
    const ids = new Set(tickets.flatMap(item => item.run_ids));
    const historical = (await response.json()).runs.filter(item => !ids.has(item.run_id));
    state.runs = [...tickets.map(item => ({ ...item, run_id: `ticket:${item.id}`, at: item.created_at, duration_ms: null })), ...historical];
    const executor = ticketData.executor;
    $('#executor').textContent = executor.alive ? `执行器在线 · 并发上限 ${executor.workers} · 心跳 ${time(executor.heartbeat)}` : '执行器未运行';
    if (!state.selected && state.runs.length) state.selected = state.runs[0].run_id;
    renderList(); await refreshDetail();
    $('#connection').textContent = '本机已连接'; $('#connection-dot').classList.add('online');
  } catch (error) { $('#connection').textContent = '连接中断'; $('#connection-dot').classList.remove('online'); }
  finally { state.busy = false; }
}
$('#search').oninput = renderList; $('#filter').onchange = renderList; $('#refresh').onclick = () => void refresh();
icons(); void refresh(); setInterval(() => void refresh(), 2000);
