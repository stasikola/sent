(()=>{
'use strict';
/* ================= утилиты ================= */
const $=(s,r=document)=>r.querySelector(s);
const clamp=(v,a,b)=>Math.min(b,Math.max(a,v));
const lerp=(a,b,t)=>a+(b-a)*t;
const el=(tag,cls,html)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(html!=null)e.innerHTML=html;return e};
const safe=fn=>{try{fn()}catch(e){}};
const m2f=m=>440*Math.pow(2,(m-69)/12);
const NOTE=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

function bindPress(e,down,up){
  const rel=ev=>{if(!e.classList.contains('down'))return;e.classList.remove('down');up&&up(ev)};
  e.addEventListener('pointerdown',ev=>{ev.preventDefault();safe(()=>e.setPointerCapture(ev.pointerId));e.classList.add('down');down&&down(ev)});
  e.addEventListener('pointerup',rel);e.addEventListener('pointercancel',rel);e.addEventListener('lostpointercapture',rel);
}

/* ================= состояние ================= */
const SC=[0,3,5,7,10,12];           // минорная пентатоника от A
const PT=[0,-4,3,-2];               // сдвиг паттернов: Am · F · C · G
const PN=['Am','F','C','G'];
const WAVE=['SINE','TRIANGLE','SAW','SQUARE'], WT=['sine','triangle','sawtooth','square'];
const KIT=['SOFT','TIGHT','DUSTY','PUNCH'], KM=[1,.6,1.5,.8];
const DR=['K','S','C','H','O','P'];
const voices=[
  {key:'bass', name:'BASS', color:'#5b8cff',base:33,macro:.45,wave:2,oct:0},
  {key:'pluck',name:'PLUCK',color:'#f2c94c',base:69,macro:.40,wave:1,oct:0},
  {key:'pad',  name:'PAD',  color:'#dcc7a3',base:57,macro:.50,wave:2,oct:0},
  {key:'drums',name:'DRUMS',color:'#ff6a2b',base:0, macro:.45,wave:0,oct:0}
];
const chInfo=[
  {n:'BASS',v:0,fader:.72,tone:.85,rev:.05,dly:0},
  {n:'PLUCK',v:1,fader:.60,tone:.9, rev:.22,dly:.25},
  {n:'PAD', v:2,fader:.55,tone:.8, rev:.45,dly:.1},
  {n:'KICK',v:3,fader:.80,tone:1,  rev:0,  dly:0},
  {n:'SNR', v:3,fader:.58,tone:1,  rev:.25,dly:.08},
  {n:'HATS',v:3,fader:.42,tone:1,  rev:.05,dly:0}
];
const grid=voices.map(()=>Array.from({length:6},()=>new Array(16).fill(0)));
(function preset(){
  const put=(v,map)=>Object.entries(map).forEach(([r,steps])=>steps.forEach(s=>grid[v][+r][s]=1));
  put(0,{0:[0,3,8,11],2:[6,14],1:[12]});
  put(1,{3:[2,10],4:[5,13],2:[7],5:[15],1:[9]});
  put(2,{0:[0],1:[0,8],3:[0],4:[0,8],2:[8],5:[8]});
  put(3,{0:[0,7,10],1:[4,12],3:[0,2,4,6,8,10,12,14],4:[15],5:[11]});
})();
let sel=0, ptn=0, pending=null, step=0, playhead=-1, lastStepTime=0;
let playing=false, rec=false, powered=false;
let bpmBase=92, half=false, dbl=false, nudge=0, swing=.3, swingOn=true;
let shiftHeld=false, fxLatch=false;
const voiceMute=[false,false,false,false], chMute=new Array(6).fill(false);

/* ================= аудио-граф ================= */
const busIn=new Tone.Gain(1);
const wobble=new Tone.Vibrato({frequency:.55,depth:.2,wet:0});
const mFilter=new Tone.Filter(18000,'lowpass',-12);
const comp=new Tone.Compressor(-14,3);
const makeup=new Tone.Gain(1);
const limiter=new Tone.Limiter(-1);
const killGain=new Tone.Gain(1);
busIn.chain(wobble,mFilter,comp,makeup,limiter,killGain,Tone.getDestination());
const analyser=new Tone.Analyser('fft',64); killGain.connect(analyser);
const recorder=new Tone.Recorder(); killGain.connect(recorder);

const reverb=new Tone.Reverb({decay:5.5,preDelay:.03,wet:1});
const revLP=new Tone.Filter(4200,'lowpass'); reverb.chain(revLP,busIn);
const delay=new Tone.FeedbackDelay({delayTime:'8n.',feedback:.42,wet:1});
const delayLP=new Tone.Filter(2600,'lowpass'); delay.chain(delayLP,busIn);
const dubBus=new Tone.Gain(0); dubBus.connect(delay);

const chs=chInfo.map(ci=>{
  const inp=new Tone.Filter(18000,'lowpass',-12);
  const ch=new Tone.Channel({volume:-6});
  const rs=new Tone.Gain(0), ds=new Tone.Gain(0);
  const meter=new Tone.Meter({smoothing:.75});
  inp.connect(ch); ch.connect(busIn);
  ch.connect(rs); rs.connect(reverb);
  ch.connect(ds); ds.connect(delay);
  ch.connect(dubBus); ch.connect(meter);
  return {inp,ch,rs,ds,meter};
});
function applyCh(i){
  const c=chs[i], ci=chInfo[i];
  c.ch.volume.value = ci.fader<=.001 ? -80 : Tone.gainToDb(ci.fader*ci.fader);
  c.inp.frequency.value = 250*Math.pow(2,ci.tone*6.2);
  c.rs.gain.value = ci.rev*.9;
  c.ds.gain.value = ci.dly*.8;
  c.ch.mute = chMute[i] || voiceMute[ci.v];
}

/* инструменты */
const bass=new Tone.MonoSynth({
  oscillator:{type:'sawtooth'},
  envelope:{attack:.01,decay:.3,sustain:.45,release:.35},
  filter:{Q:2.5,type:'lowpass',rolloff:-24},
  filterEnvelope:{attack:.005,decay:.28,sustain:.2,release:.5,baseFrequency:300,octaves:2.5},
  volume:-3
}).connect(chs[0].inp);
const pluck=new Tone.PolySynth(Tone.Synth,{
  oscillator:{type:'triangle'},
  envelope:{attack:.004,decay:.3,sustain:0,release:.25},volume:-5
}); pluck.maxPolyphony=6; pluck.connect(chs[1].inp);
const padLP=new Tone.Filter(2300,'lowpass'), padCh=new Tone.Chorus(3.5,2.5,.45).start();
const pad=new Tone.PolySynth(Tone.Synth,{
  oscillator:{type:'fatsawtooth',count:3,spread:24},
  envelope:{attack:.5,decay:.3,sustain:.8,release:1.8},volume:-16
}); pad.maxPolyphony=8; pad.chain(padLP,padCh,chs[2].inp);

const kick=new Tone.MembraneSynth({pitchDecay:.035,octaves:5,envelope:{attack:.001,decay:.4,sustain:0,release:.1},volume:2}).connect(chs[3].inp);
const snN=new Tone.NoiseSynth({noise:{type:'pink'},envelope:{attack:.001,decay:.16,sustain:0}}); snN.chain(new Tone.Filter(1800,'bandpass'),chs[4].inp);
const snB=new Tone.MembraneSynth({pitchDecay:.02,octaves:2,envelope:{attack:.001,decay:.1,sustain:0},volume:-8}).connect(chs[4].inp);
const clN=new Tone.NoiseSynth({noise:{type:'white'},envelope:{attack:.002,decay:.14,sustain:0},volume:-4}); clN.chain(new Tone.Filter(1400,'bandpass'),chs[4].inp);
const perc=new Tone.MembraneSynth({pitchDecay:.05,octaves:3,envelope:{attack:.001,decay:.3,sustain:0},volume:-4}).connect(chs[4].inp);
const hat=new Tone.NoiseSynth({noise:{type:'white'},envelope:{attack:.001,decay:.04,sustain:0},volume:-11}); hat.chain(new Tone.Filter(7500,'highpass'),chs[5].inp);
const ohat=new Tone.NoiseSynth({noise:{type:'white'},envelope:{attack:.002,decay:.28,sustain:0,release:.1},volume:-13}); ohat.chain(new Tone.Filter(7000,'highpass'),chs[5].inp);
let kickHz=52;

function applyMacro(v){
  const m=voices[v].macro;
  if(v===0){const b=70*Math.pow(2,m*4);bass.filterEnvelope.baseFrequency=b}
  if(v===1){const d=.06+m*.8;pluck.set({envelope:{decay:d,release:d*.7}})}
  if(v===2){pad.set({envelope:{attack:.02+m*1.6,release:.6+m*2.6}})}
  if(v===3){kickHz=38+m*40}
}
function applyWave(v){
  const w=voices[v].wave;
  if(v===0) bass.oscillator.type=WT[w];
  if(v===1) pluck.set({oscillator:{type:WT[w]}});
  if(v===2) pad.set({oscillator:{type:'fat'+WT[w]}});
  if(v===3){const k=KM[w];kick.envelope.decay=.4*k;snN.envelope.decay=.16*k;ohat.envelope.decay=.28*k;perc.envelope.decay=.3*k}
}
function macroText(v){
  const m=voices[v].macro;
  if(v===0){const b=70*Math.pow(2,m*4);return `FILTER FREQ ${Math.round(b)}–${Math.round(b*5.66)}`}
  if(v===1) return `DECAY ${(.06+m*.8).toFixed(2)}S`;
  if(v===2) return `SWELL ${(.02+m*1.6).toFixed(2)}S`;
  return `TUNE ${Math.round(38+m*40)}HZ`;
}
const macroName=['FILTER','DECAY','SWELL','TUNE'];

/* воспроизведение */
const stepDur=()=>Tone.Time('16n').toSeconds();
function noteFreq(v,r){return m2f(voices[v].base+12*voices[v].oct+SC[r]+PT[ptn])}
function drum(r,t,vel){
  safe(()=>{
    if(r===0) kick.triggerAttackRelease(kickHz,'8n',t,vel);
    else if(r===1){snN.triggerAttackRelease(.12,t,vel);snB.triggerAttackRelease(185,.08,t,vel*.8)}
    else if(r===2){[0,.011,.023].forEach((o,i)=>clN.triggerAttackRelease(.1,t+o,vel*(i===2?1:.6)))}
    else if(r===3) hat.triggerAttackRelease(.04,t,vel);
    else if(r===4) ohat.triggerAttackRelease(.2,t,vel);
    else if(r===5) perc.triggerAttackRelease(kickHz*2.1,.15,t,vel);
  });
}
function humanize(base){return clamp(base+(Math.random()-.5)*.16,.2,1)}

const loop=new Tone.Loop(time=>{
  if(step===0&&pending!==null){ptn=pending;pending=null;Tone.Draw.schedule(refreshPatternKeys,time)}
  lastStepTime=time;
  const s=step, sd=stepDur();
  // bass
  {const g=grid[0];for(let r=0;r<6;r++)if(g[r][s]){safe(()=>bass.triggerAttackRelease(noteFreq(0,r),sd*2.4,time,humanize(.85)));break}}
  // pluck
  {const f=[];grid[1].forEach((row,r)=>{if(row[s])f.push(noteFreq(1,r))});if(f.length)safe(()=>pluck.triggerAttackRelease(f,sd*1.2,time,humanize(.7)))}
  // pad
  {const f=[];grid[2].forEach((row,r)=>{if(row[s])f.push(noteFreq(2,r))});if(f.length)safe(()=>pad.triggerAttackRelease(f,sd*7,time,.6))}
  // drums
  grid[3].forEach((row,r)=>{if(row[s])drum(r,time,humanize(r===3&&s%4?.5:.85))});
  Tone.Draw.schedule(()=>{playhead=s;pulsePills(s)},time);
  step=(step+1)%16;
},'16n').start(0);

const T=Tone.getTransport?Tone.getTransport():Tone.Transport;
T.swing=.3;T.swingSubdivision='8n';
function effBpm(){return bpmBase*(half?.5:dbl?2:1)*(1+nudge)}
function applyBpm(ramp=.03){T.bpm.rampTo(effBpm(),ramp)}
T.bpm.value=bpmBase;

/* ================= UI: левая панель ================= */
const left=$('#left');
function cell(col,row,cs=1,rs=1,cls=''){const c=el('div','cell '+cls);c.style.gridColumn=`${col} / span ${cs}`;c.style.gridRow=`${row} / span ${rs}`;left.appendChild(c);return c}
function addKey(col,row,html,cls='',cs=1,rs=1,cc=''){const c=cell(col,row,cs,rs,cc);const k=el('button','key '+cls,html);k.type='button';c.appendChild(k);return k}
const ic={
  sine:'<svg viewBox="0 0 32 20"><path d="M2 10C7 -2 11 -2 16 10S25 22 30 10"/></svg>',
  tri:'<svg viewBox="0 0 32 20"><path d="M2 10L8 3l8 7 8 7 6-7"/></svg>',
  saw:'<svg viewBox="0 0 32 20"><path d="M2 16L16 4v12L30 4"/></svg>',
  sq:'<svg viewBox="0 0 32 20"><path d="M2 16V4h14v12h14V4"/></svg>',
  up:'<svg viewBox="0 0 32 22"><path d="M16 19V4M9 11l7-7 7 7"/></svg>',
  down:'<svg viewBox="0 0 32 22"><path d="M16 3v15M9 11l7 7 7-7"/></svg>',
  cut:'<svg viewBox="0 0 32 22"><circle cx="9" cy="17" r="3"/><circle cx="23" cy="17" r="3"/><path d="M11 15L22 3M21 15L10 3"/></svg>',
  rec:'<svg viewBox="0 0 32 22" style="stroke:none"><circle cx="16" cy="11" r="6" fill="#ff5a1f"/></svg>',
  play:'<svg viewBox="0 0 32 22" style="stroke:none"><path d="M11 3l13 8-13 8z" fill="#4c4b46"/></svg>',
  stop:'<svg viewBox="0 0 32 22" style="stroke:none"><rect x="9" y="4" width="14" height="14" rx="2" fill="#4c4b46"/></svg>',
  l:'<svg viewBox="0 0 32 22"><path d="M26 11H7M13 4l-6 7 6 7"/></svg>',
  r:'<svg viewBox="0 0 32 22"><path d="M6 11h19M19 4l7 7-7 7"/></svg>',
  rnd:'<svg viewBox="0 0 32 22"><path d="M8 17L22 5M12 5h10v10"/></svg>',
  dots:'<svg viewBox="0 0 32 22" style="fill:#5f5e58;stroke:none"><circle cx="8" cy="11" r="2"/><circle cx="16" cy="11" r="2"/><circle cx="24" cy="11" r="2"/></svg>'
};
const led='<i class="led"></i>';

/* 4 ручки-голоса */
const padEls=voices.map((vo,i)=>{
  const c=cell(1+i*2,1,2,2,'pad');
  const k=el('div','key');k.style.cssText='display:grid;place-items:center';
  const kn=el('div','knob');kn.style.setProperty('--c',vo.color);kn.innerHTML='<i class="kcap"><b></b></i>';
  k.appendChild(kn);k.insertAdjacentHTML('beforeend',led);
  c.appendChild(k);
  const lab=el('div','dotlbl',vo.name);lab.style.cssText='bottom:1px;font-size:9px;left:0;right:0';c.appendChild(lab);
  k.style.setProperty('--vc',vo.color);
  return {k,kn};
});
padEls.forEach((p,i)=>{
  const set=()=>p.kn.style.setProperty('--v',voices[i].macro);
  set();
  let y0,v0;
  p.kn.addEventListener('pointerdown',ev=>{ev.preventDefault();selectVoice(i);y0=ev.clientY;v0=voices[i].macro;p.kn.setPointerCapture(ev.pointerId);
    p.k.classList.add('down');
    const mv=e=>{const dy=(y0-e.clientY)/(scale||1);voices[i].macro=clamp(v0+dy/170,0,1);set();applyMacro(i)};
    const up=()=>{p.kn.removeEventListener('pointermove',mv);p.kn.removeEventListener('pointerup',up);p.kn.removeEventListener('pointercancel',up);p.k.classList.remove('down')};
    p.kn.addEventListener('pointermove',mv);p.kn.addEventListener('pointerup',up);p.kn.addEventListener('pointercancel',up)});
  p.kn.addEventListener('wheel',e=>{e.preventDefault();voices[i].macro=clamp(voices[i].macro-e.deltaY/1500,0,1);set();applyMacro(i)},{passive:false});
  p.kn.addEventListener('dblclick',()=>{voices[i].macro=[.45,.4,.5,.45][i];set();applyMacro(i)});
  p.k.addEventListener('pointerdown',e=>{if(e.target===p.k)selectVoice(i)});
});

/* правая колонка кнопок */
const side={};
const sideSpec=[
  ['rnd',ic.rnd,'Случайный рисунок для выбранного голоса'],
  ['com','<span class="t">COM</span>','Сильнее сжать мастер'],
  ['swg',ic.dots,'Свинг вкл/выкл'],
  ['wow','<span class="t">WOW</span>','Плавающая «плёнка»'],
  ['half','<span class="sm">½</span>','Вдвое медленнее'],
  ['dbl','<span class="sm">×2</span>','Вдвое быстрее'],
  ['kill','<span class="t">KILL</span>','Держи — звук пропадает']
];
sideSpec.forEach(([id,html,title],i)=>{const k=addKey(9,1+i,html+led);k.title=title;side[id]=k});

/* экран */
const bezel=el('div');bezel.id='bezel';bezel.innerHTML='<canvas id="screen"></canvas>';left.appendChild(bezel);

/* ряд 7: волны + паттерны */
const waveKeys=[ic.sine,ic.tri,ic.saw,ic.sq].map((h,i)=>{const k=addKey(1+i,7,h+led);k.title='Форма волны / вариант набора ударных';return k});
const ptnKeys=[1,2,3,4].map((n,i)=>{const k=addKey(5+i,7,`<span class="n">${n}</span>`+led);k.title=`Аккорд ${PN[i]}`;return k});
/* ряд 8 */
const kUp=addKey(1,8,ic.up);kUp.title='Октава вверх';
const kDn=addKey(2,8,ic.down);kDn.title='Октава вниз';
const kCut=addKey(3,8,ic.cut);kCut.title='Очистить голос';
const muteDots=voices.map((vo,i)=>{
  const c=cell(4+i,8);
  const d=el('button','dot');d.type='button';d.title=`Заглушить ${vo.name}`;
  c.appendChild(d);c.appendChild(el('i','dl'));c.appendChild(el('div','dotlbl',vo.name));
  return d;
});
/* ряды 9–10 */
const kRec=addKey(1,9,ic.rec+led);kRec.title='Запись нот с клавиш в паттерн';
const kPlay=addKey(2,9,ic.play+led);kPlay.title='Старт (Пробел)';
const kStop=addKey(3,9,ic.stop);kStop.title='Стоп';
const kL=addKey(1,10,ic.l);kL.title='Сдвинуть рисунок влево';
const kR=addKey(2,10,ic.r);kR.title='Сдвинуть рисунок вправо';
const kShift=addKey(3,10,'<span class="sm">shift</span>');kShift.title='Shift: сдвиг сразу на 4 шага';
const pills=[0,1,2,3,4,5].map(r=>{const k=addKey(4+r,9,`<span class="k"></span>`,'',1,2,'pill');return k});
const pillKeys=['a','s','d','f','g','h'];

/* ================= UI: правая часть ================= */
const mixCh=$('#mixCh');
const faders=[],knobsUI=[],ledsUI=[],muteUI=[];
chInfo.forEach((ci,i)=>{
  const col=el('div','chcol');col.style.left=(i*38)+'px';
  const mk=(cls,color,key,def,fmt)=>{
    const k=el('div','knob mini '+cls);k.style.setProperty('--c',color);k.innerHTML='<i class="kcap"><b></b></i>';
    k.style.setProperty('--v',ci[key]);
    let y0,v0;
    k.addEventListener('pointerdown',ev=>{ev.preventDefault();y0=ev.clientY;v0=ci[key];k.setPointerCapture(ev.pointerId);
      const mv=e=>{ci[key]=clamp(v0+(y0-e.clientY)/(scale||1)/90,0,1);k.style.setProperty('--v',ci[key]);applyCh(i)};
      const up=()=>{k.removeEventListener('pointermove',mv);k.removeEventListener('pointerup',up);k.removeEventListener('pointercancel',up)};
      k.addEventListener('pointermove',mv);k.addEventListener('pointerup',up);k.addEventListener('pointercancel',up)});
    k.addEventListener('dblclick',()=>{ci[key]=def;k.style.setProperty('--v',def);applyCh(i)});
    k.addEventListener('wheel',e=>{e.preventDefault();ci[key]=clamp(ci[key]-e.deltaY/1200,0,1);k.style.setProperty('--v',ci[key]);applyCh(i)},{passive:false});
    return k;
  };
  const k1=mk('blk k1','#2a2a2c','tone',ci.tone,0);k1.title='Тон (фильтр канала)';
  const k2=mk('k2','#ff6a2b','rev',ci.rev,0);k2.title='Реверб';
  const k3=mk('gry k3','#9a9b9c','dly',ci.dly,0);k3.title='Эхо';
  const leds=el('div','leds',`<i></i><i></i><i></i>`);
  const f=el('div','fader');f.style.setProperty('--v',ci.fader);f.innerHTML='<i></i>';f.title='Громкость';
  const setF=e=>{const r=f.getBoundingClientRect();ci.fader=clamp(1-(e.clientY-r.top)/r.height,0,1);f.style.setProperty('--v',ci.fader);applyCh(i)};
  f.addEventListener('pointerdown',ev=>{ev.preventDefault();f.setPointerCapture(ev.pointerId);setF(ev);
    const up=()=>{f.removeEventListener('pointermove',setF);f.removeEventListener('pointerup',up);f.removeEventListener('pointercancel',up)};
    f.addEventListener('pointermove',setF);f.addEventListener('pointerup',up);f.addEventListener('pointercancel',up)});
  const lbl=el('div','chl',ci.n);
  const m=el('button','mk');m.type='button';m.title='Заглушить канал';
  bindPress(m,()=>{chMute[i]=!chMute[i];m.classList.toggle('on',chMute[i]);applyCh(i)});
  col.append(k1,k2,k3,leds,f,lbl,m);
  mixCh.appendChild(col);
  faders.push(f);ledsUI.push([...leds.children]);muteUI.push(m);
});

/* ================= громкоговоритель ================= */
const gr=$('#grille'),gctx=gr.getContext('2d');
const GW=580,GH=140,PITCH=10,GC=58,GRW=14;
const dpr=Math.min(2,window.devicePixelRatio||1);
function fitCanvas(cv,ctx,w,h){cv.style.width=w+'px';cv.style.height=h+'px';cv.width=w*dpr;cv.height=h*dpr;ctx.setTransform(dpr,0,0,dpr,0,0)}
fitCanvas(gr,gctx,GW,GH);
const gBase=document.createElement('canvas');gBase.width=GW*dpr;gBase.height=GH*dpr;
(function(){const c=gBase.getContext('2d');c.setTransform(dpr,0,0,dpr,0,0);
  for(let x=0;x<GC;x++)for(let y=0;y<GRW;y++){const cx=5+x*PITCH,cy=5+y*PITCH;
    c.beginPath();c.arc(cx,cy,2.7,0,7);c.fillStyle='#2b2c2e';c.fill();
    c.beginPath();c.arc(cx,cy+.6,2.7,.15,Math.PI-.15);c.strokeStyle='rgba(255,255,255,.6)';c.lineWidth=1;c.stroke();
    c.beginPath();c.arc(cx,cy-.4,2.2,Math.PI,2*Math.PI);c.strokeStyle='rgba(0,0,0,.55)';c.lineWidth=1;c.stroke();}
})();
const gLevel=new Float32Array(GC);
function drawGrille(){
  gctx.clearRect(0,0,GW,GH);gctx.drawImage(gBase,0,0,GW,GH);
  if(!powered)return;
  const fft=analyser.getValue();
  for(let x=0;x<GC;x++){
    const bin=Math.min(63,Math.floor(Math.pow(x/(GC-1),1.7)*60)+1);
    const e=clamp((fft[bin]+88)/58,0,1);
    gLevel[x]=Math.max(e,gLevel[x]-.05);
    const n=Math.round(gLevel[x]*GRW);
    for(let y=0;y<n;y++){
      const cy=5+(GRW-1-y)*PITCH,cx=5+x*PITCH,a=.28+.5*(y/GRW);
      const g=gctx.createRadialGradient(cx,cy,0,cx,cy,4.4);
      g.addColorStop(0,`rgba(255,110,50,${a})`);g.addColorStop(1,'rgba(255,110,50,0)');
      gctx.fillStyle=g;gctx.fillRect(cx-5,cy-5,10,10);
    }
  }
}

/* ================= экран ================= */
const scr=$('#screen'),sctx=scr.getContext('2d');
const SW=511,SH=247;fitCanvas(scr,sctx,SW,SH);
const GX=60,GY=46,CW=20,RH=25;
const MONO='"IBM Plex Mono",ui-monospace,monospace';
function txt(s,x,y,c,font,al='left'){sctx.font=font||`600 10px ${MONO}`;sctx.fillStyle=c;sctx.textAlign=al;sctx.textBaseline='middle';sctx.fillText(s,x,y)}
function rr(x,y,w,h,r){sctx.beginPath();sctx.roundRect?sctx.roundRect(x,y,w,h,r):sctx.rect(x,y,w,h)}
function chip(s,x,y,color,fill,al='left'){
  sctx.font=`600 9px ${MONO}`;const w=sctx.measureText(s).width+14;const xx=al==='right'?x-w:x;
  rr(xx,y,w,17,4);if(fill){sctx.fillStyle=color;sctx.fill()}else{sctx.strokeStyle=color;sctx.lineWidth=1;sctx.stroke()}
  txt(s,xx+7,y+9,fill?'#0b0c0e':color,`600 9px ${MONO}`);return xx+w;
}
function wavePath(i,x,y,w,h){
  sctx.beginPath();
  if(i===0){for(let t=0;t<=1.001;t+=.05){const px=x+t*w,py=y+h/2-Math.sin(t*Math.PI*2)*h*.42;t?sctx.lineTo(px,py):sctx.moveTo(px,py)}}
  if(i===1){sctx.moveTo(x,y+h/2);sctx.lineTo(x+w*.25,y+h*.1);sctx.lineTo(x+w*.75,y+h*.9);sctx.lineTo(x+w,y+h/2)}
  if(i===2){sctx.moveTo(x,y+h*.9);sctx.lineTo(x+w*.5,y+h*.1);sctx.lineTo(x+w*.5,y+h*.9);sctx.lineTo(x+w,y+h*.1)}
  if(i===3){sctx.moveTo(x,y+h*.85);sctx.lineTo(x,y+h*.15);sctx.lineTo(x+w*.5,y+h*.15);sctx.lineTo(x+w*.5,y+h*.85);sctx.lineTo(x+w,y+h*.85);sctx.lineTo(x+w,y+h*.15)}
  sctx.stroke();
}
const hex2rgba=(h,a)=>{const n=parseInt(h.slice(1),16);return `rgba(${n>>16},${n>>8&255},${n&255},${a})`};
const railY=i=>GY+i*38;
function drawScreen(now){
  sctx.clearRect(0,0,SW,SH);sctx.fillStyle='#0b0c0e';sctx.fillRect(0,0,SW,SH);
  if(!powered){
    const a=.45+.55*Math.abs(Math.sin(now/600));
    txt('FIELD ONE',SW/2,SH/2-16,'#e9e6de',`600 20px ${MONO}`,'center');
    txt('коснись экрана — включить звук',SW/2,SH/2+14,`rgba(255,120,60,${a})`,`400 11px ${MONO}`,'center');
    return;
  }
  const vo=sel===undefined?voices[0]:voices[sel], g=grid[sel];
  // шапка
  const head=sel===3?'KIT':'WAVEFORM';
  txt(head,10,14,'#5b8cff');
  sctx.font=`600 10px ${MONO}`;const hw=sctx.measureText(head+' ').width;
  txt(sel===3?KIT[vo.wave]:WAVE[vo.wave],10+hw,14,vo.color);
  sctx.strokeStyle='#26282d';sctx.lineWidth=1;sctx.beginPath();sctx.moveTo(150,14);sctx.lineTo(300,14);sctx.stroke();
  for(let i=0;i<5;i++){sctx.beginPath();sctx.moveTo(160+i*30,11);sctx.lineTo(160+i*30,17);sctx.stroke()}
  txt(macroText(sel),SW-10,14,vo.color,`600 10px ${MONO}`,'right');
  sctx.strokeStyle='#26282d';sctx.beginPath();sctx.moveTo(8,26);sctx.lineTo(SW-8,26);sctx.stroke();

  // рейка с волнами
  for(let i=0;i<4;i++){
    const y=railY(i)+2, on=vo.wave===i;
    rr(8,y,38,32,5);sctx.fillStyle=on?hex2rgba(vo.color,.14):'#111317';sctx.fill();
    sctx.strokeStyle=on?vo.color:'#25272c';sctx.lineWidth=on?1.5:1;sctx.stroke();
    sctx.strokeStyle=on?vo.color:'#4c5057';sctx.lineWidth=1.6;wavePath(i,14,y+8,26,16);
  }
  // подписи строк
  for(let r=0;r<6;r++){
    const y=GY+(5-r)*RH+RH/2;
    let lab;
    if(sel===3)lab=DR[r];else{lab=NOTE[((vo.base+12*vo.oct+SC[r]+PT[ptn])%12+12)%12]}
    txt(lab,GX-5,y,'#4d525a',`400 8px ${MONO}`,'right');
  }
  // номера шагов
  for(let s=0;s<16;s++){if(s%4===0)txt(String(s+1),GX+s*CW+CW/2,38,'#4d525a',`400 8px ${MONO}`,'center')}
  // сетка
  for(let r=0;r<6;r++)for(let s=0;s<16;s++){
    const x=GX+s*CW,y=GY+(5-r)*RH, on=g[r][s], ph=playhead===s&&playing;
    rr(x+1.5,y+1.5,CW-3,RH-3,4);
    sctx.fillStyle=on?(ph?'#ffffff':vo.color):(ph?'#1d2026':(Math.floor(s/4)%2?'#121419':'#0f1115'));sctx.fill();
    if(on&&!ph){sctx.fillStyle='rgba(255,255,255,.22)';rr(x+3,y+3,CW-6,3,1.5);sctx.fill()}
  }
  if(playing&&playhead>=0){sctx.strokeStyle='rgba(255,255,255,.18)';sctx.lineWidth=1;sctx.strokeRect(GX+playhead*CW+.5,GY,CW-1,RH*6)}

  // каналы
  const MX=398,MW=17.5;
  for(let i=0;i<6;i++){
    const ci=chInfo[i],c=voices[ci.v].color,x=MX+i*MW+MW/2;
    sctx.beginPath();sctx.arc(x,54,5.2,0,7);sctx.strokeStyle='#2c2f35';sctx.lineWidth=1.4;sctx.stroke();
    sctx.beginPath();sctx.arc(x,54,5.2,Math.PI*.75,Math.PI*(.75+1.5*ci.tone));sctx.strokeStyle=c;sctx.stroke();
    txt(String(i+1),x,72,'#7d838c',`400 9px ${MONO}`,'center');
    const bx=x-3.5,by=82,bh=104;
    sctx.fillStyle='#14161a';sctx.fillRect(bx,by,7,bh);
    let db=chs[i].meter.getValue();if(Array.isArray(db))db=db[0];
    const lv=(chMute[i]||voiceMute[ci.v])?0:clamp((db+48)/48,0,1);
    const gr2=sctx.createLinearGradient(0,by+bh,0,by);gr2.addColorStop(0,hex2rgba(c,.5));gr2.addColorStop(1,c);
    sctx.fillStyle=gr2;sctx.fillRect(bx,by+bh*(1-lv),7,bh*lv);
    const fy=by+bh*(1-ci.fader);sctx.fillStyle='#e9e6de';sctx.fillRect(bx-2,fy-1,11,2);
    txt(ci.n,x,199,(chMute[i]||voiceMute[ci.v])?'#ff5a1f':'#5b6068',`400 6px ${MONO}`,'center');
  }
  // нижняя строка чипов
  let x=10;const y0=SH-25;
  x=chip('▲ '+vo.name,x,y0,vo.color,true)+6;
  if(sel!==3)x=chip(`OCT ${vo.oct>0?'+':''}${vo.oct}`,x,y0,'#7d838c',false)+6;
  x=chip(`PTN ${ptn+1} ${PN[ptn]}${pending!==null?' → '+PN[pending]:''}`,x,y0,'#8fb4ff',false)+6;
  x=chip(`BPM ${Math.round(effBpm())}`,x,y0,'#7d838c',false)+6;
  if(swingOn)x=chip(`SWG ${Math.round(swing*100)}`,x,y0,'#7d838c',false)+6;
  chip(rec?(Math.floor(now/400)%2?'● REC':'○ REC'):(playing?'PLAY':'STOP'),SW-10,y0,rec?'#ff5a1f':(playing?'#7cf29a':'#7d838c'),rec,'right');
}

/* ввод с экрана */
let paint=null;
function screenXY(e){const r=scr.getBoundingClientRect();return [(e.clientX-r.left)/r.width*SW,(e.clientY-r.top)/r.height*SH]}
function cellAt(x,y){const s=Math.floor((x-GX)/CW),rr_=5-Math.floor((y-GY)/RH);return (s>=0&&s<16&&rr_>=0&&rr_<6)?[rr_,s]:null}
scr.addEventListener('pointerdown',e=>{
  e.preventDefault();
  if(!powered){startAudio();return}
  const [x,y]=screenXY(e);
  if(x>=8&&x<=46){for(let i=0;i<4;i++){const yy=railY(i)+2;if(y>=yy&&y<=yy+32){setWave(i);return}}}
  const c=cellAt(x,y);if(!c)return;
  const [r,s]=c;paint=grid[sel][r][s]?0:1;grid[sel][r][s]=paint;
  if(paint){if(sel===3)drum(r,Tone.now()+.005,.8);else previewNote(r)}
  scr.setPointerCapture(e.pointerId);
});
scr.addEventListener('pointermove',e=>{if(paint===null)return;const [x,y]=screenXY(e);const c=cellAt(x,y);if(c)grid[sel][c[0]][c[1]]=paint});
const endPaint=()=>{paint=null};
scr.addEventListener('pointerup',endPaint);scr.addEventListener('pointercancel',endPaint);

/* ================= логика управления ================= */
function selectVoice(i){
  sel=i;
  padEls.forEach((p,j)=>p.k.classList.toggle('on',j===i));
  waveKeys.forEach((k,j)=>k.classList.toggle('on',voices[i].wave===j));
  refreshPills();
}
function setWave(i){voices[sel].wave=i;applyWave(sel);waveKeys.forEach((k,j)=>k.classList.toggle('on',j===i))}
function refreshPills(){
  pills.forEach((k,r)=>{
    k.querySelector('.k').textContent=sel===3?DR[r]:NOTE[((voices[sel].base+12*voices[sel].oct+SC[r]+PT[ptn])%12+12)%12];
    k.style.setProperty('--vc',voices[sel].color);
  });
}
function pulsePills(s){pills.forEach((k,r)=>k.classList.toggle('lit',!!grid[sel][r][s]))}
function refreshPatternKeys(){ptnKeys.forEach((k,i)=>{k.classList.toggle('on',ptn===i);k.classList.toggle('pend',pending===i)});refreshPills()}
function setPattern(i){
  if(playing&&i!==ptn){pending=i}else{ptn=i;pending=null}
  refreshPatternKeys();
}
ptnKeys.forEach((k,i)=>bindPress(k,()=>{startAudio();setPattern(i)}));
waveKeys.forEach((k,i)=>bindPress(k,()=>setWave(i)));

/* игра с клавиш */
const held={};
function previewNote(r){const f=noteFreq(sel,r),t=Tone.now()+.005;
  if(sel===0)safe(()=>bass.triggerAttackRelease(f,.3,t,.8));
  if(sel===1)safe(()=>pluck.triggerAttackRelease(f,.2,t,.7));
  if(sel===2)safe(()=>pad.triggerAttackRelease(f,.8,t,.6))}
function noteOn(r){
  startAudio();
  if(held[r])return;
  const v=sel,t=Tone.now()+.005;
  if(v===3)drum(r,t,.9);
  else{const f=noteFreq(v,r);held[r]={v,f};
    if(v===0)safe(()=>bass.triggerAttack(f,t,.85));
    if(v===1)safe(()=>pluck.triggerAttack(f,t,.75));
    if(v===2)safe(()=>pad.triggerAttack(f,t,.7));}
  if(v===3)held[r]={v,f:0};
  if(rec&&playing){const cur=(step+15)%16;const s=(Tone.now()-lastStepTime>stepDur()/2)?step:cur;grid[v][r][s]=1}
}
function noteOff(r){
  const h=held[r];if(!h)return;delete held[r];
  const t=Tone.now();
  if(h.v===0)safe(()=>bass.triggerRelease(t));
  if(h.v===1)safe(()=>pluck.triggerRelease(h.f,t));
  if(h.v===2)safe(()=>pad.triggerRelease(h.f,t));
}
pills.forEach((k,r)=>bindPress(k,()=>noteOn(r),()=>noteOff(r)));

/* транспорт */
function play(){
  startAudio();
  if(playing){stop();return}
  playing=true;T.start('+0.05');kPlay.classList.add('on');
}
function stop(){
  playing=false;T.stop();step=0;playhead=-1;pending=null;refreshPatternKeys();
  safe(()=>pad.releaseAll());safe(()=>bass.triggerRelease());kPlay.classList.remove('on');
  pills.forEach(k=>k.classList.remove('lit'));
}
bindPress(kPlay,play);
bindPress(kStop,()=>{stop()});
bindPress(kRec,()=>{rec=!rec;kRec.classList.toggle('on',rec)});

/* редактирование */
bindPress(kUp,()=>{if(sel===3)return;voices[sel].oct=clamp(voices[sel].oct+1,-1,1);refreshPills()});
bindPress(kDn,()=>{if(sel===3)return;voices[sel].oct=clamp(voices[sel].oct-1,-1,1);refreshPills()});
bindPress(kCut,()=>{grid[sel].forEach(r=>r.fill(0))});
function rotate(dir){const n=shiftHeld?4:1;grid[sel].forEach(row=>{for(let i=0;i<n;i++){dir>0?row.unshift(row.pop()):row.push(row.shift())}})}
bindPress(kL,()=>rotate(-1));bindPress(kR,()=>rotate(1));
bindPress(kShift,()=>{shiftHeld=true},()=>{shiftHeld=false});
function randomize(v){
  const g=grid[v];g.forEach(r=>r.fill(0));const pick=a=>a[Math.floor(Math.random()*a.length)];
  if(v===0){for(let s=0;s<16;s++)if(s%4===0?Math.random()<.85:Math.random()<.22)g[pick([0,0,0,1,2,3])][s]=1}
  if(v===1){for(let s=0;s<16;s++)if(Math.random()<.32)g[pick([1,2,3,4,5])][s]=1}
  if(v===2){[0,8].forEach(s=>{const rows=[0,1,2,3,4,5].sort(()=>Math.random()-.5).slice(0,3);rows.forEach(r=>g[r][s]=1)})}
  if(v===3){g[0][0]=1;for(let s=1;s<16;s++)if(Math.random()<.18)g[0][s]=1;g[1][4]=1;g[1][12]=1;
    for(let s=0;s<16;s+=2)if(Math.random()<.9)g[3][s]=1;for(let s=1;s<16;s+=2)if(Math.random()<.15)g[3][s]=1;
    g[4][pick([7,14,15])]=1;if(Math.random()<.5)g[5][pick([3,11,13])]=1}
}
bindPress(side.rnd,()=>randomize(sel));

/* глобальные тумблеры */
const toggles={
  com:on=>{comp.threshold.value=on?-30:-14;comp.ratio.value=on?6:3;makeup.gain.value=on?1.7:1},
  swg:on=>{swingOn=on;T.swing=on?swing:0},
  wow:on=>{wobble.wet.value=on?1:0},
  half:on=>{half=on;if(on&&dbl){dbl=false;side.dbl.classList.remove('on')}applyBpm(.08)},
  dbl:on=>{dbl=on;if(on&&half){half=false;side.half.classList.remove('on')}applyBpm(.08)}
};
Object.keys(toggles).forEach(id=>{
  const k=side[id];
  if(id==='swg')k.classList.add('on');
  bindPress(k,()=>{const on=!k.classList.contains('on');k.classList.toggle('on',on);toggles[id](on)});
});
bindPress(side.kill,()=>killGain.gain.rampTo(0,.01),()=>killGain.gain.rampTo(1,.06));

/* FX */
const fxState={dub:false,lp:false};
function setDub(on){fxState.dub=on;dubBus.gain.rampTo(on?.85:0,.02);delay.feedback.rampTo(on?.7:.42,.05);$('#fx1').classList.toggle('on',on)}
function setLP(on){fxState.lp=on;mFilter.frequency.rampTo(on?450:18000,on?.18:.25);$('#fx2').classList.toggle('on',on)}
const fx1=$('#fx1'),fx2=$('#fx2');
bindPress(fx1,()=>{startAudio();fxLatch?setDub(!fxState.dub):setDub(true)},()=>{if(!fxLatch)setDub(false)});
bindPress(fx2,()=>{startAudio();fxLatch?setLP(!fxState.lp):setLP(true)},()=>{if(!fxLatch)setLP(false)});
const shift2=$('#shift2');
bindPress(shift2,()=>{fxLatch=!fxLatch;shift2.classList.toggle('on',fxLatch);if(!fxLatch){setDub(false);setLP(false)}});

/* mute-точки */
muteDots.forEach((d,i)=>bindPress(d,()=>{voiceMute[i]=!voiceMute[i];d.classList.toggle('on',voiceMute[i]);chInfo.forEach((ci,j)=>{if(ci.v===i)applyCh(j)})}));

/* темп */
const tk=$('#tempoKnob');
function setBpm(b){bpmBase=clamp(Math.round(b),60,140);tk.style.setProperty('--v',(bpmBase-60)/80);applyBpm(.05);
  $('#lcdN').textContent=bpmBase;delay.delayTime.value='8n.'}
setBpm(92);
(function(){let y0,v0;
  tk.addEventListener('pointerdown',ev=>{ev.preventDefault();y0=ev.clientY;v0=bpmBase;tk.setPointerCapture(ev.pointerId);
    const mv=e=>setBpm(v0+(y0-e.clientY)/(scale||1)*.5);
    const up=()=>{tk.removeEventListener('pointermove',mv);tk.removeEventListener('pointerup',up);tk.removeEventListener('pointercancel',up)};
    tk.addEventListener('pointermove',mv);tk.addEventListener('pointerup',up);tk.addEventListener('pointercancel',up)});
  tk.addEventListener('wheel',e=>{e.preventDefault();setBpm(bpmBase-Math.sign(e.deltaY))},{passive:false});
  tk.addEventListener('dblclick',()=>setBpm(92));
})();
bindPress($('#nudgeUp'),()=>setBpm(bpmBase+1));
bindPress($('#nudgeDn'),()=>setBpm(bpmBase-1));

/* свинг-фейдер */
const sw=$('#swing');sw.style.setProperty('--v',swing/.6);
sw.addEventListener('pointerdown',ev=>{ev.preventDefault();sw.setPointerCapture(ev.pointerId);
  const set=e=>{const r=sw.getBoundingClientRect();const v=clamp(1-(e.clientY-r.top)/r.height,0,1);swing=v*.6;sw.style.setProperty('--v',v);if(swingOn)T.swing=swing};
  set(ev);
  const up=()=>{sw.removeEventListener('pointermove',set);sw.removeEventListener('pointerup',up);sw.removeEventListener('pointercancel',up)};
  sw.addEventListener('pointermove',set);sw.addEventListener('pointerup',up);sw.addEventListener('pointercancel',up)});

/* ================= диск: подкрутка темпа ================= */
const disc=$('#disc'),discRot=$('#discRot');
let discAngle=0,dragging=false,lastA=0,lastT=0,omega=0;
const angOf=e=>{const r=disc.getBoundingClientRect();return Math.atan2(e.clientY-(r.top+r.height/2),e.clientX-(r.left+r.width/2))};
disc.addEventListener('pointerdown',ev=>{
  if(ev.target.closest('#hub'))return;
  ev.preventDefault();startAudio();dragging=true;disc.classList.add('drag');disc.setPointerCapture(ev.pointerId);lastA=angOf(ev);lastT=performance.now();omega=0;
});
disc.addEventListener('pointermove',ev=>{
  if(!dragging)return;
  const a=angOf(ev),t=performance.now();let d=a-lastA;if(d>Math.PI)d-=2*Math.PI;if(d<-Math.PI)d+=2*Math.PI;
  discAngle+=d*180/Math.PI;const dt=Math.max(1,t-lastT)/1000;omega=lerp(omega,d/dt,.35);
  nudge=clamp(omega/7,-.55,.55);applyBpm(.04);lastA=a;lastT=t;
});
const dEnd=()=>{if(!dragging)return;dragging=false;disc.classList.remove('drag');nudge=0;omega=0;applyBpm(.3)};
disc.addEventListener('pointerup',dEnd);disc.addEventListener('pointercancel',dEnd);

/* ================= лента (запись выступления) ================= */
let recording=false,recT0=0,lastUrl=null,lastExt='webm',tapeAudio=null;
const tchip=$('#tchip'),tRec=$('#tRec'),tPlay=$('#tPlay'),tStop=$('#tStop');
function tapeLabel(a,b,isRec){tchip.querySelector('b').textContent=a;tchip.querySelector('span').textContent=b;tchip.classList.toggle('rec',!!isRec)}
async function tapeStopRec(){
  if(!recording)return;recording=false;tRec.classList.remove('on');
  const blob=await recorder.stop();lastExt=(blob.type.includes('mp4')||blob.type.includes('aac'))?'m4a':(blob.type.includes('ogg')?'ogg':'webm');
  if(lastUrl)URL.revokeObjectURL(lastUrl);lastUrl=URL.createObjectURL(blob);tapeLabel('TAPE','SAVED',false);
}
bindPress(tRec,async()=>{startAudio();
  if(tapeAudio){tapeAudio.pause();tapeAudio=null;tPlay.classList.remove('on')}
  if(recording){await tapeStopRec();return}
  await Tone.start();recorder.start();recording=true;recT0=performance.now();tRec.classList.add('on');tapeLabel('REC','00:00',true)});
bindPress(tPlay,async()=>{
  if(recording)await tapeStopRec();
  if(!lastUrl){tapeLabel('TAPE','EMPTY',false);return}
  if(tapeAudio){tapeAudio.pause();tapeAudio=null;tPlay.classList.remove('on');tapeLabel('TAPE','STOP',false);return}
  tapeAudio=new Audio(lastUrl);tapeAudio.onended=()=>{tapeAudio=null;tPlay.classList.remove('on');tapeLabel('TAPE','SAVED',false)};
  tapeAudio.play();tPlay.classList.add('on');tapeLabel('PLAY','',false);
});
bindPress(tStop,async()=>{await tapeStopRec();if(tapeAudio){tapeAudio.pause();tapeAudio=null;tPlay.classList.remove('on');tapeLabel('TAPE','STOP',false)}});
$('#hub').addEventListener('click',()=>{
  if(!lastUrl){tapeLabel('TAPE','EMPTY',false);return}
  const a=document.createElement('a');a.href=lastUrl;a.download='field-one-take.'+lastExt;document.body.appendChild(a);a.click();a.remove();
});

/* ================= старт звука ================= */
let started=false;
async function startAudio(){
  if(started)return;started=true;
  try{await Tone.start()}catch(e){}
  try{await reverb.ready}catch(e){}
  powered=true;
}
window.addEventListener('keydown',()=>{startAudio()},{once:true});

/* ================= клавиатура ================= */
window.addEventListener('keydown',e=>{
  if(e.repeat||e.metaKey||e.ctrlKey||e.altKey)return;
  const k=e.key.toLowerCase();
  if(e.key===' '){e.preventDefault();play();return}
  if(e.key==='Shift'){shiftHeld=true;return}
  const pi=pillKeys.indexOf(k);if(pi>=0){pills[pi].classList.add('down');noteOn(pi);return}
  const vi=['q','w','e','r'].indexOf(k);if(vi>=0){selectVoice(vi);return}
  if('1234'.includes(k)&&k){setPattern(+k-1)}
});
window.addEventListener('keyup',e=>{
  const k=e.key.toLowerCase();
  if(e.key==='Shift'){shiftHeld=false;return}
  const pi=pillKeys.indexOf(k);if(pi>=0){pills[pi].classList.remove('down');noteOff(pi)}
});

/* ================= масштаб ================= */
let scale=1;
const wrap=$('#wrap'),stage=$('#stage');
function fit(){
  scale=clamp((window.innerWidth-24)/1260,.25,1.4);
  stage.style.transform=`scale(${scale})`;
  wrap.style.width=1260*scale+'px';wrap.style.height=820*scale+'px';
}
window.addEventListener('resize',fit);fit();

/* ================= главный цикл ================= */
let lastFrame=performance.now();
function frame(now){
  const dt=(now-lastFrame)/1000;lastFrame=now;
  if(!dragging&&(playing||tapeAudio||recording))discAngle+=dt*(playing?60*effBpm()/92:40);
  discRot.style.transform=`rotate(${discAngle}deg)`;
  drawScreen(now);drawGrille();
  if(powered){
    chs.forEach((c,i)=>{
      let db=c.meter.getValue();if(Array.isArray(db))db=db[0];
      const lv=(chMute[i]||voiceMute[chInfo[i].v])?0:clamp((db+48)/48,0,1);
      const L=ledsUI[i];
      L[0].className=lv>.85?'r':'';L[1].className=lv>.6?'y':'';L[2].className=lv>.3?'g':'';
    });
  }
  if(recording){const s=Math.floor((performance.now()-recT0)/1000);tchip.querySelector('span').textContent=String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0')}
  $('#lcdS').innerHTML=half?'½ time':dbl?'× 2':'&nbsp;';
  requestAnimationFrame(frame);
}
/* старт */
chInfo.forEach((_,i)=>applyCh(i));
voices.forEach((_,i)=>{applyMacro(i);applyWave(i)});
selectVoice(0);refreshPatternKeys();
requestAnimationFrame(frame);
})();
