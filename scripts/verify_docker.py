#!/usr/bin/env python3
"""Smoke-test an already-built webhook-relay:verify image with an isolated volume."""
import base64
import json
import os
from pathlib import Path
import secrets
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

ROOT=Path(__file__).resolve().parents[1]
name='relay-verify-'+secrets.token_hex(5)
volume=name+'-data'
checks=[]

def docker(*args):
    return subprocess.check_output(['docker',*args],text=True).strip()

def check(label,result):
    checks.append({'name':label,'passed':bool(result)})
    print(('PASS  ' if result else 'FAIL  ')+label,flush=True)
    assert result,label

token=secrets.token_urlsafe(36)
master=base64.b64encode(secrets.token_bytes(32)).decode()
try:
    with tempfile.TemporaryDirectory(prefix='relay-container-') as directory:
        envfile=Path(directory)/'env';envfile.write_text('RELAY_ADMIN_TOKEN='+token+'\nRELAY_MASTER_KEY='+master+'\n');os.chmod(envfile,0o600)
        compose=subprocess.run(['docker','compose','config','--quiet'],cwd=ROOT,env={**os.environ,'RELAY_ADMIN_TOKEN':token,'RELAY_MASTER_KEY':master},capture_output=True)
        check('Compose configuration validates',compose.returncode==0)
        docker('volume','create',volume)
        docker('run','-d','--name',name,'--read-only','--cap-drop=ALL','--security-opt','no-new-privileges:true','--mount','type=volume,source='+volume+',target=/app/data','--tmpfs','/tmp','-p','127.0.0.1::8080','--env-file',str(envfile),'webhook-relay:verify')
        binding=json.loads(docker('inspect',name))[0]['NetworkSettings']['Ports']['8080/tcp'][0]
        base='http://127.0.0.1:'+binding['HostPort']
        opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
        def request(path,method='GET',payload=None,auth=False):
            headers={'Content-Type':'application/json'}
            if auth:headers['Authorization']='Bearer '+token
            req=urllib.request.Request(base+path,method=method,data=None if payload is None else json.dumps(payload).encode(),headers=headers)
            try:r=opener.open(req,timeout=3)
            except urllib.error.HTTPError as e:r=e
            with r:return r.status,r.read().decode(),dict(r.headers)
        for _ in range(100):
            try:
                if request('/healthz')[0]==200:break
            except OSError:pass
            time.sleep(.1)
        check('Container health endpoint responds',request('/healthz')[0]==200)
        status,page,headers=request('/')
        check('Built Kumo WebUI is served',status==200 and 'Webhook Relay' in page)
        check('Browser security headers are present','Content-Security-Policy' in headers or 'content-security-policy' in headers)
        check('Container runs as non-root',docker('exec',name,'id','-u')=='10001')
        check('Container root filesystem is read-only',json.loads(docker('inspect',name))[0]['HostConfig']['ReadonlyRootfs'])
        check('Admin endpoints require bearer authentication',request('/api/meta')[0]==401)
        status,body,_=request('/api/resources/keys','POST',{'name':'smoke','config':{'value':'ephemeral-test-value'}},True)
        key=json.loads(body)
        check('Non-root service can write to persistent volume',status==200 and key['config']=={'has_value':True})
        docker('restart',name)
        binding=json.loads(docker('inspect',name))[0]['NetworkSettings']['Ports']['8080/tcp'][0]
        base='http://127.0.0.1:'+binding['HostPort']
        for _ in range(100):
            try:
                if request('/healthz')[0]==200:break
            except OSError:pass
            time.sleep(.1)
        status,body,_=request('/api/resources/keys',auth=True)
        check('Configuration persists across container restart',status==200 and any(r['id']==key['id'] for r in json.loads(body)))
except Exception as exc:
    checks.append({'name':'Container verification error: '+str(exc),'passed':False})
    try: print(docker('logs',name),flush=True)
    except subprocess.CalledProcessError: pass
    raise
finally:
    subprocess.run(['docker','rm','-f',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    subprocess.run(['docker','volume','rm',volume],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    directory=ROOT/'reports';directory.mkdir(exist_ok=True)
    (directory/'docker-verification.json').write_text(json.dumps({'checks':checks,'passed':sum(x['passed'] for x in checks),'failed':sum(not x['passed'] for x in checks)},indent=2))
