import {test} from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import PptxGenJS from 'pptxgenjs';
import {createCanvas} from '@napi-rs/canvas';
import {inspectPresentationReference,readReferenceImage,referenceLimits} from '../backend/modules/imports/reference.js';

const p='http://schemas.openxmlformats.org/presentationml/2006/main',a='http://schemas.openxmlformats.org/drawingml/2006/main',r='http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const rels=items=>`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.map(([Id,Type,Target,TargetMode])=>`<Relationship Id="${Id}" Type="${r}/${Type}" Target="${Target}"${TargetMode?` TargetMode="${TargetMode}"`:''}/>`).join('')}</Relationships>`;
const layer=(tag,body,extra='')=>`<q:${tag} xmlns:q="${p}" xmlns:d="${a}" xmlns:r="${r}"><q:cSld>${body}</q:cSld>${extra}</q:${tag}>`;
const shape=(id,content,ph='',properties='')=>`<q:sp><q:nvSpPr><q:cNvPr id="${id}" name="shape-${id}"/><q:nvPr>${ph}</q:nvPr></q:nvSpPr><q:spPr>${properties}</q:spPr>${content}</q:sp>`;
const xfrm=(x=1000000,y=1000000,w=2000000,h=1000000)=>`<d:xfrm><d:off x="${x}" y="${y}"/><d:ext cx="${w}" cy="${h}"/></d:xfrm>`;
const text=html=>`<q:txBody><d:bodyPr lIns="100000"/><d:p>${html}</d:p></q:txBody>`;
const png=()=>{const canvas=createCanvas(40,20),ctx=canvas.getContext('2d');ctx.fillStyle='#AA44CC';ctx.fillRect(0,0,40,20);return canvas.encodeSync('png');};
async function fixture(overrides={}){
  const zip=new JSZip();
  const files={
    'ppt/presentation.xml':`<q:presentation xmlns:q="${p}" xmlns:r="${r}"><q:sldIdLst><q:sldId id="256" r:id="slide"/></q:sldIdLst><q:sldSz cx="12800000" cy="7200000"/></q:presentation>`,
    'ppt/_rels/presentation.xml.rels':rels([['slide','slide','slides/slide1.xml']]),
    'ppt/theme/theme1.xml':`<d:theme xmlns:d="${a}" name="Fixture"><d:themeElements><d:clrScheme name="Fixture"><d:dk1><d:srgbClr val="102030"/></d:dk1><d:lt1><d:sysClr val="window" lastClr="FAFBFC"/></d:lt1><d:accent1><d:srgbClr val="BB4400"/></d:accent1></d:clrScheme><d:fontScheme><d:majorFont><d:latin typeface="Arial"/></d:majorFont><d:minorFont><d:latin typeface="Verdana"/></d:minorFont></d:fontScheme></d:themeElements></d:theme>`,
    'ppt/slideMasters/_rels/slideMaster1.xml.rels':rels([['theme','theme','../theme/theme1.xml'],['logo','image','../media/logo.png']]),
    'ppt/slideMasters/slideMaster1.xml':layer('sldMaster',`<q:bg><q:bgPr><d:solidFill><d:schemeClr val="bg1"/></d:solidFill></q:bgPr></q:bg><q:spTree>${shape(1,text('<d:r><d:rPr sz="3000"><d:latin typeface="+mj-lt"/><d:solidFill><d:schemeClr val="tx1"/></d:solidFill></d:rPr><d:t>Title placeholder</d:t></d:r>'),'<q:ph type="title" idx="1"/>',xfrm())}<q:pic><q:nvPicPr><q:cNvPr id="2" name="Logo"/></q:nvPicPr><q:blipFill><d:blip r:embed="logo"/></q:blipFill><q:spPr>${xfrm(10000000,100000,800000,400000)}</q:spPr></q:pic></q:spTree>`,`<q:clrMap bg1="lt1" tx1="dk1"/>`),
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels':rels([['master','slideMaster','../slideMasters/slideMaster1.xml']]),
    'ppt/slideLayouts/slideLayout1.xml':layer('sldLayout',`<q:spTree>${shape(1,'','<q:ph type="title" idx="1"/>')}</q:spTree>`),
    'ppt/slides/_rels/slide1.xml.rels':rels([['layout','slideLayout','../slideLayouts/slideLayout1.xml']]),
    'ppt/slides/slide1.xml':layer('sld',`<q:spTree>${shape(1,text('<d:r><d:rPr b="1"/><d:t>Hello </d:t></d:r><d:r><d:rPr sz="2200"><d:latin typeface="Proxima Nova"/><d:solidFill><d:schemeClr val="accent1"><d:tint val="50000"/><d:alpha val="50000"/></d:schemeClr></d:solidFill></d:rPr><d:t>world</d:t></d:r>'),'<q:ph type="title" idx="1"/>')}</q:spTree>`),
    'ppt/media/logo.png':png(),...overrides
  };
  for(const [name,value] of Object.entries(files))if(value!==null)zip.file(name,value);
  return zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
}

