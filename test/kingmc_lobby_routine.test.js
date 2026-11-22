'use strict';

const assert = require('node:assert');
const { isLobbyPosition, getLocationKind, ServerAuth } = require('../src/game/server-auth');
const LobbyNavigator = require('../src/game/lobby-navigator');
const { DISABLED_PLUGINS, DROP_EVENTS } = require('../src/game/packet-optimization');

console.log('--- [KINGMC LOBBY & ANTI-BOT ROUTINE VERIFICATION] ---');

// 1. Verify Packet Optimizations keep chunk and light data for anti-bot ground collision
console.log('1. Verifying Packet Optimization DROP_EVENTS preserves map_chunk & light...');
assert.ok(!DROP_EVENTS.has('map_chunk'), 'map_chunk must NOT be dropped');
assert.ok(!DROP_EVENTS.has('chunk_data'), 'chunk_data must NOT be dropped');
assert.ok(!DROP_EVENTS.has('update_light'), 'update_light must NOT be dropped');
assert.ok(!DROP_EVENTS.has('light_update'), 'light_update must NOT be dropped');
console.log('✅ 1. Packet Optimization preserves chunks and light data.');

// 2. Verify Lobby coordinate detection at 1 41 1 and 0.5 41 0.8
console.log('2. Verifying Lobby Coordinate Detection...');
const lobbyBot1 = { entity: { position: { x: 1, y: 41, z: 1 } } };
const lobbyBot2 = { entity: { position: { x: 0.5, y: 41.0, z: 0.8 } } };
const authBot = { entity: { position: { x: 5, y: 119, z: 4 } } };
const gameBot = { entity: { position: { x: 1000, y: 64, z: -200 } } };

assert.ok(isLobbyPosition(lobbyBot1.entity.position), '1 41 1 must be lobby position');
assert.ok(isLobbyPosition(lobbyBot2.entity.position), '0.5 41 0.8 must be lobby position');
assert.strictEqual(getLocationKind(lobbyBot1), 'lobby', 'Location kind at 1 41 1 must be lobby');
assert.strictEqual(getLocationKind(lobbyBot2), 'lobby', 'Location kind at 0.5 41 0.8 must be lobby');
assert.strictEqual(getLocationKind(authBot), 'login', 'Location kind at 5 119 4 must be login');
assert.strictEqual(getLocationKind(gameBot), 'other', 'Location kind at wilderness must be other');
console.log('✅ 2. Lobby & Game coordinate detection verified.');

// 3. Verify ServerAuth direct /dn sending
console.log('3. Verifying ServerAuth sendDirectAuth...');
const sentChats = [];
const mockBot = {
  chat: (msg) => sentChats.push(msg)
};
const auth = new ServerAuth({
  password: 'TestPassword123',
  enabled: true,
  logger: { info: () => {}, warn: () => {} }
});

const dnSent = auth.sendDirectAuth(mockBot, 'dn');
assert.strictEqual(dnSent, true, 'sendDirectAuth should succeed');
assert.deepStrictEqual(sentChats, ['/dn TestPassword123'], 'Must chat /dn TestPassword123');
console.log('✅ 3. ServerAuth /dn command verified.');

// 4. Verify LobbyNavigator.triggerServerJoin auth gate
console.log('4. Verifying LobbyNavigator auth gate blocks navigation without authentication...');
async function testAuthGate() {
  let joinTriggered = false;
  const mockBot = {
    entity: { position: { x: 1, y: 41, z: 1 } },
    chat: () => { joinTriggered = true; },
    currentWindow: null,
    inventory: { slots: new Array(46).fill(null) },
    heldItem: null,
    quickBarSlot: 0,
    setQuickBarSlot: () => {},
    activateItem: () => {},
    on: () => {},
    once: () => {},
    removeListener: () => {},
    physicsEnabled: true
  };

  // Navigator with auth gate returning false (not authenticated)
  const nav = new LobbyNavigator({
    logger: { info: () => {}, warn: () => {}, debug: () => {} },
    isAuthenticated: () => false
  });

  nav.bot = mockBot;
  nav.triggerServerJoin(mockBot, 'test_unauth');

  // Should not trigger because isReadyForNavigation returns false
  assert.strictEqual(joinTriggered, false, 'Should NOT trigger join when not authenticated');
  assert.strictEqual(nav.serverJoinBusy, false, 'serverJoinBusy must stay false when auth blocked');

  // Now test with authenticated
  const nav2 = new LobbyNavigator({
    logger: { info: () => {}, warn: () => {}, debug: () => {} },
    isAuthenticated: () => true
  });

  let chatsSent = [];
  const mockBot2 = {
    entity: { position: { x: 1, y: 41, z: 1 } },
    chat: (msg) => { chatsSent.push(msg); },
    currentWindow: null,
    inventory: { slots: new Array(46).fill(null) },
    heldItem: null,
    quickBarSlot: 0,
    setQuickBarSlot: () => {},
    activateItem: () => {},
    on: () => {},
    once: (event, cb) => {},
    removeListener: () => {},
    physicsEnabled: true
  };

  nav2.bot = mockBot2;
  nav2.triggerServerJoin(mockBot2, 'test_auth');

  assert.strictEqual(nav2.serverJoinBusy, true, 'serverJoinBusy must be true when authenticated');
  assert.strictEqual(nav2.serverJoinAttempts, 1, 'serverJoinAttempts must increment');

  nav2.clear();
  nav.clear();
  console.log('✅ 4. LobbyNavigator auth gate verified.');
}

testAuthGate().then(() => {
  console.log('🎉 ALL KINGMC ROUTINE TESTS PASSED 100%!');
  process.exit(0);
}).catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
