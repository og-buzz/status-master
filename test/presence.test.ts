import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyPoll, plainMessage, toState, type GraphPresence, type Person } from '../src/presence.ts';

const ann: Person = { id: 'id-ann', upn: 'ann@example.com', displayName: 'Ann Example' };
const bob: Person = { id: 'id-bob', upn: 'bob@example.com', displayName: 'Bob Example' };
const pres = (id: string, availability: string, activity = availability, extra: Partial<GraphPresence> = {}) => ({
  id,
  availability,
  activity,
  ...extra,
});

test('toState maps every Graph availability, and unknown values to unknown', () => {
  assert.equal(toState('Available'), 'available');
  assert.equal(toState('AvailableIdle'), 'available');
  assert.equal(toState('Busy'), 'busy');
  assert.equal(toState('BusyIdle'), 'busy');
  assert.equal(toState('DoNotDisturb'), 'dnd');
  assert.equal(toState('Away'), 'away');
  assert.equal(toState('BeRightBack'), 'away');
  assert.equal(toState('Offline'), 'offline');
  assert.equal(toState('PresenceUnknown'), 'unknown');
  assert.equal(toState('SomethingNew'), 'unknown');
});

test('plainMessage strips Teams HTML and entities', () => {
  assert.equal(plainMessage('<p>Out until <b>2pm</b>&nbsp;&amp; on site</p>'), 'Out until 2pm & on site');
  assert.equal(plainMessage('<p></p>'), undefined);
  assert.equal(plainMessage(undefined), undefined);
});

test('first poll reports everyone; people missing from the response are unknown', () => {
  const { statuses, changes } = applyPoll(new Map(), [ann, bob], [pres('id-ann', 'Busy', 'InAMeeting')], 1000);
  assert.equal(changes.length, 2);
  assert.equal(statuses.get('id-ann')?.state, 'busy');
  assert.equal(statuses.get('id-ann')?.activity, 'InAMeeting');
  assert.equal(statuses.get('id-bob')?.state, 'unknown');
  assert.equal(statuses.get('id-ann')?.since, 1000);
});

test('no change when nothing moved; since holds while the state holds', () => {
  const first = applyPoll(new Map(), [ann], [pres('id-ann', 'Busy', 'InACall')], 1000);
  const same = applyPoll(first.statuses, [ann], [pres('id-ann', 'Busy', 'InACall')], 2000);
  assert.equal(same.changes.length, 0);

  // Activity change within the same state is reported, but since stays.
  const activity = applyPoll(same.statuses, [ann], [pres('id-ann', 'BusyIdle', 'InAMeeting')], 3000);
  assert.equal(activity.changes.length, 1);
  assert.equal(activity.statuses.get('id-ann')?.since, 1000);

  const state = applyPoll(activity.statuses, [ann], [pres('id-ann', 'Available')], 4000);
  assert.equal(state.changes[0].before?.state, 'busy');
  assert.equal(state.changes[0].after.state, 'available');
  assert.equal(state.statuses.get('id-ann')?.since, 4000);
});

test('out-of-office and status message changes are reported', () => {
  const first = applyPoll(new Map(), [ann], [pres('id-ann', 'Offline')], 1000);
  const ooo = applyPoll(
    first.statuses,
    [ann],
    [
      pres('id-ann', 'Offline', 'OffWork', {
        outOfOfficeSettings: { isOutOfOffice: true },
        statusMessage: { message: { content: '<p>On leave</p>' } },
      }),
    ],
    2000,
  );
  assert.equal(ooo.changes.length, 1);
  assert.equal(ooo.changes[0].after.outOfOffice, true);
  assert.equal(ooo.changes[0].after.message, 'On leave');
});
