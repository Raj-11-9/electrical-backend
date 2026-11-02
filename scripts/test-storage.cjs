// Isolated PostgreSQL-compatible storage QA. This does not replace Docker/PostgreSQL deployment testing.
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {PrismaClient}=require('@prisma/client');
const {PGlite}=require('@electric-sql/pglite');
const {PGLiteSocketServer}=require('@electric-sql/pglite-socket');
const root=path.resolve(__dirname,'..'),parent=path.resolve(root,'..');
const directory=path.join(root,'work','storage-verification-'+Date.now());
const databasePath=path.join(directory,'pgdata');
const source=JSON.parse(fs.readFileSync(path.join(root,'catalogue/srv.json'),'utf8'));
const checks=[],children=[];let database,socket,client;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function check(name,fn){await fn();checks.push({name,status:'passed'});console.log('PASS '+name);}
function start(args,cwd,extra){const child=spawn(process.execPath,args,{cwd,env:{...process.env,...extra},stdio:['ignore','pipe','pipe']});let log='';child.stdout.on('data',b=>{log+=b;});child.stderr.on('data',b=>{log+=b;});children.push(child);return {child,logs:()=>log.slice(-1800)};}
async function wait(url,processInfo){for(let i=0;i<120;i++){try{const response=await fetch(url,{signal:AbortSignal.timeout(1000)});if(response.ok)return;}catch{}if(processInfo.child.exitCode!==null)throw new Error('Test service stopped: '+processInfo.logs());await sleep(200);}throw new Error('Test service not ready: '+processInfo.logs());}
async function stopChildren(){for(const child of children.splice(0)){child.kill();}await sleep(300);}
(async()=>{
  fs.mkdirSync(directory,{recursive:true});
  try{
    database=await PGlite.create(databasePath);
    await check('all SQL migrations apply to a real PostgreSQL-compatible engine',async()=>{
      const folders=fs.readdirSync(path.join(root,'prisma/migrations'),{withFileTypes:true}).filter(f=>f.isDirectory()).map(f=>f.name).sort();
      for(const folder of folders)await database.exec(fs.readFileSync(path.join(root,'prisma/migrations',folder,'migration.sql'),'utf8'));
      assert.ok((await database.query("SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema='public'")).rows[0].count>=26);
    });
    socket=new PGLiteSocketServer({db:database,port:5442,host:'127.0.0.1'});await socket.start();
    const url='postgresql://postgres:postgres@127.0.0.1:5442/postgres?schema=public&connection_limit=1&sslmode=disable';
    client=new PrismaClient({datasources:{db:{url}}});
    await check('the actual Prisma PostgreSQL driver connects',async()=>{await client.$connect();assert.equal((await client.$queryRawUnsafe('SELECT 1 AS result'))[0].result,1);});
    const {importSrv}=require(path.join(root,'.test-build/scripts/import-srv.js'));
    await check('source import stores all products, variants, images and specification tables',async()=>{
      await importSrv(client);assert.equal(await client.product.count(),source.products.length);assert.equal(await client.productVariant.count(),source.products.reduce((n,p)=>n+p.variants.length,0));assert.equal(await client.productImage.count(),new Set(source.products.flatMap(p=>p.images.map(i=>i.id))).size);assert.ok(await client.productSpecification.count()>0);assert.equal(await client.inventory.count(),0);
    });
    await check('reimport is idempotent against SQL unique constraints',async()=>{await importSrv(client);assert.equal(await client.product.count(),source.products.length);assert.equal(await client.catalogueImport.count(),1);assert.equal(await client.catalogueSnapshot.count(),1);});
    await check('unknown tax, MOQ and stock quantities stay unknown',async()=>{assert.equal(await client.product.count({where:{gstRate:null,minimumOrderQuantity:null}}),source.products.length);assert.equal(await client.inventory.count(),0);});
    await check('price, reservation, foreign-key and uniqueness constraints reject invalid records',async()=>{
      const products=await client.product.findMany({take:2});const variant=await client.productVariant.findFirstOrThrow();
      await assert.rejects(client.product.update({where:{id:products[0].id},data:{sellingPrice:-1}}));
      await assert.rejects(client.product.update({where:{id:products[0].id},data:{sku:products[1].sku}}));
      await assert.rejects(client.inventory.create({data:{variantId:variant.id,quantity:1,reserved:2}}));
      await assert.rejects(client.productVariant.create({data:{productId:'missing-parent',sku:'QA-INVALID-RELATION',name:'isolated test',sellingPrice:'1',attributes:{}}}));
      assert.equal(await client.inventory.count(),0);
    });
    await check('failed inventory transactions roll back completely',async()=>{const variant=await client.productVariant.findFirstOrThrow();await assert.rejects(client.$transaction(async tx=>{await tx.inventory.create({data:{variantId:variant.id,quantity:5,reserved:0}});throw new Error('intentional QA rollback');}));assert.equal(await client.inventory.count(),0);});
    const marker='SRV-INTEGRATION-CHECK-'+Date.now();
    await client.siteSettings.update({where:{id:'main'},data:{content:{...source.settings,announcement:marker,businessEmail:'integration@example.test'}}});
    await client.$disconnect();client=undefined;
    // The test socket multiplexes one physical session; clear its previous client's prepared statements.
    // A normal PostgreSQL server has independent per-client sessions and does not need this test-adapter reset.
    await database.exec('DEALLOCATE ALL');
    const adminEmail='admin.qa@example.test',adminPassword='qa-admin-password-2026',jwtSecret='qa-jwt-secret-that-is-long-enough-for-integration-tests';
    const api=start(['dist/main.js'],root,{PORT:'4003',HOST:'127.0.0.1',NODE_ENV:'test',ALLOW_CATALOGUE_SNAPSHOT:'false',DATABASE_URL:url,ADMIN_EMAIL:adminEmail,ADMIN_PASSWORD:adminPassword,JWT_SECRET:jwtSecret});
    await wait('http://127.0.0.1:4003/api/health',api);
    await check('NestJS reads persisted records through Prisma rather than the source fallback',async()=>{const response=await fetch('http://127.0.0.1:4003/api/catalogue');const data=await response.json();if(!response.ok)await sleep(200);assert.equal(response.status,200,JSON.stringify(data)+' '+api.logs());assert.equal(data.storage,'postgresql');assert.equal(data.settings.announcement,marker);assert.equal(data.products.length,source.products.length);});
    let adminToken,createdCategory,createdProduct;
    await check('administrator login issues a short-lived access token and protects writes',async()=>{const denied=await fetch('http://127.0.0.1:4003/api/admin/categories',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'Unauthorized'})});assert.equal(denied.status,401);const response=await fetch('http://127.0.0.1:4003/api/admin/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:adminEmail,password:adminPassword})});assert.equal(response.status,201);adminToken=(await response.json()).token;assert.equal(typeof adminToken,'string');});
    await check('admin can persist a product category and a published product with stock',async()=>{const headers={authorization:'Bearer '+adminToken,'content-type':'application/json'};const stamp=Date.now();const categoryResponse=await fetch('http://127.0.0.1:4003/api/admin/categories',{method:'POST',headers,body:JSON.stringify({name:'Admin QA Category '+stamp})});createdCategory=await categoryResponse.json();assert.equal(categoryResponse.status,201,JSON.stringify(createdCategory));const productResponse=await fetch('http://127.0.0.1:4003/api/admin/products',{method:'POST',headers,body:JSON.stringify({name:'Admin QA Product '+stamp,sku:'QA-'+stamp,categoryId:createdCategory.id,sellingPrice:'123.45',description:'Integration test product',quantity:7})});createdProduct=await productResponse.json();assert.equal(productResponse.status,201,JSON.stringify(createdProduct));const catalogue=await(await fetch('http://127.0.0.1:4003/api/catalogue')).json();assert.ok(catalogue.products.some(p=>p.id===createdProduct.id&&p.name===createdProduct.name));assert.ok(catalogue.collections.some(c=>c.id===createdCategory.id&&c.name===createdCategory.name&&c.productIds.includes(createdProduct.id)));const product=catalogue.products.find(p=>p.id===createdProduct.id);assert.equal(product.variants.length,1);assert.equal(product.variants[0].available,true);assert.equal(product.description,'Integration test product');});
    const store=start(['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','-p','3004'],path.join(parent,'electrical-frontend'),{NODE_ENV:'production',API_URL:'http://127.0.0.1:4003/api'});
    const admin=start(['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','-p','3005'],path.join(parent,'electrical-admin-panel'),{NODE_ENV:'production',API_URL:'http://127.0.0.1:4003/api',STOREFRONT_URL:'http://127.0.0.1:3004'});
    await wait('http://127.0.0.1:3004',store);await wait('http://127.0.0.1:3005/settings',admin);
    await check('the production storefront uses the same persisted backend data',async()=>{assert.ok((await(await fetch('http://127.0.0.1:3004')).text()).includes(marker));});
    await check('the production admin uses persisted settings without database-specific copy',async()=>{const html=await(await fetch('http://127.0.0.1:3005/settings')).text();assert.ok(html.includes('integration@example.test'));assert.equal(/postgresql|database connection|catalogue source/i.test(html),false);});
    await check('the production admin exposes product and category creation forms',async()=>{const products=await(await fetch('http://127.0.0.1:3005/products')).text();const categories=await(await fetch('http://127.0.0.1:3005/categories')).text();assert.ok(products.includes('Add product'));assert.ok(categories.includes('Add product category'));});
    await check('admin login cookie protects the product and category creation proxy',async()=>{const login=await fetch('http://127.0.0.1:3005/api/admin/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:adminEmail,password:adminPassword})});assert.equal(login.status,200);const cookie=login.headers.get('set-cookie')?.split(';',1)[0];assert.ok(cookie?.startsWith('srv_admin_session='));const headers={'content-type':'application/json',cookie};assert.equal((await fetch('http://127.0.0.1:3005/api/admin/session',{headers})).status,200);const anonymousSession=await fetch('http://127.0.0.1:3005/api/admin/session');assert.equal(anonymousSession.status,200);assert.equal((await anonymousSession.json()).authenticated,false);assert.equal((await fetch('http://127.0.0.1:3005/api/admin/categories',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'Anonymous'})})).status,401);const categoryResponse=await fetch('http://127.0.0.1:3005/api/admin/categories',{method:'POST',headers,body:JSON.stringify({name:'Proxy QA Category '+Date.now()})});const category=await categoryResponse.json();assert.equal(categoryResponse.status,201,JSON.stringify(category));const productResponse=await fetch('http://127.0.0.1:3005/api/admin/products',{method:'POST',headers,body:JSON.stringify({name:'Proxy QA Product '+Date.now(),sku:'PROXY-QA-'+Date.now(),categoryId:category.id,sellingPrice:'55.25',quantity:2})});const product=await productResponse.json();assert.equal(productResponse.status,201,JSON.stringify(product));const catalogue=await(await fetch('http://127.0.0.1:4003/api/catalogue')).json();assert.ok(catalogue.products.some(p=>p.id===product.id));});
    await stopChildren();await socket.stop();socket=undefined;
    const backup=await database.dumpDataDir('gzip');fs.writeFileSync(path.join(directory,'storage-backup.tar.gz'),Buffer.from(await backup.arrayBuffer()));
    await database.close();database=undefined;
    await check('admin-created records survive a clean close and reopen of filesystem storage',async()=>{database=await PGlite.create(databasePath);assert.equal((await database.query('SELECT count(*)::int AS count FROM "Product"')).rows[0].count,source.products.length+2);assert.equal((await database.query('SELECT count(*)::int AS count FROM "Category"')).rows[0].count,source.collections.length+3);assert.equal((await database.query('SELECT "sourceHash" FROM "CatalogueSnapshot" WHERE id=$1',['srv'])).rows[0].sourceHash,source.sourceHash);await database.close();database=undefined;});
    await check('the test-engine backup restores both admin-created variants and products',async()=>{database=await PGlite.create({loadDataDir:new Blob([fs.readFileSync(path.join(directory,'storage-backup.tar.gz'))])});assert.equal((await database.query('SELECT count(*)::int AS count FROM "ProductVariant"')).rows[0].count,source.products.reduce((n,p)=>n+p.variants.length,0)+2);assert.equal((await database.query('SELECT count(*)::int AS count FROM "Product"')).rows[0].count,source.products.length+2);});
    const report={engine:'PGlite PostgreSQL-compatible WASM, actual Prisma PostgreSQL driver; isolated test database',docker:'not exercised; Windows engine-pipe permission denied',passed:checks.length,checks,dataDirectory:directory};
    fs.writeFileSync(path.join(root,'work/verification/storage.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed:checks.length,dataDirectory:directory}));
  }finally{await stopChildren();if(client)await client.$disconnect();if(socket)await socket.stop();if(database)await database.close();}
})().catch(error=>{fs.mkdirSync(path.join(root,'work/verification'),{recursive:true});fs.writeFileSync(path.join(root,'work/verification/storage.json'),JSON.stringify({checks,error:error.message,passed:checks.length,docker:'not exercised'},null,2));console.error(error);process.exitCode=1;});
