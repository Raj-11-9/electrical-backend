const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const cheerio = require('cheerio');
const backend = path.resolve(__dirname,'..');
const frontend = process.env.FRONTEND_DIR || path.resolve(backend,'../electrical-frontend');
const admin = process.env.ADMIN_DIR || path.resolve(backend,'../electrical-admin-panel');
const base = 'https://srvelectricals.com';
async function read(url, json = true) {
  const r = await fetch(url, {signal: AbortSignal.timeout(30000)});
  if (!r.ok) throw new Error(`${r.status}: ${url}`);
  return json ? r.json() : r.text();
}
async function pool(items, fn) {
  const output=[]; let index=0;
  await Promise.all(Array.from({length:3},async()=>{while(index<items.length){const i=index++;output[i]=await fn(items[i]);}}));
  return output;
}
function safeHtml(html) {
  const $ = cheerio.load(html || '', null, false);
  $('script,style,iframe,form,input,button,object,embed,svg,noscript').remove();
  const allowed=new Set(['p','br','strong','b','em','i','u','ul','ol','li','h2','h3','h4','table','thead','tbody','tr','td','th','a','blockquote','hr','img']);
  $('*').each((_,el)=>{
    const node=$(el); if(!allowed.has(el.name)){node.replaceWith(node.contents());return;}
    const original={...el.attribs};for(const attr of Object.keys(el.attribs))node.removeAttr(attr);
    if(el.name==='a'&&original.href){const url=new URL(original.href,base);if(['https:','mailto:','tel:'].includes(url.protocol)){node.attr('href',url.href);node.attr('rel','noopener noreferrer');}}
    if(el.name==='img'&&original.src){const url=new URL(original.src,base);if(url.protocol==='https:'){node.attr('src',url.href);node.attr('alt',original.alt||'SRV Electricals');node.attr('loading','lazy');}else node.remove();}
    if(['td','th'].includes(el.name))for(const attr of ['colspan','rowspan'])if(/^\d{1,2}$/.test(original[attr]||''))node.attr(attr,original[attr]);
  });
  return $.html();
}
function plain(html) {return cheerio.load(html||'').text().replace(/\s+/g,' ').trim();}
async function run(){
  const html=await read(base+'/',false); const $=cheerio.load(html);
  const products=[];
  for(let page=1;page<=100;page++){const data=await read(`${base}/products.json?limit=250&page=${page}`);if(!data.products?.length)break;products.push(...data.products);}
  const unique=[...new Map(products.map(p=>[p.id,p])).values()];
  const rawCollections=(await read(base+'/collections.json?limit=250')).collections;
  const collections=await pool(rawCollections,async c=>{
    const items=[];
    for(let page=1;page<=100;page++){const d=await read(`${base}/collections/${c.handle}/products.json?limit=250&page=${page}`);if(!d.products?.length)break;items.push(...d.products.map(p=>String(p.id)));}
    return {id:String(c.id),name:c.title,slug:c.handle,description:plain(c.description),sourceDescriptionHtml:safeHtml(c.description),productIds:[...new Set(items)],image:c.image?.src||null,sourceUrl:`${base}/collections/${c.handle}`};
  });
  const pagePaths=[...new Set($('a[href^="/pages/"]').map((_,el)=>$(el).attr('href').split('?')[0]).get())];
  const pages=await pool(pagePaths,async href=>{const raw=await read(base+href,false);const page=cheerio.load(raw);const main=page('main');main.find('script,style,form').remove();let body=main.find('.rte').first();if(!body.length)body=main.find('.page__content,.page-content,.page-content-wrapper').first();if(!body.length)body=main;return {slug:href.split('/').pop(),title:main.find('h1').first().text().trim()||page('title').text().split('â€“')[0].trim(),html:safeHtml(body.html()),sourceUrl:base+href};});
  const headerLogo=$('.header__heading-logo').first().attr('src');
  const logoUrl=new URL(headerLogo,base).href;
  const logo=Buffer.from(await (await fetch(logoUrl)).arrayBuffer());
  const reviews=[];
  // Testimonials are preserved as source-site testimonials; they are not newly verified reviews.
  $('.srv-card').each((_,el)=>{const node=$(el);const quote=node.find('.srv-card__text').text().trim();if(quote&&!reviews.some(r=>r.quote===quote)){const text=node.text().replace(/\s+/g,' ').trim();reviews.push({name:node.find('.srv-author__name').text().trim(),quote,sourceUrl:base+'/',sourceText:text.slice(-300)});}});
  const data={sourceUrl:base,importedAt:new Date().toISOString(),logoSourceUrl:logoUrl,settings:{brand:'SRV Electricals',heroTitle:'Powering every connection.',heroDescription:"Electrical products for residential, commercial and industrial applications. Explore SRVâ€™s complete public catalogue.",announcement:'SRV Electricals Â· Retail, wholesale & dealer enquiries',businessEmail:'info@srvelectricals.com',businessPhone:'+91 88376 84004',businessAddress:'Nangal Kalan Road, Village Jawaharke, Mansa, Punjab â€“ 151505',businessHours:'Monâ€“Sat, 9amâ€“6pm',whatsappNumber:'',reviews:[],brands:['SRV Electricals'],certifications:[]},collections,pages,sourceReviews:reviews,sourceCertificationClaims:['ISI','BIS','ISO 9001'],products:unique.map(p=>{
    const membership=collections.filter(c=>c.productIds.includes(String(p.id)));
    const category=membership.find(c=>!['best-sellers','featured-products','appliances','led','accessories'].includes(c.slug))||membership[0];
    const variants=p.variants.map(v=>({id:String(v.id),sku:v.sku||null,name:v.title,price:v.price,mrp:v.compare_at_price||null,available:v.available,options:Object.fromEntries(p.options.map((o,i)=>[o.name,v['option'+(i+1)]]).filter(([,v])=>v!=null)),image:v.featured_image?.src||null,grams:v.grams,taxable:v.taxable}));
    return {id:String(p.id),name:p.title,slug:p.handle,sku:variants[0]?.sku||null,sellingPrice:variants.reduce((min,v)=>Number(v.price)<Number(min)?v.price:min,variants[0]?.price||'0'),category:{name:category?.name||'Electrical equipment',slug:category?.slug||'electrical-equipment'},collectionSlugs:membership.map(c=>c.slug),images:p.images.map(i=>({id:String(i.id),url:i.src,alt:i.alt||p.title})),variants,descriptionHtml:safeHtml(p.body_html),description:plain(p.body_html),sourceUrl:`${base}/products/${p.handle}`,vendor:p.vendor,productType:p.product_type,tags:p.tags,createdAt:p.created_at,updatedAt:p.updated_at,sourceData:p};
  })};
  for(const p of data.products){const doc=cheerio.load(p.descriptionHtml);p.specificationTables=doc('table').toArray().map(table=>doc(table).find('tr').toArray().map(row=>doc(row).find('th,td').toArray().map(cell=>doc(cell).text().replace(/\s+/g,' ').trim())));}
  for(const p of data.pages)p.html=p.html.replaceAll('href="tel:+"','href="tel:+918837684004"').replaceAll('href="mailto:info@srvelectricals.comi"','href="mailto:info@srvelectricals.com"');
  data.settings.reviews=reviews.map(({name,quote})=>({name,quote}));
  const contact=pages.find(p=>p.slug==='contact-us');
  const wa=contact?.html.match(/https:\/\/wa\.me\/(\d{7,15})/);
  if(wa)data.settings.whatsappNumber=wa[1];
  const order=['fan-box','concealed-box','modular-box','mcb-distribution-box','bus-bar-distribution-box','off-load-change-over-switch'];
  const taxonomy=collections.filter(c=>!['best-sellers','featured-products'].includes(c.slug)).sort((a,b)=>(order.indexOf(a.slug)<0?99:order.indexOf(a.slug))-(order.indexOf(b.slug)<0?99:order.indexOf(b.slug))).map(c=>({name:c.name,slug:c.slug,image:c.image||data.products.find(p=>p.collectionSlugs.includes(c.slug))?.images[0]?.url||null,count:c.productIds.length}));
  await fs.writeFile(path.join(frontend,'src/data/srv-categories.json'),JSON.stringify(taxonomy,null,2));
  data.sourceHash=crypto.createHash('sha256').update(JSON.stringify({products:unique,collections,pages,reviews,settings:data.settings,logoHash:crypto.createHash('sha256').update(logo).digest('hex')})).digest('hex');
  for(const [root,file] of [[backend,'catalogue/srv.json'],[frontend,'src/data/srv.json']]){await fs.mkdir(path.dirname(path.join(root,file)),{recursive:true});await fs.writeFile(path.join(root,file),JSON.stringify(data,null,2));}
  for(const root of [frontend,admin]){await fs.mkdir(path.join(root,'public'),{recursive:true});await fs.writeFile(path.join(root,'public/srv-logo.png'),logo);}
  await fs.writeFile(path.join(backend,'catalogue/srv-public-products.raw.json'),JSON.stringify(unique,null,2));
  console.log(JSON.stringify({products:data.products.length,variants:data.products.reduce((n,p)=>n+p.variants.length,0),collections:collections.length,pages:pages.map(p=>[p.slug,p.html.length]),images:data.products.reduce((n,p)=>n+p.images.length,0),logoBytes:logo.length,sourceHash:data.sourceHash}));
}
run().catch(e=>{console.error(e);process.exitCode=1;});
