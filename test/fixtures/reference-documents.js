import PptxGenJS from 'pptxgenjs';
import {PDFDocument,StandardFonts,rgb} from 'pdf-lib';
import {createCanvas} from '@napi-rs/canvas';
import JSZip from 'jszip';
import {DOMParser} from 'linkedom';

export const referencePalette=Object.freeze({background:'#13223d',text:'#f4f0e7',muted:'#aebed6',accent:'#f47e52',surface:'#263958',border:'#4c617f',secondAccent:'#42c9b0'});
export const referenceGeometry=Object.freeze({
  bar:{x:0,y:0,width:1280,height:12},
  logo:{x:1144,y:42,width:64,height:64},
  panel:{x:72,y:270,width:1136,height:260},
  footer:{x:72,y:662,width:600,height:22},
  rule:{x:72,y:642,width:1136,height:2},
  circle:{x:1088,y:542,width:44,height:44},
});
const hex=color=>color.slice(1),pdfColor=color=>rgb(...[1,3,5].map(offset=>parseInt(color.slice(offset,offset+2),16)/255));
const inches=rect=>({x:rect.x/96,y:rect.y/96,w:rect.width/96,h:rect.height/96});

async function putSharedObjectsOnMaster(buffer){
  // PptxGenJS's named "master" is emitted as a common layout. Place its
  // ordinary objects on the actual OOXML master to exercise both inheritance
  // levels; relationship targets remain sibling-relative within ppt/.
  const zip=await JSZip.loadAsync(buffer),parser=new DOMParser();
  const layout=parser.parseFromString(await zip.file('ppt/slideLayouts/slideLayout2.xml').async('string'),'text/xml');
  const master=parser.parseFromString(await zip.file('ppt/slideMasters/slideMaster1.xml').async('string'),'text/xml');
  const layoutRelations=parser.parseFromString(await zip.file('ppt/slideLayouts/_rels/slideLayout2.xml.rels').async('string'),'text/xml');
  const masterRelations=parser.parseFromString(await zip.file('ppt/slideMasters/_rels/slideMaster1.xml.rels').async('string'),'text/xml');
  const tree=master.getElementsByTagName('p:spTree')[0],common=master.getElementsByTagName('p:cSld')[0];
  const background=layout.getElementsByTagName('p:bg')[0];if(background){common.insertBefore(background.cloneNode(true),tree);background.remove();}
  const remap=new Map();
  for(const relation of Array.from(layoutRelations.getElementsByTagName('Relationship'))){
    if(!relation.getAttribute('Type')?.endsWith('/image'))continue;
    const id='rIdReferenceImage'+remap.size;remap.set(relation.getAttribute('Id'),id);const copy=relation.cloneNode(true);copy.setAttribute('Id',id);masterRelations.documentElement.append(copy);relation.remove();
  }
  const sourceTree=layout.getElementsByTagName('p:spTree')[0];
  for(const node of Array.from(sourceTree.children)){
    if(!['p:sp','p:pic','p:cxnSp'].includes(node.tagName))continue;
    const copy=node.cloneNode(true);for(const blip of Array.from(copy.getElementsByTagName('a:blip'))){const id=remap.get(blip.getAttribute('r:embed'));if(id)blip.setAttribute('r:embed',id);}
    tree.append(copy);node.remove();
  }
  for(const [name,document] of [['ppt/slideLayouts/slideLayout2.xml',layout],['ppt/slideMasters/slideMaster1.xml',master],['ppt/slideLayouts/_rels/slideLayout2.xml.rels',layoutRelations],['ppt/slideMasters/_rels/slideMaster1.xml.rels',masterRelations]])zip.file(name,document.toString());
  return zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
}

