// X API UserTweets 通道：真实网络抓取 + 通道集成测试（需 data/x_cookie.txt；离线解析器单测见 x-api-channel.test.mjs）
import { fetchCreatorViaXApi, fetchCreatorTweets } from '../core/fetch-x-worlds.js';
import fs from 'node:fs';
import path from 'node:path';

if (!process.env.VRC_MONITOR_HTTP_PROXY) {
  process.env.VRC_MONITOR_HTTP_PROXY = 'http://127.0.0.1:7892';
}

let pass = 0, fail = 0;
function assert(label, cond) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}`); }
}

// 注：解析器离线单测已迁至 test/x-api-channel.test.mjs（带 .test 段，进 npm test / CI 门禁，issue #190）；
//     本文件保留需要真实网络与 cookie 的用例（Part B 真实抓取 / Part C 通道集成），手动运行。

// ── Part B: 真实网络调用测试 ──────────────────────────────────
console.log('=== B. 真实网络调用 @Bradlee1011 ===');

const cookiePath = path.join(import.meta.dirname || path.dirname(new URL(import.meta.url).pathname), '..', 'data', 'x_cookie.txt');
let cookieExists = false;
try {
  fs.accessSync(cookiePath);
  cookieExists = true;
} catch { cookieExists = false; }

if (!cookieExists) {
  console.log('  ⚠ data/x_cookie.txt 不存在，跳过网络测试');
} else {
  try {
    const result = await fetchCreatorViaXApi('Bradlee1011');
    const count = result.length;
    console.log(`  返回条数：${count}`);

    assert(`返回条数 >= 5`, count >= 5);

    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000);
    const recentTweets = result.filter(t => t.time && new Date(t.time) > sevenDaysAgo);
    assert(`至少一条推文在最近 7 天内`, recentTweets.length >= 1);

    const worldTweets = result.filter(t => t.text && t.text.includes('World name:'));
    assert(`含 "World name:" 的推文 >= 3`, worldTweets.length >= 3);

    if (result.length > 0) {
      const sorted = [...result].sort((a, b) => new Date(b.time) - new Date(a.time));
      const latest = sorted[0];
      const utcTime = new Date(latest.time).toISOString();
      const utc8 = new Date(new Date(latest.time).getTime() + 8 * 3600000).toISOString().replace('Z', '+08:00');
      console.log(`  最新推文时间：UTC ${utcTime} / UTC+8 ${utc8}`);
    }

    console.log('  前 3 条文本摘要：');
    const sorted = [...result].sort((a, b) => new Date(b.time) - new Date(a.time));
    for (const t of sorted.slice(0, 3)) {
      const summary = (t.text || '').replace(/\n/g, ' ').slice(0, 80);
      console.log(`    [${t.time}] ${summary}`);
    }
  } catch (e) {
    console.log(`  ✗ 网络调用失败：${e.message}`);
    fail++;
  }
}

// ── Part C: 通道集成测试（fetchCreatorTweets 应优先走 X API 通道）──
console.log('\n=== C. fetchCreatorTweets 通道集成（source 应为 x_api）===');
if (!cookieExists) {
  console.log('  ⚠ data/x_cookie.txt 不存在，跳过集成测试');
} else {
  try {
    const r = await fetchCreatorTweets('Bradlee1011');
    console.log(`  source=${r.source} tweets=${r.tweets.length}`);
    assert('集成：source 为 x_api', r.source === 'x_api');
    assert('集成：tweets >= 5', r.tweets.length >= 5);
    assert('集成：返回条目含 id/text/time 字段', r.tweets.every(t => t.id && t.text && t.time));
  } catch (e) {
    console.log(`  ✗ 集成测试失败：${e.message}`);
    fail++;
  }
}

console.log(`\n=== 总计：${pass} pass / ${fail} fail ===`);
process.exit(fail > 0 ? 1 : 0);
