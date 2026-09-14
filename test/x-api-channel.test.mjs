/**
 * test/x-api-channel.test.mjs — X API UserTweets 通道：离线解析器回归测试（进 npm test 门禁）
 *
 * 覆盖 parseUserTweetsTimeline 的纯函数行为（无网络、无 cookie、无凭据）：
 *   - 递归遍历 timeline instructions 收集推文（含 pinned 旧推）
 *   - legacy.full_text 与 note_tweet 长文本的优先级
 *   - created_at → ISO 时间、url 拼接、pinned 旧推按时间处理
 *   - 世界名/作者解析（复用 extractWorldsFromTweetText）、链接世界 ID 提取
 *
 * 需要真实网络/cookie 的用例（真实抓取 + 通道集成）在独立套件 test/test-x-api-channel.mjs
 * （`test-*.mjs` 不被 npm test 收录，需手动 `node test/test-x-api-channel.mjs` 运行）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseUserTweetsTimeline,
  extractWorldsFromTweetText,
  extractWorldIdsFromLinks,
} from '../core/fetch-x-worlds.js';

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
                    content: {
                      entryType: 'TimelineTimelineItem',
                      itemContent: {
                        itemContent: {
                          tweet_results: {
                            result: {
                              __typename: 'Tweet',
                              rest_id: '1001',
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
                    content: {
                      entryType: 'TimelineTimelineItem',
                      itemContent: {
                        itemContent: {
                          tweet_results: {
                            result: {
                              __typename: 'Tweet',
                              rest_id: '2002',
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
                    content: {
                      entryType: 'TimelineTimelineItem',
                      itemContent: {
                        itemContent: {
                          tweet_results: {
                            result: {
                              __typename: 'Tweet',
                              rest_id: '3003',
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

test('parseUserTweetsTimeline：收集全部推文（含 pinned 旧推）', () => {
  const tweets = parseUserTweetsTimeline(mockTimeline, 'Bradlee1011');
  assert.equal(tweets.length, 3);
  const byId = Object.fromEntries(tweets.map((t) => [t.id, t]));
  assert.equal(byId['1001'].id, '1001');
  assert.equal(byId['1001'].time, new Date('Fri Oct 04 12:00:00 +0000 2019').toISOString());
  assert.equal(byId['1001'].url, 'https://x.com/Bradlee1011/status/1001');
});

test('parseUserTweetsTimeline：世界名/作者解析 + 时间 ISO', () => {
  const tweets = parseUserTweetsTimeline(mockTimeline, 'Bradlee1011');
  const byId = Object.fromEntries(tweets.map((t) => [t.id, t]));
  assert.ok(byId['2002'].worldNames.some((n) => n.includes('Noise')));
  assert.equal(byId['2002'].authorName, 'Dal');
  assert.equal(byId['2002'].time, new Date('Sun Sep 14 02:19:43 +0000 2026').toISOString());
});

test('parseUserTweetsTimeline：note_tweet 长文本优先于 legacy.full_text', () => {
  const tweets = parseUserTweetsTimeline(mockTimeline, 'Bradlee1011');
  const byId = Object.fromEntries(tweets.map((t) => [t.id, t]));
  assert.ok(byId['3003'].text.includes('complete content'));
  assert.ok(byId['3003'].worldNames.some((n) => n.includes('Tranquility Lane')));
  assert.equal(byId['3003'].authorName, 'ControVR');
});

test('parseUserTweetsTimeline：按时间排序时 pinned 旧推排最后', () => {
  const tweets = parseUserTweetsTimeline(mockTimeline, 'Bradlee1011');
  const sorted = [...tweets].sort((a, b) => new Date(b.time) - new Date(a.time));
  assert.equal(sorted[0].id, '2002');
  assert.equal(sorted[sorted.length - 1].id, '1001');
});

test('extractWorldsFromTweetText / extractWorldIdsFromLinks：语法兼容性', () => {
  // 博主通用格式：世界名 + 作者在文本里（t.co 指向截图，不是世界链接）
  const parsed = extractWorldsFromTweetText('World name: 翠鳴\nBy: inami haruka\nPlatform: PC\nhttps://t.co/x');
  assert.ok(parsed.worldNames.length >= 1);
  assert.ok(parsed.worldNames.some((n) => n.includes('翠鳴')));

  // 链接里直接给 wrld_id 时也能提取（浏览器/RSS 通道产物）
  const ids = extractWorldIdsFromLinks(['https://vrchat.com/home/world/wrld_ae62af20-8ad0-449e-8191-5ea00f85dd8f']);
  assert.deepEqual(ids, ['wrld_ae62af20-8ad0-449e-8191-5ea00f85dd8f']);
});
