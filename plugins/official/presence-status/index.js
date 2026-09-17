/**
 * presence-status —— 按「自己是否在游戏内」自动切换自定义状态描述
 * =====================================================================
 * 需求：使用者常驻挂着本服务（云服务器 24h 在线），自己的 VRChat 状态因此长期显示
 * "在网站上活跃"。使用者希望**在游戏内**和**只在网页端在线（挂机）**这两种情况
 * 显示不同的自定义状态描述，一眼能看出人到底在不在游戏里。
 *
 * 为什么做成插件（DEVELOPMENT.md §1.1 贡献模型）：这是具体业务功能，必须落插件；
 * 插件经 `api.consume('dashboard.selfPresence')` 复用核心的自我在场判定
 * （三态 in_game / not_in_game / unknown，见 core/self-presence.js），
 * 状态写入经 `api.vrchat.fetch`（核心注入登录态 + 自动限流）。
 *
 * 为什么是轮询：插件契约 v1.3 的 8 个 API 面没有「事件订阅」能力，插件只能
 * `api.consume` 拉取核心服务；因此本插件按 pollSeconds（默认 60s，下限 20s）轮询
 * 在场状态。轮询成本 = 一次本地 SQL 查询（不产生 VRChat API 调用），只有文案真正
 * 变化时才发生一次 /auth/user + PUT /users/{id}。要秒级切换需先给插件加事件订阅面
 * （架构级改动，按 DEVELOPMENT.md §1 应先开 issue 讨论）。
 *
 * 安全与不变量：
 *   - 只改 `statusDescription`（自定义状态文字），并把当前 `status` 种类原样回传，
 *     不改变在线形态（与核心动态状态引擎同口径）；
 *   - PUT 之间最小间隔 65s（与核心 status-sync 同阈值），文案不变不提交；
 *   - 三态里的 `unknown`（无法确认是否在游戏、位置记录陈旧）**不翻转**现状，保持
 *     上一次写入的文案；
 *   - 默认 enabled=false，需使用者显式开启。
 *
 * 工具：get_presence_status（查询配置/在场/最近应用）、set_presence_status（改配置）。
 */
const DEFAULT_CONFIG = Object.freeze({
  enabled: false,
  inGameTemplate: '在玩 VRChat，可能看不到消息',
  idleTemplate: '挂机中（服务在线）',
  pollSeconds: 60,
});

const MIN_POLL_SECONDS = 20;
const MAX_POLL_SECONDS = 3600;
/** 两次 PUT 的最小间隔（与 core/status-sync.js 的 65s 同口径，避免高频改状态） */
const MIN_APPLY_INTERVAL_MS = 65 * 1000;
/** VRChat statusDescription 上限（与核心 set_dynamic_status 一致） */
const MAX_TEMPLATE_CHARS = 64;
/** 启动后延迟首跑：等核心完成登录态就绪与 WS 建连 */
const BOOT_DELAY_MS = 5 * 1000;

/**
 * 按在场状态选模板（纯函数，便于单测）。
 * unknown → 返回空串 = 不改现状（保守）。
 * @param {{inGameTemplate: string, idleTemplate: string}} config
 * @param {'in_game'|'not_in_game'|'unknown'} state
 * @returns {string}
 */
export function pickTemplate(config, state) {
  if (state === 'in_game') return config.inGameTemplate || '';
  if (state === 'not_in_game') return config.idleTemplate || '';
  return '';
}

/** pollSeconds 规整：非数字/非法回落默认，越界钳到 [20, 3600]（纯函数，便于单测） */
export function clampPollSeconds(value, fallback = DEFAULT_CONFIG.pollSeconds) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(MAX_POLL_SECONDS, Math.max(MIN_POLL_SECONDS, Math.round(n)));
}

/** 模板校验：字符串、去空白后非空且不超过 64 字符（纯函数，便于单测） */
export function isValidTemplate(value) {
  return typeof value === 'string'
    && value.trim().length > 0
    && [...value].length <= MAX_TEMPLATE_CHARS;
}

/** 是否处于两次 PUT 之间的最小间隔内（纯函数，便于单测） */
export function isWithinCooldown({ lastApplyAt = 0, now = Date.now(), manual = false, minIntervalMs = MIN_APPLY_INTERVAL_MS } = {}) {
  if (manual) return false;
  if (!lastApplyAt) return false;
  return now - lastApplyAt < minIntervalMs;
}

