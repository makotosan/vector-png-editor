"""Controlled subprocess faults for the bridge tests; never imported by production."""
import json
import sys
import time

request = json.load(sys.stdin)
mode = request.get('input')
if mode == 'slow':
    time.sleep(10)
if mode == 'stdout-limit':
    sys.stdout.write('x' * 300_000)
elif mode == 'stderr-limit':
    sys.stderr.write('x' * 70_000)
elif mode == 'invalid-json':
    sys.stdout.write('{}{}')
elif mode == 'invalid-utf8':
    sys.stdout.buffer.write(b'\xff')
else:
    result = {'protocol': 1, 'command': request['command'], 'request_id': request['request_id'], 'ok': True, 'result': {'mode': mode}}
    if mode == 'wrong-id':
        result['request_id'] = 'different-id'
    if mode == 'bad-success':
        result['error'] = {'code': 'io-error', 'message': 'contradiction'}
    if mode == 'core-error':
        result.pop('result')
        result.update(ok=False, error={'code': 'invalid-svg', 'message': 'test diagnostic'})
    if mode == 'stderr':
        sys.stderr.write('a bounded diagnostic')
    print(json.dumps(result))
    if mode == 'core-error':
        sys.exit(4)
