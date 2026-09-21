const $ = (selector) => document.querySelector(selector);
let prepared = null;
function message(value, error = false) {
  const node = $('#registry-message'); node.textContent = value;
  node.classList.toggle('error', error);
}
async function api(path, options = {}) {
  const response = await fetch(path, { ...options,
    headers: options.body ? { 'content-type': 'application/json' } : undefined });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}
const short = (value) => value ? `${value.slice(0, 10)}…${value.slice(-8)}` : '—';
async function refresh() {
  message('正在读取钱包、RPC 和卡带状态…');
  const status = await api('/api/registry-v4/status');
  $('#registry-wallet').textContent = status.wallet.exists ? short(status.wallet.address) : '未创建';
  const selected = status.networks[$('#registry-network').value];
  $('#registry-balance').textContent = selected.rpcReady
    ? `${selected.balanceBnb || '0'} BNB · ${selected.name}` : `RPC 不可用：${selected.error}`;
  $('#registry-artifact').textContent = `SHA-256 ${short(status.artifact.artifactSha256)}`;
  if (status.candidate?.cardId) {
    $('#registry-candidate').textContent = short(status.candidate.cardId);
    $('#registry-candidate-size').textContent = `${status.candidate.manifestBytes.toLocaleString()} + ${status.candidate.stateBytes.toLocaleString()} bytes`;
  } else {
    $('#registry-candidate').textContent = '尚无 v4 导出';
    $('#registry-candidate-size').textContent = status.candidate?.error || '请先在卡带游戏机导出';
  }
  const deployment = selected.deployment;
  message(deployment?.address
    ? `${selected.name} 已登记 ${deployment.address}${selected.verified ? '，字节码核验通过。' : '，但当前核验失败。'}`
    : `${selected.name} 尚未部署 Registry V4。`);
  return status;
}
function updateExecuteState() {
  $('#registry-execute').disabled = !prepared || !$('#registry-final-consent').checked ||
    $('#registry-phrase').value !== prepared.confirmationPhrase ||
    $('#registry-password').value.length < 12;
}
$('#registry-network').addEventListener('change', () => {
  prepared = null; $('#registry-preview').hidden = true;
  refresh().catch((error) => message(error.message, true));
});
$('#registry-mode').addEventListener('change', () => {
  prepared = null; $('#registry-preview').hidden = true;
});
$('#registry-refresh').addEventListener('click', () => refresh().catch((error) => message(error.message, true)));
$('#registry-prepare').addEventListener('click', async () => {
  const button = $('#registry-prepare'); button.disabled = true;
  message('正在核对链、余额、nonce、固定字节码和 Gas…');
  try {
    prepared = await api('/api/registry-v4/prepare', { method: 'POST',
      body: JSON.stringify({ network: $('#registry-network').value, mode: $('#registry-mode').value }) });
    $('#preview-chain').textContent = `${prepared.network} / ${prepared.chainId}`;
    $('#preview-address').textContent = prepared.expectedAddress;
    $('#preview-artifact').textContent = prepared.artifactSha256;
    $('#preview-runtime').textContent = prepared.runtimeBytecodeSha256;
    $('#preview-constructor').textContent = JSON.stringify(prepared.constructorArgs);
    $('#preview-gas').textContent = `${Number(prepared.maximumGas).toLocaleString()} gas`;
    $('#preview-cost').textContent = `最多约 ${prepared.maximumCostBnb} BNB（按当前 gasPrice）`;
    $('#preview-card').textContent = prepared.candidate?.cardId || '不发布卡带';
    $('#preview-expiry').textContent = new Date(prepared.expiresAt).toLocaleString();
    $('#preview-rollback').textContent = prepared.rollback;
    $('#registry-required-phrase').textContent = prepared.confirmationPhrase;
    $('#registry-password').value = ''; $('#registry-phrase').value = '';
    $('#registry-final-consent').checked = false; $('#registry-preview').hidden = false;
    updateExecuteState(); message('预览已冻结五分钟。核对全部字段后输入密码和确认短语。');
  } catch (error) {
    prepared = null; $('#registry-preview').hidden = true; message(error.message, true);
  } finally { button.disabled = false; }
});
for (const selector of ['#registry-password', '#registry-phrase', '#registry-final-consent']) {
  $(selector).addEventListener('input', updateExecuteState);
  $(selector).addEventListener('change', updateExecuteState);
}
$('#registry-execute').addEventListener('click', async () => {
  if (!prepared) return;
  const button = $('#registry-execute'); button.disabled = true;
  message('正在签名、等待确认并执行链上回读；请不要关闭窗口…');
  try {
    const result = await api('/api/registry-v4/execute', { method: 'POST', body: JSON.stringify({
      authorizationId: prepared.authorizationId, password: $('#registry-password').value,
      confirmationPhrase: $('#registry-phrase').value }) });
    $('#registry-password').value = ''; $('#registry-phrase').value = '';
    $('#registry-final-consent').checked = false; $('#registry-result').hidden = false;
    $('#registry-result-summary').textContent = result.publicationTx
      ? `合约登记完成，Card ${result.cardId} 已发布、逐字节回读并完成新鲜安装验证。`
      : 'Registry V4 合约部署并完成精确运行字节码核验。';
    for (const [selector, url] of [['#registry-address-link', result.addressUrl],
      ['#registry-deploy-link', result.deploymentTxUrl], ['#registry-publish-link', result.publicationTxUrl]]) {
      const node = $(selector); node.hidden = !url; if (url) node.href = url;
    }
    prepared = null; message('Registry V4 链上操作与验证已完成。'); await refresh();
  } catch (error) { message(error.message, true); }
  finally { updateExecuteState(); }
});
refresh().catch((error) => message(`Registry V4 状态读取失败：${error.message}`, true));