export default function register(api) {
  const cfg = api.db.table('settings');

  const readRaw = () => {
    const rows = cfg.all('SELECT cfg_key, cfg_val FROM settings');
    const out = {};
    for (const r of rows) out[r.cfg_key] = r.cfg_val;
    return out;
  };

  const writeRaw = (key, val) => {
    // 命名参数（仓库惯例：core/storage.js 的 _normParams 只支持 $name 形式，位置参数 ? 不生效）
    cfg.run('INSERT OR REPLACE INTO settings (cfg_key, cfg_val, updated_at) VALUES ($k, $v, datetime(\'now\'))',
      { $k: key, $v: String(val) });
  };

  function readConfig() {
    const raw = readRaw();
    return {
      enabled: raw.enabled === 'true',
      inGameTemplate: isValidTemplate(raw.inGameTemplate) ? raw.inGameTemplate : DEFAULT_CONFIG.inGameTemplate,
      idleTemplate: isValidTemplate(raw.idleTemplate) ? raw.idleTemplate : DEFAULT_CONFIG.idleTemplate,
      pollSeconds: clampPollSeconds(raw.pollSeconds),
    };
  }

  // 进程内状态：最近一次成功写入的文案（跨重启由 api.db 恢复，避免重启后重复 PUT）
  let appliedText = '';
  try {
    const persisted = readRaw().lastText || '';
    if (typeof persisted === 'string') appliedText = persisted;
  } catch { /* 首次加载无表数据 */ }
  let lastApplyAt = 0;
  let lastError = '';
  let lastState = '';

  /** 执行一次同步：读在场状态 → 选模板 → 变化时才 PUT 自己的 statusDescription */
  async function applyStatus({ manual = false } = {}) {
    const config = readConfig();
    if (!config.enabled) return { action: 'skipped', reason: 'disabled' };

    if (!api.hasService('dashboard.selfPresence')) {
      return { action: 'skipped', reason: 'no-self-presence-service' };
    }
    let presence = null;
    try {
      presence = await api.consume('dashboard.selfPresence');
    } catch (err) {
      lastError = `consume 失败: ${err.message}`;
      return { action: 'skipped', reason: 'consume-failed', detail: lastError };
    }
    const state = (presence && presence.state) || 'unknown';
    lastState = state;
    const text = pickTemplate(config, state);
    // unknown（无法确认）→ 不翻转现状
    if (!text) return { action: 'skipped', reason: `state-${state}` };
    if (text === appliedText) return { action: 'skipped', reason: 'unchanged', state };

    const now = Date.now();
    if (isWithinCooldown({ lastApplyAt, now, manual })) {
      return { action: 'skipped', reason: 'cooldown', nextInMs: MIN_APPLY_INTERVAL_MS - (now - lastApplyAt), state };
    }

    try {
      const me = await api.vrchat.fetch('/auth/user');
      if (!me || !me.id) throw new Error('无法读取当前用户');
      const current = typeof me.statusDescription === 'string' ? me.statusDescription : '';
      if (current === text) {
        // 别处已经写成同一文案（如手动改过）→ 只记基线，不重复提交
        appliedText = text;
        writeRaw('lastText', text);
        return { action: 'skipped', reason: 'already-set', state };
      }
      await api.vrchat.fetch(`/users/${encodeURIComponent(me.id)}`, {
        method: 'PUT',
        // 只改自定义状态文字，status 种类原样带回，不改变在线形态
        body: { statusDescription: text, status: me.status || 'active' },
      });
      appliedText = text;
      lastApplyAt = Date.now();
      lastError = '';
      writeRaw('lastText', text);
      writeRaw('lastState', state);
      writeRaw('lastAppliedAt', new Date().toISOString());
      api.log(`presence-status: 状态描述已切换（${state}）→ ${text}`);
      return { action: 'applied', state, statusDescription: text, at: new Date().toISOString() };
    } catch (err) {
      lastError = String((err && err.message) || err);
      api.log(`presence-status: 状态描述写入失败：${lastError}`);
      return { action: 'failed', reason: 'put-failed', detail: lastError, state };
    }
  }

  let timer = null;
  function reschedule() {
    if (timer) { clearInterval(timer); timer = null; }
    const config = readConfig();
    if (!config.enabled) return;
    timer = setInterval(() => { applyStatus().catch(() => {}); }, config.pollSeconds * 1000);
    if (typeof timer.unref === 'function') timer.unref();
  }

  // ── MCP 工具 ─────────────────────────────────────────────────────────
  api.registerTool({
    name: 'get_presence_status',
    description: '[query] 查询「按自己是否在游戏内自动切换自定义状态描述」的配置与最近一次应用结果（含核心自我在场判定：in_game 在游戏内 / not_in_game 只在网页端在线 / unknown 无法判定）。',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      let presence = null;
      if (api.hasService('dashboard.selfPresence')) {
        try { presence = await api.consume('dashboard.selfPresence'); } catch { /* 服务异常时只报配置 */ }
      }
      return {
        plugin: 'presence-status',
        config: readConfig(),
        presence,
        lastState: lastState || (readRaw().lastState || ''),
        lastText: appliedText,
        lastAppliedAt: (readRaw().lastAppliedAt || ''),
        lastError,
        minApplyIntervalMs: MIN_APPLY_INTERVAL_MS,
        serviceAvailable: api.hasService('dashboard.selfPresence'),
      };
    },
  });

  api.registerTool({
    name: 'set_presence_status',
    description: '[manage] 设置「按自己是否在游戏内自动切换自定义状态描述」：enabled 开关（默认关闭）、inGameTemplate 在游戏内文案、idleTemplate 挂机文案（各 ≤64 字符，只改状态文字不改在线形态）、pollSeconds 轮询间隔秒（默认 60，下限 20）、syncNow 保存后是否立即同步一次（默认 true）。',
    inputSchema: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean', description: '是否启用自动切换（默认关闭）' },
        inGameTemplate: { type: 'string', description: '在游戏内时写入的自定义状态文字（≤64 字符）' },
        idleTemplate: { type: 'string', description: '只在网页端在线（挂机）时写入的自定义状态文字（≤64 字符）' },
        pollSeconds: { type: 'number', description: '轮询在场状态的间隔秒数（默认 60，下限 20，上限 3600）' },
        syncNow: { type: 'boolean', description: '保存后立即同步一次（默认 true）' },
      },
    },
    destructive: false,
    handler: async (args = {}) => {
      if (args.enabled !== undefined && typeof args.enabled !== 'boolean') {
        return { ok: false, error: 'enabled 必须是 boolean' };
      }
      for (const key of ['inGameTemplate', 'idleTemplate']) {
        if (args[key] !== undefined && !isValidTemplate(args[key])) {
          return { ok: false, error: `${key} 必须是非空字符串且不超过 ${MAX_TEMPLATE_CHARS} 字符` };
        }
      }
      if (args.pollSeconds !== undefined && !Number.isFinite(Number(args.pollSeconds))) {
        return { ok: false, error: 'pollSeconds 必须是数字' };
      }

      if (args.enabled !== undefined) writeRaw('enabled', args.enabled ? 'true' : 'false');
      if (args.inGameTemplate !== undefined) writeRaw('inGameTemplate', args.inGameTemplate);
      if (args.idleTemplate !== undefined) writeRaw('idleTemplate', args.idleTemplate);
      if (args.pollSeconds !== undefined) writeRaw('pollSeconds', String(clampPollSeconds(args.pollSeconds)));

      reschedule();
      const config = readConfig();
      const syncResult = (args.syncNow === false)
        ? { action: 'skipped', reason: 'not-sync-now' }
        : await applyStatus({ manual: true });
      return { ok: true, config, syncResult };
    },
  });

  reschedule();
  const boot = setTimeout(() => { applyStatus().catch(() => {}); }, BOOT_DELAY_MS);
  if (typeof boot.unref === 'function') boot.unref();

  api.log(`presence-status: 已加载（enabled=${readConfig().enabled}，pollSeconds=${readConfig().pollSeconds}）`);

  return function dispose() {
    if (timer) { clearInterval(timer); timer = null; }
    clearTimeout(boot);
  };
}
