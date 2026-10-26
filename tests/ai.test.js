'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../js/rules.js');
const { createGame, makeRng } = require('../js/engine.js');
const AI = require('../js/ai.js');

test('AI 对局在各种人数、角色与难度下都能正常结束', () => {
  const rng = makeRng(2024);
  const counts = { good: 0, evil: 0 };
  for (let g = 0; g < 240; g++) {
    const n = 5 + (g % 6);
    const options = {
      percival: rng() < 0.7, morgana: rng() < 0.7, mordred: rng() < 0.4, oberon: rng() < 0.3, lady: rng() < 0.5,
    };
    while (R.validateOptions(n, options).length) {
      if (options.oberon) options.oberon = false;
      else if (options.mordred) options.mordred = false;
      else options.morgana = false;
    }
    const level = ['easy', 'normal', 'hard'][g % 3];
    const game = createGame({ numPlayers: n, options, seed: g });
    AI.playOut(game, AI.createBots(game, { level }));
    assert.equal(game.phase, 'over');
    assert.ok(game.quests.length >= 3 || game.endReason === '连续五次组队被否决');
    counts[game.winner]++;
  }
  // 双方都应该有机会获胜
  assert.ok(counts.good > 40, JSON.stringify(counts));
  assert.ok(counts.evil > 40, JSON.stringify(counts));
});

test('有人类玩家时，AI 行动到轮到人类为止', () => {
  const game = createGame({ numPlayers: 6, seed: 9, humanSeat: 0 });
  const bots = AI.createBots(game);
  assert.equal(bots[0], null);
  let guard = 0;
  while (AI.stepAI(game, bots)) guard++;
  assert.ok(game.pendingActors().includes(0));
  assert.ok(guard < 50);
});

test('信念模型：失败的两人任务让队友嫌疑上升', () => {
  const b = new AI.Belief(5, 2, (w) => !(w & 1)); // 0 号是好人
  const { toMask, questLik } = AI._internal;
  const team = toMask([0, 1]);
  b.update((w) => questLik(((w & team) ? 1 : 0), 1, 0));
  assert.equal(b.pEvil(1), 1);
  assert.ok(Math.abs(b.pEvil(2) - 1 / 3) < 1e-9);
});

test('坏人在关键任务中一定出失败票', () => {
  const game = createGame({ numPlayers: 5, seed: 77 });
  const evil = game.players.find((p) => p.team === 'evil');
  const bot = new AI.Bot(game.viewFor(evil.id), { rng: makeRng(1) });
  const view = Object.assign(game.viewFor(evil.id), { phase: 'quest', team: [evil.id], successes: 2, round: 2 });
  for (let i = 0; i < 20; i++) assert.equal(bot.quest(view), false);
});

test('好人 AI 在第五次组队时总是赞成', () => {
  const game = createGame({ numPlayers: 5, seed: 78 });
  const good = game.players.find((p) => p.role === 'servant' || p.role === 'percival');
  const bot = new AI.Bot(game.viewFor(good.id), { rng: makeRng(1) });
  const view = Object.assign(game.viewFor(good.id), { phase: 'vote', attempt: 4, team: [0, 1], leader: (good.id + 1) % 5 });
  assert.equal(bot.vote(view), true);
});

test('刺客能从投票中认出"太准"的梅林', () => {
  // 构造一个 5 人局历史：2 号每次都反对含坏人的队伍、赞成干净队伍
  const visible = AI._internal.toMask([3, 4]);
  const proposals = [];
  const add = (team, votes) => proposals.push({ round: 0, attempt: 0, leader: 0, team, votes, approved: true });
  add([0, 3], [true, true, false, true, true]);
  add([1, 4], [true, true, false, true, true]);
  add([0, 1], [true, true, true, false, false]);
  add([0, 1, 4], [true, false, false, true, true]);
  const view = { proposals, speeches: [] };
  const scores = [0, 1, 2].map((c) => AI.merlinScore(c, view, visible));
  assert.equal(scores.indexOf(Math.max(...scores)), 2);
});
