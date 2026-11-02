const {spawn}=require('node:child_process');
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const net=require('node:net');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const root=path.resolve(__dirname,'..');
const source=JSON.parse(fs.readFileSync(path.join(root,'catalogue/srv.json'),'utf8'));
const checks=[];
async function check(name,fn){await fn();checks.push({name,status:'passed'});}
async function availablePort(){
  const server=net.createServer();
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const {port}=server.address();
  await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  return port;
}
(async()=>{
  const port=process.env.API_TEST_PORT?Number(process.env.API_TEST_PORT):await availablePort();
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error('API_TEST_PORT must be a valid TCP port');
  const base='http://127.0.0.1:'+port+'/api';
  const child=spawn(process.execPath,['dist/main.js'],{cwd:root,env:{...process.env,PORT:String(port),HOST:'127.0.0.1',NODE_ENV:'test',ALLOW_CATALOGUE_SNAPSHOT:'true'},stdio:['ignore','pipe','pipe']});
  let logs='';child.stdout.on('data',b=>{logs+=b;});child.stderr.on('data',b=>{logs+=b;});
  async function request(route,options={}){return fetch(base+route,{...options,signal:AbortSignal.timeout(3000)});}
  try{
    let ready=false;
    for(let i=0;i<100;i++){try{if((await request('/status')).ok){ready=true;break;}}catch{}await delay(200);}
    if(!ready)throw new Error('Isolated API did not start. '+logs.slice(-1500));
    await check('status accurately reports degraded, read-only preview',async()=>{const body=await(await request('/status')).json();assert.equal(body.status,'degraded');assert.equal(body.readOnly,true);assert.notEqual(body.database,'connected');});
    await check('health does not claim a PostgreSQL connection',async()=>{const response=await request('/health');assert.equal(response.status,503);});
    await check('catalogue preserves all products, options and source provenance',async()=>{const response=await request('/catalogue');const body=await response.json();assert.equal(body.storage,'snapshot');assert.equal(body.products.length,source.products.length);assert.equal(body.products.reduce((n,p)=>n+p.variants.length,0),source.products.reduce((n,p)=>n+p.variants.length,0));assert.equal(body.sourceHash,source.sourceHash);assert.equal(JSON.stringify(body).includes('sourceData'),false);assert.ok(response.headers.get('content-security-policy'));});
    await check('categories and homepage expose the public catalogue',async()=>{assert.equal((await(await request('/categories')).json()).length,source.collections.length);assert.equal((await(await request('/home')).json()).products.length,12);});
    await check('allowed storefront origin receives CORS headers',async()=>{assert.equal((await request('/catalogue',{headers:{origin:'http://localhost:3000'}})).headers.get('access-control-allow-origin'),'http://localhost:3000');});
    await check('unknown origin does not receive CORS access',async()=>{assert.equal((await request('/catalogue',{headers:{origin:'https://untrusted.invalid'}})).headers.get('access-control-allow-origin'),null);});
    await check('admin product and category writes require an authenticated administrator',async()=>{for(const route of ['/admin/products','/admin/categories'])assert.equal((await request(route,{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,401);});
    await check('public API rate limit returns 429 under bounded load',async()=>{let limited=false;for(let i=0;i<125;i++){const response=await request('/status');if(response.status===429){limited=true;break;}}assert.equal(limited,true);});
    fs.mkdirSync(path.join(root,'work/verification'),{recursive:true});fs.writeFileSync(path.join(root,'work/verification/api.json'),JSON.stringify({checks,mode:'isolated read-only preview; no PostgreSQL integration',passed:checks.length},null,2));
    console.log(JSON.stringify({passed:checks.length,checks}));
  }finally{if(child.exitCode===null){child.kill();await new Promise(resolve=>child.once('exit',resolve));}}
})().catch(error=>{console.error(error.message);process.exitCode=1;});
