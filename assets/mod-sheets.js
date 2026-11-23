'use strict';
// Lifecycle scoped to each banner: navigating away stops the slideshow.
customElements.define('gdsp-liveries',class extends HTMLElement {
  connectedCallback(){
    const pick=this.querySelector('select'),img=this.querySelector('img'),play=this.querySelector('[data-play]');
    if(!pick||!play)return;
    const show=i=>{
      pick.selectedIndex=(i+pick.length)%pick.length;
      const opt=pick.selectedOptions[0];img.hidden=false;const missing=this.querySelector('[data-image-missing]');if(missing)missing.hidden=true;img.src=opt.dataset.image;img.alt=opt.text;
      this.querySelector('[data-count]').textContent=`${pick.selectedIndex+1} / ${pick.length}`;
    };
    const pause=()=>{clearInterval(this.timer);this.timer=null;play.textContent='Lecture';};
    const start=()=>{pause();play.textContent='Pause';this.timer=setInterval(()=>{if(!document.hidden)show(pick.selectedIndex+1);},5000);};
    pick.onchange=()=>{pause();show(pick.selectedIndex);};
    for(const btn of this.querySelectorAll('[data-step]'))btn.onclick=()=>{pause();show(pick.selectedIndex+Number(btn.dataset.step));};
    play.onclick=()=>this.timer?pause():start();
    if(matchMedia('(prefers-reduced-motion: reduce)').matches)pause();else start();
  }
  disconnectedCallback(){clearInterval(this.timer);}
});

