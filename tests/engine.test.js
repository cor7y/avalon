'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../js/rules.js');
const { Game, createGame, makeRng } = require('../js/engine.js');

// 用指定的角色顺序建局，方便脚本化测试
function fixedGame(roles, options = {}) {
  const n = roles.length;
  const opts = Object.assign(R.defaultOptions(n), { lady: false }, options);
  const names = roles.map((_, i) => `P${i}`);
  return new Game({ n, options: opts, roles, names, humanSeat: null, rng: makeRng(42), seed: 42 });
}

function idsOf(game, pred) {
  return game.players.filter(pred).map((p) => p.id);
}

function voteAll(game, approve) {
  for (let i = 0; i < game.n; i++) game.act(i, { type: 'vote', approve });
}

// 让好人组成一支队伍并完成任务
function goodQuest(game) {
  const team = idsOf(game, (p) => p.team === 'good').slice(0, game.teamSize);
  game.act(game.leader, { type: 'propose', team });
  voteAll(game, true);
  team.forEach((id) => game.act(id, { type: 'quest', success: true }));
}

// 队伍里放一个坏人并让他出失败票
function evilQuest(game, failCount = 1) {
  const evil = idsOf(game, (p) => p.team === 'evil');
  const good = idsOf(game, (p) => p.team === 'good');
  const team = evil.slice(0, failCount).concat(good).slice(0, game.teamSize);
  game.act(game.leader, { type: 'propose', team });
  voteAll(game, true);
  team.forEach((id) => game.act(id, { type: 'quest', success: game.players[id].team === 'good' }));
}

function skipDiscussion(game) {
  while (game.phase === 'discuss') game.act(game.pendingActors()[0], { type: 'speak' });
}

const FIVE = ['merlin', 'percival', 'servant', 'assassin', 'morgana'];

test('规则表：人数、任务人数与双失败票', () => {
  for (let n = 5; n <= 10; n++) {
    assert.equal(R.TEAM_SIZES[n].length, 5);
    const roles = R.buildRoleList(n, R.defaultOptions(n));
    assert.equal(roles.length, n);
    assert.equal(roles.filter((r) => R.ROLES[r].team === 'evil').length, R.EVIL_COUNT[n]);
    assert.ok(roles.includes('merlin') && roles.includes('assassin'));
  }
  assert.equal(R.requiredFails(7, 3), 2);
  assert.equal(R.requiredFails(6, 3), 1);
  assert.equal(R.requiredFails(10, 2), 1);
});

test('规则表：坏人特殊角色超过坏人数量时报错', () => {
  const errs = R.validateOptions(5, { percival: true, morgana: true, mordred: true, oberon: false });
  assert.equal(errs.length, 1);
  assert.throws(() => R.buildRoleList(5, { morgana: true, mordred: true }));
});

test('同一种子生成同样的对局', () => {
  const a = createGame({ numPlayers: 7, seed: 123 });
  const b = createGame({ numPlayers: 7, seed: 123 });
  assert.deepEqual(a.players, b.players);
  assert.equal(a.leader, b.leader);
});

test('可以指定人类玩家的角色', () => {
  for (const role of ['merlin', 'assassin', 'percival', 'morgana']) {
    const g = createGame({ numPlayers: 6, seed: 5, humanSeat: 0, humanRole: role });
    assert.equal(g.players[0].role, role);
    assert.equal(g.players[0].human, true);
  }
  assert.throws(() => createGame({ numPlayers: 5, seed: 5, humanSeat: 0, humanRole: 'oberon' }));
});

test('夜晚信息：梅林看不到莫德雷德，坏人看不到奥伯伦', () => {
  const g = fixedGame(['merlin', 'percival', 'servant', 'servant', 'assassin', 'mordred', 'oberon', 'morgana', 'servant', 'servant'],
    { mordred: true, oberon: true });
  const ids = (k) => k.map((x) => x.id).sort();
  assert.deepEqual(ids(g.knowledgeFor(0)), [4, 6, 7]); // 梅林
  assert.deepEqual(ids(g.knowledgeFor(1)), [0, 7]); // 派西维尔
  assert.deepEqual(ids(g.knowledgeFor(4)), [5, 7]); // 刺客
  assert.deepEqual(ids(g.knowledgeFor(6)), []); // 奥伯伦
  assert.deepEqual(ids(g.knowledgeFor(2)), []); // 忠臣
});

test('玩家视角不泄露隐藏身份', () => {
  const g = fixedGame(FIVE);
  const v = g.viewFor(2);
  assert.equal(v.revealed, null);
  assert.equal(v.evilReveal, null);
  assert.deepEqual(v.knowledge, []);
  const text = JSON.stringify(v);
  for (const role of ['merlin', 'percival', 'assassin', 'morgana']) {
    // 角色名只会出现在本局角色列表 roleKeys 中，不会与具体玩家关联
    assert.equal(text.split(`"${role}"`).length - 1, 1, role);
  }
});

test('组队校验：人数、重复与行动顺序', () => {
  const g = fixedGame(FIVE);
  const other = (g.leader + 1) % 5;
  assert.throws(() => g.act(g.leader, { type: 'propose', team: [0] }));
  assert.throws(() => g.act(g.leader, { type: 'propose', team: [1, 1] }));
  assert.throws(() => g.act(other, { type: 'propose', team: [0, 1] }));
  assert.throws(() => g.act(g.leader, { type: 'vote', approve: true }));
  g.act(g.leader, { type: 'propose', team: [0, 1] });
  assert.equal(g.phase, 'vote');
});

