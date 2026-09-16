import * as THREE from "/vendor/three.module.js";

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const $ = (selector) => document.querySelector(selector);
let motorReleaseTimer = null;

const visualState = {
  action: "HOLD",
  membrane: 0,
  arousal: 0,
  kcRatio: 0,
  apl: 0,
  dopamine: 0,
  activity: 0,
  running: false,
  pulseAt: 0,
  pressAt: 0,
  pressAction: "HOLD",
  decisionAt: null,
  candles: [],
  price: null,
  symbol: "TOKEN",
  chartRevision: 0,
  revision: 0,
};

function xorshift(seed = 0x51f15e) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return (state >>> 0) / 0xffffffff;
  };
}

function rendererFor(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  return renderer;
}

function syncRenderer(renderer, camera, canvas) {
  const width = Math.max(1, canvas.clientWidth);
  const height = Math.max(1, canvas.clientHeight);
  const pixelRatio = renderer.getPixelRatio();
  if (canvas.width !== Math.floor(width * pixelRatio) || canvas.height !== Math.floor(height * pixelRatio)) {
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }
}

function tube(from, to, radius, material) {
  const start = new THREE.Vector3(...from);
  const end = new THREE.Vector3(...to);
  const direction = end.clone().sub(start);
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius * .82, direction.length(), 10), material);
  mesh.position.copy(start).add(end).multiplyScalar(.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
  return mesh;
}

function ellipsoid(scale, position, material, segments = 34) {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, segments, Math.round(segments * .72)), material);
  mesh.scale.set(...scale);
  mesh.position.set(...position);
  return mesh;
}

function makeWing(side, material, veinMaterial) {
  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  shape.bezierCurveTo(side * 1.25, .2, side * 2.35, 1.25, side * 2.7, 2.25);
  shape.bezierCurveTo(side * 1.55, 2.8, side * .55, 2.1, 0, 0);
  const wing = new THREE.Group();
  const membrane = new THREE.Mesh(new THREE.ShapeGeometry(shape, 36), material);
  membrane.rotation.x = -Math.PI / 2.9;
  wing.add(membrane);
  for (const factor of [.32, .58, .8]) {
    const vein = tube([0, 0, .01], [side * 2.34 * factor, 1.88 * factor, .01], .014, veinMaterial);
    vein.rotation.x = -Math.PI / 2.9;
    wing.add(vein);
  }
  wing.position.set(side * .28, .45, .15);
  return wing;
}

