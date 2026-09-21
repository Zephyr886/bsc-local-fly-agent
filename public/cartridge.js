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
function tokenAddress({ optional = false } = {}) {
  const value = $('#deck-token-input').value.trim();
  if (optional && !value) return null;
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
    const [m, s] = await Promise.all([manifest.arrayBuffer(), state.arrayBuffer()]);
    let header;
    try { header = JSON.parse(new TextDecoder().decode(m)); }
    catch { throw new Error('cartridge.json 不是有效 JSON'); }
    if (header.format !== 'fly-cartridge' || ![3, 4].includes(header.formatVersion)) {
      throw new Error('仅支持 Fly Cartridge v3 或 v4');
    }
    if (header.formatVersion === 3 &&
        (manifest.size > 16_384 || manifest.size + state.size > 120_000)) {
      throw new Error('卡带超过 v3 一笔发布长度限制');
    }
    if (header.formatVersion === 4 && (manifest.size > 32_768 || state.size > 262_144)) {
      throw new Error('v4 本地卡带超过 32KB manifest 或 256KB state 限制');
    }
    const result = await api('/api/cartridge/import-file', { method: 'POST', body: JSON.stringify({
      tokenAddress: tokenAddress({ optional: header.formatVersion === 4 }),
      manifest: toBase64(new Uint8Array(m)),
      state: toBase64(new Uint8Array(s)),
    }) });
    message(`导入成功：${result.cardId}，已创建并激活果蝇 ${result.flyId}。`);
  }));

$('#deck-import-chain').addEventListener('click', () => withBusy(
  $('#deck-import-chain'), '正在链上取回并验证…', async () => {
    const cardId = $('#deck-card-id').value.trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(cardId)) throw new Error('Card ID 格式无效');
    const result = await api('/api/cartridge/import-chain', { method: 'POST',
      body: JSON.stringify({ cardId, tokenAddress: tokenAddress() }) });
    message(`链上 v3 卡带导入成功：${result.cardId}，已包装为新果蝇 ${result.flyId}。`);
  }));

$('#deck-pause').addEventListener('click', () => withBusy(
  $('#deck-pause'), '正在暂停…', async () => {
    await api('/api/simulation/stop', { method: 'POST' });
    message('运行时已暂停。现在可以导入新卡带或导出当前特质。');
  }));

$('#deck-export').addEventListener('click', () => withBusy(
  $('#deck-export'), '正在保存并导出…', async () => {
    const result = await api('/api/cartridge/export', { method: 'POST' });
    const publishable = result.publishability?.publishableToRegistryV3 ? '可发布' : '当前不可直接发布到 Registry V3';
    message(`v4 导出完成：${result.cardId}；${publishable}。`);
  }));

refresh().catch((error) => message(`卡带游戏机状态读取失败：${error.message}`, true));
