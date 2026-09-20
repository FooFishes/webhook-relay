#!/usr/bin/env python3
"""Local, preview-only console using real metadata and rendering on an isolated database.
Run cargo build first, then python3 scripts/preview_templates.py. No credentials required.
"""
import base64
import os
from pathlib import Path
import secrets
import subprocess
import tempfile
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


def main():
    children = []
    with tempfile.TemporaryDirectory(prefix='relay-template-preview-') as temp:
        folder = Path(temp)
        env = {**os.environ, 'RELAY_ADMIN_TOKEN': secrets.token_urlsafe(36),
               'RELAY_MASTER_KEY': base64.b64encode(secrets.token_bytes(32)).decode(),
               'DATABASE_URL': 'sqlite://' + str(folder / 'preview.db'),
               'RELAY_BIND': '127.0.0.1:8096', 'RELAY_PUBLIC_URL': 'http://127.0.0.1:8096',
               'RELAY_WEB_DIR': str(ROOT / 'web/dist')}
        # Never inherit a delivery stub or production config into this preview.
        env.pop('RELAY_TEST_FEISHU_ORIGIN', None)
        (folder / 'node_modules').symlink_to(ROOT / 'web/node_modules', target_is_directory=True)
        (folder / 'package.json').write_text('{"type":"module"}')
        (folder / 'index.html').write_text('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Relay · 消息模板预览</title></head><body><div id="root"></div><script type="module" src="/main.tsx"></script></body></html>')
        (folder / 'main.tsx').write_text('''import React from 'react';
import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {Console} from 'PROJECT/web/src/App.tsx';
import 'PROJECT/web/src/styles.css';
const api=async(path,method='GET',body)=>{
  const res=await fetch('/api'+path,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  const data=await res.json();if(!res.ok)throw Error(data.error);return data;
};
function Preview(){const [dark,setDark]=React.useState(false);return <Console api={api} initialTab="templates" logout={()=>location.reload()} themeButton={<button aria-label="切换预览主题" onClick={()=>{document.documentElement.dataset.mode=dark?'light':'dark';setDark(!dark)}}>{dark?'浅色':'深色'}</button>}/>}
createRoot(document.getElementById('root')).render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><Preview/></QueryClientProvider>);
'''.replace('PROJECT', str(ROOT)))
        (folder / 'vite.config.ts').write_text('''import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
export default defineConfig({plugins:[react(),tailwind(),{name:'preview-only',configureServer(server){server.middlewares.use((req,res,next)=>{
  if(req.url?.startsWith('/api/resources/')&&req.method==='GET'){res.setHeader('Content-Type','application/json');res.end('[]');return;}
  if(req.url?.startsWith('/api/')&&!((req.url==='/api/meta'&&req.method==='GET')||(req.url==='/api/preview'&&req.method==='POST'))){res.statusCode=403;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({error:'此页面仅用于模板预览，不保存资源或发送消息。'}));return;}
  next();
});}}],server:{host:'127.0.0.1',port:5196,strictPort:true,fs:{allow:['PROJECT','FOLDER']},proxy:{'/api':{target:'http://127.0.0.1:8096',configure(proxy){proxy.on('proxyReq',request=>request.setHeader('Authorization','Bearer '+process.env.PREVIEW_RELAY_TOKEN));}}}},resolve:{dedupe:['react','react-dom','@tanstack/react-query']}});
'''.replace('PROJECT', str(ROOT)).replace('FOLDER', str(folder)))
        try:
            with (folder / 'relay.log').open('w') as log:
                children.append(subprocess.Popen([str(ROOT / 'target/debug/webhook-relay')], cwd=ROOT, env=env, stdout=log, stderr=log))
                for _ in range(50):
                    if children[0].poll() is not None:
                        raise RuntimeError('Preview backend did not start: ' + (folder / 'relay.log').read_text())
                    try:
                        urllib.request.urlopen('http://127.0.0.1:8096/healthz', timeout=1)
                        break
                    except OSError:
                        time.sleep(.1)
                preview_env = {**os.environ, 'PREVIEW_RELAY_TOKEN': env['RELAY_ADMIN_TOKEN']}
                children.append(subprocess.Popen(['pnpm', '--dir', str(ROOT / 'web'), 'exec', 'vite', str(folder), '--config', str(folder / 'vite.config.ts')], cwd=ROOT, env=preview_env))
                print('Preview: http://127.0.0.1:5196 — isolated database; resource writes and delivery APIs blocked.', flush=True)
                children[-1].wait()
        finally:
            for child in reversed(children):
                if child.poll() is None:
                    child.terminate()
                    child.wait(timeout=10)


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        pass