function addSurfaceParticles(group, random, color) {
  const positions = [];
  const colors = [];
  const tint = new THREE.Color(color);
  const lobes = [
    { c: [0, .18, .12], s: [.78, .62, .95], n: 580 },
    { c: [0, -.08, 1.28], s: [.63, .52, 1.12], n: 520 },
    { c: [0, .2, -1.0], s: [.64, .54, .6], n: 340 },
  ];
  for (const lobe of lobes) {
    for (let index = 0; index < lobe.n; index += 1) {
      const theta = random() * Math.PI * 2;
      const phi = Math.acos(2 * random() - 1);
      const radius = .84 + random() * .18;
      positions.push(
        lobe.c[0] + Math.sin(phi) * Math.cos(theta) * lobe.s[0] * radius,
        lobe.c[1] + Math.cos(phi) * lobe.s[1] * radius,
        lobe.c[2] + Math.sin(phi) * Math.sin(theta) * lobe.s[2] * radius,
      );
      const gain = .65 + random() * .45;
      colors.push(tint.r * gain, tint.g * gain, tint.b * gain);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  const material = new THREE.PointsMaterial({ size: .035, vertexColors: true, transparent: true, opacity: .72, blending: THREE.AdditiveBlending, depthWrite: false });
  group.add(new THREE.Points(geometry, material));
}

function displayPrice(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  if (number >= 1) return number.toLocaleString("zh-CN", { maximumFractionDigits: 6 });
  if (number >= .001) return number.toFixed(8).replace(/0+$/, "");
  return number.toExponential(7);
}

function chartSummary(candles, currentPrice) {
  if (!candles.length) return "K 线正在等待行情数据";
  const first = Number(candles[0].open);
  const last = Number(candles.at(-1).close);
  const change = first ? (last / first - 1) * 100 : 0;
  return `最近 ${candles.length} 根 5 秒 K，现价 ${displayPrice(currentPrice ?? last)}，区间${change >= 0 ? "上涨" : "下跌"} ${Math.abs(change).toFixed(2)}%`;
}

function paintChart(context, canvas, candles, currentPrice, symbol) {
  const width = canvas.width, height = canvas.height;
  const visible = candles.slice(-36);
  const left = 62, right = 142, top = 112, bottom = 52;
  const chartWidth = width - left - right, chartHeight = height - top - bottom;
  const gradient = context.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, "#071215"); gradient.addColorStop(1, "#020607");
  context.fillStyle = gradient; context.fillRect(0, 0, width, height);
  context.fillStyle = "rgba(175,221,255,.04)"; context.fillRect(0, 0, width, 82);
  context.strokeStyle = "rgba(175,221,255,.13)"; context.beginPath(); context.moveTo(0, 82.5); context.lineTo(width, 82.5); context.stroke();
  context.fillStyle = "#dceef7"; context.font = "600 27px ui-monospace,Consolas,monospace"; context.fillText(`${symbol || "TOKEN"} / BNB`, 30, 48);
  context.fillStyle = "rgba(220,238,247,.42)"; context.font = "500 16px ui-monospace,Consolas,monospace"; context.fillText("5 SECOND · OHLC", 30, 70);
  if (!visible.length) {
    context.textAlign = "center"; context.fillStyle = "rgba(175,221,255,.4)"; context.font = "600 22px ui-monospace,Consolas,monospace";
    context.fillText("AWAITING MARKET DATA", width / 2, height / 2); context.textAlign = "start"; return;
  }
  const low = Math.min(...visible.map((item) => Number(item.low)));
  const high = Math.max(...visible.map((item) => Number(item.high)));
  const rawSpan = high - low || Math.abs(high) * .001 || 1;
  const paddedLow = low - rawSpan * .08, paddedHigh = high + rawSpan * .08, span = paddedHigh - paddedLow;
  const mapY = (value) => top + ((paddedHigh - Number(value)) / span) * chartHeight;
  const first = Number(visible[0].open), last = Number(visible.at(-1).close);
  const change = first ? (last / first - 1) * 100 : 0;
  const accent = change >= 0 ? "#31e6a1" : "#ff7a91";
  context.textAlign = "right"; context.fillStyle = "#eef7fa"; context.font = "600 29px ui-monospace,Consolas,monospace";
  context.fillText(displayPrice(currentPrice ?? last), width - 28, 46); context.fillStyle = accent; context.font = "600 17px ui-monospace,Consolas,monospace";
  context.fillText(`${change >= 0 ? "+" : ""}${change.toFixed(3)}%`, width - 28, 70); context.textAlign = "start";
  context.strokeStyle = "rgba(175,221,255,.09)"; context.fillStyle = "rgba(220,238,247,.34)"; context.lineWidth = 1; context.font = "400 14px ui-monospace,Consolas,monospace";
  for (let row = 0; row <= 5; row += 1) {
    const y = top + chartHeight / 5 * row + .5; context.beginPath(); context.moveTo(left, y); context.lineTo(left + chartWidth, y); context.stroke();
    context.fillText(displayPrice(paddedHigh - span / 5 * row), left + chartWidth + 14, y + 5);
  }
  for (let column = 0; column <= 8; column += 1) { const x = left + chartWidth / 8 * column + .5; context.beginPath(); context.moveTo(x, top); context.lineTo(x, top + chartHeight); context.stroke(); }
  const slot = chartWidth / visible.length, candleWidth = Math.max(5, slot * .58);
  visible.forEach((item, index) => {
    const x = left + slot * index + slot / 2, open = mapY(item.open), close = mapY(item.close);
    const color = Number(item.close) >= Number(item.open) ? "#31e6a1" : "#ff7a91";
    context.strokeStyle = color; context.fillStyle = color; context.lineWidth = 2; context.beginPath(); context.moveTo(x, mapY(item.high)); context.lineTo(x, mapY(item.low)); context.stroke();
    context.fillRect(x - candleWidth / 2, Math.min(open, close), candleWidth, Math.max(3, Math.abs(close - open)));
  });
  const activeY = mapY(currentPrice ?? last); context.setLineDash([8, 6]); context.strokeStyle = accent; context.beginPath(); context.moveTo(left, activeY); context.lineTo(left + chartWidth, activeY); context.stroke(); context.setLineDash([]);
  context.textAlign = "center"; context.fillStyle = "rgba(175,221,255,.07)"; context.font = "700 52px ui-monospace,Consolas,monospace"; context.fillText("FLAP PULSE", left + chartWidth / 2, top + chartHeight / 2 + 18); context.textAlign = "start";
}

function createFlyScene(canvas) {
  const renderer = rendererFor(canvas);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x020708);
  scene.fog = new THREE.FogExp2(0x020708, .042);
  const camera = new THREE.PerspectiveCamera(33, 1, .1, 60);
  const cameraTarget = new THREE.Vector3(0, .12, .38);
  const view = { yaw: 3.02, pitch: .02, zoom: 1, desiredYaw: 3.02, desiredPitch: .02, desiredZoom: 1 };
  const random = xorshift(0xf17a9);

  scene.add(new THREE.HemisphereLight(0xd8f6ff, 0x06100c, 1.75));
  const key = new THREE.DirectionalLight(0xe2f5ff, 4.2); key.position.set(-4, 7, 5); scene.add(key);
  const rim = new THREE.PointLight(0x35e6a7, 17, 15, 2); rim.position.set(4, 2, 2); scene.add(rim);
  const warm = new THREE.PointLight(0xff7b5f, 10, 9, 2); warm.position.set(-3, 1, -3); scene.add(warm);

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(22, 17), new THREE.MeshStandardMaterial({ color: 0x071012, roughness: .86, metalness: .2 }));
  floor.rotation.x = -Math.PI / 2; floor.position.y = -1.48; floor.receiveShadow = true; scene.add(floor);
  const grid = new THREE.GridHelper(20, 40, 0x294840, 0x102621); grid.position.y = -1.46; scene.add(grid);

  const chartCanvas = document.createElement("canvas");
  chartCanvas.width = 1024; chartCanvas.height = 512;
  const chartContext = chartCanvas.getContext("2d");
  const chartTexture = new THREE.CanvasTexture(chartCanvas);
  chartTexture.colorSpace = THREE.SRGBColorSpace;
  chartTexture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  let paintedChartRevision = -1;
  const monitor = new THREE.Group(); monitor.position.set(0, 2.05, 3.05);
  const monitorShell = new THREE.Mesh(new THREE.BoxGeometry(6.25, 3.32, .32), new THREE.MeshStandardMaterial({ color: 0x091316, roughness: .3, metalness: .7 }));
  monitorShell.castShadow = true; monitor.add(monitorShell);
  const bezel = new THREE.Mesh(new THREE.BoxGeometry(5.88, 2.96, .12), new THREE.MeshStandardMaterial({ color: 0x1a2b31, roughness: .3, metalness: .68 })); bezel.position.z = -.19; monitor.add(bezel);
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(5.56, 2.66), new THREE.MeshBasicMaterial({ map: chartTexture, toneMapped: false, side: THREE.DoubleSide })); screen.position.z = -.26; screen.rotation.y = Math.PI; monitor.add(screen);
  const stand = new THREE.Mesh(new THREE.BoxGeometry(.42, 1.12, .42), new THREE.MeshStandardMaterial({ color: 0x152328, roughness: .36, metalness: .7 })); stand.position.set(0, -2.15, 0); monitor.add(stand);
  const standFoot = new THREE.Mesh(new THREE.BoxGeometry(2.2, .18, 1), new THREE.MeshStandardMaterial({ color: 0x101d21, roughness: .38, metalness: .68 })); standFoot.position.set(0, -2.76, -.04); monitor.add(standFoot);
  scene.add(monitor);
  const screenGlow = new THREE.PointLight(0x78d8ff, 8, 12, 2); screenGlow.position.set(0, 1.9, .9); scene.add(screenGlow);

  const fly = new THREE.Group();
  // Head is model -Z. Turn it toward the monitor (+Z), so the computer is
  // physically in front of the fly and the camera sees the abdomen from rear.
  fly.rotation.y = Math.PI - .1;
  scene.add(fly);
  const bodyMaterial = new THREE.MeshPhysicalMaterial({ color: 0x4f291d, roughness: .55, metalness: .1, clearcoat: .28, emissive: 0x120905, emissiveIntensity: .5 });
  const abdomenMaterial = new THREE.MeshPhysicalMaterial({ color: 0x68472a, roughness: .62, metalness: .08, clearcoat: .2, emissive: 0x140c05, emissiveIntensity: .35 });
  const headMaterial = new THREE.MeshPhysicalMaterial({ color: 0x5a3626, roughness: .5, clearcoat: .45, emissive: 0x140806, emissiveIntensity: .4 });
  const jointMaterial = new THREE.MeshStandardMaterial({ color: 0x281914, roughness: .85 });
  const eyeMaterial = new THREE.MeshPhysicalMaterial({ color: 0xc83d39, emissive: 0x6a120f, emissiveIntensity: 1.4, roughness: .23, clearcoat: .92 });
  const wingMaterial = new THREE.MeshPhysicalMaterial({ color: 0xa7d9d3, transparent: true, opacity: .27, transmission: .55, roughness: .18, metalness: .04, side: THREE.DoubleSide, depthWrite: false });
  const veinMaterial = new THREE.MeshStandardMaterial({ color: 0x53736c, transparent: true, opacity: .7, roughness: .7 });

  fly.add(ellipsoid([.78, .62, .92], [0, .1, .02], bodyMaterial, 48));
  fly.add(ellipsoid([.58, .49, 1.22], [0, -.04, 1.34], abdomenMaterial, 46));
  fly.add(ellipsoid([.63, .54, .58], [0, .2, -1.02], headMaterial, 46));
  for (const side of [-1, 1]) {
    const eye = ellipsoid([.29, .38, .24], [side * .5, .26, -1.2], eyeMaterial, 28); eye.rotation.z = side * .18; fly.add(eye);
  }
  const leftWing = makeWing(-1, wingMaterial, veinMaterial);
  const rightWing = makeWing(1, wingMaterial, veinMaterial);
  fly.add(leftWing, rightWing);

  const legRoots = [[-.5, -.2, -.65], [-.61, -.33, .05], [-.5, -.35, .62], [.5, -.2, -.65], [.61, -.33, .05], [.5, -.35, .62]];
  legRoots.forEach((root, index) => {
    const side = root[0] < 0 ? -1 : 1;
    const pair = index % 3;
    const knee = [side * (1.05 + pair * .11), -.82, root[2] + (pair - 1) * .28];
    const ankle = [side * (1.62 + pair * .1), -1.25, root[2] + (pair - 1) * .55];
    const foot = [side * (2.02 + pair * .08), -1.38, root[2] + (pair - 1) * .72];
    fly.add(tube(root, knee, .038, jointMaterial), tube(knee, ankle, .027, jointMaterial), tube(ankle, foot, .012, jointMaterial));
  });
  for (const side of [-1, 1]) {
    fly.add(tube([side * .16, .38, -1.45], [side * .3, .58, -1.68], .02, jointMaterial));
    fly.add(tube([side * .3, .58, -1.68], [side * .55, .83, -1.92], .006, jointMaterial));
  }
  addSurfaceParticles(fly, random, 0xffb67a);

  function makeTextTexture(label, color) {
    const canvas = document.createElement("canvas"); canvas.width = 512; canvas.height = 170;
    const context = canvas.getContext("2d"); context.fillStyle = color; context.font = "800 104px ui-monospace,Consolas,monospace"; context.textAlign = "center"; context.fillText(label, 256, 108);
    context.fillStyle = "rgba(0,0,0,.52)"; context.font = "700 23px ui-monospace,Consolas,monospace"; context.fillText(label === "BUY" ? "LEFT MOTOR" : "RIGHT MOTOR", 256, 150);
    const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace; return texture;
  }
  function makeMotorButton(action, x, color, labelColor) {
    const group = new THREE.Group(); group.position.set(x, -1.18, 1.3);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(.83, .94, .31, 48), new THREE.MeshStandardMaterial({ color: action === "BUY" ? 0x082d21 : 0x31101b, roughness: .28, metalness: .58 })); base.castShadow = true; group.add(base);
    const material = new THREE.MeshPhysicalMaterial({ color, emissive: color, emissiveIntensity: .42, roughness: .22, metalness: .2, clearcoat: .8 });
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(.72, .78, .22, 48), material); cap.position.y = .25; cap.castShadow = true; group.add(cap);
    const label = new THREE.Mesh(new THREE.PlaneGeometry(1.25, .42), new THREE.MeshBasicMaterial({ map: makeTextTexture(action, labelColor), transparent: true, toneMapped: false })); label.rotation.x = -Math.PI / 2; label.rotation.z = Math.PI; label.position.y = .37; group.add(label);
    scene.add(group); return { group, cap, label, material };
  }
  const buyButton = makeMotorButton("BUY", 2.02, 0x31e6a1, "#03110b");
  const burnButton = makeMotorButton("BURN", -2.02, 0xff6686, "#19040a");

  const orbitRing = new THREE.Mesh(new THREE.TorusGeometry(2.8, .012, 6, 160), new THREE.MeshBasicMaterial({ color: 0x31564e, transparent: true, opacity: .58 }));
  orbitRing.rotation.x = Math.PI / 2; orbitRing.position.y = -.04; scene.add(orbitRing);
  const scanRing = new THREE.Mesh(new THREE.TorusGeometry(1.75, .02, 8, 120), new THREE.MeshBasicMaterial({ color: 0xb8f25b, transparent: true, opacity: .72 }));
  scanRing.rotation.x = Math.PI / 2; scene.add(scanRing);

  function reset() { view.desiredYaw = 3.02; view.desiredPitch = .02; view.desiredZoom = 1; }
  function side() { view.desiredYaw = Math.PI / 2; view.desiredPitch = .02; view.desiredZoom = 1.05; }
  setupOrbit(canvas, view, reset);

  function render(time) {
    if (paintedChartRevision !== visualState.chartRevision && chartContext) {
      paintChart(chartContext, chartCanvas, visualState.candles, visualState.price, visualState.symbol);
      chartTexture.needsUpdate = true; paintedChartRevision = visualState.chartRevision;
    }
    syncRenderer(renderer, camera, canvas);
    view.yaw += (view.desiredYaw - view.yaw) * .09;
    view.pitch += (view.desiredPitch - view.pitch) * .09;
    view.zoom += (view.desiredZoom - view.zoom) * .1;
    const radius = 11.4 * view.zoom;
    camera.position.set(Math.sin(view.yaw) * radius, 3.65 + view.pitch * 5, Math.cos(view.yaw) * radius);
    camera.lookAt(cameraTarget);
    const calm = reducedMotion.matches ? 0 : 1;
    fly.position.y = -.02 + Math.sin(time * .0014) * .035 * calm;
    const wingSpeed = 2 + visualState.arousal * 13 + (visualState.action === "HOLD" ? 0 : 7);
    const wingBeat = Math.sin(time * .001 * wingSpeed) * (.045 + visualState.arousal * .08) * calm;
    leftWing.rotation.z = -.08 - wingBeat; rightWing.rotation.z = .08 + wingBeat;
    fly.rotation.z += ((visualState.action === "BUY" ? -.08 : visualState.action === "BURN" ? .08 : 0) - fly.rotation.z) * .07;
    eyeMaterial.emissive.setHex(visualState.action === "BUY" ? 0x087b70 : visualState.action === "BURN" ? 0x9a251d : 0x6a120f);
    eyeMaterial.emissiveIntensity = 1.15 + visualState.arousal * 2.2;
    const pressAge = time - visualState.pressAt;
    const pressingBuy = visualState.pressAction === "BUY" && pressAge >= 0 && pressAge < 1050;
    const pressingBurn = visualState.pressAction === "BURN" && pressAge >= 0 && pressAge < 1050;
    const pressEase = (pressed) => pressed ? Math.sin(Math.min(1, pressAge / 300) * Math.PI / 2) : 0;
    buyButton.cap.position.y += ((.25 - pressEase(pressingBuy) * .15) - buyButton.cap.position.y) * .22;
    buyButton.label.position.y = buyButton.cap.position.y + .12;
    burnButton.cap.position.y += ((.25 - pressEase(pressingBurn) * .15) - burnButton.cap.position.y) * .22;
    burnButton.label.position.y = burnButton.cap.position.y + .12;
    buyButton.material.emissiveIntensity = pressingBuy ? 2.4 : .42;
    burnButton.material.emissiveIntensity = pressingBurn ? 2.4 : .42;
    scanRing.scale.setScalar(1 + ((time * .00035) % 1) * .8);
    scanRing.material.opacity = .55 * (1 - ((time * .00035) % 1));
    orbitRing.rotation.z = time * .00008 * calm;
    renderer.render(scene, camera);
  }

  return { render, reset, side, dispose: () => renderer.dispose() };
}

