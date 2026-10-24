import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, mkdtemp, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepareEnvironment, activeEnvironment, rollbackEnvironment, isolatedEnvironment, supportedPythonVersion, runManagedCore } from '../src/environment.ts';
import { runBounded } from '../src/process.ts';

const python = process.env.VECTOR_PNG_PYTHON ?? execFileSync('python', ['-c', 'import sys;print(sys.executable)'], {encoding:'utf8'}).trim();
const root = fileURLToPath(new URL('../../../', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const testRoot = process.env.VECTOR_PNG_ENV_TEST_ROOT ?? tmpdir();
async function directory() { await mkdir(testRoot, {recursive:true}); return mkdtemp(join(testRoot, 'vector-png 環境 ')); }

async function fixture() {
  const root = await directory();
  const lock = Buffer.from('Pillow==13.0.0\n');
  const wheel = Buffer.from('intentionally invalid wheel');
  const entry = {id:randomUUID(),version:'0.1.0.dev3',wheel_sha256:hash(wheel),lock_sha256:hash(lock),python_version:'3.13.5'};
  const env = join(root, 'envs', entry.id);
  await mkdir(join(env, 'setup'), {recursive:true});
  await writeFile(join(env,'ready.json'), JSON.stringify(entry));
  await writeFile(join(env,'setup','requirements.lock'), lock);
  const state = {protocol:1,active:entry,previous:null};
  await writeFile(join(root,'active.json'), JSON.stringify(state));
  const wheelPath=join(root,'input.whl'), lockPath=join(root,'input.lock');
  await writeFile(wheelPath,wheel); await writeFile(lockPath,lock);
  return {root,entry,state,wheelPath,lockPath,options:{root,python,wheel:wheelPath,wheelSha256:hash(wheel),
    requirements:lockPath,requirementsSha256:hash(lock),version:'0.1.0.dev3'}};
}

test('ambient Python/pip install redirects are removed without changing caller environment', () => {
  const original = {PATH:'trusted',PYTHONPATH:'wrong',PYTHONHOME:'wrong',PIP_TARGET:'system',PIP_PREFIX:'system',
    PIP_CONFIG_FILE:'wrong',VIRTUAL_ENV:'wrong',VECTOR_PNG_CAIRO_DIR:'cairo'};
  const isolated = isolatedEnvironment(original);
  assert.equal(isolated.PIP_TARGET, undefined); assert.equal(isolated.PYTHONHOME, undefined);
  assert.equal(isolated.VIRTUAL_ENV, undefined); assert.equal(isolated.VECTOR_PNG_CAIRO_DIR,'cairo');
  assert.equal(original.PIP_TARGET,'system');
});
test('an empty store has no active interpreter', async () => {
  const root=await directory();
  assert.equal(await activeEnvironment(root), null);
  await assert.rejects(runManagedCore(root,{protocol:1,command:'inspect',request_id:'none',input:'none.png'}),{code:'no-active-environment'});
});
test('supported Python range rejects unsupported and malformed interpreter reports', () => {
  for (const value of [[3,10,9],[3,14,0],[2,13,0],[3,12,true],[3,12,-1],null])
    assert.throws(()=>supportedPythonVersion(value),{code:'unsupported-python'});
  assert.equal(supportedPythonVersion([3,11,0]),'3.11.0');
  assert.equal(supportedPythonVersion([3,13,5]),'3.13.5');
});
test('digest failure preserves active state byte for byte', async () => {
  const f=await fixture(), before=await readFile(join(f.root,'active.json'));
  await assert.rejects(prepareEnvironment({...f.options,wheelSha256:'0'.repeat(64)}), /digest differs/);
  assert.deepEqual(await readFile(join(f.root,'active.json')),before);
  await assert.rejects(access(join(f.root,'setup.lock')));
});
test('missing Python preserves active state', async () => {
  const f=await fixture(), before=await readFile(join(f.root,'active.json'));
  await assert.rejects(prepareEnvironment({...f.options,python:join(f.root,'missing-python.exe')}),{code:'launch-failed'});
  assert.deepEqual(await readFile(join(f.root,'active.json')),before);
});
test('pre-cancelled setup does not touch state', async () => {
  const f=await fixture(), controller=new AbortController(); controller.abort();
  await assert.rejects(prepareEnvironment({...f.options,signal:controller.signal}),{code:'cancelled'});
  assert.equal((await activeEnvironment(f.root)).entry.id,f.entry.id);
});
test('parallel/stale lock fails closed', async () => {
  const f=await fixture(); await writeFile(join(f.root,'setup.lock'),'');
  await assert.rejects(prepareEnvironment(f.options),{code:'busy'});
  assert.equal((await activeEnvironment(f.root)).entry.id,f.entry.id);
});
test('rollback without previous entry preserves state', async () => {
  const f=await fixture();
  await assert.rejects(rollbackEnvironment({root:f.root}),{code:'no-previous-environment'});
  assert.equal((await activeEnvironment(f.root)).entry.id,f.entry.id);
});
test('unready previous environment cannot replace active state', async () => {
  const f=await fixture(); f.state.previous={...f.entry,id:randomUUID()};
  await writeFile(join(f.root,'active.json'),JSON.stringify(f.state));
  const before=await readFile(join(f.root,'active.json'));
  await assert.rejects(rollbackEnvironment({root:f.root}));
  assert.deepEqual(await readFile(join(f.root,'active.json')),before);
});
test('state paths cannot traverse outside the store', async () => {
  const f=await fixture(); f.state.active.id='../outside';
  await writeFile(join(f.root,'active.json'),JSON.stringify(f.state));
  await assert.rejects(activeEnvironment(f.root),/Invalid managed-environment state/);
});
test('lock options and unpinned requirements cannot enter pip', async () => {
  const f=await fixture(), bytes=Buffer.from('--target outside\nPillow>=13\n');
  await writeFile(f.lockPath,bytes);
  await assert.rejects(prepareEnvironment({...f.options,requirementsSha256:hash(bytes)}),/exact name==version/);
  assert.equal((await activeEnvironment(f.root)).entry.id,f.entry.id);
});
test('bounded setup runner supports cancellation and timeout', async () => {
  const cwd=await directory(), controller=new AbortController();
  const options={cwd,env:isolatedEnvironment(),timeoutMs:10_000,signal:controller.signal};
  const work=runBounded(python,['-c','import time;time.sleep(10)'],options);
  setTimeout(()=>controller.abort(),100);
  await assert.rejects(work,{code:'cancelled'});
  await assert.rejects(runBounded(python,['-c','import time;time.sleep(10)'],{...options,signal:undefined,timeoutMs:100}),{code:'timeout'});
});

test('real versioned venv update, offline failure, cancellation and rollback preserve originals',
  {skip: !process.env.VECTOR_PNG_ENV_TEST_WHEEL, timeout: 900_000}, async () => {
    const store=await directory(), source=join(store,'original.svg');
    await writeFile(source,'unchanged source');
    const wheel=resolve(process.env.VECTOR_PNG_ENV_TEST_WHEEL), requirements=join(root,'requirements.lock');
    const options={root:join(store,'managed environments'),python,wheel,requirements,
      wheelSha256:hash(await readFile(wheel)),requirementsSha256:hash(await readFile(requirements)),
      version:process.env.VECTOR_PNG_ENV_TEST_VERSION ?? '0.1.0.dev3',allowNetwork:true};
    let parallel;
    const first=await prepareEnvironment({...options,onProgress(stage){
      if(stage==='install') parallel=prepareEnvironment(options).then(()=>assert.fail('parallel setup succeeded'),e=>assert.equal(e.code,'busy'));
    }});
    await parallel;
    const activeFile=join(options.root,'active.json'), before=await readFile(activeFile);
    assert.equal((await activeEnvironment(options.root)).entry.id,first.entry.id);
    const result=await runManagedCore(options.root,{protocol:1,command:'validate',request_id:'managed',
      source_base64:Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64'),syntax_only:true},
      {env:{...process.env,PYTHONHOME:'invalid ambient Python home',PYTHONPATH:'invalid ambient import directory',PIP_TARGET:'wrong target'}});
    assert.equal(result.response.ok,true);
    // No index and an empty wheelhouse must fail rather than mutate the active venv.
    const empty=join(store,'empty-wheelhouse'); await mkdir(empty);
    await assert.rejects(prepareEnvironment({...options,allowNetwork:false,wheelhouse:empty}),{stage:'install'});
    assert.deepEqual(await readFile(activeFile),before);
    const broken=join(store,'broken.whl'); await writeFile(broken,'broken wheel');
    await assert.rejects(prepareEnvironment({...options,wheel:broken,wheelSha256:hash(await readFile(broken))}),{stage:'install'});
    assert.deepEqual(await readFile(activeFile),before);
    const badHealth=join(store,'bad-health.whl');
    execFileSync(python,['-I',fileURLToPath(new URL('./fixtures/bad_health_wheel.py',import.meta.url)),wheel,badHealth]);
    await assert.rejects(prepareEnvironment({...options,wheel:badHealth,wheelSha256:hash(await readFile(badHealth))}),{code:'health-failed',stage:'render-health'});
    assert.deepEqual(await readFile(activeFile),before);
    // Cancellation after creating the new venv leaves the active pointer untouched.
    const controller=new AbortController();
    await assert.rejects(prepareEnvironment({...options,signal:controller.signal,onProgress(stage){if(stage==='install')controller.abort();}}),{code:'cancelled'});
    assert.deepEqual(await readFile(activeFile),before);
    const second=await prepareEnvironment(options);
    assert.notEqual(first.entry.id,second.entry.id);
    assert.equal((await activeEnvironment(options.root)).entry.id,second.entry.id);
    const previous=await rollbackEnvironment({root:options.root});
    assert.equal(previous.entry.id,first.entry.id);
    assert.equal((await activeEnvironment(options.root)).entry.id,first.entry.id);
    await access(second.python);
    assert.equal(await readFile(source,'utf8'),'unchanged source');
  });
