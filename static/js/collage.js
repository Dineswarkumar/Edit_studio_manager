(() => {
  const canvas = document.getElementById('collageCanvas');
  const ctx = canvas.getContext('2d');
  const $ = id => document.getElementById(id);
  const ratios = { '1:1': 1, '4:3': 4 / 3, '3:4': 3 / 4, '16:9': 16 / 9, '9:16': 9 / 16 };
  const templates = {
    grid: count => gridSlots(count),
    'hero-left': count => count < 2 ? [{x:0,y:0,w:1,h:1}] : [
      {x:0,y:0,w:.62,h:1}, ...gridInRect(count-1,.62,0,.38,1,1)
    ],
    'hero-top': count => count < 2 ? [{x:0,y:0,w:1,h:1}] : [
      {x:0,y:0,w:1,h:.62}, ...gridInRect(count-1,0,.62,1,.38)
    ],
    triptych: count => gridInRect(count,0,0,1,1,3),
    filmstrip: count => count < 2 ? [{x:0,y:0,w:1,h:1}] : [
      {x:0,y:0,w:1,h:.62}, ...gridInRect(count-1,0,.62,1,.38)
    ],
    mosaic: count => count > 5 ? gridSlots(count) : count <= 2 ? gridSlots(count) : count === 3
      ? [{x:0,y:0,w:.62,h:1},{x:.62,y:0,w:.38,h:.5},{x:.62,y:.5,w:.38,h:.5}]
      : count === 4 ? [{x:0,y:0,w:1,h:.62},...gridInRect(3,0,.62,1,.38,3)]
      : [{x:0,y:0,w:.5,h:.5},{x:.5,y:0,w:.5,h:.5},{x:0,y:.5,w:1/3,h:.5},{x:1/3,y:.5,w:1/3,h:.5},{x:2/3,y:.5,w:1/3,h:.5}],
    custom: count => state.customSlots.length === count ? state.customSlots : gridSlots(count)
  };
  const state = {
    photos: [], selectedPhoto: 0, template: 'grid', ratio: '1:1', fitMode: 'cover', tool: 'select',
    backgroundMode: 'solid', background: '#ffffff', gradient: '#3b82f6', direction: 'horizontal', backgroundImage: null,
    radius: 18, margin: 8, padding: 8, borderColor: '#ffffff', borderWidth: 0, customSlots: [],
    fillColor: '#2563eb', lineColor: '#0f172a', fillEnabled: true, lineWidth: 6,
    text: 'Your title', font: 'Arial', textColor: '#ffffff', bold: true,
    annotations: [], selectedAnnotation: -1, pointer: null, replacePhotoIndex: -1
  };

  function gridSlots(count) {
    if (count <= 1) return [{x:0,y:0,w:1,h:1}];
    const aspect = ratios[state.ratio] || 1;
    const columns = count <= 2
      ? (aspect < .8 ? 1 : 2)
      : aspect < .8 ? Math.min(2, Math.ceil(Math.sqrt(count)))
      : Math.max(2, Math.min(4, Math.round(Math.sqrt(count * aspect))));
    const rows = Math.max(1, Math.ceil(Math.max(1, count) / columns));
    return Array.from({length: Math.max(1,count)}, (_, i) => {
      const col = i % columns, row = Math.floor(i / columns);
      return {x: col / columns, y: row / rows, w: 1 / columns, h: 1 / rows};
    });
  }

  function gridInRect(count,x,y,w,h,columns) {
    if (!count) return [];
    const cols = columns || Math.max(1, Math.ceil(Math.sqrt(count*w/h)));
    const rows = Math.ceil(count/cols);
    return Array.from({length:count},(_,i)=>{
      const col = i % cols, row = Math.floor(i / cols);
      return {x: x + col*w/cols, y: y + row*h/rows, w: w/cols, h: h/rows};
    });
  }

  function computeSlotRect(slot, w, h) {
    const shortSide = Math.min(w, h);
    const margin = shortSide * (state.margin / 500);
    const gap = shortSide * (state.padding / 1000);
    const usableW = Math.max(1, w - margin * 2);
    const usableH = Math.max(1, h - margin * 2);
    const insetL = slot.x > 0.001 ? gap / 2 : 0;
    const insetR = (slot.x + slot.w) < 0.999 ? gap / 2 : 0;
    const insetT = slot.y > 0.001 ? gap / 2 : 0;
    const insetB = (slot.y + slot.h) < 0.999 ? gap / 2 : 0;
    let x1 = margin + slot.x * usableW + insetL;
    let y1 = margin + slot.y * usableH + insetT;
    let x2 = margin + (slot.x + slot.w) * usableW - insetR;
    let y2 = margin + (slot.y + slot.h) * usableH - insetB;
    if (state.padding === 0) {
      x1 = Math.round(x1);
      y1 = Math.round(y1);
      x2 = Math.round(x2);
      y2 = Math.round(y2);
    }
    return { x: x1, y: y1, w: Math.max(1, x2 - x1), h: Math.max(1, y2 - y1) };
  }

  function pathRoundRect(x,y,w,h,r) {
    const radius = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + radius, y); ctx.lineTo(x + w - radius, y); ctx.quadraticCurveTo(x+w,y,x+w,y+radius);
    ctx.lineTo(x+w,y+h-radius); ctx.quadraticCurveTo(x+w,y+h,x+w-radius,y+h);
    ctx.lineTo(x+radius,y+h); ctx.quadraticCurveTo(x,y+h,x,y+h-radius);
    ctx.lineTo(x,y+radius); ctx.quadraticCurveTo(x,y,x+radius,y); ctx.closePath();
  }

  function coverImage(image, x, y, w, h) {
    const scale = Math.max(w / image.width, h / image.height);
    const sw = w / scale, sh = h / scale;
    const sx = (image.width - sw) / 2, sy = (image.height - sh) / 2;
    ctx.drawImage(image, sx, sy, sw, sh, x, y, w, h);
  }

  function drawBackground(w,h) {
    if (state.backgroundMode === 'image' && state.backgroundImage) {
      coverImage(state.backgroundImage, 0, 0, w, h);
    } else if (state.backgroundMode === 'gradient') {
      const grad = state.direction === 'vertical' ? ctx.createLinearGradient(0,0,0,h)
        : state.direction === 'diagonal' ? ctx.createLinearGradient(0,0,w,h) : ctx.createLinearGradient(0,0,w,0);
      grad.addColorStop(0,state.background); grad.addColorStop(1,state.gradient);
      ctx.fillStyle = grad; ctx.fillRect(0,0,w,h);
    } else {
      ctx.fillStyle = state.background; ctx.fillRect(0,0,w,h);
    }
  }

  function drawSlots(w,h) {
    const slots = templates[state.template](state.photos.length);
    const shortSide = Math.min(w,h);
    slots.forEach((slot,i) => {
      const { x, y, w: sw, h: sh } = computeSlotRect(slot, w, h);
      if (sw <= 0 || sh <= 0) return;
      const r = shortSide * state.radius / 1000;
      pathRoundRect(x,y,sw,sh,r); ctx.save(); ctx.clip();
      ctx.fillStyle = state.background;
      ctx.fillRect(x,y,sw,sh);
      const photo = state.photos[i];
      if (photo) drawPhoto(photo,x,y,sw,sh);
      ctx.restore();
      if (state.borderWidth > 0) {
        pathRoundRect(x,y,sw,sh,r); ctx.lineWidth = state.borderWidth * (w / 1200);
        ctx.strokeStyle = state.borderColor; ctx.stroke();
      }
      if (!state.isExporting && state.template==='custom' && i===state.selectedPhoto) {
        pathRoundRect(x,y,sw,sh,r); ctx.lineWidth=Math.max(3,w/400); ctx.strokeStyle='#2563eb'; ctx.stroke();
        ctx.fillStyle='#2563eb'; ctx.fillRect(x+sw-14,y+sh-14,14,14);
      }
    });
  }

  function drawPhoto(photo,x,y,w,h) {
    const filters={original:'none',mono:'grayscale(1)',warm:'sepia(.25) saturate(1.25)',cool:'hue-rotate(12deg) saturate(1.1)',vintage:'sepia(.5) contrast(1.08)',bright:'brightness(1.12) contrast(1.05)'};
    ctx.save();
    ctx.beginPath(); ctx.rect(x,y,w,h); ctx.clip();
    ctx.translate(x+w/2+(photo.offsetX||0)*w,y+h/2+(photo.offsetY||0)*h);
    ctx.rotate((photo.rotation||0)*Math.PI/180);
    ctx.scale((photo.flipX?-1:1)*(photo.zoom||100)/100,(photo.flipY?-1:1)*(photo.zoom||100)/100);
    ctx.filter=filters[photo.filter||'original']||'none';
    if(state.fitMode==='cover') coverImage(photo.image,-w/2,-h/2,w,h);
    else {
      const scale=Math.min(w/photo.image.width,h/photo.image.height),dw=photo.image.width*scale,dh=photo.image.height*scale;
      ctx.drawImage(photo.image,-dw/2,-dh/2,dw,dh);
    }
    ctx.restore();
  }

  function drawArrow(x1,y1,x2,y2) {
    const angle = Math.atan2(y2-y1,x2-x1), head = state.lineWidth*3;
    ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2);
    ctx.lineTo(x2-head*Math.cos(angle-Math.PI/6),y2-head*Math.sin(angle-Math.PI/6));
    ctx.moveTo(x2,y2); ctx.lineTo(x2-head*Math.cos(angle+Math.PI/6),y2-head*Math.sin(angle+Math.PI/6)); ctx.stroke();
  }

  function drawAnnotation(item) {
    const w=canvas.width,h=canvas.height, x=item.x*w,y=item.y*h, x2=(item.x+item.w)*w,y2=(item.y+item.h)*h;
    ctx.save(); ctx.lineWidth=state.lineWidth*(w/1200); ctx.strokeStyle=state.lineColor; ctx.fillStyle=state.fillColor;
    ctx.lineCap='round'; ctx.lineJoin='round';
    if (item.type === 'draw') {
      if (item.points.length > 1) {
        ctx.beginPath(); ctx.moveTo(item.points[0].x*w,item.points[0].y*h);
        item.points.slice(1).forEach(p=>ctx.lineTo(p.x*w,p.y*h)); ctx.stroke();
      }
    } else if (item.type === 'rect') {
      const rx=Math.min(x,x2),ry=Math.min(y,y2),rw=Math.abs(x2-x),rh=Math.abs(y2-y);
      if (state.fillEnabled) ctx.fillRect(rx,ry,rw,rh); ctx.strokeRect(rx,ry,rw,rh);
    } else if (item.type === 'ellipse') {
      ctx.beginPath(); ctx.ellipse((x+x2)/2,(y+y2)/2,Math.abs(x2-x)/2,Math.abs(y2-y)/2,0,0,Math.PI*2);
      if (state.fillEnabled) ctx.fill(); ctx.stroke();
    } else if (item.type === 'arrow') {
      drawArrow(x,y,x2,y2);
    } else if (item.type === 'text') {
      const fontSize = Math.max(20, Math.min(120, (item.size || 72) * (w/1200)));
      ctx.font = `${state.bold ? '700 ' : ''}${fontSize}px "${state.font}"`;
      ctx.textBaseline='top'; ctx.lineWidth=Math.max(2,fontSize*.07); ctx.strokeStyle=state.lineColor; ctx.fillStyle=state.textColor;
      const lines=(item.text || state.text).split('\n');
      lines.forEach((line,i)=>{ctx.strokeText(line,x,y+i*fontSize*1.18);ctx.fillText(line,x,y+i*fontSize*1.18);});
    }
    if (!state.isExporting && item === state.annotations[state.selectedAnnotation]) {
      ctx.setLineDash([8,6]); ctx.lineWidth=2; ctx.strokeStyle='#2563eb';
      ctx.strokeRect(Math.min(x,x2)-5,Math.min(y,y2)-5,Math.max(12,Math.abs(x2-x)+10),Math.max(12,Math.abs(y2-y)+10));
    }
    ctx.restore();
  }

  function redraw() {
    const width=1200,height=Math.round(width/ratios[state.ratio]);
    canvas.width=width; canvas.height=height;
    $('collageCanvasSize').textContent=`${state.ratio} · ${width} × ${height}`;
    ctx.clearRect(0,0,width,height);
    const outerRadius=Math.min(width,height)*state.radius/1000;
    pathRoundRect(0,0,width,height,outerRadius); ctx.save(); ctx.clip();
    drawBackground(width,height); drawSlots(width,height);
    state.annotations.forEach(drawAnnotation);
    ctx.restore();
    $('btnExportCollage').disabled=state.photos.length===0;
    $('btnDeleteAnnotation').disabled=state.selectedAnnotation<0;
  }

  function renderPhotos() {
    $('collagePhotoCount').textContent=`${state.photos.length} photo${state.photos.length===1?'':'s'}`;
    syncSelectedPhotoControls();
    $('btnClearPhotos').disabled=state.photos.length===0;
    $('collagePhotoList').replaceChildren();
    if (!state.photos.length) {
      const note=document.createElement('p'); note.className='empty-note'; note.textContent='Your photos will appear here.'; $('collagePhotoList').append(note); return;
    }
    state.photos.forEach((photo,index)=>{
      const row=document.createElement('div'); row.className=`collage-photo-row ${index===state.selectedPhoto?'active':''}`;
      const select=document.createElement('button'); select.type='button'; select.className='collage-photo-select'; select.title='Select photo';
      const img=document.createElement('img'); img.src=photo.url; img.alt=''; const name=document.createElement('span'); name.textContent=photo.name;
      select.append(img,name); select.addEventListener('click',()=>{state.selectedPhoto=index;renderPhotos();redraw();});
      const controls=document.createElement('div'); controls.className='collage-photo-actions';
      [['↑',-1,'Move photo up'],['↓',1,'Move photo down'],['×',0,'Remove photo']].forEach(([label,delta,title])=>{
        const btn=document.createElement('button'); btn.type='button'; btn.textContent=label; btn.title=title;
        if(delta<0&&index===0)btn.disabled=true;
        if(delta>0&&index===state.photos.length-1)btn.disabled=true;
        btn.addEventListener('click',()=>{
          if(label==='×'){URL.revokeObjectURL(photo.url);state.photos.splice(index,1);if(state.template==='custom')state.customSlots.splice(index,1);state.selectedPhoto=Math.min(state.selectedPhoto,Math.max(0,state.photos.length-1));}
          else {const to=Math.max(0,Math.min(state.photos.length-1,index+delta));[state.photos[index],state.photos[to]]=[state.photos[to],state.photos[index]];state.selectedPhoto=to;}
          renderPhotos();redraw();
        }); controls.append(btn);
      });
      row.append(select,controls); row.addEventListener('contextmenu',event=>showPhotoContextMenu(event,index)); $('collagePhotoList').append(row);
    });
  }

  function setTool(tool) {
    state.tool=tool; document.querySelectorAll('.tool-mode').forEach(btn=>btn.classList.toggle('active',btn.dataset.tool===tool));
    canvas.style.cursor=tool==='text'?'text':(tool==='select'?'default':(tool==='arrange'?'grab':'crosshair'));
  }
  function pointFromEvent(event) {
    const rect=canvas.getBoundingClientRect();
    return {x:(event.clientX-rect.left)/rect.width,y:(event.clientY-rect.top)/rect.height};
  }
  function slotRects() {
    const w = canvas.width, h = canvas.height;
    return templates[state.template](state.photos.length).map(slot => computeSlotRect(slot, w, h));
  }
  function photoAtPoint(point) {
    const x=point.x*canvas.width,y=point.y*canvas.height,rects=slotRects();
    for(let i=rects.length-1;i>=0;i--){const r=rects[i];if(x>=r.x&&x<=r.x+r.w&&y>=r.y&&y<=r.y+r.h&&state.photos[i])return i;}
    return -1;
  }
  function photoAtEvent(event) { return photoAtPoint(pointFromEvent(event)); }
  function syncCustomSlots() {
    const count=state.photos.length;
    if(state.customSlots.length>count)state.customSlots.length=count;
    if(state.customSlots.length<count){
      const defaults=gridSlots(count);
      if(!state.customSlots.length)state.customSlots=defaults.slice(0,count);
      else {
        if(state.customSlots.length===1&&Math.abs(state.customSlots[0].w-1)<.001)state.customSlots[0]={...defaults[0]};
        for(let i=state.customSlots.length;i<count;i++)state.customSlots.push({...defaults[i]});
      }
    }
  }
  function syncSelectedPhotoControls() {
    const photo=state.photos[state.selectedPhoto],available=Boolean(photo);
    $('collagePhotoZoom').disabled=!available;
    $('collagePhotoFilter').value=photo?.filter||'original';
    $('collagePhotoZoom').value=photo?.zoom||100;
    $('collagePhotoZoomValue').textContent=`${photo?.zoom||100}%`;
  }
  function hidePhotoContextMenu() { $('collagePhotoContextMenu').hidden=true; }
  function showPhotoContextMenu(event,index) {
    if(index<0||!state.photos[index])return;
    event.preventDefault();state.selectedPhoto=index;state.selectedAnnotation=-1;renderPhotos();redraw();
    const menu=$('collagePhotoContextMenu');menu.hidden=false;
    const width=menu.offsetWidth||180,height=menu.offsetHeight||190;
    menu.style.left=`${Math.max(6,Math.min(event.clientX,window.innerWidth-width-6))}px`;
    menu.style.top=`${Math.max(6,Math.min(event.clientY,window.innerHeight-height-6))}px`;
  }
  function applyPhotoAction(action) {
    const photo=state.photos[state.selectedPhoto];if(!photo)return;
    if(action==='replace'){state.replacePhotoIndex=state.selectedPhoto;$('collageReplaceInput').click();hidePhotoContextMenu();return;}
    if(action==='rotate-left')photo.rotation=(photo.rotation-90+360)%360;
    else if(action==='rotate-right')photo.rotation=(photo.rotation+90)%360;
    else if(action==='flip-x')photo.flipX=!photo.flipX;
    else if(action==='flip-y')photo.flipY=!photo.flipY;
    else if(action==='reset'){photo.rotation=0;photo.flipX=false;photo.flipY=false;photo.zoom=100;photo.offsetX=0;photo.offsetY=0;photo.filter='original';}
    hidePhotoContextMenu();renderPhotos();redraw();
  }
  function hitAnnotation(point) {
    for(let i=state.annotations.length-1;i>=0;i--){const a=state.annotations[i];
      if(a.type==='draw' && a.points.some(p=>Math.hypot(p.x-point.x,p.y-point.y)<.035))return i;
      if(point.x>=Math.min(a.x,a.x+a.w)-.025&&point.x<=Math.max(a.x,a.x+a.w)+.025&&point.y>=Math.min(a.y,a.y+a.h)-.025&&point.y<=Math.max(a.y,a.y+a.h)+.025)return i;
    } return -1;
  }
  canvas.addEventListener('pointerdown',event=>{
    if(!state.photos.length)return;
    const p=pointFromEvent(event); canvas.setPointerCapture(event.pointerId);
    if(state.tool==='text'){
      state.annotations.push({type:'text',x:p.x,y:p.y,w:.25,h:.1,text:$('collageTextInput').value||'Text',size:72});
      state.selectedAnnotation=state.annotations.length-1;redraw();return;
    }
    if(state.tool==='arrange'){
      const photoIndex=photoAtPoint(p);
      if(photoIndex>=0){state.selectedPhoto=photoIndex;state.selectedAnnotation=-1;renderPhotos();state.pointer={kind:'photo-swap',index:photoIndex};canvas.style.cursor='grabbing';redraw();}
      return;
    }
    if(state.tool==='select'){
      state.selectedAnnotation=hitAnnotation(p);
      if(state.selectedAnnotation>=0)state.pointer={kind:'annotation',start:p,last:p,index:state.selectedAnnotation};
      else {
        const photoIndex=photoAtPoint(p);
        if(photoIndex>=0){
          state.selectedPhoto=photoIndex;renderPhotos();
          const rect=slotRects()[photoIndex],slot=state.template==='custom'?state.customSlots[photoIndex]:null;
          if(slot && p.x*canvas.width>=rect.x+rect.w-24 && p.y*canvas.height>=rect.y+rect.h-24){
            state.pointer={kind:'slot-resize',start:p,index:photoIndex,slot:{...slot}};
          } else if(state.template==='custom'&&slot){
            state.pointer={kind:'slot-move',start:p,last:p,index:photoIndex,slot:{...slot}};
          } else state.pointer={kind:'photo',last:p,index:photoIndex};
        }
      }
      redraw();return;
    }
    const item={type:state.tool,x:p.x,y:p.y,w:0,h:0,points:[p]};
    state.annotations.push(item);state.selectedAnnotation=state.annotations.length-1;state.pointer={kind:'draw',start:p,last:p,index:state.selectedAnnotation};redraw();
  });
  canvas.addEventListener('pointermove',event=>{
    if(!state.pointer)return;
    const p=pointFromEvent(event),pointer=state.pointer;
    if(pointer.kind==='annotation'){
      const item=state.annotations[pointer.index],dx=p.x-pointer.last.x,dy=p.y-pointer.last.y;
      if(item.type==='draw')item.points.forEach(point=>{point.x+=dx;point.y+=dy;});
      item.x+=dx;item.y+=dy;pointer.last=p;
    } else if(pointer.kind==='photo'){
      const photo=state.photos[pointer.index],rect=slotRects()[pointer.index];
      if(photo&&rect){photo.offsetX=Math.max(-1,Math.min(1,(photo.offsetX||0)+(p.x-pointer.last.x)*canvas.width/rect.w));photo.offsetY=Math.max(-1,Math.min(1,(photo.offsetY||0)+(p.y-pointer.last.y)*canvas.height/rect.h));}
      pointer.last=p;syncSelectedPhotoControls();
    } else if(pointer.kind==='slot-move'){
      const slot=state.customSlots[pointer.index];
      const margin=Math.min(canvas.width,canvas.height)*state.margin/500;
      const usableW=Math.max(1,canvas.width-margin*2),usableH=Math.max(1,canvas.height-margin*2);
      const dx=(p.x-pointer.start.x)*canvas.width/usableW,dy=(p.y-pointer.start.y)*canvas.height/usableH;
      slot.x=Math.max(0,Math.min(1-slot.w,pointer.slot.x+dx));
      slot.y=Math.max(0,Math.min(1-slot.h,pointer.slot.y+dy));
    } else if(pointer.kind==='slot-resize'){
      const slot=state.customSlots[pointer.index];
      const margin=Math.min(canvas.width,canvas.height)*state.margin/500;
      const usableW=Math.max(1,canvas.width-margin*2),usableH=Math.max(1,canvas.height-margin*2);
      const dw=(p.x-pointer.start.x)*canvas.width/usableW,dh=(p.y-pointer.start.y)*canvas.height/usableH;
      slot.w=Math.max(.08,Math.min(1-pointer.slot.x,pointer.slot.w+dw));
      slot.h=Math.max(.08,Math.min(1-pointer.slot.y,pointer.slot.h+dh));
    } else if(pointer.kind==='draw'){
      const item=state.annotations[pointer.index];
      item.w=p.x-pointer.start.x;item.h=p.y-pointer.start.y;
      if(item.type==='draw'){
        item.points.push(p);
        const xs=item.points.map(point=>point.x),ys=item.points.map(point=>point.y);
        item.x=Math.min(...xs);item.y=Math.min(...ys);item.w=Math.max(...xs)-item.x;item.h=Math.max(...ys)-item.y;
      }
      pointer.last=p;
    }
    redraw();
  });
  const stopPointer=event=>{
    if(state.pointer?.kind==='photo-swap'&&event.type==='pointerup'){
      const target=photoAtEvent(event),source=state.pointer.index;
      if(target>=0&&target!==source){[state.photos[source],state.photos[target]]=[state.photos[target],state.photos[source]];state.selectedPhoto=target;renderPhotos();redraw();}
    }
    state.pointer=null;
    if(state.tool==='arrange')canvas.style.cursor='grab';
  }; canvas.addEventListener('pointerup',stopPointer);canvas.addEventListener('pointercancel',stopPointer);
  canvas.addEventListener('contextmenu',event=>showPhotoContextMenu(event,photoAtEvent(event)));
  canvas.addEventListener('wheel',event=>{
    const index=photoAtEvent(event);if(index<0)return;event.preventDefault();
    state.selectedPhoto=index;state.photos[index].zoom=Math.max(100,Math.min(300,(state.photos[index].zoom||100)+(event.deltaY<0?10:-10)));
    renderPhotos();redraw();
  },{passive:false});
  document.addEventListener('click',event=>{if(event.target.closest('#collagePhotoContextMenu select'))return;if(!event.target.closest('#collagePhotoContextMenu'))hidePhotoContextMenu();});
  document.addEventListener('keydown',event=>{if(event.key==='Escape')hidePhotoContextMenu();});
  $('collagePhotoContextMenu').addEventListener('click',event=>{const button=event.target.closest('[data-photo-action]');if(button)applyPhotoAction(button.dataset.photoAction);});
  document.querySelectorAll('.collage-photo-edit-group [data-photo-action]').forEach(button=>button.addEventListener('click',()=>applyPhotoAction(button.dataset.photoAction)));

  $('collageUploadButton').addEventListener('click',()=>$('collageImageInput').click());
  const makePhoto=(name,url,image)=>({name,url,image,rotation:0,flipX:false,flipY:false,zoom:100,offsetX:0,offsetY:0,filter:'original'});
  function addPhotos(files) {
    [...files].filter(file=>file.type.startsWith('image/')).forEach(file=>{
      const url=URL.createObjectURL(file),image=new Image();
      image.onload=()=>{state.photos.push(makePhoto(file.name,url,image));if(state.photos.length===1)state.selectedPhoto=0;if(state.template==='custom')syncCustomSlots();renderPhotos();redraw();};
      image.onerror=()=>URL.revokeObjectURL(url);
      image.src=url;
    });
  }
  $('collageImageInput').addEventListener('change',event=>{addPhotos(event.target.files);event.target.value='';});
  $('collageReplaceInput').addEventListener('change',event=>{
    const file=event.target.files[0],index=state.replacePhotoIndex;event.target.value='';state.replacePhotoIndex=-1;if(!file||index<0||!file.type.startsWith('image/'))return;
    const url=URL.createObjectURL(file),image=new Image();
    image.onload=()=>{const old=state.photos[index];if(old)URL.revokeObjectURL(old.url);state.photos[index]=makePhoto(file.name,url,image);state.selectedPhoto=index;renderPhotos();redraw();};
    image.onerror=()=>URL.revokeObjectURL(url);image.src=url;
  });
  const uploadZone=$('collageUploadButton');
  uploadZone.addEventListener('dragover',event=>{event.preventDefault();uploadZone.classList.add('dragover');});
  uploadZone.addEventListener('dragleave',()=>uploadZone.classList.remove('dragover'));
  uploadZone.addEventListener('drop',event=>{event.preventDefault();uploadZone.classList.remove('dragover');addPhotos(event.dataTransfer.files);});
  $('btnClearPhotos').addEventListener('click',()=>{state.photos.forEach(p=>URL.revokeObjectURL(p.url));state.photos=[];state.customSlots=[];state.annotations=[];state.selectedAnnotation=-1;state.selectedPhoto=0;renderPhotos();redraw();});
  $('collageRatio').addEventListener('change',event=>{state.ratio=event.target.value;redraw();});
  $('collageFitMode').addEventListener('change',event=>{state.fitMode=event.target.value;redraw();});
  $('collageTemplateGrid').addEventListener('click',event=>{const btn=event.target.closest('[data-template]');if(!btn)return;state.template=btn.dataset.template;if(state.template==='custom')state.customSlots=state.photos.length?gridSlots(state.photos.length):[];document.querySelectorAll('.template-choice').forEach(b=>b.classList.toggle('active',b===btn));redraw();});
  $('collageBackgroundMode').addEventListener('change',event=>{state.backgroundMode=event.target.value;$('collageGradientControls').hidden=state.backgroundMode!=='gradient';$('btnChooseBackground').hidden=state.backgroundMode!=='image';redraw();});
  $('collageBackgroundColor').addEventListener('input',event=>{state.background=event.target.value;redraw();});
  $('collageGradientColor').addEventListener('input',event=>{state.gradient=event.target.value;redraw();});
  $('collageGradientDirection').addEventListener('change',event=>{state.direction=event.target.value;redraw();});
  $('btnChooseBackground').addEventListener('click',()=>$('collageBackgroundInput').click());
  $('collageBackgroundInput').addEventListener('change',event=>{const file=event.target.files[0];if(!file)return;const image=new Image();image.onload=()=>{if(state.backgroundImage?.url)URL.revokeObjectURL(state.backgroundImage.url);state.backgroundImage={image,url:image.src};redraw();};image.src=URL.createObjectURL(file);event.target.value='';});
  [['collageRadius','radius','collageRadiusValue'],['collageMargin','margin','collageMarginValue'],['collagePadding','padding','collagePaddingValue'],['collageLineWidth','lineWidth','collageLineWidthValue']].forEach(([id,key,label])=>$(id).addEventListener('input',event=>{state[key]=Number(event.target.value);$(label).textContent=event.target.value;redraw();}));
  $('collageBorderWidth').addEventListener('input',event=>{state.borderWidth=Number(event.target.value);$('collageBorderWidthValue').textContent=event.target.value;redraw();});
  [['collageBorderColor','borderColor'],['collageFillColor','fillColor'],['collageLineColor','lineColor'],['collageTextColor','textColor']].forEach(([id,key])=>$(id).addEventListener('input',event=>{state[key]=event.target.value;redraw();}));
  $('collageFillEnabled').addEventListener('change',event=>{state.fillEnabled=event.target.checked;redraw();});
  $('collageTextInput').addEventListener('input',event=>{state.text=event.target.value;if(state.annotations[state.selectedAnnotation]?.type==='text')state.annotations[state.selectedAnnotation].text=state.text;redraw();});
  $('collageFont').addEventListener('change',event=>{state.font=event.target.value;redraw();});
  $('collageBold').addEventListener('change',event=>{state.bold=event.target.checked;redraw();});
  $('collagePhotoFilter').addEventListener('change',event=>{const photo=state.photos[state.selectedPhoto];if(photo){photo.filter=event.target.value;redraw();}hidePhotoContextMenu();});
  $('collagePhotoZoom').addEventListener('input',event=>{const photo=state.photos[state.selectedPhoto];if(photo){photo.zoom=Number(event.target.value);$('collagePhotoZoomValue').textContent=`${photo.zoom}%`;redraw();}});
  document.querySelectorAll('.tool-mode').forEach(btn=>btn.addEventListener('click',()=>setTool(btn.dataset.tool)));
  $('btnDeleteAnnotation').addEventListener('click',()=>{if(state.selectedAnnotation<0)return;state.annotations.splice(state.selectedAnnotation,1);state.selectedAnnotation=-1;redraw();});
  $('btnExportCollage').addEventListener('click',()=>{
    state.isExporting=true;redraw();
    canvas.toBlob(blob=>{
      state.isExporting=false;redraw();if(!blob)return;
      const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=`frame-studio-collage-${state.ratio.replace(':','x')}.png`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    },'image/png');
  });

  renderPhotos();redraw();
})();
