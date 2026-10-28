import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverPython, pythonCandidates, parseProbeOutput, isSupported } from '../src/pythonDiscovery.ts';

const probeFrom = (table) => async (candidate) => {
  const key = [candidate.command, ...candidate.args].join(' ');
  return table[key];
};

test('no Python anywhere: nothing selected, misses are reported', async () => {
  const d = await discoverPython(async () => undefined, 'linux');
  assert.equal(d.selected, undefined);
  assert.deepEqual(d.unsupported, []);
  assert.equal(d.probed, pythonCandidates('linux').length);
});

test('an unsupported version is skipped and reported; a supported one is selected', async () => {
  const d = await discoverPython(probeFrom({
    'python3.13': undefined,
    'python3.12': undefined,
    'python3.11': undefined,
    'python3': { executable: '/usr/bin/python3', version: [3, 10, 4] },
    'python': { executable: '/usr/local/bin/python', version: [3, 12, 1] },
  }), 'linux');
  assert.equal(d.selected.executable, '/usr/local/bin/python');
  assert.equal(d.unsupported.length, 1);
  assert.deepEqual(d.unsupported[0].version, [3, 10, 4]);
});

test('the first supported candidate wins (versioned names before generic)', async () => {
  const d = await discoverPython(probeFrom({
    'python3.13': { executable: '/opt/3.13/bin/python', version: [3, 13, 0] },
    'python3': { executable: '/usr/bin/python3', version: [3, 12, 0] },
  }), 'darwin');
  assert.equal(d.selected.executable, '/opt/3.13/bin/python');
});

test('windows candidates use the py launcher with explicit versions', () => {
  const commands = pythonCandidates('win32').map((c) => [c.command, ...c.args].join(' '));
  assert.deepEqual(commands.slice(0, 3), ['py -3.13', 'py -3.12', 'py -3.11']);
});

test('probe output parsing is strict', () => {
  assert.deepEqual(parseProbeOutput('{"version":[3,12,1],"executable":"/x/python"}'), { version: [3, 12, 1], executable: '/x/python' });
  assert.equal(parseProbeOutput('{"version":[3,12]}'), undefined);
  assert.equal(parseProbeOutput('not json'), undefined);
  assert.equal(parseProbeOutput('{"version":[3,12,1],"executable":""}'), undefined);
  assert.equal(isSupported([3, 11, 0]), true);
  assert.equal(isSupported([3, 14, 0]), false);
  assert.equal(isSupported([4, 0, 0]), false);
});