const MALECNS_PALETTE = {
  optic: [58, 160, 222],
  central: [176, 112, 255],
  sensory: [44, 186, 172],
  visual_projection: [112, 128, 248],
  descending: [255, 154, 92],
  ascending: [240, 190, 96],
  visual_centrifugal: [239, 122, 208],
  motor: [255, 109, 99],
  endocrine: [201, 234, 107],
  sensory_ascending: [233, 251, 255],
};
const MALECNS_FALLBACK = [[120, 200, 180], [200, 160, 240], [255, 190, 120], [130, 200, 255]];

function canonicalCellClass(name) {
  if (name === "ENS") return "sensory";
  if (name === "ascending_neuron" || name === "efferent_ascending") return "ascending";
  if (["descending_neuron", "descending_neuron_tbc", "efferent_descending", "sensory_descending"].includes(name)) return "descending";
  if (name === "sensory_ascending" || name === "sensory_ascending_tbc") return "sensory_ascending";
  if (name === "ol_intrinsic") return "optic";
  if (name === "ol_sensory") return "sensory";
  if (["cb_intrinsic", "vnc_intrinsic", "vnc_tbc"].includes(name)) return "central";
  if (name === "cb_endocrine" || name === "vnc_endocrine") return "endocrine";
  if (name === "cb_motor" || name === "vnc_motor") return "motor";
  if (name === "cb_efferent" || name === "vnc_efferent") return "descending";
  if (name.startsWith("cb_sensory") || name.startsWith("vnc_sensory")) return "sensory";
  if (name === "visual_projection_tbc") return "visual_projection";
  return name;
}

