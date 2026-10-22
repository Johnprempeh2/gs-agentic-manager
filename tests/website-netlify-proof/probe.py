import os,json,subprocess,time,urllib.request,urllib.error,re,datetime
root=os.environ['GSAM_RUN_SCRATCH_DIR'];site=json.load(open(os.path.join(root,'site.json')));token=open(os.path.join(root,'netlify.token')).read().strip();base='https://'+site['name']+'.netlify.app';paths=['/check/home','/check/inner','/check/product','/check/old','/_release','/.netlify/functions/cdn-check']
def fetch(path):
 t=time.monotonic();r=urllib.request.urlopen(urllib.request.Request(base+path,headers={'User-Agent':'GRE-1915-cache-proof'}),timeout=30);b=r.read().decode();m=re.search('id="release">([^<]+)',b);v=m.group(1) if m else json.loads(b).get('release');return {'path':path,'release':v,'status':r.status,'url':r.geturl(),'cache':r.headers.get('Cache-Status'),'age':r.headers.get('Age'),'ms':round((time.monotonic()-t)*1000)}
def purge(auth):
 req=urllib.request.Request('https://api.netlify.com/api/v1/purge',data=json.dumps({'site_id':site['id'],'cache_tags':['gre-1915-content']}).encode(),headers={'Authorization':'Bearer '+auth,'Content-Type':'application/json'},method='POST')
 try:r=urllib.request.urlopen(req,timeout=20);return {'status':r.status,'body':r.read().decode()[:150]}
 except urllib.error.HTTPError as e:return {'status':e.code,'body':e.read().decode()[:150]}
print('BASELINE',json.dumps([fetch(p) for p in paths]))
t0=time.monotonic();w=subprocess.check_output(['node','writer.mjs',site['id'],os.path.join(root,'netlify.token'),'r2'],text=True);switch=time.monotonic();print('SWITCH',w.strip(),'elapsed_ms',round((switch-t0)*1000))
print('FAILED_PURGE',purge('invalid-for-negative-test'))
print('AFTER_FAILED_PURGE',json.dumps([fetch(p) for p in paths]))
print('PURGE',purge(token));purged=time.monotonic();results=[]
for i in range(15):
 checks=[fetch(p) for p in paths];results.append({'after_purge_ms':round((time.monotonic()-purged)*1000),'checks':checks})
 if all(x['release']=='r2' for x in checks):break
 time.sleep(1)
print('POLL',json.dumps(results))
print('ALL_LIVE_MS_FROM_SWITCH',round((time.monotonic()-switch)*1000) if all(x['release']=='r2' for x in checks) else 'NOT_REACHED')
