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

test('checkCommand accepts IO ramps and normalizes them', () => {
  assert.equal(checkCommand('io4=ramp,50,100,1250ms'), 'IO4=RAMP,50,100,1250MS');
  assert.equal(checkCommand('IO4 = RAMP , 40 , on'), 'IO4=RAMP,40');
  assert.equal(checkCommand('IO5=RAMP,27.5,40,FAST,100MS'), 'IO5=RAMP,27.5,40,FAST,100MS');
  assert.equal(checkCommand('io4=pulse,50,100,6000ms'), 'IO4=PULSE,50,100,6000MS');
});

test('checkCommand rejects IO ramps the firmware would reject', () => {
  for (const bad of ['IO4=RAMP', 'IO4=RAMP,', 'IO4=RAMP,1,2,3', 'IO4=RAMP,50,100,OFF', 'IO4=RAMP,50,100,99MS',
                     'IO4=RAMP,50,100,60001MS', 'IO4=RAMP,50,1250', 'IO4=RAMPS,50', 'IO4=50,RAMP', 'IO6=RAMP,50',
                     'IO4=PULSE', 'IO4=PULSE,1,2,3', 'IO4=PULSES,50']) {
    assert.throws(() => checkCommand(bad), Error, bad);
  }
});

test('checkCommand accepts strip effects with their options', () => {
  assert.equal(checkCommand('STRIP[12]=ramp,2/0/0,6/0/0,1250ms'), 'STRIP[12]=RAMP,2/0/0,6/0/0,1250MS');
  assert.equal(checkCommand('strip=fire,fast'), 'STRIP=FIRE,FAST');
  assert.equal(checkCommand('STRIP=LIGHT,3000K,20'), 'STRIP=LIGHT,3000K,20');
  assert.equal(checkCommand('STRIP=STROBE,25HZ,ON'), 'STRIP=STROBE,25HZ');
  assert.equal(checkCommand('STRIP[0-9]=TWINKLE,SLOW,WARM,0/0/10.0'), 'STRIP[0-9]=TWINKLE,SLOW,WARM,0/0/10');
  assert.equal(checkCommand('STRIP=RAMP'), 'STRIP=RAMP');
  assert.equal(checkCommand('strip=sparkle,0/0/0/0/40'), 'STRIP=SPARKLE,0/0/0/0/40');
  assert.equal(
    checkCommand('IO4=PULSE,50,100,6000MS;IO5=PULSE,13,26,6000MS;STRIP=0,0,0,3,0;STRIP[12]=PULSE,1/0.4/0,5/2/0,6000MS'),
    'IO4=PULSE,50,100,6000MS;IO5=PULSE,13,26,6000MS;STRIP=0,0,0,3,0;STRIP[12]=PULSE,1/0.4/0,5/2/0,6000MS',
  );
  assert.equal(
    checkCommand('IO4=RAMP,50,100,1250MS;STRIP=0,0,0,3,0;STRIP[12]=RAMP,2/0/0,6/0/0,1250MS'),
    'IO4=RAMP,50,100,1250MS;STRIP=0,0,0,3,0;STRIP[12]=RAMP,2/0/0,6/0/0,1250MS',
  );
});

test('checkCommand rejects strip effects the firmware would reject', () => {
  const nine = Array.from({ length: 9 }, (_, i) => `STRIP[${i}]=FIRE`).join(';');
  for (const bad of ['STRIP=FIRE,OFF', 'STRIP=FIRE,HOT', 'STRIP=LASER,1/2', 'STRIP=LASER,RED,BLUE,GREEN',
                     'STRIP=RAMP,50MS', 'STRIP=RAMP,1.5MS', 'STRIP=LIGHT,999K', 'STRIP=STROBE,61HZ', 'STRIP=BOGUS',
                     nine, `STRIP=RAMP,${'0/0/0/0/0,'.repeat(10)}`]) {
    assert.throws(() => checkCommand(bad), Error, bad);
  }
});

test('checkCommand accepts PIX items on physical pixels, which may run backwards', () => {
  assert.equal(checkCommand('pix[13-14]=0,5,0'), 'PIX[13-14]=0,5,0');
  assert.equal(checkCommand('PIX[38-20]=fire,fast'), 'PIX[38-20]=FIRE,FAST');
  assert.equal(
    checkCommand('IO4=RAMP,50,100,1250MS;STRIP=0,0,0,3,0;PIX[13-14]=RAMP,2/0/0,6/0/0,1250MS'),
    'IO4=RAMP,50,100,1250MS;STRIP=0,0,0,3,0;PIX[13-14]=RAMP,2/0/0,6/0/0,1250MS',
  );
  assert.equal(checkCommand('PIX=0,0,0'), 'PIX=0,0,0');
  for (const bad of ['PIX[300]=1,2,3', 'PIX[1-]=1,2,3', 'PIXEL[1]=1,2,3', 'PIX[1]=1,2', 'STRIP[5-2]=1,2,3']) {
    assert.throws(() => checkCommand(bad), Error, bad);
  }
});
