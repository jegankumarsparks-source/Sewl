#!/usr/bin/env python3
"""Publish SEWL code (first run) and the static status page to the public repo as ONE commit per publish.
Reads only var/sewl.sqlite via export-web.js. Refuses to publish .env, var/ or node_modules. PAPER ONLY."""
import json,urllib.request,urllib.error,base64,subprocess,os,sys,time,hashlib
tok=open("/tmp/pumpwatch/pumptrack/github_token.txt").read().strip()
R='jegankumarsparks-source/Sewl'; ROOT='/home/sandbox/sewl'; STATE=ROOT+'/var/.pub_state.json'
def gh(m,p,b=None):
    r=urllib.request.Request(f'https://api.github.com/repos/{R}/{p}',data=json.dumps(b).encode() if b is not None else None,method=m,headers={'Authorization':'token '+tok,'Accept':'application/vnd.github+json','Content-Type':'application/json'})
    try:return json.load(urllib.request.urlopen(r,timeout=60))
    except urllib.error.HTTPError as e:raise RuntimeError(f'{m} {p} {e.code} {e.read().decode()[:200]}')
os.chdir(ROOT)
full='--full' in sys.argv
subprocess.run(['node','scripts/export-web.js'],check=True,capture_output=True)
st=json.load(open(STATE)) if os.path.exists(STATE) else {}
d=json.load(open('site/data.json')); core=dict(d); core.pop('generated_at',None)
h=hashlib.sha1(json.dumps(core,sort_keys=True).encode()).hexdigest()
if not full and st.get('h')==h and time.time()-st.get('t',0)<3600: print('unchanged, skip'); sys.exit(0)
files={}
if full or not st.get('code_pushed'):
    for f in subprocess.check_output(['git','ls-files']).decode().split('\n'):
        if f and not f.startswith('site/'): files[f]=open(f,'rb').read()
for f in files: assert f!='.env' and not f.startswith('var/') and not f.startswith('node_modules'),f
files['index.html']=open('site/index.html','rb').read(); files['data.json']=open('site/data.json','rb').read()
try: head=gh('GET','git/ref/heads/main')['object']['sha']; empty=False
except RuntimeError: empty=True
if empty:
    gh('PUT','contents/.gitignore',{'message':'init: .gitignore (secrets and runtime data excluded)','content':base64.b64encode(open('.gitignore','rb').read()).decode(),'branch':'main'})
    head=gh('GET','git/ref/heads/main')['object']['sha']
base=gh('GET','git/commits/'+head)['tree']['sha']
entries=[{'path':p,'mode':'100755' if p.endswith('.sh') else '100644','type':'blob','content':b.decode('utf-8')} for p,b in files.items()]
tree=gh('POST','git/trees',{'base_tree':base,'tree':entries})
msg=('SEWL paper-trading research pilot: code + status page (PAPER ONLY, no real funds). package.json test script now "node --test tests/paper.test.js" (Node 22 runner quirk).' if (full or not st.get('code_pushed')) else 'status page update '+time.strftime('%H:%M',time.gmtime())+'Z')
c=gh('POST','git/commits',{'message':msg,'tree':tree['sha'],'parents':[head]})
gh('PATCH','git/refs/heads/main',{'sha':c['sha'],'force':False})
st.update({'h':h,'t':time.time(),'code_pushed':True,'commit':c['sha']}); os.makedirs('var',exist_ok=True); json.dump(st,open(STATE,'w'))
print('published',len(files),'files commit',c['sha'][:7])
