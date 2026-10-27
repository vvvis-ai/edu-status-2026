(function(root,factory) {
  const api=factory();
  if(typeof module==='object' && module.exports) module.exports=api;
  else root.CertificateOcr=api;
})(globalThis,function() {
  'use strict';

  // Prepare a separate recognition image; the uploaded document stays intact.
  function cleanPixels(pixels,width,height) {
    const data=new Uint8ClampedArray(pixels);
    for(let i=0;i<data.length;i+=4) {
      const max=Math.max(data[i],data[i+1],data[i+2]);
      const min=Math.min(data[i],data[i+1],data[i+2]);
      const value=max<180 && max-min<45 ? 0 : 255;
      data[i]=data[i+1]=data[i+2]=value;
      data[i+3]=255;
    }
    // Detect both directions before erasing, so intersections do not split rules.
    const horizontal=[],vertical=[];
    for(let y=0;y<height;y++) {
      let start=0;
      for(let x=0;x<=width;x++) {
        if(x<width && data[(y*width+x)*4]===0) continue;
        if(x-start>width*.3) horizontal.push([start,x,y]);
        start=x+1;
      }
    }
    for(let x=0;x<width;x++) {
      let start=0;
      for(let y=0;y<=height;y++) {
        if(y<height && data[(y*width+x)*4]===0) continue;
        if(y-start>height*.07) vertical.push([start,y,x]);
        start=y+1;
      }
    }
    const erase=(x,y)=>{const i=(y*width+x)*4;data[i]=data[i+1]=data[i+2]=255;};
    for(const [start,end,y] of horizontal) for(let x=start;x<end;x++) erase(x,y);
    for(const [start,end,x] of vertical) for(let y=start;y<end;y++) erase(x,y);
    return data;
  }

  async function recognize({canvas,Tesseract,parser,filename='',defaultDept='평생교육과',nativeFields,logger,document}) {
    if(!Tesseract) throw new Error('OCR 엔진을 불러오지 못했습니다. 인터넷 연결을 확인해 주세요.');
    const prepared=document.createElement('canvas');
    prepared.width=canvas.width;prepared.height=canvas.height;
    const ctx=prepared.getContext('2d');
    ctx.drawImage(canvas,0,0);
    const pixels=ctx.getImageData(0,0,prepared.width,prepared.height);
    pixels.data.set(cleanPixels(pixels.data,prepared.width,prepared.height));
    ctx.putImageData(pixels,0,0);
    let worker;
    let fields=parser.extractFields(filename,'',defaultDept);
    const texts=[];
    const sufficient=()=>parser.mergeMissingFields(nativeFields || {},fields).missingFields.length===0;
    try {
      worker=await Tesseract.createWorker('kor',1,{logger});
      const passes=[
        {label:'한글 OCR · 표 선/도장 전처리',image:prepared,psm:'6'},
        {label:'한글 OCR · 원본',image:canvas,psm:'6'},
        {label:'한글/영문 OCR · 원본',image:canvas,psm:'3',mixed:true}
      ];
      for(const pass of passes) {
        if(pass.mixed) await worker.reinitialize('kor+eng',1);
        await worker.setParameters({tessedit_pageseg_mode:pass.psm,preserve_interword_spaces:'1'});
        const {data}=await worker.recognize(pass.image);
        texts.push('=== '+pass.label+' ===\n'+data.text);
        fields=parser.mergeMissingFields(fields,parser.extractFields(filename,data.text,defaultDept));
        if(sufficient()) break;
      }
      return {text:texts.join('\n\n'),fields};
    } finally {
      if(worker) await worker.terminate();
      prepared.width=prepared.height=0;
    }
  }
  return {cleanPixels,recognize};
});