async function loadMaleCnsCloud() {
  const response = await fetch("/malecns-points.json", { cache: "force-cache" });
  if (!response.ok) throw new Error(`MaleCNS 点云加载失败（HTTP ${response.status}）`);
  const json = await response.json();
  const stride = Number(json.stride) || 4;
  const count = Math.floor(json.points.length / stride);
  const x = new Float32Array(count), y = new Float32Array(count), z = new Float32Array(count), cls = new Uint8Array(count);
  const extent = [0, 0, 0];
  const rawClasses = json.meta?.classes?.length ? json.meta.classes : ["central"];
  const rawCanonical = rawClasses.map(canonicalCellClass);
  const classNames = [...new Set(rawCanonical)];
  const classIndex = new Map(classNames.map((name, index) => [name, index]));
  const groups = Array.from({ length: classNames.length }, () => []);
  for (let index = 0; index < count; index += 1) {
    const offset = index * stride;
    const px = Number(json.points[offset]), py = Number(json.points[offset + 1]), pz = Number(json.points[offset + 2]);
    const rawIndex = clamp(Number(json.points[offset + 3]) || 0, 0, rawCanonical.length - 1);
    const displayIndex = classIndex.get(rawCanonical[rawIndex]) ?? 0;
    x[index] = px; y[index] = py; z[index] = pz; cls[index] = displayIndex;
    groups[displayIndex].push(index);
    extent[0] = Math.max(extent[0], Math.abs(px));
    extent[1] = Math.max(extent[1], Math.abs(py));
    extent[2] = Math.max(extent[2], Math.abs(pz));
  }
  const buckets = groups.map((group) => Int32Array.from(group));
  const tints = classNames.map((name, index) => MALECNS_PALETTE[name] || MALECNS_FALLBACK[index % MALECNS_FALLBACK.length]);
  const biggest = buckets.reduce((largest, bucket) => Math.max(largest, bucket.length), 1);
  const gains = Float32Array.from(buckets.map((bucket) => clamp(Math.pow(biggest / Math.max(1, bucket.length), .22), 1, 2.4)));
  return { x, y, z, cls, buckets, tints, gains, count, extent, meta: json.meta };
}

