/**
 * 苍蝇大脑决策引擎（Fly-brain decision engine）
 *
 * 设计目标：用一套**可解释、确定性、可回放**的神经回路，把「价格波动 → 回购/销毁」
 * 这条决策链做得像真实果蝇的嗅觉/味觉决策，而不是一个打分器。
 *
 * 参照的真实果蝇解剖结构（FlyWire 等）：
 *
 *  ① 感觉投射神经元 PN
 *       价格收益、量能相对基线 → 一组归一化特征向量。
 *  ② 蘑菇体 Kenyon 细胞 KC —— 稀疏编码
 *       每个 KC 随机接收一小片输入（这里用确定性的随机权重）。
 *       真实果蝇里同一气味只激活 5–10% 的 KC；这里用 k-WTA 强制稀疏。
 *  ③ APL 神经元 —— 全局抑制 / 分裂式归一化
 *       单个 APL 细胞铺满整个蘑菇体，把 KC 群体活动按总量做除法。
 *       这是「每个刺激都被归一化」的生理基础，也防止单笔大单顶穿决策。
 *  ④ 多巴胺能神经元 PPL1 / PPL2 —— 价值评估
 *       单侧只有十几个细胞，投射到蘑菇体输出端做**奖励预测误差**调制。
 *       这里的奖励是「动作之后价格往有利方向走过的最大幅度」（路径式 MFE），
 *       而不是「动作之后的终点价格」—— 后者会把逆势回购系统性判成失败。
 *  ⑤ 蘑菇体输出神经元 MBON —— 两条独立通路
 *       回购通路与销毁通路**各自学习**（双 gain 分账）：买入看涨、销毁看跌，
 *       方向相反，共用一个增益必然互相打架。
 *  ⑥ 下行神经元 DN —— 全脑唯一的运动出口，**竞争性选择（winner-take-all）**
 *       真实果蝇全脑只有几百个 DN 汇总到运动系统；这里只有 buy / burn / 不动 三选一。
 *  ⑦ 适应，而不是硬冻结
 *       生理上没有「30 秒不许动」这种绝对不应期（绝对不应期只有 1–2 ms）。
 *       真实机制是**适应**：刚发放过的通路增益下调，随时间恢复，但从不禁止行动。
 *  ⑧ 饥饿 / 能量状态调制
 *       能量低时提高门槛（不是禁止），并随时间持续无动作而**放宽门槛**，保证不会饿死。
 *
 * 与旧 `score-engine` 的兼容：对外仍暴露一个「累积电位」`membrane`，
 * 正值倾向销毁、负值倾向回购，可以直接喂给 `actionForScore()` 与既有前端。
 */

import { createHash } from "node:crypto";

