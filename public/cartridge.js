const $ = (selector) => document.querySelector(selector);
const message = (value, error = false) => {
  const node = $('#deck-message'); node.textContent = value;
  node.classList.toggle('error', error);
};
const validToken = (value) => /^0x[0-9a-fA-F]{40}$/.test(value) && BigInt(value) !== 0n;

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: options.body ?
    { 'content-type': 'application/json' } : undefined });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}
async function refresh() {
  const status = await api('/api/cartridge/status');
  $('#deck-active').textContent = status.active ? '已载入学习特质' : '默认本地大脑';
  $('#deck-active-id').textContent = status.active?.cardId || '尚未安装卡带';
  $('#deck-runtime').textContent = status.simulation === 'running' ? '运行中' : '已暂停 / 未启动';
  $('#deck-token').textContent = status.active?.tokenAddress || '设备环境尚未绑定';
  $('#deck-contract').textContent = status.contract;
  $('#deck-export').disabled = status.busy || status.simulation === 'running';
  $('#deck-import-file').disabled = status.busy || status.simulation === 'running';
  $('#deck-import-chain').disabled = status.busy || status.simulation === 'running';
  if (status.active?.tokenAddress && !$('#deck-token-input').value) {
    $('#deck-token-input').value = status.active.tokenAddress;
  }
  const latest = status.lastExport;
  $('#deck-export-result').hidden = !latest;
  if (latest) {
    $('#deck-export-id').textContent = latest.cardId;
    $('#deck-download-manifest').href = `/api/cartridge/export/${latest.id}/cartridge.json`;
    $('#deck-download-state').href = `/api/cartridge/export/${latest.id}/state.bin`;
  }
  return status;
}
function tokenAddress() {
  const value = $('#deck-token-input').value.trim();
  if (!validToken(value)) throw new Error('请填写本次设备运行的有效 BSC 代币地址');
  return value;
}
function toBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
async function withBusy(button, label, action) {
  const old = button.textContent; button.disabled = true; button.textContent = label;
  message(label);
  try { await action(); await refresh(); }
  catch (error) { message(error.message || String(error), true); }
  finally { button.textContent = old; button.disabled = false; }
}

$('#deck-import-file').addEventListener('click', () => withBusy(
  $('#deck-import-file'), '正在验证并安装…', async () => {
    const files = [...$('#deck-files').files];
    if (files.length !== 2 || files.filter((f) => f.name === 'cartridge.json').length !== 1 ||
        files.filter((f) => f.name === 'state.bin').length !== 1) {
      throw new Error('请同时选择 cartridge.json 和 state.bin');
    }
    const manifest = files.find((f) => f.name === 'cartridge.json');
    const state = files.find((f) => f.name === 'state.bin');
    if (manifest.size > 16_384 || manifest.size + state.size > 120_000) {
      throw new Error('卡带超过 v3 一笔发布长度限制');
    }
    const [m, s] = await Promise.all([manifest.arrayBuffer(), state.arrayBuffer()]);
    const result = await api('/api/cartridge/import-file', { method: 'POST', body: JSON.stringify({
      tokenAddress: tokenAddress(), manifest: toBase64(new Uint8Array(m)),
      state: toBase64(new Uint8Array(s)),
    }) });
    message(`导入成功：${result.cardId}。请返回运行台，用已绑定代币地址启动。`);
  }));

$('#deck-import-chain').addEventListener('click', () => withBusy(
  $('#deck-import-chain'), '正在链上取回并验证…', async () => {
    const cardId = $('#deck-card-id').value.trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(cardId)) throw new Error('Card ID 格式无效');
    const result = await api('/api/cartridge/import-chain', { method: 'POST',
      body: JSON.stringify({ cardId, tokenAddress: tokenAddress() }) });
    message(`链上卡带导入成功：${result.cardId}。请返回运行台启动。`);
  }));

$('#deck-pause').addEventListener('click', () => withBusy(
  $('#deck-pause'), '正在暂停…', async () => {
    await api('/api/simulation/stop', { method: 'POST' });
    message('运行时已暂停。现在可以导入新卡带或导出当前特质。');
  }));

$('#deck-export').addEventListener('click', () => withBusy(
  $('#deck-export'), '正在保存并导出…', async () => {
    const result = await api('/api/cartridge/export', { method: 'POST' });
    message(`导出完成：${result.cardId}。请下载两份文件并在发布前核对。`);
  }));

refresh().catch((error) => message(`卡带游戏机状态读取失败：${error.message}`, true));