function createBrainScene(canvas) {
  const context = canvas.getContext("2d", { alpha: false });
  const view = { yawOffset: 0, desiredYawOffset: 0, pitch: 0, desiredPitch: 0, zoom: 1, desiredZoom: 1 };
  let colorMode = "class";
  let cloud = null;
  let loadError = null;
  let disposed = false;
  let dragging = false;
  let pointerId = null;
  let lastX = 0;
  let lastY = 0;

  loadMaleCnsCloud().then((loaded) => {
    cloud = loaded;
    canvas.dataset.cloudState = "ready";
    canvas.dataset.pointCount = String(loaded.count);
  }).catch((error) => {
    loadError = error;
    canvas.dataset.cloudState = "error";
    console.error(error);
  });

  function reset() {
    view.desiredYawOffset = 0;
    view.desiredPitch = 0;
    view.desiredZoom = 1;
  }
  function setMode(mode) {
    colorMode = mode;
    updateButtonPair("#brain-mode-class", "#brain-mode-state", mode === "class");
  }
  canvas.addEventListener("pointerdown", (event) => {
    dragging = true; pointerId = event.pointerId; lastX = event.clientX; lastY = event.clientY;
    canvas.setPointerCapture(pointerId);
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!dragging || event.pointerId !== pointerId) return;
    view.desiredYawOffset += (event.clientX - lastX) * .006;
    view.desiredPitch = clamp(view.desiredPitch + (event.clientY - lastY) * .65, -130, 130);
    lastX = event.clientX; lastY = event.clientY;
  });
  const release = () => { dragging = false; pointerId = null; };
  canvas.addEventListener("pointerup", release);
  canvas.addEventListener("pointercancel", release);
  canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    view.desiredZoom = clamp(view.desiredZoom - event.deltaY * .0008, .72, 1.5);
  }, { passive: false });
  canvas.addEventListener("dblclick", reset);

  function syncCanvas() {
    const width = Math.max(1, canvas.clientWidth), height = Math.max(1, canvas.clientHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
    }
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { width, height };
  }

  function render(time) {
    if (disposed) return;
    const { width, height } = syncCanvas();
    context.globalCompositeOperation = "source-over";
    const backdrop = context.createRadialGradient(width * .5, height * .38, 0, width * .5, height * .48, Math.max(width, height) * .72);
    backdrop.addColorStop(0, "#071510"); backdrop.addColorStop(.55, "#04100d"); backdrop.addColorStop(1, "#020708");
    context.fillStyle = backdrop; context.fillRect(0, 0, width, height);
    if (!cloud) {
      context.fillStyle = loadError ? "#ff7a91" : "rgba(220,238,247,.55)";
      context.font = "600 12px ui-monospace,Consolas,monospace";
      context.textAlign = "center";
      context.fillText(loadError ? loadError.message : "LOADING MALECNS V1.0 · 12,781 SOMA POINTS", width / 2, height / 2);
      context.textAlign = "start";
      return;
    }

    view.yawOffset += (view.desiredYawOffset - view.yawOffset) * .08;
    view.pitch += (view.desiredPitch - view.pitch) * .08;
    view.zoom += (view.desiredZoom - view.zoom) * .08;
    const spinHalfX = Math.hypot(cloud.extent[0], cloud.extent[1]) * 1.12;
    const halfZ = cloud.extent[2] * 1.12;
    const unit = Math.min((width - 48) / (spinHalfX * 2), (height - 48) / (halfZ * 2)) * view.zoom;
    const autoSpin = reducedMotion.matches ? .34 : Math.sin(time * .00011) * .42;
    const spin = autoSpin + view.yawOffset;
    const cos = Math.cos(spin), sin = Math.sin(spin);
    const cx = width / 2, cy = height / 2 + view.pitch;
    const dot = Math.max(1, unit * 3.2);
    const stateTint = visualState.action === "BUY" ? [49, 230, 161] : visualState.action === "BURN" ? [255, 122, 145] : [184, 242, 91];
    const activityGain = .82 + visualState.activity * .34;

    context.globalCompositeOperation = "lighter";
    const paintPoint = (index, tint, gain = 1) => {
      const mx = cloud.x[index] * cos - cloud.y[index] * sin;
      const depth = cloud.x[index] * sin + cloud.y[index] * cos;
      const near = 1 / (1 + depth / 2400);
      const sx = cx + mx * unit * near;
      const sy = cy - cloud.z[index] * unit * near;
      const size = dot * near;
      const depthAlpha = .2 + .34 * ((depth + 260) / 520);
      context.fillStyle = `rgb(${tint[0]} ${tint[1]} ${tint[2]})`;
      context.globalAlpha = clamp(depthAlpha * activityGain * gain, .05, .94);
      context.fillRect(sx - size / 2, sy - size / 2, size, size);
      return { sx, sy, near };
    };

    if (colorMode === "state") {
      for (let index = 0; index < cloud.count; index += 1) paintPoint(index, stateTint, 1);
    } else {
      for (let classIndex = 0; classIndex < cloud.buckets.length; classIndex += 1) {
        const bucket = cloud.buckets[classIndex];
        const tint = cloud.tints[classIndex];
        const gain = cloud.gains[classIndex] || 1;
        for (let offset = 0; offset < bucket.length; offset += 1) paintPoint(bucket[offset], tint, gain);
      }
    }

    const pulseAge = time - visualState.pulseAt;
    if (visualState.pulseAt && pulseAge >= 0 && pulseAge < 1450) {
      const wave = pulseAge / 1450;
      const alpha = Math.sin(wave * Math.PI);
      context.fillStyle = `rgb(${stateTint[0]} ${stateTint[1]} ${stateTint[2]})`;
      for (let index = 0; index < cloud.count; index += 29) {
        if (((index * 17) % 101) / 101 > alpha * .42) continue;
        const mx = cloud.x[index] * cos - cloud.y[index] * sin;
        const depth = cloud.x[index] * sin + cloud.y[index] * cos;
        const near = 1 / (1 + depth / 2400);
        const sx = cx + mx * unit * near, sy = cy - cloud.z[index] * unit * near;
        context.globalAlpha = .25 + alpha * .7;
        context.beginPath(); context.arc(sx, sy, dot * near * (1.2 + alpha * 2.2), 0, Math.PI * 2); context.fill();
      }
    }
    context.globalAlpha = 1;
    context.globalCompositeOperation = "source-over";
  }

  return { render, reset, setMode, dispose: () => { disposed = true; } };
}

