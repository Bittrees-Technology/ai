/** Explicit owner consent for one existing approved template. No URL secrets or
 * persisted browser credentials; session changes discard the entire review. */
export function mountMcpConnections(root, context, templates, api) {
  let scope = '', epoch = 0, busy = false, review = null, grants = [], reviewTimer;
  const el = (tag, text = '') => { const node = document.createElement(tag); node.textContent = text; return node; };
  const heading = el('h2', 'MCP connections');
  const description = el('p', 'Allow your MCP workspace to request one approved local template. This does not approve source writes or change its prompt.');
  const notice = el('p'); notice.setAttribute('role', 'status');
  const form = el('form'), id = el('input'), code = el('input');
  id.required = code.required = true; id.autocomplete = code.autocomplete = 'off'; id.maxLength = 36; code.maxLength = 43;
  const field = (text, input) => { const label = el('label', text); label.append(input); return label; };
  const load = el('button', 'Review connection request'); load.type = 'submit';
  form.append(field('Request ID from MCP', id), field('Approval code from MCP', code), load);
  const details = el('div'), history = el('div'), refresh = el('button', 'Refresh connections'); refresh.type = 'button';
  root.replaceChildren(heading, description, form, notice, details, refresh, history);
  function clearReview() { clearTimeout(reviewTimer); review = null; id.value = code.value = ''; details.replaceChildren(); }
  function current(saved, turn) { return saved && saved === JSON.stringify(context()) && turn === epoch && !document.hidden; }
  async function perform(work) {
    if (busy || !context()) return;
    const saved = JSON.stringify(context()), turn = epoch;
    busy = true; load.disabled = refresh.disabled = true;
    try { await work(() => current(saved, turn)); }
    catch { if (current(saved, turn)) notice.textContent = 'This request could not be completed. Refresh the connection and review it again.'; }
    finally { busy = false; load.disabled = refresh.disabled = false; }
  }
  function renderGrants() {
    history.replaceChildren();
    for (const grant of grants) {
      const row = el('article');
      row.append(el('h3', grant.revoked ? 'Revoked connection' : 'Approved connection'), el('p', `Request ${grant.id}. MCP workspace ${grant.actor.tenant}, account ${grant.actor.subject}.`), el('p', `${grant.submittedRuns} of ${grant.maxRuns} requests accepted. Ends ${new Date(grant.expiresAt).toLocaleString()}.`));
      const ack = el('input'); ack.type = 'checkbox';
      const action = el('button', grant.revoked ? 'Remove connection record' : 'Revoke connection'); action.type = 'button';
      row.append(field(grant.revoked ? 'I want to remove this revoked record.' : 'Stop future requests. Already accepted work may still finish.', ack), action);
      action.onclick = () => { if (!ack.checked) return; perform(async valid => {
        await api(`/browser/mcp/${grant.revoked ? 'forget' : 'revoke'}`, { id: grant.id, confirmed: true });
        const result = await api('/browser/mcp/grants', {});
        if (valid()) { grants = result.items; renderGrants(); notice.textContent = grant.revoked ? 'Connection record removed.' : 'Connection revoked.'; }
      }); };
      history.append(row);
    }
    if (!grants.length) history.append(el('p', 'No approved MCP connections loaded.'));
  }
  form.onsubmit = event => { event.preventDefault(); const request = { id: id.value.trim(), approvalCode: code.value.trim() };
    perform(async valid => {
      clearReview();
      const result = await api('/browser/mcp/review', request);
      if (!valid()) return;
      review = { ...request, requestExpiresAt: result.requestExpiresAt };
      reviewTimer = setTimeout(clearReview, Math.max(0, result.requestExpiresAt - Date.now()));
      const available = templates().filter(t => t.expiresAt > Date.now() && t.submittedRuns < t.maxRuns);
      details.replaceChildren(el('p', `MCP workspace: ${result.actor.tenant}. Account: ${result.actor.subject}. Actor identity: ${result.actor.actorId}. Match these to the workspace you intend to connect.`));
      if (!available.length) { details.append(el('p', 'Choose “View approved templates” on your device above, then review this connection again.')); return; }
      const select = el('select');
      for (const t of available) { const option = el('option', `Template ${t.templateId}, revision ${t.templateRevision}, device ${t.deviceId}`); option.value = t.permissionId; select.append(option); }
      const runs = el('input'); runs.type = 'number'; runs.min = '1'; runs.max = '20'; runs.value = '1'; runs.required = true;
      const minutes = el('input'); minutes.type = 'number'; minutes.min = '1'; minutes.max = '1440'; minutes.value = '30'; minutes.required = true;
      const ack = el('input'); ack.type = 'checkbox';
      const approve = el('button', 'Approve this connection'); approve.type = 'button';
      details.append(field('Approved template', select), field('Maximum requests (1–20)', runs), field('Connection duration in minutes', minutes), field('I checked the MCP identity, template, limit and expiry.', ack), approve);
      approve.onclick = () => {
        const chosen = available.find(t => t.permissionId === select.value), pending = review;
        if (!ack.checked || !chosen || !pending || !runs.checkValidity() || !minutes.checkValidity()) return;
        const maxRuns = Number(runs.value), expiresAt = Math.min(Date.now() + Number(minutes.value) * 60000, chosen.expiresAt);
        if (maxRuns > chosen.maxRuns - chosen.submittedRuns || pending.requestExpiresAt <= Date.now()) { notice.textContent = 'Choose a limit within the remaining template allowance, or review an unexpired request.'; return; }
        perform(async validApproval => {
          clearReview();
          await api('/browser/mcp/approve', { id: pending.id, approvalCode: pending.approvalCode, permissionId: chosen.permissionId, expectedTemplateRevision: chosen.templateRevision, maxRuns, expiresAt, confirmed: true });
          if (validApproval()) notice.textContent = `Approved. Return to MCP and confirm this AI owner ID: ${context().ownerId}. Request: ${pending.id}.`;
        });
      };
    });
  };
  refresh.onclick = () => perform(async valid => { const result = await api('/browser/mcp/grants', {}); if (valid()) { grants = result.items; renderGrants(); } });
  function conceal() { epoch++; clearReview(); }
  window.addEventListener('blur', conceal);
  document.addEventListener('visibilitychange', () => { if (document.hidden) conceal(); });
  return { sync() {
    const next = context() ? JSON.stringify(context()) : '';
    if (scope !== next) { scope = next; epoch++; clearReview(); grants = []; history.replaceChildren(); notice.textContent = ''; }
    root.hidden = !next;
  } };
}