test('连续五次组队被否决，坏人获胜', () => {
  const g = fixedGame(FIVE);
  for (let i = 0; i < 5; i++) {
    g.act(g.leader, { type: 'propose', team: [0, 1] });
    voteAll(g, false);
  }
  assert.equal(g.phase, 'over');
  assert.equal(g.winner, 'evil');
});

test('平票视为否决，队长轮换', () => {
  const g = fixedGame(['merlin', 'percival', 'servant', 'servant', 'assassin', 'morgana']);
  const leader = g.leader;
  g.act(leader, { type: 'propose', team: [0, 1] });
  for (let i = 0; i < 6; i++) g.act(i, { type: 'vote', approve: i < 3 });
  assert.equal(g.phase, 'propose');
  assert.equal(g.leader, (leader + 1) % 6);
  assert.equal(g.attempt, 1);
});

test('好人不能出失败票', () => {
  const g = fixedGame(FIVE);
  g.act(g.leader, { type: 'propose', team: [0, 3] });
  voteAll(g, true);
  assert.throws(() => g.act(0, { type: 'quest', success: false }));
  g.act(0, { type: 'quest', success: true });
  g.act(3, { type: 'quest', success: false });
  assert.equal(g.quests[0].success, false);
  assert.equal(g.phase, 'discuss');
});

test('7 人局第四个任务需要两张失败票', () => {
  const g = fixedGame(['merlin', 'percival', 'servant', 'servant', 'assassin', 'morgana', 'oberon'], { oberon: true });
  goodQuest(g); skipDiscussion(g);
  evilQuest(g, 1); skipDiscussion(g);
  evilQuest(g, 1); skipDiscussion(g);
  assert.equal(g.round, 3);
  assert.equal(g.requiredFails, 2);
  evilQuest(g, 1);
  assert.equal(g.quests[3].fails, 1);
  assert.equal(g.quests[3].success, true);
});

test('三次任务失败，坏人获胜', () => {
  const g = fixedGame(FIVE);
  evilQuest(g); skipDiscussion(g);
  evilQuest(g); skipDiscussion(g);
  evilQuest(g);
  assert.equal(g.winner, 'evil');
  assert.equal(g.endReason, '三次任务失败');
});

test('三次任务成功后进入刺杀；刺中梅林坏人获胜', () => {
  const g = fixedGame(FIVE);
  goodQuest(g); skipDiscussion(g);
  goodQuest(g); skipDiscussion(g);
  goodQuest(g);
  assert.equal(g.phase, 'assassinate');
  assert.deepEqual(g.pendingActors(), [3]);
  const v = g.viewFor(4);
  assert.deepEqual(v.evilReveal.map((x) => x.id), [3, 4]);
  g.act(3, { type: 'assassinate', target: 0 });
  assert.equal(g.winner, 'evil');
});

test('刺客刺错人，好人获胜', () => {
  const g = fixedGame(FIVE);
  goodQuest(g); skipDiscussion(g);
  goodQuest(g); skipDiscussion(g);
  goodQuest(g);
  g.act(3, { type: 'assassinate', target: 1 });
  assert.equal(g.winner, 'good');
});

test('湖中仙女：第二个任务后查验，结果只有持有者可见', () => {
  const g = fixedGame(['merlin', 'percival', 'servant', 'servant', 'assassin', 'morgana', 'minion'], { lady: true, oberon: false });
  const first = g.lady.holder;
  assert.equal(first, (g.leader - 1 + 7) % 7);
  goodQuest(g); skipDiscussion(g);
  assert.equal(g.phase, 'propose');
  goodQuest(g);
  assert.equal(g.phase, 'lady');
  assert.throws(() => g.act(first, { type: 'lady', target: first }));
  const target = (first + 1) % 7;
  const evs = g.act(first, { type: 'lady', target });
  const secret = evs.find((e) => e.type === 'ladyResult');
  assert.deepEqual(secret.to, [first]);
  assert.equal(g.eventsFor(target).some((e) => e.type === 'ladyResult'), false);
  assert.equal(g.phase, 'ladyClaim');
  assert.throws(() => g.act(first, { type: 'ladyClaim', claim: 'maybe' }));
  g.act(first, { type: 'ladyClaim', claim: 'good' });
  assert.equal(g.phase, 'discuss');
  assert.equal(g.lady.holder, target);
  skipDiscussion(g);
  // 下一次不能查验已经拿过湖中仙女的人
  evilQuest(g);
  assert.equal(g.phase, 'lady');
  assert.throws(() => g.act(target, { type: 'lady', target: first }));
});

test('发言校验', () => {
  const g = fixedGame(FIVE);
  evilQuest(g);
  const speaker = g.pendingActors()[0];
  assert.throws(() => g.act(speaker, { type: 'speak', accuse: speaker }));
  const other = (speaker + 1) % 5;
  assert.throws(() => g.act(speaker, { type: 'speak', accuse: other, trust: other }));
  g.act(speaker, { type: 'speak', accuse: other, text: '我怀疑你' });
  assert.equal(g.speeches[0].accuse, other);
});