function setupOrbit(canvas, view, reset) {
  let dragging = false;
  let pointerId = null;
  let lastX = 0;
  let lastY = 0;
  canvas.addEventListener("pointerdown", (event) => {
    dragging = true; pointerId = event.pointerId; lastX = event.clientX; lastY = event.clientY;
    canvas.setPointerCapture(pointerId);
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!dragging || event.pointerId !== pointerId) return;
    view.desiredYaw += (event.clientX - lastX) * .008;
    view.desiredPitch = clamp(view.desiredPitch + (event.clientY - lastY) * .005, -.55, .55);
    lastX = event.clientX; lastY = event.clientY;
  });
  const release = () => { dragging = false; pointerId = null; };
  canvas.addEventListener("pointerup", release); canvas.addEventListener("pointercancel", release);
  canvas.addEventListener("wheel", (event) => { event.preventDefault(); view.desiredZoom = clamp(view.desiredZoom + event.deltaY * .0008, .72, 1.45); }, { passive: false });
  canvas.addEventListener("dblclick", reset);
}

function updateButtonPair(firstSelector, secondSelector, firstActive) {
  const first = $(firstSelector), second = $(secondSelector);
  first.classList.toggle("active", firstActive); second.classList.toggle("active", !firstActive);
  first.setAttribute("aria-pressed", String(firstActive)); second.setAttribute("aria-pressed", String(!firstActive));
}

