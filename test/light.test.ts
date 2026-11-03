import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkCommand, DEFAULT_LIGHT } from '../src/light.ts';

test('checkCommand normalizes case, spaces and empty items', () => {
  assert.equal(checkCommand('green'), 'GREEN');
  assert.equal(checkCommand(' yellow , slow ; alarm,fast ;'), 'YELLOW,SLOW;ALARM,FAST');
  assert.equal(checkCommand('OFF'), 'OFF');
});

test('checkCommand rejects what the firmware would reject', () => {
  assert.throws(() => checkCommand('PURPLE'), /unknown light name "PURPLE"/);
  assert.throws(() => checkCommand('RED,BLINK'), /unknown light mode "BLINK"/);
  assert.throws(() => checkCommand('OFF,ON'), /OFF takes no mode/);
  assert.throws(() => checkCommand('RED,ON,FAST'), /one NAME\[,MODE\] pair/);
  assert.throws(() => checkCommand(' ; '), /empty light command/);
  assert.throws(() => checkCommand(',ON'), /unknown light name/);
});

test('checkCommand accepts brightness items and normalizes them like the firmware', () => {
  assert.equal(checkCommand('io5=26'), 'IO5=26');
  assert.equal(checkCommand(' IO4 = 100 , slow ; io5=27.5'), 'IO4=100,SLOW;IO5=27.5');
  assert.equal(checkCommand('IO4=100;IO5=26;STRIP=100,40,0'), 'IO4=100;IO5=26;STRIP=100,40,0');
  assert.equal(checkCommand('strip=0,0,0,0,30;strip[0-9]=100,0,0,0,0,fast'), 'STRIP=0,0,0,0,30;STRIP[0-9]=100,0,0,0,0,FAST');
  assert.equal(checkCommand('STRIP[49]=0, 0, 100'), 'STRIP[49]=0,0,100');
  assert.equal(checkCommand('GREEN;IO5=26,on'), 'GREEN;IO5=26');
  assert.equal(checkCommand('IO5=100.0'), 'IO5=100');
});

test('checkCommand rejects brightness items the firmware would reject', () => {
  for (const bad of ['IO6=50', 'IO=50', 'IO5=', 'IO5=101', 'IO5=50,60', 'IO5=50,BLINK', 'IO5=27.55',
                     'STRIP=1,2', 'STRIP=1,2,3,4', 'STRIP=1,2,3,4,5,6', 'STRIP[300]=1,2,3', 'STRIP[5-2]=1,2,3',
                     'STRIP[1-]=1,2,3', 'STRIPE=1,2,3', 'PIXEL=1,2,3']) {
    assert.throws(() => checkCommand(bad), Error, bad);
  }
});

test('every default light command is valid', () => {
  for (const [state, cmd] of Object.entries(DEFAULT_LIGHT)) assert.equal(checkCommand(cmd), cmd, state);
});
