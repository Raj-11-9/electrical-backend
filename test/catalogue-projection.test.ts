import {test} from 'node:test';import assert from 'node:assert/strict';import {publicCatalogue} from '../src/public-content';
test('public catalogue strips raw records, wholesale prices and private settings at every projected level',()=>{
  const payload={sourceUrl:'https://srvelectricals.com',importedAt:'2026-10-29',sourceHash:'hash',privateToken:'secret',products:[{id:'1',name:'Product',slug:'product',sku:'SKU',sellingPrice:'10',wholesalePrice:'1',sourceData:{private:'secret'},category:{name:'Category',slug:'category'},collectionSlugs:[],images:[{url:'https://example.com/a.png',alt:'Product',cloudinarySecret:'secret'}],variants:[{id:'2',name:'Option',sku:'SKU',price:'10',available:true,wholesalePrice:'1',options:{}}]}],pages:[],collections:[]};
  const result=publicCatalogue(payload,{brand:'SRV',smtpPassword:'secret'},'snapshot');const serialised=JSON.stringify(result);
  for(const forbidden of ['wholesalePrice','sourceData','privateToken','smtpPassword','cloudinarySecret'])assert.equal(serialised.includes(forbidden),false);
  assert.equal(result.storage,'snapshot');assert.equal(result.readOnly,true);assert.equal(result.products.length,1);
});