function applyRuntime(data) {
  const action = data?.latestDecision?.actions?.brain?.action || "HOLD";
  const normalized = action === "SELL" ? "BURN" : action;
  const motorEvent = data?.latestBrainMotorEvent || null;
  const decisionAt = motorEvent?.key || null;
  visualState.action = normalized;
  visualState.membrane = Number(data?.brain?.membrane || 0);
  visualState.arousal = clamp(Number(data?.brain?.arousal?.level || 0), 0, 1);
  visualState.kcRatio = clamp(Number(data?.brain?.kc?.activeCount || 0) / Math.max(1, Number(data?.brain?.kc?.count || 64)), 0, 1);
  visualState.apl = Number(data?.brain?.apl?.level || 0);
  visualState.dopamine = Number(data?.brain?.dopamine?.level || 0);
  visualState.activity = clamp(Number(data?.market?.activity || 0), 0, 1);
  visualState.running = data?.status === "running";
  visualState.candles = Array.isArray(data?.market?.candles) ? data.market.candles : [];
  visualState.price = Number.isFinite(Number(data?.market?.price)) ? Number(data.market.price) : null;
  visualState.symbol = data?.token?.symbol || "TOKEN";
  visualState.chartRevision += 1;
  visualState.revision += 1;
  const eventAction = motorEvent?.action === "SELL" ? "BURN" : motorEvent?.action;
  const isNewMotorEvent = decisionAt && decisionAt !== visualState.decisionAt && ["BUY", "BURN"].includes(eventAction);
  if (isNewMotorEvent) {
    visualState.pressAction = eventAction;
    visualState.pressAt = performance.now();
    visualState.pulseAt = visualState.pressAt;
  }
  visualState.decisionAt = decisionAt;
  const stateNode = $("#visual-fly-state");
  if (stateNode) { stateNode.textContent = normalized; stateNode.className = normalized === "BUY" ? "buy" : normalized === "BURN" ? "sell" : ""; }
  if ($("#visual-membrane")) $("#visual-membrane").textContent = visualState.membrane.toFixed(3);
  if ($("#visual-arousal")) $("#visual-arousal").textContent = `${(visualState.arousal * 100).toFixed(1)}%`;
  if ($("#visual-pn")) $("#visual-pn").textContent = visualState.activity > .58 ? "BURST" : visualState.activity > .28 ? "ACTIVE" : "QUIET";
  if ($("#visual-kc")) $("#visual-kc").textContent = `${data?.brain?.kc?.activeCount || 0} / ${data?.brain?.kc?.count || 64}`;
  if ($("#visual-apl")) $("#visual-apl").textContent = visualState.apl.toFixed(3);
  if ($("#visual-dopamine")) $("#visual-dopamine").textContent = visualState.dopamine.toFixed(3);
  if ($("#visual-link")) $("#visual-link").textContent = visualState.running ? "COUPLED" : "STANDBY";
  if ($("#visual-ca")) $("#visual-ca").textContent = data?.token?.address || "—";
  if ($("#chart-summary")) $("#chart-summary").textContent = chartSummary(visualState.candles, visualState.price);
  const pressing = performance.now() - visualState.pressAt < 1050;
  const displayAction = pressing ? visualState.pressAction : normalized;
  const motorStatus = $("#motor-decision")?.parentElement;
  if (motorStatus) {
    motorStatus.className = `motor-status ${displayAction === "BUY" ? "buy" : displayAction === "BURN" ? "burn" : ""}`;
    if (isNewMotorEvent) {
      motorStatus.dataset.lastEvent = decisionAt;
      motorStatus.dataset.lastAction = eventAction;
    }
    $("#motor-decision").textContent = displayAction === "BUY" ? "BUY · 全脑判断" : displayAction === "BURN" ? "BURN · 全脑判断" : "WAITING · 等待全脑判断";
  }
  $("#motor-buy")?.parentElement.classList.toggle("pressed", pressing && visualState.pressAction === "BUY");
  $("#motor-burn")?.parentElement.classList.toggle("pressed", pressing && visualState.pressAction === "BURN");
  if (isNewMotorEvent) {
    clearTimeout(motorReleaseTimer);
    motorReleaseTimer = setTimeout(() => {
      $("#motor-buy")?.parentElement.classList.remove("pressed");
      $("#motor-burn")?.parentElement.classList.remove("pressed");
      const latest = window.__flyRuntimeState?.latestDecision?.actions?.brain?.action || "HOLD";
      const released = latest === "SELL" ? "BURN" : latest;
      const node = $("#motor-decision");
      if (node && released === "HOLD") { node.textContent = "WAITING · 等待全脑判断"; node.parentElement.className = "motor-status"; }
    }, 1050);
  }
}