customElements.define('gdsp-track-guide',class extends HTMLElement {
  connectedCallback(){
    const map=this.querySelector('.cir-map-stage svg'),profile=this.querySelector('.cir-elev svg');
    const slider=this.querySelector('input[type=range]'),output=this.querySelector('output');
    if(!map||!slider||!output)return;
    const road=map.querySelector('.cir-map-center'),plot=profile?.querySelector('path.line');
    const play=this.querySelector('[data-play]'),jump=this.querySelector('[data-jump]');
    const svg=(parent,tag,attrs,before=null)=>{
      const node=document.createElementNS('http://www.w3.org/2000/svg',tag);
      for(const [k,v] of Object.entries(attrs))node.setAttribute(k,v);
      parent.insertBefore(node,before);return node;
    };
    let points=JSON.parse(slider.dataset.samples);
    if(points.length<2){
      // Les fiches historiques n’ont que le chemin SVG. Ne pas inventer d’altitude.
      const size=road.getTotalLength();if(!size)return;
      points=Array.from({length:301},(_,i)=>{const p=road.getPointAtLength(size*i/300);return [i/300,p.x,p.y];});
    }else if(points.at(-1)[0]<1){points.push([1,...points[0].slice(1)]);}
    const clamp=v=>Math.max(0,Math.min(1,v));
    function at(f){
      let i=1;while(i<points.length-1&&points[i][0]<f)i++;
      const a=points[i-1],b=points[i],k=clamp((f-a[0])/(b[0]-a[0]||1));
      return [f,...a.slice(1).map((v,j)=>v+k*(b[j+1]-v))];
    }
    const section=(a,b)=>[at(a),...points.filter(p=>p[0]>a&&p[0]<b),at(b)].map((p,i)=>`${i?'L':'M'}${p[1]} ${p[2]}`).join(' ');
    const bounds=[0,...JSON.parse(slider.dataset.bounds).filter(f=>f>0&&f<1).sort((a,b)=>a-b),1];
    const palette=['#aac8b6','#c89667','#7daec1'];
    bounds.slice(1).forEach((b,i)=>svg(map,'path',{d:section(bounds[i],b),fill:'none',stroke:palette[i%3],'stroke-width':9},road));
    road.style.display='none';
    const lit=svg(map,'path',{fill:'none',stroke:'#ffd076','stroke-width':14,'stroke-linecap':'round'},road);
    const dot=svg(map,'circle',{r:17,class:'guide-dot'});
    const line=profile&&svg(profile,'line',{y1:0,y2:120,class:'guide-line'});
    const height=plot&&svg(profile,'circle',{r:4,fill:'#a43723'});
    const plotLength=plot?.getTotalLength();
    const pins=[...map.querySelectorAll('.cir-pin')];
    let fraction=0,active=-1,last;
    function show(value){
      fraction=clamp(value);const [,x,y,z]=at(fraction);
      dot.setAttribute('cx',x);dot.setAttribute('cy',y);
      if(line){const px=1000*fraction;line.setAttribute('x1',px);line.setAttribute('x2',px);
        if(height){let lo=0,hi=plotLength;for(let n=0;n<12;n++){const mid=(lo+hi)/2;if(plot.getPointAtLength(mid).x<px)lo=mid;else hi=mid;}height.setAttribute('cx',px);height.setAttribute('cy',plot.getPointAtLength((lo+hi)/2).y);}
      }
      const i=pins.reduce((best,p,k)=>fraction>=+p.dataset.from&&fraction<=+p.dataset.to&&(best<0||Math.abs(+p.dataset.norm-fraction)<Math.abs(+pins[best].dataset.norm-fraction))?k:best,-1);
      if(i!==active){pins[active]?.classList.remove('active');active=i;pins[i]?.classList.add('active');lit.setAttribute('d',i<0?'':section(+pins[i].dataset.from,+pins[i].dataset.to));}
      if(jump)jump.value=i<0?'':String(i);
      slider.value=Math.round(fraction*1000);
      output.textContent=[pins[i]?.dataset.name,`${Math.round(fraction*slider.dataset.length).toLocaleString('fr-FR')} m du départ`,Number.isFinite(z)?`Altitude ${z.toLocaleString('fr-FR',{maximumFractionDigits:1})} m`:''].filter(Boolean).join(' · ');
    }
    const stop=()=>{cancelAnimationFrame(this.frame);this.frame=0;last=null;play.textContent=fraction===1?'↺ Rejouer':'▶ Lire le tour';};
    const seek=f=>{show(f);stop();};
    const tick=now=>{if(last!=null)show(fraction+(now-last)/60000);last=now;if(fraction===1||document.hidden)stop();else this.frame=requestAnimationFrame(tick);};
    play.onclick=()=>{if(this.frame)return stop();if(fraction===1)show(0);last=null;play.textContent='Ⅱ Pause';this.frame=requestAnimationFrame(tick);};
    slider.oninput=()=>seek(+slider.value/1000);
    if(jump)jump.onchange=()=>{if(jump.value!=='')seek(+pins[+jump.value].dataset.norm);};
    pins.forEach(pin=>{pin.onclick=pin.onfocus=()=>seek(+pin.dataset.norm);pin.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();seek(+pin.dataset.norm);}};});
    function hover(node,project){if(node)node.onpointermove=e=>{if(e.pointerType!=='mouse')return;const matrix=node.getScreenCTM();if(!matrix)return;const f=project(new DOMPoint(e.clientX,e.clientY).matrixTransform(matrix.inverse()));if(f!=null)seek(f);};}
    hover(profile,p=>p.x/1000);
    hover(map,p=>{
      let best=20**2,found=null;
      for(let i=1;i<points.length;i++){
        const a=points[i-1],b=points[i],dx=b[1]-a[1],dy=b[2]-a[2];
        const k=clamp(((p.x-a[1])*dx+(p.y-a[2])*dy)/(dx*dx+dy*dy||1));
        const gap=(p.x-a[1]-k*dx)**2+(p.y-a[2]-k*dy)**2;
        if(gap<best){best=gap;found=a[0]+k*(b[0]-a[0]);}
      }return found;
    });
    show(0);
  }
  disconnectedCallback(){cancelAnimationFrame(this.frame);this.frame=0;}
});
