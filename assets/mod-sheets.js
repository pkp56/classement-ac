'use strict';
// Lifecycle scoped to each banner: navigating away stops the slideshow.
customElements.define('gdsp-liveries',class extends HTMLElement {
  connectedCallback(){
    const pick=this.querySelector('select'),img=this.querySelector('img'),play=this.querySelector('[data-play]');
    if(!pick||!play)return;
    const show=i=>{
      pick.selectedIndex=(i+pick.length)%pick.length;
      const opt=pick.selectedOptions[0];img.src=opt.dataset.image;img.alt=opt.text;
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
    const slider=this.querySelector('input[type=range]'),output=this.querySelector('output');
    const map=this.querySelector('.cir-map-stage svg'),profile=this.querySelector('.cir-elev svg');
    if(!map||!output)return;
    const svg=(tag,parent,attrs)=>{
      const el=document.createElementNS('http://www.w3.org/2000/svg',tag);
      for(const [k,v] of Object.entries(attrs))el.setAttribute(k,v);
      parent.appendChild(el);el.style.display='none';return el;
    };
    const dot=svg('circle',map,{r:17,class:'guide-dot'});
    const line=profile&&svg('line',profile,{y1:0,y2:120,class:'guide-line'});
    const position=(norm,x,y,text)=>{
      dot.style.display='';dot.setAttribute('cx',x);dot.setAttribute('cy',y);
      if(line){line.style.display='';line.setAttribute('x1',norm*1000);line.setAttribute('x2',norm*1000);}
      if(slider)slider.value=Math.round(norm*1000);output.textContent=text;
    };
    for(const pin of map.querySelectorAll('.cir-pin')){
      const activate=()=>position(+pin.dataset.norm,pin.dataset.x,pin.dataset.y,pin.getAttribute('aria-label'));
      pin.onclick=pin.onfocus=pin.onpointerenter=activate;
      pin.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();activate();}};
    }
    if(slider){
      const points=JSON.parse(slider.dataset.samples);
      slider.oninput=()=>{
        const f=Number(slider.value)/1000;
        const p=points.reduce((a,b)=>Math.abs(a[0]-f)<Math.abs(b[0]-f)?a:b);
        position(p[0],p[1],p[2],`${Math.round(p[0]*slider.dataset.length)} m du départ · altitude ${p[3].toLocaleString('fr-FR')} m`);
        slider.value=Math.round(f*1000);
      };
    }
  }
});