test('inspects namespace aliases, theme colors/fonts, inherited placeholders and owned logo',async()=>{
  const buffer=await fixture(),result=await inspectPresentationReference(buffer);
  assert.deepEqual(result.canvas.emu,{width:12800000,height:7200000});assert.equal(result.canvas.width,1280);
  assert.equal(result.palette[0].colors.lt1,'#FAFBFC');assert.equal(result.palette[0].fonts.major,'Arial');
  assert.equal(result.slides[0].background.color.resolved,'#FAFBFC');assert.equal(result.slides[0].background.provenance.role,'master');
  assert.equal(result.slides[0].related.master,'ppt/slideMasters/slideMaster1.xml');
  const title=result.slides[0].shapes[0];assert.equal(title.text,'Hello world');assert.equal(title.box.x,100);assert.equal(title.box.width,200);
  assert.equal(title.textStyle.font,'Arial');assert.equal(title.textStyle.bold,true);assert.equal(title.runs[1].style.font,'Proxima Nova');assert.equal(title.runs[1].style.color.resolved,'#DDA280');assert.equal(title.runs[1].style.color.opacity,.5);
  assert.equal(title.provenance.inheritedFrom,'ppt/slideLayouts/slideLayout1.xml');
  assert.equal(result.masters[0].shapes[1].imageAssetId,'ppt/media/logo.png');assert.equal(result.images[0].width,40);
  const image=await readReferenceImage(buffer,result.images[0].assetId);assert.equal(image.mime,'image/png');assert.deepEqual(image.buffer,png());
  assert.equal(result.warnings.length,0);
});

test('reads generated PowerPoint layout decorations without merging sample content into master',async()=>{
  const pptx=new PptxGenJS();pptx.layout='LAYOUT_WIDE';pptx.theme={headFontFace:'Arial',bodyFontFace:'Arial'};
  pptx.defineSlideMaster({title:'REFERENCE',background:{color:'142536'},objects:[{rect:{x:0,y:0,w:13.333,h:.2,fill:{color:'FFAA11'},line:{color:'FFAA11'}}},{image:{data:'image/png;base64,'+png().toString('base64'),x:11.5,y:.5,w:1,h:.5}},{text:{text:'{{author}}',options:{x:.7,y:7,w:3,h:.2,fontSize:10,color:'FFFFFF'}}}]});
  const slide=pptx.addSlide('REFERENCE');slide.addText('Example content',{x:1,y:2,w:8,h:1,fontFace:'Arial',fontSize:40,color:'FFFFFF'});
  const result=await inspectPresentationReference(await pptx.write({outputType:'nodebuffer'})),layout=result.layouts.find(layout=>layout.name==='REFERENCE');
  assert.equal(layout.background.color.resolved,'#142536');assert.equal(layout.shapes[0].fill.color.resolved,'#FFAA11');assert.ok(layout.shapes.find(shape=>shape.type==='image'));assert.ok(layout.shapes.find(shape=>shape.text==='{{author}}'));
  assert.ok(!layout.shapes.some(shape=>shape.text.includes('Example content')));assert.ok(result.slides[0].shapes.some(shape=>shape.text==='Example content'));
});