// ---------------------------------------------------------------- 确定性随机
// 同一代币地址永远得到同一套突触权重，回放与线上行为一致。
function hashUnit(seed) {
  return Number.parseInt(createHash("sha256").update(seed).digest("hex").slice(0, 8), 16) / 0xffffffff;
}
/** Box–Muller，确定性高斯。 */
function hashGauss(seed) {
  const u1 = Math.max(1e-9, hashUnit(`${seed}:u`));
  const u2 = hashUnit(`${seed}:v`);
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

export const FLY_BRAIN_DEFAULTS = {
  // ---------------------------------------------------------------- ① 感觉层
  /**
   * 1 秒对数收益的**饱和尺度** —— 决定大脑能分辨多大幅度的秒级波动。
   *
   * 早先写死 0.02（约 ±1% 就饱和）。本币分钟收益 sd 12.5%、单根分钟 K 线里
   * 单秒 ±5% 很常见，于是**所有**像样的波动都被压成同一个 ±1：大脑分不出
   * 「+2% 的正常噪音」和「+50% 的垂直拉升」。主升段里驱动量不再有增量，
   * 输出级适应一减就归零 —— 这就是「剧烈上涨后不产生销毁」的第一根因。
   * 放宽到 0.08 后：±2%/秒 只给 0.46、±8%/秒 才接近满量程，强度重新可分辨。
   */
  returnSatScale: 0.08,
  /** 中期趋势（30 秒）的饱和尺度。同理：4% 饱和时，30 秒走 4% 和走 40% 长得一模一样。 */
  trendSatScale: 0.15,
  /**
   * 四个维度在先天感受野里的权重（统一乘 innateStrength）。
   *
   * ⚠️ 这三条是**联合标定**的结果（work/_fix-tune.mjs：7 组配比 × 六项验收），
   * 不是随手取的数。要点是「位置主导、动量退到调制位」：
   * 只把饱和点放宽、权重照旧时，位置的抑制量（positionWeight×innateStrength）
   * 与 12 个收益维的累积驱动（≈+0.2）几乎抵消 —— 高位小回调照样会回购。
   * 实测（15 池 / 429 分钟，居中 ±300 秒窗口位置，随机基准 0.441）：
   *   动量权重 1/1.1 → 买 0.375 / 烧 0.498（位置几乎没在起作用）
   *   动量权重 0.6/0.7、位置 1.8 → 买 0.364 / 烧 0.528，且动作频率几乎不变
   *     （回放 4.88 次/分 vs 修复前 4.73 次/分）
   */
  returnWeight: 0.6,
  /** 趋势维度在先天感受野里的权重。 */
  trendWeight: 0.7,
  /** 量能维度在先天感受野里的权重。 */
  volumeWeight: 0.7,
  /**
   * 量能门控的**死区**（量能比 = 当前 10 秒成交笔数 / 前 30 个桶的中位）。
   *
   * 早先用的是对称的 `tanh(2·(vr−1))`：放量为负、缩量为正，而权重对
   * 「顶部探测 KC」同样是负担 —— 可剧烈上涨**天然放量**（实测该币主升段 vr≈4），
   * 于是最该销毁的时候，销毁通路被自己的量能项削掉一半。
   * 实测同一个 10 分钟 ×2.5 的 pump：放量 vr=4 只烧 22 次，缩量 vr=0.5 能烧 46 次。
   *
   * 量能只有在**异常放量**时才有方向性含义，温和放量与缩量一律按 0 处理 ——
   * 不再拿「放量」去惩罚上涨。
   */
  volumeDeadzone: 3,
  /** 越过死区后量能信号的饱和尺度。 */
  volumeSatScale: 3,
  /**
   * 位置特征的回溯窗口（秒）：价格相对**该窗口滚动中位**的对数位置。
   *
   * 这是感觉层里唯一一个**慢变量**。其余 12 阶收益 + 30 秒趋势全是短窗差分，
   * 大脑因此完全不知道「现在这个价格在最近这段行情里算高还是低」——
   * +80% 之后一个 −2% 的小回调，在它眼里和「跌了 2%」一模一样，立刻回购，
   * 买在大顶（线上实测买位中位 0.50、烧位 0.45）。
   *
   * 用中位数而不是均值：meme 币里几笔插针会把均值整体带跑，中位对极端值稳健。
   */
  positionWindowSeconds: 3600,
  /** 位置维度的饱和尺度（对数）。0.25 ≈ 相对中位偏离 ±25% 就接近满量程。 */
  positionSatScale: 0.25,
  /** 位置维度在先天感受野里的权重。位置是唯一带均值回复含义的分量，所以它必须占主导。 */
  positionWeight: 1.8,
  /**
   * ③ 唤醒调制（觉醒水平 / 章鱼胺能调制）。
   *
   * 前面 15 个感觉维度决定大脑「看得见什么」，这一层只决定**多久出手一次** ——
   * 它是发射器的扳机行程，不是眼睛。真实果蝇也是这样：同一套感觉通路，
   * 觉醒水平不同时行为阈值差一个数量级（安静停歇时几乎不动，被惊动后连续动作）。
   *
   * 唤醒度 a ∈ [0,1] 由两个量合成，但两者的口径**故意不同**：
   *   · 价格：最近 activityWindowSeconds 的 1 秒对数收益 RMS —— **绝对**口径（无量纲、跨代币可比）
   *   · 量能：最近 activityWindowSeconds 的**报价资产成交额** ÷ 长窗基线 —— **相对**口径（有量纲，只能比自己）
   * 价格必须绝对：「价格稳定」的语义是「这段时间几乎不动」，而不是「比平时更不动」——
   * 用比值的话「一直很平静」与「一直很平常」会被判成同一件事（比值恒 ≈1），调制等于没写。
   * 成交量必须相对：GOOGLB 与 USDT 差几个数量级，绝对值没有可比性。
   *
   * ⚠️ 它必须同时调制**阈值**与**焦急机制**，只调阈值是无效的：
   * 阈值上调之后，`starveRelax`（300 秒无动作 → ×0.5）与 `homeostatRelax`
   * （该通路 150 秒未发放 → ×0.55）会在市场沉睡时**主动把阈值拉回来**，
   * 正好抵消掉整个调制。所以沉睡时这两个机制也要按 quietRelaxFactor 衰减。
   */
  /** 活动度观测窗口（秒）。用户口径 = 5 分钟。 */
  activityWindowSeconds: 300,
  /** 活动度基线的长窗长度（秒）：用这段时间里「每分钟活动度」的中位数当基线。 */
  activityBaselineSeconds: 1800,
  /**
   * 价格活度的**绝对**端点：1 秒对数收益的 RMS（无量纲，跨代币可比）。
   *
   * ⚠️ 端点必须对着**真实逐笔成交**标定，不能照抄合成序列。
   * 第一版用 0.0005 / 0.004（合成探针的 σ 量级），但真实 meme 币的 5 分钟 RMS 中位就有 **0.010**
   * → 几乎所有时刻都判成「剧烈」，唤醒度没有动态范围，频率被单调抬高
   * （真实序列实测 4.10 → 8.04 次/分，方向正好与目标相反）。
   * 现值取自真实 NECTAR 198 分钟分布的 p10 ≈ 0.003 与 p80 ≈ 0.018：
   * 平静的一端真的落到 0，剧烈的一端真的落到 1，中间有完整刻度。
   * 标定脚本：`work/_arousal-calibrate.mjs`。
   */
  activityPriceLow: 0.003,
  activityPriceHigh: 0.018,
  /**
   * 成交量的活度权重与端点。成交量有量纲（GOOGLB 与 USDT 差几个数量级），只能相对自己比。
   * 端点同样对着真实分布取（比值 p35 0.54 / p50 0.72 / p80 1.62）：
   * 「只有平常一半」→ 0，「两倍于平常」→ 1。
   */
  activityVolumeWeight: 0.5,
  /** 量能比值低于它 → 量能活度 0。 */
  activityLow: 0.5,
  /** 量能比值高于它 → 量能活度 1。 */
  activityHigh: 2,
  /**
   * 沉睡时的阈值乘数：让平静期那几次出手尽量落在真有信号的时候。
   *
   * ⚠️ 别指望用它来控频率 —— 频率归 `quietMinIntervalSeconds` 管。
   * 实测阈值乘数从 ×4 抬到 ×12 只能把平静段动作数从 15 压到 2，中间没有可用的刻度；
   * 而且抬到 ×4 时「死市里两侧都能出得来」这条性质开始破（实测某 6 种子批次少数侧只剩 0.067）。
   */
  quietThresholdScale: 2,
  /**
   * ⚠️ 活跃端的阈值乘数**故意是 1（不打折）**。
   *
   * 一开始取 0.35（「活跃就大胆出手」），真实 15 池回放上把「买位（60 分钟窗口）」
   * 从 0.18 顶到 0.52 —— 阈值是**质量过滤器**，行情剧烈时低信念的动作正好在拉升里成交，
   * 折扣越狠越差（0.6 → 0.357、0.8 → 0.294、1.0 → 0.277，单调）。
   * 所以这一层的分工是**单向**的：沉睡时更挑（×2）、清醒时原样；
   * 「活跃 → 出手快」完全交给 `activeMinIntervalSeconds`，不去动门槛。
   */
  activeThresholdScale: 1,
  /** 沉睡时「焦急机制」（饥饿 + 稳态放宽）保留多少强度 —— 市场没动静时不该靠饥饿把自己催起来。 */
  quietRelaxFactor: 0.25,
  /**
   * 沉睡时的**耐心上限**（分钟）：静默超过这么久，「焦急机制」就完全恢复。
   *
   * 这一条是**结构性的，不是调参** —— 没有它，`quietRelaxFactor` 会把饥饿与稳态放宽
   * 永久压到 25%，沉睡阈值固定在一个很高的常数上，市场再怎么没动静也不会松口，
   * 于是「沉睡」变成了「锁死」：实测 quietThresholdScale ≥ 6 时平静段 20 分钟零动作，
   * 且没有任何上界。真实动物饿久了必然出手，耐心是会被耗尽的。
   */
  quietPatienceMinutes: 30,
  /**
   * 最小动作间隔（秒），随唤醒度在 quiet / active 之间几何插值。
   *
   * 这是**频率的直接控制量**，与上面的阈值乘数分工明确：
   *   · 阈值乘数 → 「只在真有信号时出手」（质量）
   *   · 最小间隔 → 「最多多久出手一次」（频率）
   * 只靠抬阈值是不行的：实测阈值乘数从 ×4 抬到 ×12，平静段的中位间隔从 9 秒跳到 55 秒、
   * 而动作次数从 15 次掉到 2 次 —— 又陡又难驯服，稍微一调就越过 30 分钟的上界。
   *
   * ⚠️ 它是**全局**间隔，不是每条通路各自的（`refractorySeconds` 是每条通路各自的，
   * 两条通路交替时全局能压到 1 秒 —— 实测合成活跃段中位间隔只有 2 秒）。
   * 全局间隔不偏向任何一侧，所以不会破坏「两侧都能出得来」这条防锁死性质。
   */
  activeMinIntervalSeconds: 5,
  quietMinIntervalSeconds: 900,
  // ② 蘑菇体
  kcCount: 64,
  kcSparsity: 0.12, // 真实值 5–10%，取略高以留出学习余量
  kcField: 12, // 价格收益的回溯阶数
  kcWeightScale: 0.85,
  kcThreshold: 0.35,
  /**
   * KC 阈值在群体内的离散度。
   *
   * 这个值必须和「输入能带来多大差异」相称，否则稀疏码就不再反映输入：
   * 实测离散度 0.8 时，静止价格下 `w·x` 只有 ±0.22，谁能越过阈值**完全由静态阈值决定**，
   * 于是每一秒发放的都是同几个 KC、读出是个常数、回路被钉死在一侧。
   * 蘑菇体的意义就在于「用发放的是哪一群 KC 来编码刺激」，所以阈值离散度要压到输入量级。
   */
  kcThresholdSpread: 0.8,
  /**
   * KC 自身的内在适应（真实蘑菇体 Kenyon 细胞会随发放历史降低兴奋性）。
   *
   * 这一条是**结构性的**，不是调参：没有它时，静止价格下能越过阈值的永远是同几个 KC，
   * 读出成为一个常数，驱动量的直流符号由种子决定 —— 实测有的种子 113 买 / 1 烧、
   * 有的 1 买 / 113 烧，一路单向刷单。有了适应，刚发放过的 KC 会被自己压下去，
   * 稀疏码就会**轮换**，即使刺激完全不变。
   */
  kcAdaptStrength: 0.5,
  kcAdaptTauSeconds: 60,
  // 先天感受野：真实果蝇并非白板，嗅觉/味觉通路有**与生俱来的效价**（天生趋避）。
  // 这里把 KCs 分成三组：底部探测 / 顶部探测 / 通用，前两组用我们自己的实证结论做模板 ——
  //   缩量底部 = 近期下跌 + 下行趋势 + 量能萎缩
  //   缩量顶部 = 近期上涨 + 上行趋势 + 量能萎缩
  innateStrength: 0.22,
  innateShare: 0.25, // 每一组占整个 KC 群体的比例
  // 慢探索噪声（OU 过程）：打破「先发火的一侧永远赢」的锁死，让两条通路都持续被采样到。
  // 单位与膜电位一致 —— 这里是**长期标准差**，不是每步增量。
  // （早先写成每步增量时，实际幅度只有 ±0.5 左右，相对 ±30 的驱动量形同虚设，等于没有探索。）
  exploreScale: 20,
  exploreTauSeconds: 45,
  // 感觉噪声：投射神经元本身有自发发放。没有它的话，价格静止时输入恒为 0、
  // KC 群体全体静默 → 整个回路死掉（实测最长空窗 604 秒）。这不是调参能修的，是结构问题。
  sensoryNoise: 0.12,
  // ③ APL
  aplGain: 0.35,
  aplAdaptation: 0.8, // 群体活动持续偏高时进一步压低增益
  // ④ 多巴胺
  dopamineRate: 0.12,
  rewardFloorPct: 10, // 低于 10% 算失败（用户定义）
  rewardCeilPct: 50, // 达到 50% 记满分（用户定义：10–50% 都算，权重递减）
  outcomeWindowSeconds: 180,
  // ⑤ MBON 学习
  learningRate: 0.06,
  weightClamp: 1.5,
  mbonInitScale: 0.25,
  // 稳态突触缩放：每条通路的 |w| 总和守恒。
  // 没有它，先发火的一侧会靠「权重变大」把自己变成不可挑战的赢家 ——
  // 实测纯周期行情里买卖比会锁死在 74:4。守恒之后，两条通路预算相等，
  // 胜出只取决于**模式匹配**（哪些 KC 在发放），而不是幅度，这才是可解释的竞争。
  weightNorm: 0.25,
  // ⑥ 下行神经元
  // 工作点由联合扫描定下（work/brain-sweep.mjs）：增益 200 / 阈值 45 / 输出适应 300s / 探索 20。
  // 真实样本表现为 2.69 次/分、回购 564 / 销毁 589（方向均衡）、
  // 回购落在 90 秒区间的 0.27、销毁落在 0.81；静止行情下亦不会单向刷单。
  mbonGain: 200,
  membraneTauSeconds: 4,
  /**
   * 输出级适应（MBON → DN 突触的可塑性）：把驱动量里**变化很慢的那部分**减掉。
   *
   * 这是整个回路里最容易被忽略、但缺了就会出事的一环：
   * 价格静止时，蘑菇体里能越过阈值的 KC 几乎总是同几个（阈值是静态的），
   * 于是读出变成一个**恒定值**、驱动量恒为 +30~+65，回路被永久锁死在销毁一侧
   * —— 实测 4 分钟里 16 次动作全是销毁，膜电位从头到尾没有变负过。
   *
   * 真实 MBON→DN 突触会适应恒定输入，果蝇也不会因为「环境不变」就永远只做一个动作。
   * 减掉慢基线之后，回路只对**模式**起反应，不变的直流成分被自动遗忘。
   */
  outputTauSeconds: 300,
  spontaneousActivity: 0.06, // 自发活动，保证点云不会完全死掉
  minThreshold: 2,
  // ⑥ 门槛（由调用方的 buyThreshold / burnThreshold 覆盖，两者都是**正的数量**）
  buyThreshold: 45,
  burnThreshold: 45,
  // ⑦ 适应
  refractorySeconds: 1, // 绝对不应期（生理上只有 1–2 ms，这里按 tick 取 1 秒）
  adaptFactor: 0.42, // 发放后该通路增益下调到 42%
  adaptTauSeconds: 9,
  // ⑧ 饥饿 / 能量
  starveSeconds: 300,
  starveRelax: 0.5, // 最长 300 秒无动作 → 门槛放宽 50%
  // 稳态可塑性：长期不发放的通路，兴奋性上调（门槛下降）。
  // 没有这一条会「赢者通吃」：先发火那侧强化自己、另一侧永不发火也永不学习 —— 实测纯周期行情里
  // 销毁通路彻底锁死（0 次发放）。真实神经元靠内在兴奋性的稳态调节避免这种事。
  homeostatSeconds: 150,
  homeostatRelax: 0.55,
  /**
   * 剩余能量越少，门槛抬得越高（上限 +energyRisk×100%）。
   *
   * ⚠️ 原本的修复方案里打算把它从 1.2 降到 0.6，理由是「销毁会减少代币余额 →
   * 销毁门槛被自己的上一次销毁抬高」。**实测把这个改动否掉了**（work/_fix-attr.mjs，
   * 真实 NECTAR 序列单变量归因）：1.2→0.6 让动作从 3.51 升到 4.42 次/分（+0.91，
   * 是所有改动的最大单项来源），而买位 / 烧位 / 居中位置 / 剧烈上涨段的销毁笔数
   * 全部没有可辨认的改善。既然只有代价没有收益，就保持原值不动。
   */
  energyRisk: 1.2,
  energyReferenceDecay: 0.002,
};

/** 把 percent 形式的收益换算成 0–1 的成功度（用户定义：10% 起算，50% 封顶）。 */
export function rewardFromMfe(mfePercent, floorPct, ceilPct) {
  if (!Number.isFinite(mfePercent)) return 0;
  const span = Math.max(1e-6, ceilPct - floorPct);
  return Math.min(1, Math.max(0, (mfePercent - floorPct) / span));
}

/** 取数组里前 k 大的下标（小数组直接排序，够用且好读）。 */
function topKIndices(values, k) {
  const indices = Array.from(values, (_, i) => i);
  indices.sort((a, b) => values[b] - values[a]);
  return indices.slice(0, Math.max(0, Math.min(k, indices.length)));
}

export function createFlyBrain(options = {}) {
  const cfg = { ...FLY_BRAIN_DEFAULTS, ...options };
  const seedBase = String(cfg.seed ?? "fly");
  const D = cfg.kcField + 3; // 价格收益 + 量能比 + 中期趋势 + 滚动中位位置
  const N = cfg.kcCount;
  const K = Math.max(1, Math.round(N * cfg.kcSparsity));

  /**
   * 先天感受野。
   *  · 通用组：确定性随机权重（代表蘑菇体把任意气味映射成稀疏码的能力）
   *  · 底部组 / 顶部组：权重符号由「形态学」决定 ——
   *      底部 KC 对**负收益 + 下行趋势 + 低位**响应为正；
   *      顶部 KC 对**正收益 + 上行趋势 + 高位**响应为正。
   *    权重上叠加个体抖动，避免整组完全同质。
   *
   * 三条通路分工：① 短期收益 = 动量方向；② 趋势 = 动量强度；
   * ③ 位置（相对 60 分钟滚动中位）= **高度**，是唯一带均值回复含义的分量。
   * 只有①②时，大脑只会「追涨杀跌」；加上③之后，「+80% 后的 −2% 小回调」
   * 才会被判成「仍在高位」而不是「在下跌」。
   */
  const buildWeights = () => {
    const c = cfg.innateStrength;
    const edge = Math.round(N * cfg.innateShare);
    return Array.from({ length: N }, (_, i) => {
      const row = new Float64Array(D);
      if (i >= edge * 2) {
        for (let j = 0; j < D; j += 1) row[j] = hashGauss(`${seedBase}:kc:${i}:${j}`) * cfg.kcWeightScale;
        return row;
      }
      const sgn = i < edge ? -1 : 1; // 底部组取负号：负收益才能把它推过阈值
      const jit = (j) => 1 + 0.35 * hashGauss(`${seedBase}:jit:${i}:${j}`);
      for (let j = 0; j < cfg.kcField; j += 1) row[j] = sgn * c * cfg.returnWeight * jit(j);
      // 量能：权重带负号 —— 异常放量既不是「底部」也不是「顶部」，只是「看不太清」。
      // 信号本身在 volumeDeadzone 以内恒为 0，所以平时这项只是「不贡献」。
      row[cfg.kcField] = -c * cfg.volumeWeight * jit(cfg.kcField);
      row[cfg.kcField + 1] = sgn * c * cfg.trendWeight * jit(cfg.kcField + 1);
      // 位置：处在近期行情的高位 → 顶部组响应（倾向销毁）、底部组反向，反之亦然
      row[cfg.kcField + 2] = sgn * c * cfg.positionWeight * jit(cfg.kcField + 2);
      return row;
    });
  };
  const buildThresholds = () => Float64Array.from({ length: N }, (_, i) =>
    hashGauss(`${seedBase}:kcTheta:${i}`) * cfg.kcThresholdSpread + cfg.kcThreshold);
  /**
   * 输出通路的初始权重 —— **双 gain 分账的先天部分**。
   * 回购通路把「底部探测 KC」当正证据、把「顶部探测 KC」当负证据；销毁通路正好相反。
   * 这就是天生知道「往低处走该买、往高处走该烧」，之后靠多巴胺预测误差修正。
   *
   * 注意顶部组的感受野里现在同时含「涨得快」和「位置高」，所以回购通路会**同时**
   * 被这两件事压制 —— 不追高、不在大顶接刀，是先天就有的克制，不靠后天学出来。
   */
  const buildMbon = (pool) => {
    const edge = Math.round(N * cfg.innateShare);
    const sign = pool === "buy" ? 1 : -1;
    return Float64Array.from({ length: N }, (_, i) => {
      if (i < edge) return sign;
      if (i < edge * 2) return -sign;
      return hashGauss(`${seedBase}:mbon:${pool}:${i}`) * cfg.mbonInitScale;
    });
  };

  let state;
  function reset() {
    state = {
      weights: buildWeights(),
      thresholds: buildThresholds(),
      kcAdaptation: new Float64Array(N), // KC 的发放历史 → 兴奋性下调
      mbon: { buy: buildMbon("buy"), burn: buildMbon("burn") },
      priceHistory: [], // [{ at, price }]，只保留决策需要的窗口
      returnLags: new Float64Array(cfg.kcField), // 最近 kcField 个对数收益，最新在 [0]
      volumeRatio: 1,
      /**
       * 活动窗口内的报价资产成交量（由调用方喂入）。
       * `null` 与 `0` 语义不同：`null` = **数据源不可用**（还没扫到过成交流），
       * `0` = 确实一笔都没有。前者要退化成「只看价格波动」，后者才是真正的沉睡。
       */
      volume5m: null,
      activityRms: 0, // 活动窗口内 1 秒对数收益的 RMS（实现波动，量纲 = 收益）
      minuteRms: { sum: 0, n: 0, from: null }, // 当前这一分钟的平方和累积
      activityHist: [], // [{ at, rms, vol }] 每分钟一个样本 → 唤醒度的长窗基线
      arousal: { level: 0, price: 0, volume: null, rms: 0, priceRatio: 1, volumeRatio: null, thresholdScale: 1, refractorySeconds: 1 },
      trend: 0,
      position: 0, // 相对滚动中位的对数位置（慢变量：大脑唯一知道「现在算高还是低」的途径）
      kcActivity: new Float64Array(N),
      kcRaw: 0, // 抑制前的群体活动总量
      aplLevel: 0,
      aplEma: 0,
      readout: { buy: 0, burn: 0 },
      membrane: 0,
      drive: 0,
      driveBaseline: 0,
      dopamine: { plus: 0, minus: 0, level: 0 },
      pending: [], // 未结算的动作 [{ action, price, at, mfe, activation }]
      exploration: { buy: 0, burn: 0 },
      adaptation: { buy: 1, burn: 1 },
      lastFireAt: { buy: null, burn: null },
      startedAt: null,
      lastActionAt: null,
      lastAction: null,
      stats: { actions: 0, buy: 0, burn: 0, updates: 0, rewardSum: 0, rewardCount: 0, lastReward: null },
      energyRef: { quote: null, token: null },
      energy: { buy: 1, burn: 1 },
      hunger: 0,
      ticks: 0,
      lastStepAt: null,
      blocked: null,
      fired: null,
    };
    scalePool("buy");
    scalePool("burn");
  }
  reset();

  /** 记录一次价格，维护收益序列、中期趋势与「相对滚动中位的位置」。 */
  function observe(now, price) {
    const hist = state.priceHistory;
    const last = hist.at(-1);
    hist.push({ at: now, price });
    // 短窗（kcField 阶收益 + 30 秒趋势）用不到这么久，但位置特征要看整个回溯窗口。
    // 时间窗裁剪 + 条数硬上限：tick 比 1 秒更快时也不会无界增长。
    const windowMs = Math.max(60_000, cfg.positionWindowSeconds * 1000);
    while (hist.length > 2 && now - hist[0].at > windowMs) hist.shift();
    if (hist.length > 7200) hist.splice(0, hist.length - 7200);

    if (last && last.price > 0 && price > 0) {
      const r = Math.log(price / last.price);
      const lags = state.returnLags;
      for (let i = lags.length - 1; i > 0; i -= 1) lags[i] = lags[i - 1];
      lags[0] = r;
    }
    // 30 秒趋势：从末尾往前找第一条落在窗口内的样本（hist 按时间升序，找到旧的就停）
    let ref = null;
    for (let i = hist.length - 1; i >= 0; i -= 1) {
      if (now - hist[i].at <= 30_000) ref = hist[i];
      else break;
    }
    ref = ref ?? hist[0];
    state.trend = ref && ref.price > 0 ? Math.log(price / ref.price) : 0;

    // 位置：当前价相对整个回溯窗口**中位**的对数偏离。
    // 均匀降采样到 ~240 个点再排序 —— 每秒对几千个样本全排序没有意义，
    // 位置是个慢变量，采样一下完全够，省下的算力留给主循环。
    const step = Math.max(1, Math.floor(hist.length / 240));
    const sample = [];
    for (let i = 0; i < hist.length; i += step) sample.push(hist[i].price);
    sample.sort((a, b) => a - b);
    const median = sample.length ? sample[sample.length >> 1] : price;
    state.position = median > 0 && price > 0 ? Math.log(price / median) : 0;

    // ---- 唤醒调制：市场活跃度（价格波动 + 成交量）。
    // 它不影响任何一个感觉维度，只影响「多久出手」—— 相当于发射器的扳机行程，不是眼睛。
    // 先把**上一分钟**结算进基线：基线必须用活动窗口之外的历史算，否则基线会跟着当前窗口一起动，
    // 比值恒等于 1，调制等于没写。
    const minuteKey = Math.floor(now / 60_000);
    if (state.minuteRms.from === null) state.minuteRms.from = minuteKey;
    if (minuteKey !== state.minuteRms.from) {
      const prev = state.minuteRms;
      state.activityHist.push({
        at: prev.from,
        rms: prev.n > 0 ? Math.sqrt(prev.sum / prev.n) : 0,
        vol: state.volume5m,
      });
      const maxLen = Math.max(3, Math.ceil(Math.max(60, cfg.activityBaselineSeconds) / 60));
      if (state.activityHist.length > maxLen) state.activityHist.splice(0, state.activityHist.length - maxLen);
      state.minuteRms = { sum: 0, n: 0, from: minuteKey };
    }
    if (last && last.price > 0 && price > 0) {
      const minuteR = Math.log(price / last.price);
      state.minuteRms.sum += minuteR * minuteR;
      state.minuteRms.n += 1;
    }

    // 活动窗口内的实现波动：从末尾往回扫到窗口边界（hist 按时间升序）
    const actMs = Math.max(5, cfg.activityWindowSeconds) * 1000;
    let sq = 0;
    let cnt = 0;
    for (let i = hist.length - 1; i > 0; i -= 1) {
      const cur = hist[i];
      const prev = hist[i - 1];
      if (now - cur.at > actMs) break;
      if (prev.price > 0 && cur.price > 0) {
        const rr = Math.log(cur.price / prev.price);
        sq += rr * rr;
        cnt += 1;
      }
    }
    state.activityRms = cnt > 0 ? Math.sqrt(sq / cnt) : 0;

    // 基线 = 长窗内「每分钟活动度」的中位数。中位而不是均值：一次拉升不该把基线整体抬上去，
    // 否则最需要敏锐的那一段反而是基线最高的一段，唤醒度反而上不去。
    const medianOf = (key) => {
      const vals = [];
      for (const item of state.activityHist) if (Number.isFinite(item[key])) vals.push(item[key]);
      if (vals.length < 3) return null;
      vals.sort((a, b) => a - b);
      return vals[vals.length >> 1];
    };
    // 唤醒度的比值 → [0,1] 映射。below/above 是区间端点，r ≤ below → 0，r ≥ above → 1。
    const unit = (below, above, r) => {
      const lo = Math.min(below, above - 1e-9);
      const hi = Math.max(above, lo + 1e-9);
      return Math.max(0, Math.min(1, (r - lo) / (hi - lo)));
    };
    // 价格活度：基线之外的绝对水平（见 activityPriceLow 的说明）。
    // 基线不可用（样本不足）时取中性 1，而不是 0 —— 刚启动就把自己判成沉睡，
    // 等于开局连阈值都不敢碰。基线为 0 时用 high 的 2 倍当哨兵：说明「此前完全没动过、
    // 现在动了」，那就是满量能活度（哨兵是有限数，避免 Infinity 流进快照变成 NaN）。
    const ratioTo = (cur, base) => {
      if (base === null) return 1;
      if (base <= 0) return cur > 0 ? cfg.activityHigh * 2 : 0;
      return cur / base;
    };
    const priceRatio = ratioTo(state.activityRms, medianOf("rms"));
    const volumeRatio = Number.isFinite(state.volume5m) ? ratioTo(state.volume5m, medianOf("vol")) : null;

    // 价格活度走**绝对**口径（1 秒收益 RMS 本身无量纲），成交量活度走**相对**口径。
    const priceAct = unit(cfg.activityPriceLow, cfg.activityPriceHigh, state.activityRms);
    const volAct = volumeRatio === null ? null : unit(cfg.activityLow, cfg.activityHigh, volumeRatio);
    // 成交量数据缺失时把它的权重让给价格：「拿不到量」与「没有量」是两件事，
    // 本地回放只有价格序列，不能因此把大脑判成沉睡。
    const wVol = volAct === null ? 0 : Math.max(0, Math.min(1, cfg.activityVolumeWeight));
    const level = wVol > 0 ? wVol * volAct + (1 - wVol) * priceAct : priceAct;

    state.arousal.priceRatio = priceRatio;
    state.arousal.volumeRatio = volumeRatio;
    state.arousal.price = priceAct;
    state.arousal.volume = volAct;
    state.arousal.rms = state.activityRms;
    state.arousal.level = Math.max(0, Math.min(1, level));
  }

  /** ② 稀疏编码：随机感受野 → ReLU → 只留最强的 K 个 KC。 */
  function sparseCode(tick, dt) {
    const x = new Float64Array(D);
    const lags = state.returnLags;
    // 饱和尺度全部走参数：见 FLY_BRAIN_DEFAULTS.returnSatScale 关于「2% 饱和
    // 等于把大脑的眼睛蒙上一半」的说明。
    const retSat = Math.max(1e-6, cfg.returnSatScale);
    for (let i = 0; i < cfg.kcField; i += 1) x[i] = Math.tanh((2 * lags[i]) / retSat);
    // 量能：只对**异常放量**出力（越过 volumeDeadzone），缩量与温和放量一律按 0 ——
    // 剧烈上涨天然放量，不能拿它去惩罚上涨。
    const vr = state.volumeRatio;
    x[cfg.kcField] = vr > cfg.volumeDeadzone
      ? Math.tanh((vr - cfg.volumeDeadzone) / Math.max(1e-6, cfg.volumeSatScale))
      : 0;
    x[cfg.kcField + 1] = Math.tanh(state.trend / Math.max(1e-6, cfg.trendSatScale));
    x[cfg.kcField + 2] = Math.tanh(state.position / Math.max(1e-6, cfg.positionSatScale));
    // 投射神经元自带噪声（自发发放）：保证价格完全静止时回路也不会整体静默
    if (cfg.sensoryNoise > 0) {
      for (let j = 0; j < D; j += 1) {
        const n = (hashUnit(`${seedBase}:pn:${tick}:${j}`) - 0.5) * 2 * cfg.sensoryNoise;
        x[j] = Math.max(-1, Math.min(1, x[j] + n));
      }
    }

    const raw = new Float64Array(N);
    const adapt = state.kcAdaptation;
    for (let i = 0; i < N; i += 1) {
      const w = state.weights[i];
      let sum = 0;
      for (let j = 0; j < D; j += 1) sum += w[j] * x[j];
      // 内在适应直接抬在该 KC 自己的阈值上：刚发放过的 KC 更难再次越过
      raw[i] = Math.max(0, sum - state.thresholds[i] - cfg.kcAdaptStrength * adapt[i]);
    }
    let total = 0;
    for (let i = 0; i < N; i += 1) total += raw[i];
    state.kcRaw = total;

    const active = new Set(topKIndices(raw, K));
    const activity = state.kcActivity;
    activity.fill(0);
    for (const i of active) activity[i] = raw[i];

    // 更新 KC 的发放历史（一阶低通），下一拍这一群 KC 就更难发放
    const decay = Math.exp(-dt / Math.max(1, cfg.kcAdaptTauSeconds));
    for (let i = 0; i < N; i += 1) {
      adapt[i] = adapt[i] * decay + (activity[i] > 0 ? 1 : 0) * (1 - decay);
    }
    return { active, total };
  }

  /** 在体内真实感更强的写法：把 k-WTA 也暴露给 UI（哪些 KC 在发放）。 */
  function snapshotKc() {
    const a = state.kcActivity;
    let activeCount = 0;
    for (let i = 0; i < N; i += 1) if (a[i] > 0) activeCount += 1;
    const idx = topKIndices(a, 12).filter((i) => a[i] > 0);
    let adaptSum = 0;
    for (let i = 0; i < N; i += 1) adaptSum += state.kcAdaptation[i];
    return {
      count: N,
      activeCount,
      sparsity: N ? +(activeCount / N).toFixed(3) : 0,
      // 群体平均的发放历史：越接近 1 说明这一群 KC 刚被反复用过、正在被自己压下去
      adaptation: +(adaptSum / N).toFixed(3),
      top: idx.map((i) => ({ i, a: +a[i].toFixed(4) })),
    };
  }

  function step(input) {
    const { now, price } = input;
    if (!Number.isFinite(price) || price <= 0) return decision(null, "bad-price");
    const dt = state.lastStepAt === null ? 1 : Math.min(10, Math.max(0.2, (now - state.lastStepAt) / 1000));
    state.lastStepAt = now;
    if (state.startedAt === null) state.startedAt = now;
    state.ticks += 1;

    // 唤醒调制的两个外部输入必须在 observe() 之前落进 state：
    // observe() 在分钟边界结算基线样本时要读 volume5m。
    state.volumeRatio = Number.isFinite(input.volumeRatio) && input.volumeRatio > 0 ? input.volumeRatio : 1;
    // null 与 0 语义不同：null = 成交流数据源不可用（退化成只看价格），0 = 真的没有成交（沉睡）
    state.volume5m = Number.isFinite(input.volume5m) && input.volume5m >= 0 ? input.volume5m : null;
    observe(now, price);

    // ---- ①②③ 感觉 → 稀疏编码 → APL 全局抑制
    const { total } = sparseCode(Math.floor(now / 1000), dt);
    state.aplEma = state.aplEma * 0.95 + total * 0.05;
    const overload = Math.min(1, state.aplEma / (N * 0.5));
    const gamma = cfg.aplGain * (1 + cfg.aplAdaptation * overload);
    const inhibition = gamma * total;
    state.aplLevel = +inhibition.toFixed(4);
    const a = state.kcActivity;
    const norm = 1 / (1 + inhibition);
    for (let i = 0; i < N; i += 1) if (a[i] > 0) a[i] *= norm;

    // ---- ④ 结算到期动作：路径式 MFE → 奖励预测误差
    settlePending(now, price);

    // ---- ⑤⑥ MBON 读出 → 侧抑制 → 膜电位积分
    let sumA = 0;
    for (let i = 0; i < N; i += 1) sumA += a[i];
    const denom = sumA > 1e-9 ? sumA : 1;
    let rb = 0;
    let rBurn = 0;
    for (let i = 0; i < N; i += 1) {
      if (a[i] === 0) continue;
      rb += state.mbon.buy[i] * a[i];
      rBurn += state.mbon.burn[i] * a[i];
    }
    state.readout.buy = rb / denom;
    state.readout.burn = rBurn / denom;

    const tickSeed = Math.floor(now / 1000);
    // 自发活动：两条通路各有独立的自发发放。
    // （早先给两条通路加的是**同一个**随机数，做差时正好抵消，等于白写。）
    const spontaneous = (key) => cfg.spontaneousActivity * (hashUnit(`${seedBase}:noise:${key}:${tickSeed}`) - 0.5);
    // 慢探索噪声（OU 过程）：长时间尺度上的随机游走，保证两条通路都不会被永久压死。
    // 用标准正态驱动、幅度按「长期标准差 = exploreScale」标定，才能与膜电位同量纲，
    // 真有把决策翻到另一侧的能力。
    const rho = Math.exp(-dt / Math.max(1, cfg.exploreTauSeconds));
    const shockSd = cfg.exploreScale * Math.sqrt(1 - rho * rho);
    const ouStep = (prev, key) => prev * rho + shockSd * hashGauss(`${seedBase}:ou:${key}:${tickSeed}`);
    state.exploration.buy = ouStep(state.exploration.buy, "buy");
    state.exploration.burn = ouStep(state.exploration.burn, "burn");

    const outBuy = cfg.mbonGain * state.readout.buy + spontaneous("buy") + state.exploration.buy;
    const outBurn = cfg.mbonGain * state.readout.burn + spontaneous("burn") + state.exploration.burn;

    // 竞争性选择实现为**两条通路输出之差**（推挽式）。
    // 早先的写法是「各自整流后互相减对方的正部」，结果占优的一侧会把另一侧直接压到 0，
    // 形成不可逆的锁死（实测某个种子 417 次动作全是销毁）。差值天然反对称，没有这个问题。
    const drive = outBurn - outBuy;

    // 输出级适应：减掉驱动量的慢速基线，恒定输入因此不会把回路钉死在一侧。
    // outputTauSeconds <= 0 表示关闭该机制（留作对照实验用）。
    let effectiveDrive = drive;
    if (cfg.outputTauSeconds > 0) {
      const baseRate = Math.exp(-dt / Math.max(1, cfg.outputTauSeconds));
      state.driveBaseline = state.driveBaseline * baseRate + drive * (1 - baseRate);
      effectiveDrive = drive - state.driveBaseline;
    } else {
      state.driveBaseline = 0;
    }

    const decayRate = Math.exp(-dt / Math.max(0.5, cfg.membraneTauSeconds));
    state.drive = drive;
    state.membrane = state.membrane * decayRate + effectiveDrive * (1 - decayRate);

    // ---- 唤醒调制：把「市场活跃度」翻译成阈值的乘数。
    // 几何插值（在对数尺度上线性）而不是线性：这样 ×3（沉睡）与 ×0.35（活跃）相对 1 的距离
    // 是对称的，唤醒度在 0.5 附近恰好落在中性附近，不会因为一端是 3 一端是 0.35 而整体偏移。
    const arousal = state.arousal;
    const quietScale = Math.max(1e-6, cfg.quietThresholdScale);
    const activeScale = Math.max(1e-6, cfg.activeThresholdScale);
    const arousalScale = Math.exp(
      Math.log(quietScale) * (1 - arousal.level) + Math.log(activeScale) * arousal.level,
    );
    // 沉睡时衰减「焦急机制」：饥饿（300 秒无动作就放宽）与稳态（该通路久未发放就降门槛）
    // 本来是为了防止锁死，但它们会在市场沉睡时把刚抬上去的阈值又拉回来 ——
    // 实测两者叠起来能把阈值压到 0.275 倍，足以把整个调制抵消掉。
    //
    // ⚠️ 但压制必须有**边界**：静默越久，耐心越少，焦急机制越该恢复。
    // 少了 patience 这一项，「沉睡」就变成了「锁死」（实测 20 分钟零动作且无上界）。
    // ⚠️ 静默时钟的起点必须是「上次动作」**或「大脑启动」**：只看 lastActionAt 的话，
    // 开局就没有上一次动作 → patience 永远 0 → 在最需要兜底的那个场景（开局就是死市）
    // 兜底反而不生效（实测 90 分钟只出手 1 次，远超用户要的 30 分钟上界）。
    const lastQuietAt = state.lastActionAt ?? state.startedAt ?? now;
    const silenceMin = Math.max(0, (now - lastQuietAt) / 60_000);
    const patience = Math.min(1, silenceMin / Math.max(0.5, cfg.quietPatienceMinutes));
    const keep = Math.max(0, Math.min(1, cfg.quietRelaxFactor));
    const relaxWeight = keep + (1 - keep) * Math.max(arousal.level, patience);
    arousal.thresholdScale = arousalScale;

    // ---- ⑦ 适应（不是硬冻结）
    for (const pool of ["buy", "burn"]) {
      state.adaptation[pool] = Math.min(1, state.adaptation[pool] + dt / Math.max(1, cfg.adaptTauSeconds));
    }
    // ---- ⑧ 饥饿 / 能量
    state.energy = computeEnergy(input);
    state.hunger = state.lastActionAt === null
      ? 0
      : Math.min(1, (now - state.lastActionAt) / (cfg.starveSeconds * 1000));

    const relax = 1 - cfg.starveRelax * state.hunger * relaxWeight;
    // 稳态可塑性：只看「这条通路自己多久没发放过」
    const homeo = (pool) => {
      const last = state.lastFireAt[pool] ?? state.startedAt ?? now;
      return 1 - cfg.homeostatRelax * Math.min(1, (now - last) / (cfg.homeostatSeconds * 1000)) * relaxWeight;
    };
    const buyFactor = state.energy.buy >= 1 ? 1 : 1 + cfg.energyRisk * (1 - state.energy.buy);
    const burnFactor = state.energy.burn >= 1 ? 1 : 1 + cfg.energyRisk * (1 - state.energy.burn);
    const thresholdBuy = Math.max(cfg.minThreshold, cfg.buyThreshold * arousalScale * relax * homeo("buy") * buyFactor / state.adaptation.buy);
    const thresholdBurn = Math.max(cfg.minThreshold, cfg.burnThreshold * arousalScale * relax * homeo("burn") * burnFactor / state.adaptation.burn);

    // ---- 竞争性选择：膜电位同时判决两个方向（WTA 由 sign 天然保证互斥）
    // 动作间隔也随唤醒度走，取「基准不应期」与「插值出来的最小间隔」中更严的那个。
    // 沉睡时是 5–30 分钟级别，活跃时回到 5 秒级 —— 这就是用户要的那条频率曲线。
    const minInterval = Math.exp(
      Math.log(Math.max(0.1, cfg.quietMinIntervalSeconds)) * (1 - arousal.level)
      + Math.log(Math.max(0.1, cfg.activeMinIntervalSeconds)) * arousal.level,
    );
    const refractoryEff = Math.max(Math.max(0.1, cfg.refractorySeconds), minInterval);
    arousal.refractorySeconds = refractoryEff;
    const refractory = state.lastActionAt !== null && now - state.lastActionAt < refractoryEff * 1000;
    const fireBurn = state.membrane >= thresholdBurn;
    const fireBuy = state.membrane <= -thresholdBuy;
    let action = null;
    let blocked = null;
    if (fireBurn) action = "burn";
    else if (fireBuy) action = "buy";

    // 资源约束不是「不应期」，是「没有能量可用」——硬闸门，但语义诚实
    const quoteBalance = Number.isFinite(input.quoteBalance) ? input.quoteBalance : Infinity;
    const tokenBalance = Number.isFinite(input.tokenBalance) ? input.tokenBalance : Infinity;
    if (action === "buy" && quoteBalance <= 0) { action = null; blocked = "no-quote"; }
    if (action === "burn" && tokenBalance <= 0) { action = null; blocked = "no-token"; }
    if (action && refractory) { action = null; blocked = "refractory"; }
    state.blocked = blocked;

    if (action) {
      state.adaptation[action] *= cfg.adaptFactor;
      state.lastFireAt[action] = now;
      state.lastActionAt = now;
      state.lastAction = action;
      state.stats.actions += 1;
      state.stats[action] += 1;
      state.pending.push({
        action,
        price,
        at: now,
        mfe: 0,
        activation: Float64Array.from(a), // 记下当时的 KC 活动，供学习用
      });
    }

    return decision(action, blocked, { outBuy, outBurn, thresholdBuy, thresholdBurn });
  }

  function decision(action, blocked, extra = {}) {
    return {
      action,
      blocked,
      membrane: +state.membrane.toFixed(4),
      readout: { buy: +state.readout.buy.toFixed(5), burn: +state.readout.burn.toFixed(5) },
      out: { buy: +(extra.outBuy ?? 0).toFixed(3), burn: +(extra.outBurn ?? 0).toFixed(3) },
      threshold: {
        buy: +(extra.thresholdBuy ?? cfg.buyThreshold).toFixed(2),
        burn: +(extra.thresholdBurn ?? cfg.burnThreshold).toFixed(2),
      },
    };
  }

  function computeEnergy(input) {
    const ref = state.energyRef;
    const q = Math.max(0, Number(input.quoteBalance) || 0);
    const t = Math.max(0, Number(input.tokenBalance) || 0);
    // 参考量取「见过的最大值」，缓慢衰减 —— 这样能量是相对自身历史而言的
    if (ref.quote === null || q > ref.quote) ref.quote = q;
    else ref.quote = Math.max(q, ref.quote * (1 - cfg.energyReferenceDecay));
    if (ref.token === null || t > ref.token) ref.token = t;
    else ref.token = Math.max(t, ref.token * (1 - cfg.energyReferenceDecay));
    const ratio = (v, r) => (r > 0 ? Math.min(1, v / r) : v > 0 ? 1 : 0);
    return { buy: ratio(q, ref.quote), burn: ratio(t, ref.token) };
  }

  /**
   * 结算到期动作。
   * 关键设计：奖励用**路径式 MFE**（窗口内走过的最有利幅度），
   * 而不是终点价格。这样「在下跌里接刀、随后出现一次反弹」不会被判成全错，
   * 逆势回购因此不会被反馈系统性压制。
   */
  function settlePending(now, price) {
    if (!state.pending.length) return;
    const windowMs = cfg.outcomeWindowSeconds * 1000;
    const keep = [];
    for (const item of state.pending) {
      const fav = item.action === "buy" ? price / item.price - 1 : 1 - price / item.price;
      if (fav > item.mfe) item.mfe = fav;
      if (now - item.at < windowMs) { keep.push(item); continue; }
      const r = rewardFromMfe(item.mfe * 100, cfg.rewardFloorPct, cfg.rewardCeilPct);
      const pe = r - (item.action === "buy" ? state.dopamine.plus : state.dopamine.minus);
      learn(item.action, pe, item.activation);
      if (item.action === "buy") {
        state.dopamine.plus += cfg.dopamineRate * pe;
        state.dopamine.plus = Math.min(1, Math.max(0, state.dopamine.plus));
      } else {
        state.dopamine.minus += cfg.dopamineRate * pe;
        state.dopamine.minus = Math.min(1, Math.max(0, state.dopamine.minus));
      }
      state.dopamine.level = state.dopamine.plus - state.dopamine.minus;
      state.stats.updates += 1;
      state.stats.rewardSum += r;
      state.stats.rewardCount += 1;
      state.stats.lastReward = +r.toFixed(3);
    }
    state.pending = keep;
  }

  /**
   * 多巴胺门控的**对比式** Hebbian 更新。
   *
   * 关键：更新量用 `(a_i − 同群均值)`，而不是 `a_i`。
   * 用 `a_i` 的话，奖励会无差别地抬高所有当时发放的 KC 权重，学出来的是一个**直流偏置**
   * （「总体上该买」），而不是条件反射（「这种模式该买」）—— 实测会把另一条通路彻底压死
   * （买卖比锁死在 225:4）。减去同群均值后，只有「比同群更强」的 KC 被强化，
   * 权重保持零均值，读出变成真正的**模式判别**。
   */
  function learn(pool, predictionError, activation) {
    const w = state.mbon[pool];
    const eta = cfg.learningRate * predictionError;
    if (eta) {
      let sum = 0;
      let n = 0;
      for (let i = 0; i < N; i += 1) if (activation[i] > 0) { sum += activation[i]; n += 1; }
      if (n > 0) {
        const mean = sum / n;
        for (let i = 0; i < N; i += 1) {
          const a = activation[i];
          if (a === 0) continue;
          const next = w[i] + eta * (a - mean);
          w[i] = next > cfg.weightClamp ? cfg.weightClamp : next < -cfg.weightClamp ? -cfg.weightClamp : next;
        }
      }
    }
    scalePool(pool);
  }

  /**
   * 稳态突触缩放 + **去直流**。
   *
   * 两件事都是必须的：
   *  · 缩放：把该通路的 |w| 总和控制回目标值，否则两条通路的「音量」会越差越远。
   *  · 去直流：64 个高斯样本的均值本来就不严格为 0，这个偏置会原封不动地进到读出里，
   *    变成膜电位上的一个恒定偏移 —— 种子一选，就注定了长期是买还是卖（实测某个种子
   *    锁死成 213:5）。而且对比式学习保持权重和为常数，这个偏置**永远不会自己消失**。
   */
  function scalePool(pool) {
    const w = state.mbon[pool];
    let l1 = 0;
    for (let i = 0; i < N; i += 1) l1 += Math.abs(w[i]);
    if (l1 < 1e-9) {
      for (let i = 0; i < N; i += 1) w[i] = hashGauss(`${seedBase}:reseed:${pool}:${i}`);
    }
    let sum = 0;
    for (let i = 0; i < N; i += 1) sum += w[i];
    const mean = sum / N;
    if (Math.abs(mean) > 1e-12) for (let i = 0; i < N; i += 1) w[i] -= mean;
    let total = 0;
    for (let i = 0; i < N; i += 1) total += Math.abs(w[i]);
    const target = cfg.weightNorm * N;
    if (total > 1e-9) {
      const f = target / total;
      if (Math.abs(f - 1) > 1e-9) for (let i = 0; i < N; i += 1) w[i] *= f;
    }
  }

  function snapshot() {
    return {
      membrane: +state.membrane.toFixed(4),
      // 兼容旧前端：正值倾向销毁、负值倾向回购
      score: +state.membrane.toFixed(4),
      kc: snapshotKc(),
      apl: { level: state.aplLevel, ema: +state.aplEma.toFixed(3), gain: +(cfg.aplGain * (1 + cfg.aplAdaptation * Math.min(1, state.aplEma / (N * 0.5)))).toFixed(3) },
      dopamine: {
        plus: +state.dopamine.plus.toFixed(4),
        minus: +state.dopamine.minus.toFixed(4),
        level: +state.dopamine.level.toFixed(4),
        lastReward: state.stats.lastReward,
        meanReward: state.stats.rewardCount ? +(state.stats.rewardSum / state.stats.rewardCount).toFixed(3) : null,
      },
      mbon: { buy: +state.readout.buy.toFixed(5), burn: +state.readout.burn.toFixed(5) },
      // 下行神经元看到的量：原始驱动、慢基线、以及真正进入膜电位的差值
      drive: {
        raw: +state.drive.toFixed(3),
        baseline: +state.driveBaseline.toFixed(3),
        effective: +(state.drive - state.driveBaseline).toFixed(3),
      },
      explore: { buy: +state.exploration.buy.toFixed(3), burn: +state.exploration.burn.toFixed(3) },
      adaptation: { buy: +state.adaptation.buy.toFixed(3), burn: +state.adaptation.burn.toFixed(3) },
      hunger: +state.hunger.toFixed(3),
      /**
       * 唤醒度：只影响「多久出手」，不影响任何一个感觉维度。
       * `volumeRatio` 为 null 表示成交流数据源不可用（此时唤醒度只用价格波动算出来）。
       */
      arousal: {
        level: +state.arousal.level.toFixed(3),
        price: +state.arousal.price.toFixed(3),
        volume: state.arousal.volume === null ? null : +state.arousal.volume.toFixed(3),
        priceRatio: +state.arousal.priceRatio.toFixed(3),
        rms: +(state.arousal.rms ?? 0).toFixed(6),
        volumeRatio: state.arousal.volumeRatio === null ? null : +state.arousal.volumeRatio.toFixed(3),
        thresholdScale: +state.arousal.thresholdScale.toFixed(3),
        refractorySeconds: +(state.arousal.refractorySeconds ?? cfg.refractorySeconds).toFixed(2),
        baselineMinutes: state.activityHist.length,
      },
      energy: { buy: +state.energy.buy.toFixed(3), burn: +state.energy.burn.toFixed(3) },
      sensory: {
        volumeRatio: +state.volumeRatio.toFixed(3),
        trend: +state.trend.toFixed(4),
        position: +state.position.toFixed(4),
        lags: Array.from(state.returnLags, (v) => +v.toFixed(5)),
      },
      pending: state.pending.length,
      blocked: state.blocked,
      lastAction: state.lastAction,
      stats: { actions: state.stats.actions, buy: state.stats.buy, burn: state.stats.burn, updates: state.stats.updates },
      ticks: state.ticks,
    };
  }

  /**
   * 学习成果的持久化。
   *
   * 真正**学出来**的只有 MBON 输出权重：KC 感受野与阈值是先天模板（由 seed 决定，重建即还原），
   * 膜电位 / 适应 / 探索噪声全是瞬态。所以存档只带 MBON + 多巴胺 + 统计量 ——
   * 重启后「先天反射还在、后天经验还在」，但不会把上一轮的瞬态状态掺进来。
   *
   * seed 与 kcCount 一并写进存档：换币（seed 变）或改神经元规模时自动拒绝导入，
   * 不会出现「用上个代币的权重做当前代币决策」这种隐蔽的错误。
   *
   * `dims` 也一并写进存档（version 2 起）：感觉层的**编码方式**一变
   * （例如新增了「位置」维度），「哪个 KC 对什么敏感」就整体改写了，
   * 旧的 MBON 读出不再可比。宁可退回先天模板重跑，也不要带着错位的经验上线。
   */
  function exportState() {
    return {
      version: 2,
      seed: seedBase,
      kcCount: N,
      dims: D,
      mbon: { buy: Array.from(state.mbon.buy), burn: Array.from(state.mbon.burn) },
      dopamine: { ...state.dopamine },
      energyRef: { ...state.energyRef },
      stats: { ...state.stats },
      lastAction: state.lastAction,
    };
  }

  /** 导入一份 `exportState()` 存档；任何字段不匹配都返回 false 并保持现状。 */
  function importState(saved) {
    if (!saved || saved.version !== 2 || saved.seed !== seedBase || saved.kcCount !== N) return false;
    if (Number(saved.dims) !== D) return false; // 感觉层维度变了，旧权重不可比
    for (const pool of ["buy", "burn"]) {
      const src = saved.mbon?.[pool];
      if (!Array.isArray(src) || src.length !== N) return false;
      for (let i = 0; i < N; i += 1) {
        const v = Number(src[i]);
        if (!Number.isFinite(v)) return false;
        state.mbon[pool][i] = v;
      }
      scalePool(pool); // 导入后再归一化一次，防止手工改过的存档把音量改坏
    }
    if (saved.dopamine) state.dopamine = { ...state.dopamine, ...saved.dopamine };
    if (saved.energyRef) state.energyRef = { ...state.energyRef, ...saved.energyRef };
    if (saved.stats) state.stats = { ...state.stats, ...saved.stats };
    state.lastAction = saved.lastAction ?? null;
    return true;
  }

  return {
    step,
    snapshot,
    reset,
    exportState,
    importState,
    get state() { return state; },
    config: cfg,
  };
}
