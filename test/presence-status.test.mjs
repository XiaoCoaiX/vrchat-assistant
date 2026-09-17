/**
 * presence-status.test.mjs — presence-status 插件回归（按自我在场切换自定义状态描述）
 *
 * 覆盖：纯函数（模板选择 / 轮询间隔钳制 / 模板校验 / 冷却判定）+ register() 行为
 *      （工具注册、默认关闭不动作、三态分支、文案未变不提交、写前核对、参数校验）。
 * 自包含：手写最小 fake api（db / vrchat.fetch / consume 全为可断言的替身），
 * 不触网、不写生产库。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import register, {
  pickTemplate,
  clampPollSeconds,
  isValidTemplate,
  isWithinCooldown,
} from '../plugins/official/presence-status/index.js';

const SELF = 'usr_me_test';

function makeDb() {
  const rows = new Map();
  const handle = {
    all: () => [...rows.entries()].map(([cfg_key, cfg_val]) => ({ cfg_key, cfg_val })),
    // 真仓库用命名参数（$k/$v）；fake 只断言"键与值被写入"
    run: (_sql, params = {}) => { rows.set(params.$k, params.$v); },
  };
  return { table: () => handle, __rows: rows };
}

function makeApi({ presence = { state: 'not_in_game', location: 'offline:offline' }, user = { id: SELF, status: 'join me', statusDescription: '' }, serviceAvailable = true } = {}) {
  const tools = new Map();
  const fetchCalls = [];
  const logs = [];
  const api = {
    db: makeDb(),
    registerTool: (def) => tools.set(def.name, def),
    log: (m) => logs.push(String(m)),
    hasService: () => serviceAvailable,
    consume: async () => presence,
    vrchat: {
      fetch: async (path, opts) => {
        fetchCalls.push({ path, opts });
        if (path === '/auth/user') return { ...user };
        return { ok: true };
      },
    },
  };
  return { api, tools, fetchCalls, logs };
}

// ── 纯函数 ────────────────────────────────────────────────────────────────
test('pickTemplate：按三态选模板，unknown 不改现状（空串）', () => {
  const cfg = { inGameTemplate: 'A', idleTemplate: 'B' };
  assert.equal(pickTemplate(cfg, 'in_game'), 'A');
  assert.equal(pickTemplate(cfg, 'not_in_game'), 'B');
  assert.equal(pickTemplate(cfg, 'unknown'), '');
});

test('clampPollSeconds：默认兜底 + 上下限钳制', () => {
  assert.equal(clampPollSeconds(undefined), 60);
  assert.equal(clampPollSeconds('abc'), 60);
  assert.equal(clampPollSeconds(0), 60);
  assert.equal(clampPollSeconds(5), 20);      // 下限
  assert.equal(clampPollSeconds(99999), 3600); // 上限
  assert.equal(clampPollSeconds(120), 120);
});

test('isValidTemplate：非空字符串且 ≤64 字符', () => {
  assert.equal(isValidTemplate('挂机中'), true);
  assert.equal(isValidTemplate(''), false);
  assert.equal(isValidTemplate('   '), false);
  assert.equal(isValidTemplate(123), false);
  assert.equal(isValidTemplate('x'.repeat(64)), true);
  assert.equal(isValidTemplate('x'.repeat(65)), false);
});

test('isWithinCooldown：manual 直通，未写过不算冷却，间隔内算冷却', () => {
  const now = 1_000_000;
  assert.equal(isWithinCooldown({ lastApplyAt: now - 1000, now }), true);
  assert.equal(isWithinCooldown({ lastApplyAt: now - 1000, now, manual: true }), false);
  assert.equal(isWithinCooldown({ lastApplyAt: 0, now }), false);
  assert.equal(isWithinCooldown({ lastApplyAt: now - 70_000, now }), false);
});

// ── register 行为 ─────────────────────────────────────────────────────────
test('register：注册两个工具并返回 dispose', () => {
  const { api, tools } = makeApi();
  const dispose = register(api);
  assert.deepEqual([...tools.keys()].sort(), ['get_presence_status', 'set_presence_status']);
  assert.equal(typeof dispose, 'function');
  dispose();
});

test('默认关闭：set_presence_status 不触发任何 VRChat 调用', async () => {
  const { api, tools, fetchCalls } = makeApi();
  const dispose = register(api);
  const res = await tools.get('set_presence_status').handler({});
  assert.equal(res.config.enabled, false);
  assert.equal(res.syncResult.reason, 'disabled');
  assert.equal(fetchCalls.length, 0);
  dispose();
});

test('开启且在游戏内 → PUT 用 inGameTemplate，且保留 status 种类不改在线形态', async () => {
  const { api, tools, fetchCalls } = makeApi({ presence: { state: 'in_game', location: 'wrld_abc:1', worldId: 'wrld_abc' } });
  const dispose = register(api);
  await tools.get('set_presence_status').handler({ enabled: true, inGameTemplate: '在玩', idleTemplate: '挂机' });
  const put = fetchCalls.find(c => c.opts && c.opts.method === 'PUT');
  assert.ok(put, '应发生一次 PUT');
  assert.equal(put.path, `/users/${SELF}`);
  assert.deepEqual(put.opts.body, { statusDescription: '在玩', status: 'join me' });
  dispose();
});

test('只在网页端在线 → PUT 用 idleTemplate', async () => {
  const { api, tools, fetchCalls } = makeApi({ presence: { state: 'not_in_game', location: 'offline:offline' } });
  const dispose = register(api);
  await tools.get('set_presence_status').handler({ enabled: true, inGameTemplate: '在玩', idleTemplate: '挂机中' });
  const put = fetchCalls.find(c => c.opts && c.opts.method === 'PUT');
  assert.equal(put.opts.body.statusDescription, '挂机中');
  dispose();
});

test('unknown（无法判定）→ 不动现状，不发 PUT', async () => {
  const { api, tools, fetchCalls } = makeApi({ presence: { state: 'unknown' } });
  const dispose = register(api);
  const res = await tools.get('set_presence_status').handler({ enabled: true });
  assert.equal(res.syncResult.reason, 'state-unknown');
  assert.equal(fetchCalls.filter(c => c.opts && c.opts.method === 'PUT').length, 0);
  dispose();
});

test('文案未变化 → 第二次同步跳过且不再 PUT', async () => {
  const { api, tools, fetchCalls } = makeApi();
  const dispose = register(api);
  await tools.get('set_presence_status').handler({ enabled: true, idleTemplate: '挂机中' });
  const before = fetchCalls.filter(c => c.opts && c.opts.method === 'PUT').length;
  const res = await tools.get('set_presence_status').handler({ idleTemplate: '挂机中' });
  assert.equal(res.syncResult.reason, 'unchanged');
  assert.equal(fetchCalls.filter(c => c.opts && c.opts.method === 'PUT').length, before);
  dispose();
});

test('写前核对：当前文案已等于目标值 → 只记基线，不重复 PUT', async () => {
  const { api, tools, fetchCalls } = makeApi({ user: { id: SELF, status: 'active', statusDescription: '挂机中' } });
  const dispose = register(api);
  const res = await tools.get('set_presence_status').handler({ enabled: true, idleTemplate: '挂机中' });
  assert.equal(res.syncResult.reason, 'already-set');
  assert.equal(fetchCalls.filter(c => c.opts && c.opts.method === 'PUT').length, 0);
  dispose();
});

test('缺少核心 selfPresence 服务 → 明确跳过（不静默、不误改）', async () => {
  const { api, tools, fetchCalls } = makeApi({ serviceAvailable: false });
  const dispose = register(api);
  const res = await tools.get('set_presence_status').handler({ enabled: true });
  assert.equal(res.syncResult.reason, 'no-self-presence-service');
  assert.equal(fetchCalls.length, 0);
  dispose();
});

test('参数校验：类型/长度/数字非法时拒绝且不写入', async () => {
  const { api, tools } = makeApi();
  const dispose = register(api);
  const set = tools.get('set_presence_status');
  assert.equal((await set.handler({ enabled: 'yes' })).ok, false);
  assert.equal((await set.handler({ inGameTemplate: '' })).ok, false);
  assert.equal((await set.handler({ idleTemplate: 'x'.repeat(65) })).ok, false);
  assert.equal((await set.handler({ pollSeconds: 'abc' })).ok, false);
  const cfg = (await tools.get('get_presence_status').handler()).config;
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.pollSeconds, 60);
  dispose();
});

test('get_presence_status：返回配置、在场判定与最近应用信息', async () => {
  const { api, tools } = makeApi({ presence: { state: 'in_game', location: 'wrld_abc:1', worldId: 'wrld_abc' } });
  const dispose = register(api);
  await tools.get('set_presence_status').handler({ enabled: true, inGameTemplate: '在玩' });
  const res = await tools.get('get_presence_status').handler();
  assert.equal(res.serviceAvailable, true);
  assert.equal(res.config.enabled, true);
  assert.equal(res.presence.state, 'in_game');
  assert.equal(res.lastText, '在玩');
  assert.equal(res.lastAppliedAt.length > 0, true);
  dispose();
});

test('配置跨重启保留（重载后 enabled/lastText 从插件表恢复）', async () => {
  const { api, tools } = makeApi();
  const d1 = register(api);
  await tools.get('set_presence_status').handler({ enabled: true, idleTemplate: '挂机中' });
  d1();
  // 用同一个 api（同一份 db）重新 register，模拟热重载
  const tools2 = new Map();
  const api2 = { ...api, registerTool: (def) => tools2.set(def.name, def) };
  const d2 = register(api2);
  const res = await tools2.get('get_presence_status').handler();
  assert.equal(res.config.enabled, true);
  assert.equal(res.lastText, '挂机中');
  d2();
});
