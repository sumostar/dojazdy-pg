/* Dojazdy PG: date-scoped timetable routing, sourced from PKP PLK. */
(() => {
  'use strict';
  const API = 'https://dojazdy-pg-api.sebamolin.workers.dev';
  const ST = {stg:'8607',tcz:'7112',wrz:'7534'};
  const CACHE_PREFIX='dojazdy-pg-auto-v1:';
  let requestSerial=0;
  const pad=n=>String(n).padStart(2,'0');
  const clock=n=>pad(Math.floor(n/60)%24)+':'+pad(n%60);
  const minutes=s=>/^[0-2]\d:[0-5]\d$/.test(String(s||''))?Number(s.slice(0,2))*60+Number(s.slice(3)):null;
  const dateOnly=v=>String(v||'').slice(0,10);
  function dayOffset(date,days){
    const dt=new Date(date+'T12:00:00Z');
    dt.setUTCDate(dt.getUTCDate()+days);
    return dt.toISOString().slice(0,10);
  }
  function time(v){
    if(v===undefined||v===null||v==='')return null;
    const s=String(v);
    const iso=s.match(/^\d{4}-\d\d-\d\dT(\d\d):(\d\d)/);
    if(iso)return Number(iso[1])*60+Number(iso[2]);
    const m=s.match(/^(\d{1,2}):(\d\d)(?::\d\d)?$/);
    if(m)return Number(m[1])*60+Number(m[2]);
    const duration=s.match(/^P(?:\d+D)?T(?:(\d+)H)?(?:(\d+)M)?/);
    if(duration)return Number(duration[1]||0)*60+Number(duration[2]||0);
    return null;
  }
  const value=(s,arrival)=>arrival ? (s.arrivalTime??s.plannedArrivalTime??s.plannedArrival??null) : (s.departureTime??s.plannedDepartureTime??s.plannedDeparture??null);
  function operatingOn(route,date){
    const days=route.operatingDates;
    return !Array.isArray(days)||days.length===0||days.includes(date);
  }
  function eventOn(route,stop,date,arriving){
    const day=Number(stop[arriving?'arrivalDay':'departureDay']||0);
    const raw=value(stop,arriving);
    const eventDate=typeof raw==='string' && /^\d{4}-/.test(raw) ? dateOnly(raw) : dayOffset(date,day);
    return eventDate===date;
  }
  function plat(stop,date,arriving){
    const variants=Array.isArray(stop.platformVariants)?stop.platformVariants:[];
    const match=variants.find(v=>Array.isArray(v.operatingDates)&&v.operatingDates.includes(date));
    const obj=match||stop;
    const p=obj[arriving?'arrivalPlatform':'departurePlatform'];
    const track=obj[arriving?'arrivalTrack':'departureTrack'];
    return [p,track].filter(x=>x!==null&&x!==undefined&&String(x).trim()).join('/');
  }
  // The monthly-ticket view is restricted to POLREGIO (formerly Przewozy
  // Regionalne). Never infer operator solely from a train number.
  // Some PLK schedule versions omit the operator but retain the commercial
  // REG category; in that case include only REG-class services, not IC/SKM.
  function namedValues(obj,keys){
    if(!obj||typeof obj!=='object')return [];
    const found=[];
    for(const key of keys){
      const raw=obj[key];
      if(raw===undefined||raw===null)continue;
      if(typeof raw==='object'){
        for(const sub of ['code','symbol','name','shortName','id']){
          if(typeof raw[sub]==='string')found.push(raw[sub]);
        }
      }else if(typeof raw==='string')found.push(raw);
    }
    return found.map(v=>String(v).trim().toUpperCase()).filter(Boolean);
  }
  function isPolregioRoute(route){
    const carrierFields=['carrierCode','carrierName','carrierSymbol','carrierShortName','carrier',
      'operatorCode','operatorName','operator','railwayUndertaking','railwayUndertakingCode',
      'railwayUndertakingName','trainOperator','commercialCarrier','commercialCarrierCode'];
    const carriers=namedValues(route,carrierFields);
    // A recognized operator identity is more reliable than the service category.
    if(carriers.length){
      return carriers.some(v=>/^(PR|POLREGIO|PRZEWOZY REGIONALNE)$/.test(v)||
        v.includes('POLREGIO')||v.includes('PRZEWOZY REGIONALNE'));
    }
    const catFields=['commercialCategorySymbol','commercialCategory','category','categorySymbol',
      'trainCategory','trainCategorySymbol','departureCommercialCategory','arrivalCommercialCategory'];
    const categories=[...namedValues(route,catFields)];
    for(const s of Array.isArray(route.stations)?route.stations:[]){
      categories.push(...namedValues(s,catFields));
    }
    return categories.some(v=>/^(REG|R|RP|PR)$/.test(v));
  }
  function extractTrains(payload,date){
    const trains=[];
    for(const route of Array.isArray(payload?.routes)?payload.routes:[]){
      if(!operatingOn(route,date)||!isPolregioRoute(route))continue;
      const stations=Array.isArray(route.stations)?route.stations:[];
      // Do not re-sort: the station list is ordered along the service's route.
      const stops=stations.map((s,i)=>{
        const arr=time(value(s,true)),dep=time(value(s,false));
        return {i,id:String(s.stationId||''),arr,dep,
          arrDate:eventOn(route,s,date,true),depDate:eventOn(route,s,date,false),
          platform:plat(s,date,false),
          number:String(s.departureTrainNumber||s.arrivalTrainNumber||route.nationalNumber||route.trainNumber||'').trim()
        };
      });
      const id=String(route.scheduleId||'')+':'+String(route.orderId||'')+':'+date;
      trains.push({id,stops,number:String(route.nationalNumber||route.trainNumber||'').trim()});
    }
    return trains;
  }
  function legs(trains,from,to,date){
    const out=[];
    for(const train of trains){
      const stops=train.stops;
      for(let i=0;i<stops.length;i++){
        const a=stops[i];
        if(a.id!==from||a.dep===null||!a.depDate)continue;
        for(let j=i+1;j<stops.length;j++){
          const b=stops[j];
          if(b.id!==to||b.arr===null||!b.arrDate)continue;
          let arrival=b.arr;
          if(arrival<a.dep)arrival+=1440; // next-day trips do not fit the commute window
          if(arrival-a.dep<=0||arrival-a.dep>240)continue;
          out.push({id:train.id+':'+i+':'+j,trainId:train.id,from,to,
            dep:a.dep,arr:arrival,
            number:a.number||train.number||'',
            platform:a.platform});
          break;
        }
      }
    }
    return out;
  }
  function uniqueLegs(legs){
    const map=new Map();
    for(const x of legs){
      const key=x.from+'|'+x.to+'|'+x.dep+'|'+x.arr+'|'+x.number;
      const prev=map.get(key);
      if(!prev||(!prev.platform&&x.platform))map.set(key,x);
    }
    return [...map.values()].sort((a,b)=>a.dep-b.dep);
  }
  function busTimes(direction,date){
    const day=new Date(date+'T12:00:00Z').getUTCDay();
    const category=day===0?'holiday':day===6?'saturday':'weekday';
    const entries=(MZK12[direction][category]||'').trim().split(/\s+/);
    return entries.filter(x=>direction!=='to'||!x.endsWith('z'))
      .map(x=>({dep:minutes(x.slice(0,5)),tag:x.slice(5)}))
      .filter(x=>x.dep!==null);
  }
  function morningCandidate(first,second,buses,minimumBusBuffer=2){
    // Always anchor a morning journey to the limited Starogard departures.
    const candidates=buses.filter(b=>b.dep+14<=first.dep-minimumBusBuffer);
    if(!candidates.length)return null;
    const bus=candidates[candidates.length-1],stgArrival=bus.dep+14;
    const wrz=second?second.arr:first.arr;
    const home=bus.dep-5,pg=wrz+25;
    if(home<4*60||home>12*60||wrz>15*60)return null;
    const direct=!second;
    const t=[clock(home),clock(bus.dep),clock(stgArrival),clock(first.dep),
      second?clock(first.arr):'',second?clock(second.dep):'',clock(wrz),clock(pg),
      first.number,second?second.number:'',second?second.platform:first.platform,first.platform];
    return {id:'auto-M-'+first.id+(second?'-'+second.id:'')+'-bus-'+bus.dep,d:'M',t,auto:true,direct,
      anchors:[first.id,second?.id||''],source:'PKP PLK',
      uncertainBus:bus.tag==='s',busBuffer:first.dep-stgArrival};
  }
  function returnCandidate(first,second,buses,minimumBusBuffer=2){
    const end=second||first;
    const candidates=buses.filter(b=>b.dep>=end.arr+minimumBusBuffer);
    if(!candidates.length)return null;
    const bus=candidates[0],home=bus.dep+14+3,pg=first.dep-25;
    if(pg<13*60)return null;
    const t=[clock(pg),clock(first.dep),second?clock(first.arr):'',
      second?clock(second.dep):'',clock(end.arr),clock(bus.dep),clock(home),
      first.number,second?second.number:'',first.platform,second?second.platform:''];
    return {id:'auto-R-'+first.id+(second?'-'+second.id:'')+'-bus-'+bus.dep,d:'R',t,auto:true,direct:!second,
      anchors:[first.id,second?.id||''],source:'PKP PLK',busBuffer:bus.dep-end.arr};
  }
  function generate(payload,date){
    const trains=extractTrains(payload,date);
    const sw=uniqueLegs(legs(trains,ST.stg,ST.wrz,date));
    const st=uniqueLegs(legs(trains,ST.stg,ST.tcz,date));
    const tw=uniqueLegs(legs(trains,ST.tcz,ST.wrz,date));
    const ws=uniqueLegs(legs(trains,ST.wrz,ST.stg,date));
    const wt=uniqueLegs(legs(trains,ST.wrz,ST.tcz,date));
    const ts=uniqueLegs(legs(trains,ST.tcz,ST.stg,date));
    const going=[],back=[];
    const outboundBus=busTimes('to',date),returnBus=busTimes('back',date);
    // Generate all physically feasible transfers; time and risk settings are presentation filters.
    for(const direct of sw){
      for(const margin of [2,5]){
        const r=morningCandidate(direct,null,outboundBus,margin);
        if(r)going.push(r);
      }
    }
    for(const leg of st){
      // Same physical service continuing to Wrzeszcz is already a direct journey.
      if(sw.some(d=>d.trainId===leg.trainId&&d.dep===leg.dep))continue;
      const possible=tw.filter(next=>next.dep>=leg.arr+5&&next.dep-leg.arr<=120);
      // Keep all reasonable alternatives, including 5-minute transfers; do not lose
      // other options when the user changes a threshold on the screen.
      possible.sort((a,b)=>a.arr-b.arr);
      for(const connection of possible.slice(0,5)){
        for(const margin of [2,5]){
          const r=morningCandidate(leg,connection,outboundBus,margin);
          if(r)going.push(r);
        }
      }
    }
    for(const direct of ws){
      for(const margin of [2,5]){
        const r=returnCandidate(direct,null,returnBus,margin);
        if(r)back.push(r);
      }
    }
    for(const leg of ts){
      if(ws.some(d=>d.trainId===leg.trainId&&d.arr===leg.arr))continue;
      const possible=wt.filter(prev=>prev.arr<=leg.dep-5&&leg.dep-prev.arr<=120);
      // Latest possible departure from the university, after respecting transfer buffer.
      possible.sort((a,b)=>b.dep-a.dep);
      for(const connection of possible.slice(0,5)){
        for(const margin of [2,5]){
          const r=returnCandidate(connection,leg,returnBus,margin);
          if(r)back.push(r);
        }
      }
    }
    const unique=new Map();
    for(const r of [...going,...back]){
      const key=r.d+'|'+r.t[1]+'|'+r.t[3]+'|'+(r.d==='M'?r.t[6]:r.t[4])+'|'+(r.d==='R'?r.t[5]:'');
      const old=unique.get(key);
      if(!old||r.t[0]>old.t[0])unique.set(key,r);
    }
    const data=[...unique.values()].sort((a,b)=>a.d.localeCompare(b.d)||a.t[0].localeCompare(b.t[0]));
    const morningServices=new Set(data.filter(r=>r.d==='M').map(r=>r.anchors[0])).size;
    const returnServices=new Set(data.filter(r=>r.d==='R').map(r=>r.anchors[1]||r.anchors[0])).size;
    return {routes:data,summary:{scheduleTrains:trains.length,starogardOutbound:morningServices,
      starogardInbound:returnServices,morning:morningServices,returns:returnServices,
      directMorning:sw.length,directReturn:ws.length}};
  }
  function status(message,state=''){
    const el=document.getElementById('autoStatus');
    if(el){el.textContent=message;el.dataset.state=state;}
  }
  async function load(force=false){
    const input=document.getElementById('travelDate');
    const date=input?.value;
    if(!/^\d{4}-\d\d-\d\d$/.test(date||''))return;
    const seq=++requestSerial,cacheKey=CACHE_PREFIX+date;
    if(!force){
      try{
        const cached=JSON.parse(localStorage.getItem(cacheKey)||'null');
        if(cached?.payload){
          window.autoRoutes=generate(cached.payload,date).routes;
          status('Zapisany rozkład POLREGIO / REG · '+date+' (dane offline)','cached');
          render();
        }
      }catch(e){}
    }
    const button=document.getElementById('autoRefresh');
    if(button)button.disabled=true;
    status('Pobieranie planowego rozkładu PKP PLK…','loading');
    try{
      const response=await fetch(API+'/schedules?date='+encodeURIComponent(date)+'&stations=8607,7112,7534',
        {cache:force?'reload':'default'});
      if(!response.ok)throw new Error('HTTP '+response.status);
      const payload=await response.json();
      if(seq!==requestSerial)return;
      if(!Array.isArray(payload?.routes))throw new Error('Brak listy tras w odpowiedzi PLK');
      const result=generate(payload,date);
      window.autoRoutes=result.routes;
      try{localStorage.setItem(cacheKey,JSON.stringify({payload,created:new Date().toISOString()}));}catch(e){}
      status('PKP PLK · POLREGIO / REG · '+date+': '+result.summary.morning+
        ' kursów do Gdańska, '+result.summary.returns+
        ' kursów do Starogardu. Wybieramy tylko pierwszy wariant na każdy kurs.','success');
      render();
    }catch(err){
      if(seq!==requestSerial)return;
      if(window.autoRoutes?.length)status('Nie udało się odświeżyć: używam ostatniego zapisanego rozkładu.','cached');
      else{window.autoRoutes=null;status('Brak rozkładu online ('+err.message+'). Pokazuję zapisane warianty offline.','error');render()}
    }finally{if(button)button.disabled=false}
  }
  window.PGAuto={generate,load,extractTrains,legs,busTimes,isPolregioRoute};
  document.getElementById('autoRefresh')?.addEventListener('click',()=>load(true));
  document.getElementById('travelDate')?.addEventListener('change',()=>{window.autoRoutes=null;render();load()});
  load();
})();
