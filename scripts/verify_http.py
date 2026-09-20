#!/usr/bin/env python3
"""Real HTTP regression against an isolated SQLite database and loopback Feishu stub.
No third-party Python packages and no real Apple/Feishu credentials are required.
Usage: cargo build && python3 scripts/verify_http.py
"""
import base64
import concurrent.futures
import hashlib
import hmac
import html
import json
import os
from pathlib import Path
import secrets
import socket
import sqlite3
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[1]
CHECKS = []
MESSAGES = []
COUNTS = {}
SIGNING = 'local-test-feishu-signing-secret'
APPLE = 'local-test-apple-signing-secret'
TOKEN = secrets.token_urlsafe(36)
MASTER = base64.b64encode(secrets.token_bytes(32)).decode()
LOCK = threading.Lock()
RELEASE = threading.Event()


def check(name, condition, detail=''):
    CHECKS.append({'name': name, 'passed': bool(condition), 'detail': str(detail)})
    print(('PASS' if condition else 'FAIL') + '  ' + name, flush=True)
    if not condition:
        raise AssertionError(name + ': ' + str(detail))


class FeishuStub(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        with LOCK:
            MESSAGES.append({'path': self.path, 'body': body})
            COUNTS[self.path] = COUNTS.get(self.path, 0) + 1
            count = COUNTS[self.path]
        mode = self.path.rsplit('/', 1)[-1]
        if mode == 'held':
            RELEASE.wait(12)
        status, payload = 200, {'code': 0, 'msg': 'success'}
        if mode == 'business-failure':
            payload = {'code': 19021, 'msg': 'secret reflected by upstream: ' + SIGNING}
        elif mode == 'rate-limit' and count == 1:
            status, payload = 429, {'code': 11232}
        elif mode == 'retry-business' and count == 1:
            payload = {'code': 11232}
        elif mode == 'always-500':
            status, payload = 500, {'code': -1}
        elif mode == 'invalid-response':
            payload = {'message': 'missing status code'}
        elif mode == 'redirect':
            status = 302
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        if status == 429:
            self.send_header('Retry-After', '2')
        if status == 302:
            self.send_header('Location', '/open-apis/bot/v2/hook/redirect-target')
        self.end_headers()
        try:
            self.wfile.write(json.dumps(payload).encode())
        except (BrokenPipeError, ConnectionResetError):
            pass


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def run():
    stub = ThreadingHTTPServer(('127.0.0.1', 0), FeishuStub)
    threading.Thread(target=stub.serve_forever, daemon=True).start()
    origin = 'http://127.0.0.1:' + str(stub.server_port)
    port = free_port()
    base = 'http://127.0.0.1:' + str(port)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    process = None
    with tempfile.TemporaryDirectory(prefix='webhook-relay-test-') as directory:
        db = Path(directory) / 'test.db'
        log = open(Path(directory) / 'server.log', 'w+')
        env = {**os.environ, 'DATABASE_URL': 'sqlite://' + str(db), 'RELAY_BIND': '127.0.0.1:' + str(port),
               'RELAY_ADMIN_TOKEN': TOKEN, 'RELAY_MASTER_KEY': MASTER, 'RELAY_PUBLIC_URL': base,
               'RELAY_TEST_FEISHU_ORIGIN': origin, 'NO_PROXY': '127.0.0.1,localhost'}

        def start():
            p = subprocess.Popen([str(ROOT / 'target/debug/webhook-relay')], cwd=ROOT, env=env, stdout=log, stderr=log)
            for _ in range(150):
                if p.poll() is not None:
                    raise RuntimeError('server failed to start')
                try:
                    if request('/healthz', auth=False)[0] == 200:
                        return p
                except OSError:
                    pass
                time.sleep(.05)
            raise TimeoutError('server startup timeout')

        def request(path, method='GET', data=None, auth=True, headers=None, raw=None):
            values = {'Content-Type': 'application/json'}
            if auth:
                values['Authorization'] = 'Bearer ' + TOKEN
            values.update(headers or {})
            body = raw if raw is not None else (None if data is None else json.dumps(data).encode())
            req = urllib.request.Request(base + path, data=body, headers=values, method=method)
            try:
                response = opener.open(req, timeout=20)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                content = response.read()
                try:
                    parsed = json.loads(content)
                except (ValueError, UnicodeDecodeError):
                    parsed = content.decode(errors='replace')
                return response.status, parsed

        def create(kind, name, config):
            status, row = request('/api/resources/' + kind, 'POST', {'name': name, 'config': config})
            if status != 200:
                raise AssertionError((kind, status, row))
            return row

        def update(row, **fields):
            status, result = request('/api/resources/' + row['kind'] + '/' + row['id'], 'PUT',
                                    {'name': row['name'], 'config': {**({} if row['kind'] == 'keys' else row['config']), **fields}, 'revision': row['revision']})
            if status != 200:
                raise AssertionError((status, result))
            return result

        def event(event_type='appStoreVersionAppVersionStateUpdated', event_id=None):
            return {'data': {'id': event_id or secrets.token_hex(16), 'type': event_type, 'version': 1,
                             'attributes': {'oldValue': 'PREPARE_FOR_SUBMISSION', 'newValue': 'READY_FOR_REVIEW',
                                            'comment': 'encrypted-private-feedback'},
                             'relationships': {'instance': {'data': {'type': 'appStoreVersions', 'id': 'version-123'}}}}}

        def send(source, payload=None, raw=None, signature=None):
            raw = raw if raw is not None else json.dumps(payload or event(), ensure_ascii=False).encode()
            signature = signature or 'hmacsha256=' + hmac.new(APPLE.encode(), raw, hashlib.sha256).hexdigest()
            return request('/hooks/apple/' + source['id'], 'POST', auth=False, raw=raw, headers={'x-apple-signature': signature})

        def deliveries(event_id=None):
            rows = request('/api/deliveries?limit=200')[1]
            return [r for r in rows if event_id is None or r['event_id'] == event_id]

        def wait_for(predicate, timeout=18):
            end = time.monotonic() + timeout
            while time.monotonic() < end:
                result = predicate()
                if result:
                    return result
                time.sleep(.1)
            raise TimeoutError('condition timeout')

        try:
            process = start()
            secondary = subprocess.run([str(ROOT/'target/debug/webhook-relay')],cwd=ROOT,env={**env,'RELAY_BIND':'127.0.0.1:'+str(free_port())},stdout=log,stderr=log,timeout=5)
            check('Second process cannot share the same SQLite database', secondary.returncode != 0)
            check('Unknown source returns 404', request('/hooks/apple/missing', 'POST', data=event(), auth=False)[0] == 404)
            check('Health endpoint responds', request('/healthz', auth=False)[0] == 200)
            check('WebUI is served by Rust', 'Webhook Relay' in request('/', auth=False)[1])
            check('Admin APIs reject missing authentication', request('/api/meta', auth=False)[0] == 401)
            check('Admin APIs reject incorrect authentication', request('/api/meta', headers={'Authorization': 'Bearer wrong'})[0] == 401)
            meta = request('/api/meta')[1]
            definitions = meta['source_providers'][0]['event_definitions']
            presets = meta['message_presets']
            check('Every Apple event has a dedicated Feishu preset', len(definitions) == 13 and {p['event_type'] for p in presets} == set(definitions))
            for preset in presets:
                sample = definitions[preset['event_type']]['sample']
                status, output = request('/api/preview', 'POST', {'payload_template':preset['payload_template'], 'sample':sample, 'source_name':'原始事件字段'})
                check('Native event preset renders: ' + preset['event_type'], status == 200 and '{{' not in json.dumps(output.get('payload')))
            check('Authenticated metadata includes default template', meta['default_template']['msg_type'] == 'text')
            check('Metadata lists source and destination adapters with instance fields', meta['source_providers'][0]['id']=='apple_app_store_connect' and meta['destination_providers'][0]['id']=='feishu' and meta['source_providers'][0]['fields'][0]['key']=='key_id')
            check('Provider capabilities include event choices, sample, and message editor', 'sample' in meta['source_providers'][0] and meta['destination_providers'][0]['editor']=='feishu')
            check('Preview rejects an unregistered adapter', request('/api/preview','POST',{'source_provider':'missing','destination_provider':'feishu','sample':event(),'payload_template':meta['default_template']})[0]==400)
            overview = request('/api/overview')[1]
            check('Overview requires authentication', request('/api/overview', auth=False)[0] == 401)
            check('Empty overview reports zero counts and no invented success rate', overview['received'] == 0 and overview['success_rate'] is None and overview['attention_failed'] == 0 and len(overview['series']) == 24)
            check('Overview validates its time window', request('/api/overview?hours=1')[0] == 400 and len(request('/api/overview?hours=168')[1]['series']) == 7)
            ak = create('keys', 'Apple signing', {'value': APPLE})
            sk = create('keys', 'Feishu signing', {'value': SIGNING})
            uk = create('keys', 'Feishu URL', {'value': origin + '/open-apis/bot/v2/hook/success'})
            check('Keys are write-only in API responses', 'value' not in ak['config'] and APPLE not in json.dumps(request('/api/resources/keys')[1]))
            check('Key update rejects a non-object config', request('/api/resources/keys/'+ak['id'],'PUT',{'name':ak['name'],'config':None,'revision':ak['revision']})[0]==400)
            ak = update(ak, value='')
            check('Blank key update retains write-only representation', ak['config']=={'has_value':True})
            source = create('sources', '测试应用', {'provider': 'apple_app_store_connect', 'key_id': ak['id'], 'enabled': True})
            dest = create('destinations', 'Feishu test group', {'provider': 'feishu', 'url_key_id': uk['id'], 'signing_key_id': sk['id'], 'enabled': True})
            route = create('routes', 'Apple to Feishu', {'source_id': source['id'], 'destination_id': dest['id'], 'event_types': [],
                                                       'payload_template': meta['default_template'], 'max_attempts': 2, 'enabled': True})
            check('Referenced keys cannot be deleted', request('/api/resources/keys/' + ak['id'], 'DELETE')[0] == 409)
            status, _ = request('/api/resources/sources/' + source['id'], 'PUT', {'name': source['name'], 'config': source['config'], 'revision': 999})
            check('Stale revisions cannot overwrite configuration', status == 409)
            check('Private and foreign bot URLs are rejected', request('/api/resources/keys/' + uk['id'], 'PUT', {'name': uk['name'], 'config': {'value': 'http://169.254.169.254/meta'}, 'revision': uk['revision']})[0] == 400)
            check('Invalid provider is rejected', request('/api/resources/sources', 'POST', {'name': 'bad', 'config': {'enabled': True, 'provider': 'unknown', 'key_id': ak['id']}})[0] == 400)
            check('Unknown config fields are rejected', request('/api/resources/sources', 'POST', {'name': 'bad', 'config': {**source['config'], 'typo': 1}})[0] == 400)
            check('Missing signature is rejected', request('/hooks/apple/' + source['id'], 'POST', data=event(), auth=False)[0] == 401)
            check('Invalid signature is rejected', send(source, signature='hmacsha256=00')[0] == 401)
            check('Valid signature with invalid JSON is rejected', send(source, raw=b'not JSON')[0] == 400)
            check('Body limit rejects oversized requests', send(source, raw=b'x' * (256 * 1024 + 1))[0] == 413)
            check('Preview handles quote/newline without invalid JSON', request('/api/preview', 'POST', {'sample': event(), 'source_name': 'quote"\n中文', 'payload_template': meta['default_template']})[1]['payload']['content']['text'].startswith('quote"\n中文'))
            check('Preview rejects undefined template variables', request('/api/preview', 'POST', {'sample': event(), 'payload_template': {'msg_type': 'text', 'content': {'text': '{{ event.missing }}'}}})[0] == 400)
            raw = json.dumps(event(), indent=2).encode()
            status, accepted = send(source, raw=raw)
            check('Verified event creates durable delivery', status == 202 and accepted['deliveries'] == 1)
            sent = wait_for(lambda: next((r for r in deliveries(accepted['event_id']) if r['status'] == 'succeeded'), None))
            check('Feishu success requires business code zero', sent['attempts'] == 1)
            body = MESSAGES[-1]['body']
            expected = base64.b64encode(hmac.new((body['timestamp'] + '\n' + SIGNING).encode(), b'', hashlib.sha256).digest()).decode()
            check('Outgoing Feishu signature verifies independently', body['sign'] == expected)
            check('Apple payload becomes a Feishu text message', body['msg_type'] == 'text' and 'READY_FOR_REVIEW' in body['content']['text'])
            check('Duplicate webhook is acknowledged without another task', send(source, raw=raw)[1]['duplicate'] and len(deliveries(accepted['event_id'])) == 1)
            changed = json.loads(raw); changed['data']['attributes']['newValue'] = 'CHANGED'
            check('Event ID reused with different content is rejected', send(source, payload=changed)[0] == 409)
            original_sig = 'hmacsha256=' + hmac.new(APPLE.encode(), raw, hashlib.sha256).hexdigest()
            check('Raw-body whitespace changes invalidate signature', send(source, raw=raw+b' ', signature=original_sig)[0] == 401)
            duplicate_event = event()
            with concurrent.futures.ThreadPoolExecutor(max_workers=6) as executor:
                statuses = list(executor.map(lambda _: send(source, duplicate_event)[0], range(6)))
            check('Concurrent duplicates create exactly one event', statuses.count(202) == 1 and statuses.count(200) == 5)
            wait_for(lambda: all(r['status'] == 'succeeded' for r in deliveries()))
            route = update(route, event_types=['buildUploadStateUpdated'])
            check('Event type filter creates no unmatched task', send(source)[1]['deliveries'] == 0)
            route = update(route, event_types=[])
            source = update(source, enabled=False)
            check('Disabled source rejects incoming event', send(source)[0] == 404)
            source = update(source, enabled=True)

            def switch_url(mode):
                nonlocal uk
                uk = update(uk, value=origin + '/open-apis/bot/v2/hook/' + mode)

            for mode, wanted, count in [('business-failure','failed',1),('rate-limit','succeeded',2),('retry-business','succeeded',2),('always-500','failed',2),('invalid-response','failed',1),('redirect','failed',1)]:
                switch_url(mode)
                accepted = send(source)[1]
                row = wait_for(lambda: next((r for r in deliveries(accepted['event_id']) if r['status'] == wanted), None))
                check('Delivery classification: ' + mode, row['attempts'] == count)
                attempts = request('/api/deliveries/' + row['id'] + '/attempts')[1]
                check('Attempt history retained: ' + mode, len(attempts) == count)
                if mode == 'business-failure':
                    check('Failed tasks can be manually retried', request('/api/deliveries/' + row['id'] + '/retry', 'POST')[0] == 200)
                    wait_for(lambda: next((r for r in deliveries(accepted['event_id']) if r['status'] == 'failed' and r['attempts'] == 2), None))
            check('Destination redirects are never followed', not COUNTS.get('/open-apis/bot/v2/hook/redirect-target'))
            switch_url('success')
            route = update(route, payload_template={'msg_type':'text','content':{'text':'{{ event.raw.data.attributes.nonexistent }}'}})
            accepted = send(source)[1]
            row = deliveries(accepted['event_id'])[0]
            check('Template failure is retained as a failed task', row['status'] == 'failed' and row['last_error'] == 'template_render_failed')
            route = update(route, payload_template=meta['default_template'])

            # Accept and queue while running, then stop before the pacing interval.
            accepted = send(source)[1]
            route = update(route, enabled=False)
            process.terminate(); process.wait(timeout=5)
            process = start()
            check('Queued tasks and events survive restart', len(deliveries(accepted['event_id'])) == 1)
            route = update(route, enabled=True)
            wait_for(lambda: next((r for r in deliveries(accepted['event_id']) if r['status']=='succeeded'),None))
            check('Pending work resumes after restart and re-enable', True)

            switch_url('held')
            accepted = send(source)[1]
            wait_for(lambda: COUNTS.get('/open-apis/bot/v2/hook/held',0) == 1)
            process.kill(); process.wait(timeout=5)
            RELEASE.set()
            process = start()
            recovered = wait_for(lambda: next((r for r in deliveries(accepted['event_id']) if r['status']=='succeeded'),None))
            attempts = request('/api/deliveries/' + recovered['id'] + '/attempts')[1]
            check('Interrupted sending task is recovered', recovered['attempts'] == 2)
            check('Interrupted attempt remains explicitly unknown', any(a['status']=='unknown' for a in attempts))

            # Explicit synthetic history in this disposable database checks aggregate
            # and pagination semantics. Real delivery behavior is exercised above.
            route = update(route, enabled=False)
            stamp = int(time.time())
            with sqlite3.connect(db) as connection:
                for index in range(55):
                    connection.execute("INSERT INTO events SELECT ?,source_id,?,event_type,payload,body_sha256,? FROM events LIMIT 1",
                                       ('history-'+str(index), 'provider-history-'+str(index), stamp-(172800 if index == 0 else 0)))
                for index, state in enumerate(['pending', 'retrying', 'sending']):
                    connection.execute("INSERT INTO deliveries SELECT ?,?,route_id,destination_id,snapshot,?,attempts,max_attempts,?,created_at,updated_at,last_error FROM deliveries WHERE id=?",
                                       ('queue-'+str(index), 'history-'+str(index), state, stamp+3600, recovered['id']))
                connection.execute("UPDATE deliveries SET updated_at=? WHERE id=(SELECT id FROM deliveries WHERE status='failed' LIMIT 1)",(stamp-172800,))
            overview = request('/api/overview')[1]
            week = request('/api/overview?hours=168')[1]
            with sqlite3.connect(db) as connection:
                expected_events = connection.execute('SELECT count(*) FROM events WHERE created_at BETWEEN ? AND ?', (overview['window']['since'],overview['window']['until'])).fetchone()[0]
                totals = dict(connection.execute("SELECT status,count(*) FROM deliveries WHERE updated_at BETWEEN ? AND ? AND status IN ('failed','succeeded') GROUP BY status", (overview['window']['since'],overview['window']['until'])))
                all_failed = connection.execute("SELECT count(*) FROM deliveries WHERE status='failed'").fetchone()[0]
            check('Overview aggregates complete history beyond the 50-row UI page', overview['received'] == expected_events and expected_events > 50 and len(request('/api/events')[1]) == 50)
            check('Overview windows include only events and terminal tasks in their own time range', week['received'] == overview['received']+1 and week['failed'] == overview['failed']+1)
            check('Overview success rate uses completed tasks, not received events or attempts', overview['succeeded'] == totals['succeeded'] and overview['failed'] == totals['failed'] and abs(overview['success_rate']-100*totals['succeeded']/sum(totals.values())) < .0001)
            check('Overview chart buckets reconcile with card totals', all(sum(bucket[key] for bucket in overview['series']) == overview['received' if key=='events' else key] for key in ['events','succeeded','failed']))
            check('Current queue distinguishes sending, retries, and paused tasks', overview['queue'] == {'pending':1,'retrying':1,'sending':1,'paused':2})
            check('Current failures include older tasks outside the selected time window', overview['attention_failed'] == all_failed and all_failed > overview['failed'])
            check('Rule overview includes current queue, failures, names and enabled state', overview['routes'][0]['queued'] == 3 and overview['routes'][0]['failed'] == all_failed and not overview['routes'][0]['enabled'] and overview['routes'][0]['source_name'] == source['name'])
            check('Overview attention and activity lists are bounded', len(overview['recent_events']) == 8 and len(overview['recent_failed']) <= 8)
            queued = request('/api/deliveries?status=queued')[1]
            check('Queue drill-down includes all three active states', {r['status'] for r in queued} == {'pending','retrying','sending'} and len(queued) == 3)
            check('Source and event type filters return the correct rows', len(request('/api/events?source_id='+source['id']+'&event_type=appStoreVersionAppVersionStateUpdated')[1]) == 50 and request('/api/events?source_id=missing')[1] == [] and request('/api/events?event_type=missing')[1] == [])
            matching = request('/api/deliveries?event_id='+recovered['event_id']+'&destination_id='+dest['id']+'&route_id='+route['id'])[1]
            check('Delivery filters compose across event, route, and destination', len(matching) == 1 and matching[0]['id'] == recovered['id'] and request('/api/deliveries?destination_id=missing')[1] == [] and request('/api/deliveries?route_id=missing')[1] == [])
            check('Specific record lookup is independent of the first page', request('/api/events?id=history-0')[1][0]['id'] == 'history-0' and request('/api/deliveries?id='+recovered['id'])[1][0]['id'] == recovered['id'])
            with sqlite3.connect(db) as connection:
                connection.execute("DELETE FROM deliveries WHERE id LIKE 'queue-%'")
                connection.execute("DELETE FROM events WHERE id LIKE 'history-%'")
            route = update(route, enabled=True)

            audit = request('/api/audit?limit=200')[1]
            check('Audit includes signature failures', any(a['action']=='webhook.signature_rejected' for a in audit))
            check('Audit includes configuration before/after metadata', any(a['action']=='config.updated' and 'before' in a['detail'] and 'after' in a['detail'] for a in audit))
            check('Audit includes delivery attempts and recovery', any(a['action']=='delivery.started' for a in audit) and any(a['action']=='worker.recovered' for a in audit))
            check('Audit does not leak secrets or upstream bodies', all(s not in json.dumps(audit) for s in [APPLE,SIGNING,TOKEN,origin+'/open-apis/bot']))
            check('Audit filtering works', all(a['action']=='config.created' for a in request('/api/audit?action=config.created')[1]))
            page1 = request('/api/audit?limit=3')[1]
            page2 = request('/api/audit?limit=3&before='+str(page1[-1]['cursor']))[1]
            check('Cursor pagination has no overlap', len(page1)==3 and not ({r['id'] for r in page1}&{r['id'] for r in page2}))
            with sqlite3.connect(db) as connection:
                stored = '\n'.join(r[0] for r in connection.execute('SELECT config FROM resources'))
                stored += '\n'.join(r[0] for r in connection.execute('SELECT payload FROM events'))
                stored += '\n'.join(r[0] for r in connection.execute('SELECT snapshot FROM deliveries'))
                check('Stored secrets, raw events, and snapshots are encrypted', all(s not in stored for s in [APPLE,SIGNING,'encrypted-private-feedback',origin+'/open-apis/bot']))
                try:
                    connection.execute("UPDATE audit SET actor='tampered'")
                    guarded = False
                except sqlite3.DatabaseError:
                    guarded = True
                check('Audit update is blocked by database trigger', guarded)
            disposable = create('keys','Temporary key',{'value':'temporary-value'})
            check('Unreferenced config can be deleted', request('/api/resources/keys/'+disposable['id'],'DELETE')[0]==200)
            source2 = create('sources', '第二个应用', {**source['config'],'enabled':True})
            dest2 = create('destinations', '第二个通知目标', {**dest['config'],'enabled':True})
            route2 = create('routes', '向第二个目标分发', {**route['config'],'destination_id':dest2['id'],'enabled':True})
            route3 = create('routes', '第二个来源共用目标', {**route['config'],'source_id':source2['id'],'enabled':True})
            shared_event = event(event_id='same-provider-event-across-sources')
            first = send(source,shared_event)[1]
            second = send(source2,shared_event)[1]
            check('One source fans out to multiple independent destination instances', first['deliveries']==2 and {r['destination_id'] for r in deliveries(first['event_id'])}=={dest['id'],dest2['id']})
            check('Multiple sources reuse one destination and retain separate deduplication scopes', second['deliveries']==1 and first['event_id']!=second['event_id'] and deliveries(second['event_id'])[0]['destination_id']==dest['id'])
            wait_for(lambda: all(r['status']=='succeeded' for eid in [first['event_id'],second['event_id']] for r in deliveries(eid)))
            check('Each fan-out task has its own attempt history', all(len(request('/api/deliveries/'+r['id']+'/attempts')[1])==1 for r in deliveries(first['event_id'])))
            dest2 = update(dest2,enabled=False)
            third = send(source)[1]
            check('Disabling one destination leaves the other destination receiving', third['deliveries']==1 and deliveries(third['event_id'])[0]['destination_id']==dest['id'])
            wait_for(lambda: deliveries(third['event_id'])[0]['status']=='succeeded')
            source = update(source,enabled=False)
            fourth = send(source2)[1]
            check('Disabling one source leaves another source independently active', send(source)[0]==404 and fourth['deliveries']==1)
            wait_for(lambda: deliveries(fourth['event_id'])[0]['status']=='succeeded')
            source = update(source,enabled=True)
            raw=json.dumps(event()).encode()
            signature='hmacsha256='+hmac.new(APPLE.encode(),raw,hashlib.sha256).hexdigest()
            status,canonical=request('/hooks/'+source2['id'],'POST',raw=raw,auth=False,headers={'x-apple-signature':signature})
            check('Provider-neutral callback URL dispatches by source instance',status==202 and canonical['deliveries']==1)
            wait_for(lambda: deliveries(canonical['event_id'])[0]['status']=='succeeded')
            check('An existing instance cannot be silently reinterpreted as another provider',request('/api/resources/sources/'+source2['id'],'PUT',{'name':source2['name'],'revision':source2['revision'],'config':{**source2['config'],'provider':'other'}})[0]==400)
            check('Provider-aware preview uses the explicitly selected adapters',request('/api/preview','POST',{'source_provider':'apple_app_store_connect','destination_provider':'feishu','sample':event(),'payload_template':meta['destination_providers'][0]['default_template']})[0]==200)
            dest2 = update(dest2,enabled=True)
            route2 = update(route2,payload_template={'msg_type':'text','content':{'text':'{{ event.missing }}'}})
            isolated = send(source)[1]
            wait_for(lambda: any(r['status']=='succeeded' for r in deliveries(isolated['event_id'])))
            check('One route conversion failure does not block other destinations', isolated['deliveries']==2 and {r['status'] for r in deliveries(isolated['event_id'])}=={'failed','succeeded'})
            event_source = create('sources', '事件模板专用来源', {**source['config'], 'enabled':True})
            bindings = {p['event_type']:{'active_template_id':p['id'], 'templates':[{'id':p['id'], 'name':p['name'], 'payload_template':p['payload_template']}]} for p in presets}
            event_route = create('routes', '按事件选择模板', {'source_id':event_source['id'], 'destination_id':dest['id'], 'event_types':[], 'event_templates':bindings, 'max_attempts':2, 'enabled':True})
            readback = request('/api/resources/routes')[1]
            check('Event libraries persist with the selected template per event', next(r for r in readback if r['id']==event_route['id'])['config']['event_templates']==bindings)
            for kind in ['webhookPingCreated','appStoreVersionAppVersionStateUpdated','alternativeDistributionPackageAvailableUpdated']:
                payload = definitions[kind]['sample']
                accepted = send(event_source,payload)[1]
                check('Exactly one delivery uses the event binding: ' + kind, accepted['deliveries']==1)
                wait_for(lambda: deliveries(accepted['event_id'])[0]['status']=='succeeded')
                with LOCK:
                    rendered = json.dumps(MESSAGES[-1]['body'],ensure_ascii=False)
                check('Delivered card matches its source event: ' + kind, definitions[kind]['name'] in rendered)
                if kind == 'webhookPingCreated':
                    check('Ping card has no version state or resource placeholders', '此前版本状态' not in rendered and '资源' not in rendered)
                if kind == 'alternativeDistributionPackageAvailableUpdated':
                    check('Native boolean false and territory arrays survive rendering', '是否可用：否' in rendered and '适用地区：DNK、IRL' in rendered)
            check('Unknown events are recorded without applying another event template', send(event_source,event('futureEvent'))[1]['deliveries']==0)
            ping = bindings['webhookPingCreated']
            ping['templates'].append({'id':'custom-ping','name':'自定义测试','payload_template':{'msg_type':'text','content':{'text':'only-custom-ping'}}})
            ping['active_template_id']='custom-ping'
            event_route = update(event_route,event_templates=bindings)
            accepted = send(event_source,event('webhookPingCreated'))[1]
            wait_for(lambda: deliveries(accepted['event_id'])[0]['status']=='succeeded')
            check('Changing the active template changes the delivered message', MESSAGES[-1]['body']['content']['text']=='only-custom-ping')
            invalid_config = {**event_route['config'],'event_types':['unknownEvent']}
            check('Selected events without templates cannot be saved', request('/api/resources/routes/'+event_route['id'],'PUT',{'name':event_route['name'],'revision':event_route['revision'],'config':invalid_config})[0]==400)
            invalid_config = {**event_route['config'],'payload_template':meta['default_template']}
            check('Legacy and event template modes cannot be mixed', request('/api/resources/routes/'+event_route['id'],'PUT',{'name':event_route['name'],'revision':event_route['revision'],'config':invalid_config})[0]==400)
            audit_rows = request('/api/audit?limit=200')[1]
            check('Audit contains hashes rather than template bodies', 'only-custom-ping' not in json.dumps(audit_rows) and 'event_templates_sha256' in json.dumps(audit_rows))
            policy_source = create('sources', '内置预设专用来源', {**source['config'], 'enabled':True})
            policy_route = create('routes', '零配置内置消息', {'source_id':policy_source['id'], 'destination_id':dest['id'], 'event_types':[], 'max_attempts':2, 'enabled':True})
            check('Route accepts no explicit message configuration for built-in defaults', 'payload_template' not in policy_route['config'] and 'event_templates' not in policy_route['config'])
            for kind, definition in definitions.items():
                status, preview = request('/api/preview','POST',{'sample':definition['sample'],'source_name':'内置预设专用来源'})
                check('Zero-configuration preview: ' + kind, status == 200 and preview.get('payload',{}).get('msg_type')=='interactive',preview)
                accepted = send(policy_source,definition['sample'])[1]
                check('Zero-configuration event creates one delivery: ' + kind, accepted['deliveries']==1)
                wait_for(lambda: deliveries(accepted['event_id'])[0]['status']=='succeeded')
                with LOCK:
                    actual = {k:v for k,v in MESSAGES[-1]['body'].items() if k not in ('timestamp','sign')}
                check('Preview and delivered message match: ' + kind, actual==preview['payload'])
            check('Built-in defaults skip unknown events',send(policy_source,event('futureEvent'))[1]['deliveries']==0)
            policy = {'preset':'recommended','overrides':{'webhookPingCreated':{'content':{'title':'CUSTOM-POLICY-PING','blocks':[{'id':'body','kind':'text','label':'','text':'完整的自定义事件内容'}]},'presentation':{'style':'post'}}}}
            policy_route = update(policy_route,message_policy=policy)
            check('Sparse event overrides survive readback',next(r for r in request('/api/resources/routes')[1] if r['id']==policy_route['id'])['config']['message_policy']==policy)
            accepted=send(policy_source,event('webhookPingCreated'))[1]
            wait_for(lambda: deliveries(accepted['event_id'])[0]['status']=='succeeded')
            check('Custom content and target presentation reach the destination',MESSAGES[-1]['body']['content']['post']['zh_cn']['title']=='CUSTOM-POLICY-PING')
            policy_route=update(policy_route,message_policy={'preset':'recommended','overrides':{}})
            accepted=send(policy_source,event('webhookPingCreated'))[1]
            wait_for(lambda: deliveries(accepted['event_id'])[0]['status']=='succeeded')
            check('Reset restores the complete built-in message',MESSAGES[-1]['body']['msg_type']=='interactive' and 'CUSTOM-POLICY-PING' not in json.dumps(MESSAGES[-1]['body']))
            invalid={**policy_route['config'],'payload_template':meta['default_template']}
            check('Structured and legacy message modes are mutually exclusive',request('/api/resources/routes/'+policy_route['id'],'PUT',{'name':policy_route['name'],'revision':policy_route['revision'],'config':invalid})[0]==400)
            check('Preview rejects unknown structured events',request('/api/preview','POST',{'sample':event('futureEvent')})[0]==400)
            invalid_policy={'preset':'recommended','overrides':{'unknown':{}}}
            check('Policy rejects unknown event overrides',request('/api/preview','POST',{'sample':event(),'message_policy':invalid_policy})[0]==400)
            audit_rows=request('/api/audit?limit=200')[1]
            check('Policy audit contains hashes and no custom message body','message_policy_sha256' in json.dumps(audit_rows) and 'CUSTOM-POLICY-PING' not in json.dumps(audit_rows))
            process.terminate(); process.wait(timeout=5)
            env['RELAY_MASTER_KEY'] = base64.b64encode(secrets.token_bytes(32)).decode()
            invalid = subprocess.run([str(ROOT/'target/debug/webhook-relay')],cwd=ROOT,env=env,stdout=log,stderr=log,timeout=5)
            check('Wrong master key fails startup', invalid.returncode != 0)
        finally:
            RELEASE.set()
            if process and process.poll() is None:
                process.terminate()
                try: process.wait(timeout=5)
                except subprocess.TimeoutExpired: process.kill(); process.wait()
            stub.shutdown()
            log.close()


def report():
    directory=ROOT/'reports';directory.mkdir(exist_ok=True)
    passed=sum(c['passed'] for c in CHECKS)
    data={'passed':passed,'failed':len(CHECKS)-passed,'checks':CHECKS,'scope':'Isolated local HTTP tests; simulated Apple requests and loopback Feishu bot. No live platform delivery.'}
    (directory/'http-verification.json').write_text(json.dumps(data,ensure_ascii=False,indent=2))
    rows=''.join('<tr><td>'+('PASS' if c['passed'] else 'FAIL')+'</td><td>'+html.escape(c['name'])+'</td><td>'+html.escape(c['detail'])+'</td></tr>' for c in CHECKS)
    (directory/'http-verification.html').write_text('''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Webhook Relay HTTP 验证</title><style>body{font:14px/1.6 system-ui;max-width:1100px;margin:40px auto;padding:0 20px;color:#172b4d}h1{font-size:26px}table{border-collapse:collapse;width:100%}td,th{padding:10px 14px;text-align:left;border-bottom:1px solid #dde3ec}th{background:#f4f6f9}td:first-child{font-weight:600}p{color:#53647a}</style><h1>Webhook Relay HTTP 验证</h1><p>'''+str(passed)+' PASS / '+str(len(CHECKS)-passed)+' FAIL</p><p>使用独立临时 SQLite 数据库、本地运行的 Rust 服务、模拟 Apple 请求和飞书 HTTP 服务。未连接真实平台。</p><table><thead><tr><th>结果</th><th>检查项</th><th>说明</th></tr></thead><tbody>'+rows+'</tbody></table></html>')
    print('\nReport:',directory/'http-verification.html',flush=True)


if __name__=='__main__':
    try:
        run()
    except Exception as exc:
        if not CHECKS or CHECKS[-1]['passed']:
            CHECKS.append({'name':'Unexpected verification error','passed':False,'detail':str(exc)})
        raise
    finally:
        report()