test('flattens group coordinates and returns bounded custom numeric paths',async()=>{
  const custom=`<d:custGeom><d:pathLst><d:path w="100" h="50"><d:moveTo><d:pt x="0" y="0"/></d:moveTo><d:cubicBezTo><d:pt x="20" y="10"/><d:pt x="70" y="50"/><d:pt x="100" y="0"/></d:cubicBezTo><d:close/></d:path></d:pathLst></d:custGeom>`;
  const group=`<q:grpSp><q:grpSpPr><d:xfrm rot="60000"><d:off x="2000000" y="1000000"/><d:ext cx="4000000" cy="2000000"/><d:chOff x="0" y="0"/><d:chExt cx="2000000" cy="1000000"/></d:xfrm></q:grpSpPr>${shape(7,'','',xfrm(100000,200000,1000000,500000)+custom)}</q:grpSp>`;
  const result=await inspectPresentationReference(await fixture({'ppt/slides/slide1.xml':layer('sld',`<q:spTree>${group}</q:spTree>`)})),item=result.slides[0].shapes[0];
  assert.deepEqual([item.box.x,item.box.y,item.box.width,item.box.height],[220,140,200,100]);assert.equal(item.geometry,'custom');assert.deepEqual(item.paths[0].commands[1].points[2],{x:100,y:0});assert.ok(result.warnings.some(text=>text.includes('повёрнутых группах')));
});

test('reports slide/shape coverage and rejects unreasonable caller limits',async()=>{
  const result=await inspectPresentationReference(await fixture(),{maxShapes:1});assert.equal(result.limits.shapesRead,1);assert.equal(result.masters[0].shapeCount,2);assert.equal(result.slides[0].shapes.length,0);assert.ok(result.warnings.some(text=>text.includes('Список фигур ограничен')));
  await assert.rejects(inspectPresentationReference(await fixture(),{maxSlides:13}),e=>e.status===400);
});

test('never reads external relationships or host paths as image assets',async()=>{
  const result=await inspectPresentationReference(await fixture({'ppt/slideMasters/_rels/slideMaster1.xml.rels':rels([['theme','theme','../theme/theme1.xml'],['logo','image','https://private.example/logo.png','External']])}));
  assert.equal(result.images.length,0);assert.ok(result.warnings.some(text=>text.includes('Внешние ссылки')));
  for(const id of ['/etc/passwd','ppt/media/../../secret.png','ppt/media/evil.svg','file:///tmp/image.png'])await assert.rejects(readReferenceImage(await fixture(),id));
});

test('rejects oversized ZIP/XML, package traversal, DTD and non-presentation data',async()=>{
  await assert.rejects(inspectPresentationReference(Buffer.alloc(referenceLimits.fileBytes+1)),e=>e.status===413);
  await assert.rejects(inspectPresentationReference(await fixture({'ppt/slides/slide1.xml':'x'.repeat(referenceLimits.xmlBytes+1)})),e=>e.status===413);
  await assert.rejects(inspectPresentationReference(await fixture({'ppt/slides/slide1.xml':'<!DOCTYPE q:sld [<!ENTITY evil SYSTEM "file:///etc/passwd">]>'+layer('sld','')})),/DTD/);
  await assert.rejects(inspectPresentationReference(await fixture({'../evil.xml':'x'})),/путь/);
  await assert.rejects(inspectPresentationReference(await fixture({'ppt/presentation.xml':null})),/отсутствует/);
  await assert.rejects(inspectPresentationReference(await fixture({'ppt/huge.bin':Buffer.alloc(referenceLimits.inflatedBytes+1)})),e=>e.status===413);
});

test('resolves common fill/line style references using theme colors',async()=>{
  const buffer=await fixture(),zip=await JSZip.loadAsync(buffer),theme=await zip.file('ppt/theme/theme1.xml').async('string');
  zip.file('ppt/theme/theme1.xml',theme.replace('</d:themeElements>',`<d:fmtScheme><d:fillStyleLst><d:solidFill><d:schemeClr val="phClr"/></d:solidFill></d:fillStyleLst><d:lnStyleLst><d:ln w="12700"><d:solidFill><d:schemeClr val="phClr"/></d:solidFill></d:ln></d:lnStyleLst></d:fmtScheme></d:themeElements>`));
  const styled=shape(9,'','',xfrm()).replace('</q:sp>',`<q:style><d:fillRef idx="1"><d:schemeClr val="accent1"/></d:fillRef><d:lnRef idx="1"><d:srgbClr val="335577"/></d:lnRef></q:style></q:sp>`);
  zip.file('ppt/slides/slide1.xml',layer('sld',`<q:spTree>${styled}</q:spTree>`));
  const result=await inspectPresentationReference(await zip.generateAsync({type:'nodebuffer'})),item=result.slides[0].shapes[0];
  assert.equal(item.fill.color.resolved,'#BB4400');assert.equal(item.line.fill.color.resolved,'#335577');assert.equal(item.line.width,1.27);
});
