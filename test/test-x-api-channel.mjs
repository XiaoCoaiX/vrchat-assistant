// 测试 X API UserTweets 通道：离线解析器单测 + 真实网络调用
import { parseUserTweetsTimeline, extractWorldsFromTweetText, extractWorldIdsFromLinks, fetchCreatorViaXApi, fetchCreatorTweets } from '../core/fetch-x-worlds.js';
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

// ── Part A: 离线解析器单测 ──────────────────────────────────
console.log('=== A. parseUserTweetsTimeline 离线单测 ===');

const mockTimeline = {
  data: {
    user: {
      result: {
        __typename: 'User',
        rest_id: '2148219258',
        timeline: {
          timeline: {
            instructions: [
              {
                type: 'TimelineAddEntries',
                entries: [
                  {
                    entryId: 'tweet-1001',
                    sortIndex: '1001',
                    content: {
                      entryType: 'TimelineTimelineItem',
                      itemContent: {
                        itemContent: {
                          tweet_results: {
                            result: {
                              __typename: 'Tweet',
                              rest_id: '1001',
                              core: { user_results: { result: { rest_id: '2148219258' } } },
                              legacy: {
                                id_str: '1001',
                                created_at: 'Fri Oct 04 12:00:00 +0000 2019',
                                full_text: 'This is a pinned tweet from 2019 with no world info',
                                entities: { urls: [], media: [] },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                  {
                    entryId: 'tweet-2002',
                    sortIndex: '2002',
                    content: {
                      entryType: 'TimelineTimelineItem',
                      itemContent: {
                        itemContent: {
                          tweet_results: {
                            result: {
                              __typename: 'Tweet',
                              rest_id: '2002',
                              core: { user_results: { result: { rest_id: '2148219258' } } },
                              legacy: {
                                id_str: '2002',
                                created_at: 'Sun Sep 14 02:19:43 +0000 2026',
                                full_text: 'World name: Noise ⁄ ノイズ\nBy: Dal\nPlatform: PC\n#VRChat #VRChat_world紹介 https://t.co/bkQXCpgrPO',
                                entities: {
                                  urls: [],
                                  media: [{ expanded_url: 'https://pbs.twimg.com/media/screenshot.jpg' }],
                                },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                  {
                    entryId: 'tweet-3003',
                    sortIndex: '3003',
                    content: {
                      entryType: 'TimelineTimelineItem',
                      itemContent: {
                        itemContent: {
                          tweet_results: {
                            result: {
                              __typename: 'Tweet',
                              rest_id: '3003',
                              core: { user_results: { result: { rest_id: '2148219258' } } },
                              note_tweet: {
                                note_tweet_results: {
                                  result: {
                                    text: 'World name: Tranquility Lane （Fallout 3）\nBy: ControVR\nPlatform: PC & Quest\nThis is a very long tweet that exceeds the legacy full_text limit and requires note_tweet expansion to read the complete content. The world is amazing and you should try it!',
                                  },
                                },
                              },
                              legacy: {
                                id_str: '3003',
                                created_at: 'Sat Sep 13 10:00:00 +0000 2026',
                                full_text: 'World name: Tranquility Lane （Fallout 3）\nBy: ControVR\nPlatform: PC & Quest\nThis is a very long tweet that exceeds the legacy…',
                                entities: { urls: [], media: [] },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                ],
              },
            ],
          },
        },
      },
    },
  },
};

const tweets = parseUserTweetsTimeline(mockTimeline, 'Bradlee1011');

assert(`解析出 3 条推文（含 pinned 旧推）`, tweets.length === 3);

const byId = Object.fromEntries(tweets.map(t => [t.id, t]));

assert('推文 1001 (pinned) id 正确', byId['1001']?.id === '1001');
assert('推文 1001 time 为 ISO 格式', byId['1001']?.time === new Date('Fri Oct 04 12:00:00 +0000 2019').toISOString());
assert('推文 1001 url 格式正确', byId['1001']?.url === 'https://x.com/Bradlee1011/status/1001');

assert('推文 2002 世界名解析', byId['2002']?.worldNames.some(n => n.includes('Noise')));
assert('推文 2002 作者解析', byId['2002']?.authorName === 'Dal');
assert('推文 2002 time ISO 格式', byId['2002']?.time === new Date('Sun Sep 14 02:19:43 +0000 2026').toISOString());

assert('推文 3003 (note_tweet) 使用长文本', byId['3003']?.text.includes('complete content'));
assert('推文 3003 世界名从 note_tweet 解析', byId['3003']?.worldNames.some(n => n.includes('Tranquility Lane')));
assert('推文 3003 作者从 note_tweet 解析', byId['3003']?.authorName === 'ControVR');

const sorted = [...tweets].sort((a, b) => new Date(b.time) - new Date(a.time));
assert('按时间排序后最新为推文 2002', sorted[0].id === '2002');
assert('pinned 旧推排在最后', sorted[sorted.length - 1].id === '1001');

console.log(`\n  离线单测结果：${pass} pass / ${fail} fail\n`);

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