// Original generic fixtures: no private deck, upstream template or external URL.
// The PPTX has inherited master assets as well as ordinary editable slide shapes.
export async function buildReferenceDocuments(){
  const canvas=createCanvas(64,64),drawing=canvas.getContext('2d');
  drawing.fillStyle=referencePalette.accent;drawing.fillRect(0,0,64,64);drawing.fillStyle=referencePalette.background;
  drawing.fillRect(14,14,14,36);drawing.fillRect(28,14,22,12);drawing.fillRect(28,30,14,10);drawing.fillRect(38,40,12,10);
  const logo=canvas.encodeSync('png'),pptx=new PptxGenJS();pptx.defineLayout({name:'REFERENCE_WIDE',width:1280/96,height:720/96});pptx.layout='REFERENCE_WIDE';pptx.author='Fixture author';pptx.subject='Synthetic visual reference';pptx.title='Reference style fixture';pptx.lang='en-US';
  pptx.theme={headFontFace:'Arial',bodyFontFace:'Arial',lang:'en-US'};
  pptx.defineSlideMaster({title:'REFERENCE_MASTER',background:{color:hex(referencePalette.background)},objects:[
    {rect:{...inches(referenceGeometry.bar),fill:{color:hex(referencePalette.accent)},line:{color:hex(referencePalette.accent),width:0}}},
    {rect:{...inches(referenceGeometry.panel),fill:{color:hex(referencePalette.surface)},line:{color:hex(referencePalette.border),width:1.5}}},
    {rect:{...inches(referenceGeometry.rule),fill:{color:hex(referencePalette.border)},line:{color:hex(referencePalette.border),width:0}}},
    {image:{data:'image/png;base64,'+logo.toString('base64'),...inches(referenceGeometry.logo)}},
    {text:{text:'REFERENCE STUDIO',options:{...inches(referenceGeometry.footer),fontFace:'Arial',fontSize:12,color:hex(referencePalette.muted),margin:0,breakLine:false}}},
  ]});
  const titles=['A clear visual system','Layout and identity'];
  for(let index=0;index<2;index++){
    const slide=pptx.addSlide('REFERENCE_MASTER');
    if(index===1)slide.addShape(pptx.ShapeType.rect,{...inches(referenceGeometry.bar),fill:{color:hex(referencePalette.secondAccent)},line:{color:hex(referencePalette.secondAccent),width:0}});
    slide.addText(titles[index],{x:72/96,y:130/96,w:1050/96,h:70/96,fontFace:'Arial',fontSize:42*72/96,bold:true,color:hex(referencePalette.text),margin:0});
    slide.addText('Source text is content. Keep the reusable style.',{x:100/96,y:330/96,w:850/96,h:90/96,fontFace:'Arial',fontSize:28*72/96,color:hex(referencePalette.text),margin:0});
    slide.addShape(pptx.ShapeType.ellipse,{...inches(referenceGeometry.circle),fill:{color:hex(referencePalette.accent)},line:{color:hex(referencePalette.accent),width:0}});
    slide.addNotes('Synthetic speaker note, never copied into the theme.');
  }
  const document=await PDFDocument.create(),regular=await document.embedFont(StandardFonts.Helvetica),bold=await document.embedFont(StandardFonts.HelveticaBold),image=await document.embedPng(logo);
  for(let index=0;index<2;index++){
    const page=document.addPage([1280,720]);
    const rectangle=(rect,color,borderColor,borderWidth=0)=>page.drawRectangle({x:rect.x,y:720-rect.y-rect.height,width:rect.width,height:rect.height,color:pdfColor(color),...(borderColor?{borderColor:pdfColor(borderColor),borderWidth}:{})});
    rectangle({x:0,y:0,width:1280,height:720},referencePalette.background);
    rectangle(referenceGeometry.bar,index===0?referencePalette.accent:referencePalette.secondAccent);
    rectangle(referenceGeometry.panel,referencePalette.surface,referencePalette.border,2);rectangle(referenceGeometry.rule,referencePalette.border);
    const logoBox=referenceGeometry.logo;page.drawImage(image,{x:logoBox.x,y:720-logoBox.y-logoBox.height,width:logoBox.width,height:logoBox.height});
    page.drawText(titles[index],{font:bold,size:42,x:72,y:720-180,color:pdfColor(referencePalette.text)});
    page.drawText('Source text is content. Keep the reusable style.',{font:regular,size:28,x:100,y:720-370,color:pdfColor(referencePalette.text)});
    page.drawText('REFERENCE STUDIO',{font:regular,size:16,x:referenceGeometry.footer.x,y:720-referenceGeometry.footer.y-17,color:pdfColor(referencePalette.muted)});
    const circle=referenceGeometry.circle;page.drawCircle({x:circle.x+circle.width/2,y:720-circle.y-circle.height/2,size:circle.width/2,color:pdfColor(referencePalette.accent)});
  }
  return {pptx:await putSharedObjectsOnMaster(Buffer.from(await pptx.write({outputType:'nodebuffer'}))),pdf:Buffer.from(await document.save()),logo,font:'Arial',palette:referencePalette,geometry:referenceGeometry};
}