try {
  const flyCanvas = $("#fly-stage");
  const brainCanvas = $("#brain-stage");
  if (!flyCanvas || !brainCanvas) throw new Error("3D canvas missing");
  const flyScene = createFlyScene(flyCanvas);
  const brainScene = createBrainScene(brainCanvas);
  let visible = true;
  let frame = 0;
  const visibleRegions = new Set();
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => entry.isIntersecting ? visibleRegions.add(entry.target) : visibleRegions.delete(entry.target));
    visible = visibleRegions.size > 0;
  }, { rootMargin: "180px" });
  observer.observe($(".motor-console")); observer.observe($(".soma-panel"));

  $("#fly-view-reset").addEventListener("click", flyScene.reset);
  $("#brain-mode-class").addEventListener("click", () => brainScene.setMode("class"));
  $("#brain-mode-state").addEventListener("click", () => brainScene.setMode("state"));
  $("#brain-view-reset").addEventListener("click", brainScene.reset);
  window.addEventListener("flyruntime:update", (event) => applyRuntime(event.detail));
  if (window.__flyRuntimeState) applyRuntime(window.__flyRuntimeState);

  const firstFrameAt = performance.now();
  flyScene.render(firstFrameAt);
  brainScene.render(firstFrameAt);
  if ($("#visual-frame")) $("#visual-frame").textContent = "01";

  function animate(time) {
    if (visible) {
      flyScene.render(time);
      brainScene.render(time);
      frame = (frame + 1) % 100;
      if (frame % 8 === 0 && $("#visual-frame")) $("#visual-frame").textContent = String(frame).padStart(2, "0");
    }
    requestAnimationFrame(animate);
  }
  requestAnimationFrame(animate);
} catch (error) {
  console.error("3D scene initialization failed", error);
  if ($("#visual-renderer")) $("#visual-renderer").textContent = "WEBGL UNAVAILABLE";
  if ($("#visual-link")) $("#visual-link").textContent = "2D DATA ONLY";
}
