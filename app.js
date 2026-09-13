const API_BASE="https://yandex-sync-backend.onrender.com";
const urlParams=new URLSearchParams(location.search);
let roomId=urlParams.get("room");
if(!roomId)
{
  roomId=Math.random().toString(36).slice(2,8).toUpperCase();
  history.replaceState(
  {
  }
  ,"",`?room=${roomId}`)
}
const WS_URL=API_BASE.replace("https://","wss://").replace("http://","ws://")+`/ws/${roomId}`;
const $=id=>document.getElementById(id);
const esc=s=>String(s??"").replace(/[&<>"]/g,m=>(
{
  "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"
}
[m]));
let ws=null,reconnectAttempts=0,reconnectTimer=null,isSyncing=false,isSeeking=false,seekPointerId=null,lastServerTime=0,lastServerAt=0;
let localQueue=[],localCurrentIndex=-1,currentTrack=null,repeatMode="off",shuffleMode=false,djMode=false,isOwner=false,participants=[],chatMessages=[],sharedPlaylists=[],selfParticipantId="",intentionalLeave=false,roomHistory=[],selectedQueue=new Set(),replyingTo=null;
const CLIENT_KEY="syncMusicClientToken",NAME_KEY="syncMusicUserName",HISTORY_KEY="syncMusicHistory",PLAYLIST_KEY="syncMusicPlaylists",VOLUME_KEY="syncMusicVolume",MUTED_KEY="syncMusicMuted",AVATAR_KEY="syncMusicAvatar",THEME_KEY="syncMusicTheme";
const clientToken=localStorage.getItem(CLIENT_KEY)||crypto.randomUUID();
localStorage.setItem(CLIENT_KEY,clientToken);
function name()
{
  return localStorage.getItem(NAME_KEY)||""
}
function initials(s)
{
  return (s||"G").trim().split(/\s+/).slice(0,2).map(x=>x[0]).join("").toUpperCase()||"G"
}
function toast(t)
{
  const e=$("toast");
  e.textContent=t;
  e.classList.add("show");
  clearTimeout(e._t);
  e._t=setTimeout(()=>e.classList.remove("show"),2200)
}
function status(kind,text)
{
  const e=$("statusBadge");
  e.className=`status-badge ${kind}`;
  e.textContent=`● ${text}`;
  $("connectionText").textContent=text;
  document.querySelector(".live-dot").style.background=kind==="connected"?"#63e89a":kind==="reconnecting"?"#f0a53b":"#ff6572"
}
function send(msg)
{
  if(ws?.readyState===WebSocket.OPEN)ws.send(JSON.stringify(
  {
    ...msg,sender:clientToken,name:name().slice(0,24)
  }
  ))
}
function connect()
{
  if(ws?.readyState===WebSocket.OPEN||ws?.readyState===WebSocket.CONNECTING)return;
  status("reconnecting","Подключение");
  ws=new WebSocket(WS_URL);
  ws.onopen=()=>
  {
    reconnectAttempts=0;
    status("connected","Подключено");
    send(
    {
      type:"hello",token:clientToken,name:name().slice(0,24),avatar:getAvatar()
    }
    );
    clearTimeout(reconnectTimer);
    reconnectTimer=null
  }
  ;
  ws.onclose=()=>
  {
    if(intentionalLeave)
    {
      status("disconnected","Вы вышли");
      return;
    }
    status("reconnecting","Переподключение");
    if(!reconnectTimer)
    {
      const d=Math.min(15000,1000*Math.pow(1.6,reconnectAttempts++));
      reconnectTimer=setTimeout(()=>
      {
        reconnectTimer=null;
        connect()
      }
      ,d)
    }
  }
  ;
  ws.onerror=()=>status("disconnected","Ошибка");
  ws.onmessage=e=>
  {
    try
    {
      handleMessage(JSON.parse(e.data))
    }
    catch(err)
    {
      console.error(err)
    }
  }
}
function handleMessage(m)
{
  if(m.type==="full_state")
  {
    localQueue=m.queue||[];
    localCurrentIndex=m.current_index??-1;
    repeatMode=m.repeat_mode||"off";
    shuffleMode=!!m.shuffle;
    djMode=!!m.dj_mode;
    isOwner=!!m.is_owner;
    participants=m.participants||[];
    selfParticipantId=m.self_id||selfParticipantId;
    sharedPlaylists=m.shared_playlists||[];
    roomHistory=m.room_history||[];
    intentionalLeave=false;
    lastServerTime=Number(m.current_time)||0;
    lastServerAt=performance.now();
    renderAll();
    if(m.track)applyTrack(m.track,m.index,m.current_time,m.is_playing,false);
    else renderNowPlaying();
    return
  }
  if(m.type==="queue_update")
  {
    localQueue=m.queue||[];
    localCurrentIndex=m.current_index??-1;
    renderQueue();
    return
  }
  if(m.type==="room_settings")
  {
    repeatMode=m.repeat_mode||"off";
    shuffleMode=!!m.shuffle;
    djMode=!!m.dj_mode;
    isOwner=!!m.is_owner;
    renderModes();
    renderParticipants();
    return
  }
  if(m.type==="participant_update")
  {
    participants=m.participants||[];
    renderParticipants();
    renderSharedMemberModal();
    return
  }
  if(m.type==="shared_playlists")
  {
    sharedPlaylists=m.playlists||[];
    renderPlaylists();
    renderSharedMemberModal();
    if(editingSharedPlaylistId && $("sharedMembersModal").hidden && sharedPlaylists.some(p=>String(p.id)===String(editingSharedPlaylistId)))
    {
      openSharedMembers(editingSharedPlaylistId);
    }
    return
  }
  if(m.type==="left_room")
  {
    intentionalLeave=true;
    status("disconnected","Вы вышли");
    toast("Ты вышел из комнаты");
    return;
  }
  if(m.type==="kicked")
  {
    intentionalLeave=true;
    status("disconnected","Удалён из комнаты");
    toast(m.text||"Ты удалён из комнаты");
    try { ws?.close(); } catch {}
    return;
  }
  if(m.type==="play_track")
  {
    localCurrentIndex=m.index??localCurrentIndex;
    applyTrack(m.track,m.index,m.time||0,true,true);
    return
  }
  if(m.type==="play")
  {
    syncRemote(m.time,true);
    return
  }
  if(m.type==="pause")
  {
    syncRemote(m.time,false);
    return
  }
  if(m.type==="seek")
  {
    syncRemote(m.time,undefined);
    return
  }
  if(m.type==="chat_message")
  {
    chatMessages.push(m.message);
    if(chatMessages.length>100)chatMessages.shift();
    renderChat();
    return
  }
  if(m.type==="system_message")
  {
    chatMessages.push(
    {
      system:true,text:m.text,time:m.time
    }
    );
    if(chatMessages.length>100)chatMessages.shift();
    renderChat();
    return
  }
  if(m.type==="reaction")
  {
    toast(`${m.name||"Участник"} ${m.reaction}`);
    return
  }
  if(m.type==="proposal_update")
  {
    renderProposals(m.proposals||[]);
    return
  }
}
function syncRemote(t,playing)
{
  const a=$("audio");
  isSyncing=true;
  lastServerTime=Math.max(0,Number(t)||0);
  lastServerAt=performance.now();
  if(Number.isFinite(lastServerTime)&&Math.abs(a.currentTime-lastServerTime)>.45)a.currentTime=lastServerTime;
  if(playing===true)a.play().catch(()=>
  {
  }
  );
  if(playing===false)a.pause();
  setTimeout(()=>isSyncing=false,80)
}
function applyTrack(track,index,time,playing,fromRemote)
{
  currentTrack=
  {
    ...track
  }
  ;
  $("audio").src=track.url||"";
  isSyncing=true;
  $("audio").currentTime=Math.max(0,Number(time)||0);
  lastServerTime=$("audio").currentTime;
  lastServerAt=performance.now();
  renderNowPlaying();
  renderQueue();
  renderMini();
  setDynamicColor(track.cover);
  if(playing)
  {
    const p=$("audio").play();
    p?.catch(()=>
    {
    }
    ).finally?.(()=>setTimeout(()=>isSyncing=false,100))
  }
  else setTimeout(()=>isSyncing=false,80);
  if(fromRemote||playing)addHistory(track)
}
function renderNowPlaying()
{
  const t=currentTrack;
  $("nowTitle").textContent=t?.title||"Ничего не играет";
  $("nowArtist").textContent=t?.artist||"Добавьте первый трек через поиск";
  $("nowAlbum").textContent=t?.album?`Альбом · ${t.album}`:"";
  if ($("nowDuration")) $("nowDuration").textContent=formatTime(t?.duration||duration());
  const imgs=[$("heroCover"),$("fullCover"),$("miniCover")];
  imgs.forEach(i=>
  {
    if(t?.cover)
    {
      i.src=t.cover;
      i.style.display="block"
    }
    else
    {
      i.removeAttribute("src");
      i.style.display="none"
    }
  }
  );
  $("fullTitle").textContent=t?.title||"—";
  $("fullArtist").textContent=t?.artist||"—";
  updateLike();
  renderMini()
}
function renderMini()
{
  const m=$("miniPlayer");
  if(!currentTrack)
  {
    m.hidden=true;
    return
  }
  m.hidden=false;
  $("miniTitle").textContent=currentTrack.title;
  $("miniArtist").textContent=currentTrack.artist;
  $("miniCover").src=currentTrack.cover||""
}
function updateLike()
{
  const liked=!!(currentTrack&&getLibrary().some(x=>String(x.id)===String(currentTrack.id)));

  ["likeCurrentBtn","fullLike"].forEach(id=>
  {
    const button=$(id);
    if(!button)return;
    button.textContent=liked?"♥":"♡";
    button.classList.toggle("liked",liked);
    button.setAttribute("aria-label",liked?"Удалить из библиотеки":"Добавить в библиотеку");
  });
}
function setDynamicColor(url)
{
  if(!url)return;
  const img=new Image();
  img.crossOrigin="anonymous";
  img.onload=()=>
  {
    try
    {
      const c=document.createElement("canvas"),x=c.getContext("2d");
      c.width=24;
      c.height=24;
      x.drawImage(img,0,0,24,24);
      const d=x.getImageData(0,0,24,24).data;
      let r=0,g=0,b=0,n=0;
      for(let i=0;
      i<d.length;
      i+=4)
      {
        if(d[i]+d[i+1]+d[i+2]<80)continue;
        r+=d[i];
        g+=d[i+1];
        b+=d[i+2];
        n++
      }
      if(n)
      {
        r=Math.round(r/n);
        g=Math.round(g/n);
        b=Math.round(b/n);
        const c1=`rgb(${r},${g},${b})`,c2=`rgb(${Math.min(255,r+35)},${Math.min(255,g+20)},${Math.min(255,b+45)})`;
        document.documentElement.style.setProperty("--accent",c1);
        document.documentElement.style.setProperty("--accent-2",c2);
        document.documentElement.style.setProperty("--accent-3",`rgb(${b},${r},${g})`);
        $("fullscreenBg").style.background=`radial-gradient(circle at 50% 25%,${c1},transparent 34%)`
      }
    }
    catch
    {
    }
  }
  ;
  img.src=url
}
function formatTime(v)
{
  v=Number(v);
  if(!Number.isFinite(v)||v<0)return "0:00";
  const total=Math.floor(v);
  const hours=Math.floor(total/3600);
  const minutes=Math.floor((total%3600)/60);
  const seconds=total%60;
  if(hours>0)return `${hours}:${String(minutes).padStart(2,"0")}:${String(seconds).padStart(2,"0")}`;
  return `${minutes}:${String(seconds).padStart(2,"0")}`;
}
function duration()
{
  return $("audio").duration||currentTrack?.duration||0
}
function updateProgress()
{
  const a=$("audio"),d=duration(),t=a.currentTime||0,p=d?Math.max(0,Math.min(1,t/d)):0;
  if(!isSeeking)
  {
    $("progressBar").style.width=`${p*100}%`;
    $("fullProgressBar").style.width=`${p*100}%`
  }
  $ ("currentTime");
  $("currentTime").textContent=formatTime(t);
  $("remainingTime").textContent=`−${formatTime(Math.max(0,d-t))}`;
  $("totalTime").textContent=formatTime(d);
  $("fullCurrent").textContent=formatTime(t);
  $("fullRemaining").textContent=`−${formatTime(Math.max(0,d-t))}`;
  $("progressContainer").setAttribute("aria-valuenow",String(Math.round(p*100)));
  $("miniProgress").style.width=`${p*100}%`;
  if(!isSeeking)
  {
    $("progressBar").style.width=`${p*100}%`;
    $("fullProgressBar").style.width=`${p*100}%`
  }
}
// Fix accidental helper typo safely.
const __progressAlias=true;
function seekAt(container,x)
{
  const a=$("audio"),d=duration();
  if(!d)return;
  const r=container.getBoundingClientRect();
  const p=Math.max(0,Math.min(1,(x-r.left)/r.width));
  a.currentTime=p*d;
  lastServerTime=a.currentTime;
  lastServerAt=performance.now();
  updateProgress();
  return a.currentTime
}
function setupSeek(el)
{
  el.addEventListener("pointerdown",e=>
  {
    if(e.pointerType==="mouse"&&e.button!==0)return;
    if(!duration())return;
    isSeeking=true;
    seekPointerId=e.pointerId;
    el.setPointerCapture?.(e.pointerId);
    seekAt(el,e.clientX);
    e.preventDefault()
  }
  );
  el.addEventListener("pointermove",e=>
  {
    if(isSeeking&&e.pointerId===seekPointerId)
    {
      seekAt(el,e.clientX);
      e.preventDefault()
    }
  }
  );
  const end=e=>
  {
    if(!isSeeking||e.pointerId!==seekPointerId)return;
    const t=seekAt(el,e.clientX);
    isSeeking=false;
    seekPointerId=null;
    if(typeof t==="number")send(
    {
      type:"seek",time:t
    }
    )
  }
  ;
  el.addEventListener("pointerup",end);
  el.addEventListener("pointercancel",end);
  el.addEventListener("keydown",e=>
  {
    if(!duration())return;
    const step=5;
    if(e.key==="ArrowRight")
    {
      e.preventDefault();
      const t=Math.min(duration(),$("audio").currentTime+step);
      $("audio").currentTime=t;
      send(
      {
        type:"seek",time:t
      }
      )
    }
    if(e.key==="ArrowLeft")
    {
      e.preventDefault();
      const t=Math.max(0,$("audio").currentTime-step);
      $("audio").currentTime=t;
      send(
      {
        type:"seek",time:t
      }
      )
    }
  }
  )
}
function isTrackInQueue(track)
{
  if(!track?.id)return false;
  return localQueue.some(item=>String(item.id)===String(track.id));
}

function renderQueue()
{
  const c=$("queue");
  const preview=$("queuePreview");

  $("queueCount").textContent=localQueue.length;

  if(!localQueue.length)
  {
    c.innerHTML='<div class="empty"><strong>Очередь пока пуста</strong>Ищите музыку сверху и добавляйте её в комнату.</div>';
    preview.innerHTML='<div class="empty">Добавьте первый трек через поиск.</div>';
    return;
  }

  c.innerHTML="";
  preview.innerHTML="";

  localQueue.forEach((track,index)=>
  {
    // Полная строка очереди: лайк, плейлист, удаление и перетаскивание.
    c.appendChild(trackElement(track,index,true,false));

    // Компактная строка в блоке "Следующие треки".
    if(index!==localCurrentIndex && preview.children.length<4)
    {
      preview.appendChild(trackElement(track,index,true,true));
    }
  });
}

function trackElement(t,i,full=true,compact=false)
{
  const d=document.createElement("div");
  const queueItem=full && i>=0 && i<localQueue.length && String(localQueue[i]?.id)===String(t?.id);

  d.className="track"+(queueItem&&i===localCurrentIndex?" current":"");
  d.dataset.index=queueItem?String(i):"";
  d.dataset.trackId=String(t?.id??"");

  if(queueItem)
  {
    d.draggable=true;
    d.classList.add("queue-track");
  }

  const cover=t.cover
    ? `<img class="track-cover" src="${esc(t.cover)}" alt="" loading="lazy">`
    : '<div class="track-cover"></div>';

  const addedBy=queueItem && t.added_by
    ? `<div class="track-added-by">Добавил: ${esc(t.added_by)}</div>`
    : "";

  const durationText=formatTime(t.duration||0);

  d.innerHTML=`
    ${queueItem ? '<span class="drag-handle" title="Перетащить трек" aria-label="Перетащить трек">⋮⋮</span>' : ''}
    ${cover}
    <div class="track-info">
      <div class="track-title">${queueItem&&i===localCurrentIndex?'♫ ':''}${esc(t.title)}</div>
      <div class="track-artist">${esc(t.artist||"Unknown")}</div>
      ${addedBy}
    </div>
    <div class="track-meta" title="Длительность">${durationText}</div>
    <div class="track-actions"></div>
  `;

  const actions=d.querySelector(".track-actions");
  const alreadyInQueue=isTrackInQueue(t);

  // Для любой обычной строки доступны лайк и добавление в плейлист.
  // В самой очереди вместо "+" показываем только удаление.
  if(!compact)
  {
    const like=document.createElement("button");
    const liked=getLibrary().some(x=>String(x.id)===String(t.id));
    like.textContent=liked?"♥":"♡";
    like.className=liked?"liked":"";
    like.title=liked?"Убрать из библиотеки":"Добавить в библиотеку";
    like.setAttribute("aria-label",like.title);
    like.onclick=e=>
    {
      e.stopPropagation();
      toggleLibrary(t);
    };
    actions.appendChild(like);

    const playlist=document.createElement("button");
    playlist.textContent="▣";
    playlist.title="Добавить в плейлист";
    playlist.setAttribute("aria-label",playlist.title);
    playlist.onclick=e=>
    {
      e.stopPropagation();
      openPlaylistPicker(t);
    };
    actions.appendChild(playlist);

    if(queueItem)
    {
      const remove=document.createElement("button");
      remove.textContent="×";
      remove.title="Удалить из очереди";
      remove.setAttribute("aria-label",remove.title);
      remove.className="remove-track";
      remove.onclick=e=>
      {
        e.stopPropagation();
        removeQueueItem(i);
      };
      actions.appendChild(remove);
    }
    else if(!alreadyInQueue)
    {
      const add=document.createElement("button");
      add.textContent="＋";
      add.title="Добавить в очередь";
      add.setAttribute("aria-label",add.title);
      add.onclick=e=>
      {
        e.stopPropagation();
        addToQueue(t);
      };
      actions.appendChild(add);
    }
    else
    {
      const queued=document.createElement("span");
      queued.className="queue-status";
      queued.textContent="В очереди";
      queued.title="Этот трек уже находится в очереди";
      actions.appendChild(queued);
    }
  }

  d.addEventListener("click",e=>
  {
    if(e.target.closest("button,.track-actions,.drag-handle"))return;

    if(queueItem)
    {
      if(i===localCurrentIndex)return;
      send({type:"play_track_manual",index:i});
    }
  });

  if(queueItem)
  {
    enableQueueDrag(d,i);
    enableSwipe(d,i);
  }

  return d;
}

function removeQueueItem(index)
{
  if(!Number.isInteger(index)||index<0||index>=localQueue.length)return;
  send({type:"remove_from_queue",index});
}

let draggedQueueIndex=null;

function enableQueueDrag(el,index)
{
  el.addEventListener("dragstart",event=>
  {
    draggedQueueIndex=index;
    el.classList.add("dragging");
    if(event.dataTransfer)
    {
      event.dataTransfer.effectAllowed="move";
      event.dataTransfer.setData("text/plain",String(index));
    }
  });

  el.addEventListener("dragover",event=>
  {
    event.preventDefault();
    if(draggedQueueIndex===null || draggedQueueIndex===index)return;
    if(event.dataTransfer)event.dataTransfer.dropEffect="move";
    document.querySelectorAll(".queue-track.drag-over").forEach(row=>row.classList.remove("drag-over"));
    el.classList.add("drag-over");
  });

  el.addEventListener("drop",event=>
  {
    event.preventDefault();
    const from=draggedQueueIndex;
    const to=index;
    document.querySelectorAll(".queue-track.drag-over").forEach(row=>row.classList.remove("drag-over"));

    if(Number.isInteger(from) && Number.isInteger(to) && from!==to)
    {
      send({type:"reorder_queue",from,to});
    }
  });

  el.addEventListener("dragend",()=>
  {
    draggedQueueIndex=null;
    el.classList.remove("dragging","drag-over");
    document.querySelectorAll(".queue-track.drag-over").forEach(row=>row.classList.remove("drag-over"));
  });
}

function enableSwipe(el,index)
{
  let startX=0,startY=0,lastY=0,mode="",targetIndex=index,moved=false;
  const reset=()=>{startX=0;startY=0;lastY=0;mode="";targetIndex=index;moved=false;el.classList.remove("touch-dragging");document.querySelectorAll(".queue-track.touch-over").forEach(x=>x.classList.remove("touch-over"));};
  el.addEventListener("touchstart",event=>{
    if(event.touches.length!==1)return;
    if(event.target.closest("button"))return;
    startX=event.touches[0].clientX;
    startY=event.touches[0].clientY;
    lastY=startY;
    mode=event.target.closest(".drag-handle")?"drag":"swipe";
    moved=false;
    if(mode==="drag")el.classList.add("touch-dragging");
  },{passive:true});
  el.addEventListener("touchmove",event=>{
    if(!startX||event.touches.length!==1)return;
    const x=event.touches[0].clientX,y=event.touches[0].clientY;
    const dx=x-startX,dy=y-startY;
    if(mode==="swipe")
    {
      if(Math.abs(dy)>Math.abs(dx)+8){reset();return;}
      if(Math.abs(dx)>8)moved=true;
      return;
    }
    if(mode!=="drag")return;
    if(Math.abs(dy)>8)moved=true;
    lastY=y;
    const row=document.elementFromPoint(x,y)?.closest(".queue-track");
    if(row){
      const n=Number(row.dataset.index);
      if(Number.isInteger(n)){
        targetIndex=n;
        document.querySelectorAll(".queue-track.touch-over").forEach(q=>q.classList.remove("touch-over"));
        if(n!==index)row.classList.add("touch-over");
      }
    }
  },{passive:true});
  el.addEventListener("touchend",event=>{
    if(!startX)return;
    const dx=event.changedTouches[0].clientX-startX;
    const dy=event.changedTouches[0].clientY-startY;
    if(mode==="drag" && moved && Number.isInteger(targetIndex) && targetIndex!==index)
    {
      send({type:"reorder_queue",from:index,to:targetIndex});
      reset();
      return;
    }
    if(mode==="swipe" && moved && Math.abs(dx)>=55 && Math.abs(dx)>Math.abs(dy))
    {
      if(dx<0 && confirm("Удалить этот трек из очереди?"))removeQueueItem(index);
    }
    reset();
  },{passive:true});
}

function addToQueue(t)
{
  if(!t?.id)return;

  if(isTrackInQueue(t))
  {
    toast("Этот трек уже в очереди");
    return;
  }

  if(!name())
  {
    openName();
    toast("Сначала укажи имя");
    return;
  }

  send({
    type:"add_to_queue",
    track_id:String(t.id),
    title:t.title,
    artist:t.artist,
    album:t.album||"",
    cover:t.cover||"",
    duration:Number(t.duration)||0,
    added_by:name()
  });

  toast(`＋ ${t.title}`);
}

function searchRender(tracks)
{
  const c=$("searchResults");
  c.innerHTML="";
  if(!tracks.length)
  {
    c.innerHTML='<div class="empty">Ничего не найдено</div>';
    return
  }
  tracks.forEach(t=>
  {
    const d=trackElement(t,0,false,true);
    d.addEventListener("click",()=>addToQueue(t),
    {
      once:true
    }
    );
    c.appendChild(d)
  }
  )
}
let searchTimer=0,searchReq=0;
$("searchInput").addEventListener("input",e=>
{
  const q=e.target.value.trim();
  $("searchClear").hidden=!q;
  clearTimeout(searchTimer);
  if(!q)
  {
    $("searchResults").hidden=true;
    return
  }
  $("searchResults").hidden=false;
  $("searchResults").innerHTML='<div class="empty skeleton">Ищем музыку…</div>';
  searchTimer=setTimeout(async()=>
  {
    const id=++searchReq;
    try
    {
      const r=await fetch(`${API_BASE}/api/search`,
      {
        method:"POST",headers:
        {
          "Content-Type":"application/json"
        }
        ,body:JSON.stringify(
        {
          query:q
        }
        )
      }
      );
      if(!r.ok)throw Error(`HTTP ${r.status}`);
      const data=await r.json();
      if(id===searchReq)searchRender(data.tracks||[])
    }
    catch(err)
    {
      if(id===searchReq)$("searchResults").innerHTML=`<div class="empty">Ошибка поиска: ${esc(err.message)}</div>`
    }
  }
  ,350)
}
);
$("searchInput").addEventListener("keydown",e=>
{
  if(e.key==="Escape")$("searchResults").hidden=true;
  if(e.key==="Enter")
  {
    $("searchResults").hidden=false;
    clearTimeout(searchTimer);
    $("searchInput").dispatchEvent(new Event("input"))
  }
}
);
$("searchClear").onclick=()=>
{
  $("searchInput").value="";
  $("searchInput").dispatchEvent(new Event("input"));
  $("searchInput").focus()
}
;
document.addEventListener("click",e=>
{
  if(!$("searchWrap").contains(e.target))$("searchResults").hidden=true
}
);
document.addEventListener("click",e=>{
  const picker=$("emojiPicker");
  if(picker && !picker.hidden && !picker.contains(e.target) && e.target!==$("emojiBtn"))picker.hidden=true;
});

function getLibrary()
{
  try
  {
    return JSON.parse(localStorage.getItem("syncMusicLibrary")||"[]")
  }
  catch
  {
    return[]
  }
}
function saveLibrary(v)
{
  localStorage.setItem("syncMusicLibrary",JSON.stringify(v))
}
function toggleLibrary(t)
{
  const a=getLibrary(),i=a.findIndex(x=>String(x.id)===String(t.id));
  if(i>=0)
  {
    a.splice(i,1);
    toast("Удалено из библиотеки")
  }
  else
  {
    a.unshift(
    {
      ...t
    }
    );
    toast("♥ Добавлено в библиотеку")
  }
  saveLibrary(a);
  updateLike();
  renderQueue();
  renderLibrary()
}
function getHistory()
{
  try
  {
    return JSON.parse(localStorage.getItem(HISTORY_KEY)||"[]")
  }
  catch
  {
    return[]
  }
}
function addHistory(t)
{
  if(!t?.id)return;
  const h=getHistory().filter(x=>String(x.id)!==String(t.id));
  h.unshift(
  {
    id:String(t.id),title:t.title,artist:t.artist,album:t.album||"",cover:t.cover||"",duration:t.duration||0,started_at:new Date().toISOString()
  }
  );
  localStorage.setItem(HISTORY_KEY,JSON.stringify(h.slice(0,100)));
  renderHistory()
}
function renderLibrary()
{
  const c=$("library"),lib=getLibrary();
  $("libraryCount").textContent=lib.length;
  if(!lib.length)
  {
    c.innerHTML='<div class="empty"><strong>Библиотека пуста</strong>Нажимайте ♡ у треков, которые хотите сохранить.</div>';
    return
  }
  c.innerHTML="";
  lib.forEach(t=>
  {
    const d=trackElement(t,0,false,false);
    d.onclick=()=>addToQueue(t);
    c.appendChild(d)
  }
  )
}
function addAllLibrary()
{
  const lib=getLibrary();
  if(!lib.length)return toast("Библиотека пуста");
  lib.forEach(addToQueue);
  toast(`Добавлено: ${lib.length}`)
}
function renderHistory()
{
  const c=$("history"),h=getHistory();
  if(!h.length)
  {
    c.innerHTML='<div class="empty"><strong>История пуста</strong>Здесь появятся недавно запущенные треки.</div>';
    return
  }
  c.innerHTML="";
  h.forEach(t=>
  {
    const d=trackElement(t,0,false,false);
    d.querySelector(".track-meta").textContent=new Date(t.started_at).toLocaleDateString("ru-RU",
    {
      day:"2-digit",month:"short"
    }
    );
    d.onclick=()=>
    {
      if(isTrackInQueue(t))
      {
        send({type:"play_track_manual_by_id",track_id:String(t.id)});
        return;
      }

      addToQueue(t);
      setTimeout(()=>send({type:"play_track_manual_by_id",track_id:String(t.id)}),250);
    };
    ;
    c.appendChild(d)
  }
  )
}
function getPlaylists()
{
  try
  {
    return JSON.parse(localStorage.getItem(PLAYLIST_KEY)||"[]")
  }
  catch
  {
    return[]
  }
}
function savePlaylists(v)
{
  localStorage.setItem(PLAYLIST_KEY,JSON.stringify(v))
}
let editingPlaylistId=null;
let pendingPlaylistTrack=null;
let editingSharedPlaylistId=null;
let creatingSharedPlaylist=false;
function playlistArt(p)
{
  return p.tracks?.slice(0,4).map(t=>t.cover).filter(Boolean)||[]
}
function renderPlaylists()
{
  const c=$("playlistGrid");
  const local=getPlaylists();
  const all=[...sharedPlaylists.map(p=>({...p,is_shared:true})), ...local.map(p=>({...p,is_shared:false}))];
  if(!all.length)
  {
    c.innerHTML='<div class="empty"><strong>Плейлистов ещё нет</strong>Создайте личный или совместный плейлист.</div>';
    return;
  }
  c.innerHTML="";
  all.forEach(p=>{
    const d=document.createElement("article");
    d.className=`playlist-card${p.is_shared?" shared":""}`;
    const arts=playlistArt(p);
    const memberCount=p.is_shared?(p.member_ids||[]).length:0;
    d.innerHTML=`<div class="playlist-art">${arts.length?arts.slice(0,4).map(u=>`<img src="${esc(u)}" alt="" loading="lazy">`).join(""):"<span></span>"}</div><h3>${esc(p.name)}</h3><p>${p.tracks.length} треков${p.description?` · ${esc(p.description)}`:""}${p.is_shared?` <span class="shared-badge">● Совместный · ${memberCount}</span>`:""}</p><div class="playlist-buttons"><button class="btn btn-primary open-pl">Открыть</button>${p.is_shared?`<button class="btn edit-pl playlist-members-btn">Участники</button>`:`<button class="btn edit-pl">⋯</button>`}</div>`;
    d.querySelector(".open-pl").onclick=()=>p.is_shared?openSharedPlaylist(p.id):openPlaylist(p.id);
    d.querySelector(".edit-pl").onclick=()=>p.is_shared?openSharedMembers(p.id):openPlaylistModal(p.id);
    c.appendChild(d);
  });
}

function openPlaylistModal(id=null, shared=false)
{
  editingPlaylistId=id;
  creatingSharedPlaylist=shared && !id;
  const p=id?getPlaylists().find(x=>x.id===id):null;
  $("playlistModalTitle").textContent=p?"Изменить плейлист":(creatingSharedPlaylist?"Новый совместный плейлист":"Новый плейлист");
  $("playlistNameInput").value=p?.name||"";
  $("playlistDescInput").value=p?.description||"";
  $("playlistModal").hidden=false;
  setTimeout(()=>$("playlistNameInput").focus(),50)
}
$("savePlaylistBtn").onclick=()=>
{
  const n=$("playlistNameInput").value.trim();
  if(!n)return toast("Введите название");
  const desc=$("playlistDescInput").value.trim();
  if(creatingSharedPlaylist)
  {
    const id=crypto.randomUUID();
    send({type:"shared_playlist_create",id,name:n,description:desc,member_ids:[selfParticipantId]});
    $("playlistModal").hidden=true;
    editingSharedPlaylistId=id;
    toast("Совместный плейлист создаётся…");
    setTimeout(()=>{ if(sharedPlaylists.some(p=>String(p.id)===String(id))) { openSharedMembers(id); } },500);
    creatingSharedPlaylist=false;
    return;
  }
  let ps=getPlaylists();
  if(editingPlaylistId)
  {
    const p=ps.find(x=>x.id===editingPlaylistId);
    if(p)
    {
      p.name=n;
      p.description=desc;
    }
  }
  else
  {
    const playlist={id:crypto.randomUUID(),name:n,description:desc,created_at:new Date().toISOString(),tracks:[]};
    if(pendingPlaylistTrack)
    {
      playlist.tracks.push({...pendingPlaylistTrack});
      pendingPlaylistTrack=null;
    }
    ps.unshift(playlist);
  }
  savePlaylists(ps);
  $("playlistModal").hidden=true;
  renderPlaylists();
  toast("Плейлист сохранён");
};

function openPlaylistPicker(track)
{
  pendingPlaylistTrack=track?{...track}:null;
  const local=getPlaylists();
  const shared=sharedPlaylists.filter(currentUserCanEditShared);
  if(!local.length && !shared.length)
  {
    openPlaylistModal();
    toast("Создай плейлист — трек добавится автоматически");
    return;
  }
  const c=$("playlistPickerList");
  c.innerHTML="";
  local.forEach(p=>{
    const b=document.createElement("button");
    b.className="picker-item";
    b.innerHTML=`<span class="picker-art"></span><span><b>${esc(p.name)}</b><small>${p.tracks.length} треков · личный</small></span>`;
    b.onclick=()=>{
      if(!p.tracks.some(x=>String(x.id)===String(track.id)))p.tracks.push({...track});
      savePlaylists(local);
      pendingPlaylistTrack=null;
      $("playlistPicker").hidden=true;
      renderPlaylists();
      toast(`Добавлено в «${p.name}»`);
    };
    c.appendChild(b);
  });
  shared.forEach(p=>{
    const b=document.createElement("button");
    b.className="picker-item";
    const already=p.tracks.some(x=>String(x.id)===String(track.id));
    b.innerHTML=`<span class="picker-art"></span><span><b>${esc(p.name)} <span class="shared-badge">Совместный</span></b><small>${p.tracks.length} треков${already?" · уже добавлен":""}</small></span>`;
    b.disabled=already;
    b.onclick=()=>{
      if(already)return;
      send({type:"shared_playlist_add_track",playlist_id:p.id,track:{...track}});
      pendingPlaylistTrack=null;
      $("playlistPicker").hidden=true;
      toast(`Добавление в «${p.name}» отправлено`);
    };
    c.appendChild(b);
  });
  $("playlistPicker").hidden=false;
}

function openSharedPlaylist(id)
{
  const p=sharedPlaylists.find(x=>String(x.id)===String(id));
  if(!p)return;
  const d=$("playlistDetail");
  d.hidden=false;
  const arts=playlistArt(p);
  const canEdit=currentUserCanEditShared(p);
  d.innerHTML=`<div class="playlist-detail-head"><div class="playlist-art playlist-detail-art">${arts.length?arts.slice(0,4).map(u=>`<img src="${esc(u)}" alt="">`).join(""):""}</div><div><span class="eyebrow">SHARED PLAYLIST</span><h2>${esc(p.name)}</h2><p>${esc(p.description||"")} · ${p.tracks.length} треков · ${p.member_ids?.length||0} участников</p><div class="modal-actions"><button class="btn btn-primary" id="plPlay">▶ Play</button><button class="btn btn-secondary" id="plShuffle">⤨ Shuffle</button><button class="btn btn-secondary" id="plQueue">＋ В очередь</button>${canEdit?`<button class="btn btn-secondary" id="plMembers">Участники</button>`:""}${String(p.owner_id)===String(selfParticipantId)||isOwner?`<button class="btn btn-secondary" id="plDelete">Удалить</button>`:""}</div></div></div><div id="plTracks" class="track-list" style="margin-top:18px"></div>`;
  const tc=$("plTracks");
  p.tracks.forEach(t=>{
    const r=trackElement(t,0,false,false);
    if(canEdit)
    {
      const remove=document.createElement("button");
      remove.textContent="×";
      remove.title="Удалить";
      remove.onclick=()=>send({type:"shared_playlist_remove_track",playlist_id:p.id,track_id:String(t.id)});
      r.querySelector(".track-actions").appendChild(remove);
    }
    tc.appendChild(r);
  });
  $("plPlay").onclick=()=>playPlaylist(p,false);
  $("plShuffle").onclick=()=>playPlaylist(p,true);
  $("plQueue").onclick=()=>queuePlaylist(p);
  $("plMembers")?.addEventListener("click",()=>openSharedMembers(p.id));
  $("plDelete")?.addEventListener("click",()=>{ if(confirm("Удалить совместный плейлист?"))send({type:"shared_playlist_delete",playlist_id:p.id}); });
}

function openPlaylist(id)
{
  const p=getPlaylists().find(x=>x.id===id);
  if(!p)return;
  const d=$("playlistDetail");
  d.hidden=false;
  const arts=playlistArt(p);
  d.innerHTML=`<div class="playlist-detail-head"><div class="playlist-art playlist-detail-art">${arts.length?arts.slice(0,4).map(u=>`<img src="${esc(u)}" alt="">`).join(""):""}</div><div><span class="eyebrow">PLAYLIST</span><h2>${esc(p.name)}</h2><p>${esc(p.description||"")} · ${p.tracks.length} треков</p><div class="modal-actions"><button class="btn btn-primary" id="plPlay">▶ Play</button><button class="btn btn-secondary" id="plShuffle">⤨ Shuffle</button><button class="btn btn-secondary" id="plQueue">＋ В очередь</button><button class="btn btn-secondary" id="plEdit">Изменить</button><button class="btn btn-secondary" id="plDelete">Удалить</button></div></div></div><div id="plTracks" class="track-list" style="margin-top:18px"></div>`;
  const tc=$("plTracks");
  p.tracks.forEach((t,i)=>
  {
    const r=trackElement(t,i,false,false);
    r.querySelector(".track-actions").insertAdjacentHTML("beforeend",`<button title="Удалить">×</button>`);
    r.querySelector(".track-actions button:last-child").onclick=()=>
    {
      p.tracks.splice(i,1);
      savePlaylists(getPlaylists());
      openPlaylist(id);
      renderPlaylists()
    }
    ;
    tc.appendChild(r)
  }
  );
  $("plPlay").onclick=()=>playPlaylist(p,false);
  $("plShuffle").onclick=()=>playPlaylist(p,true);
  $("plQueue").onclick=()=>queuePlaylist(p);
  $("plEdit").onclick=()=>openPlaylistModal(id);
  $("plDelete").onclick=()=>
  {
    if(confirm("Удалить плейлист?"))
    {
      savePlaylists(getPlaylists().filter(x=>x.id!==id));
      d.hidden=true;
      renderPlaylists()
    }
  }
}
function playPlaylist(p,shuffle)
{
  if(!p.tracks.length)return toast("Плейлист пуст");
  const arr=[...p.tracks];
  if(shuffle)arr.sort(()=>Math.random()-.5);
  arr.forEach(t=>addToQueue(t));
  setTimeout(()=>send(
  {
    type:"play_track_manual_by_id",track_id:String(arr[0].id)
  }
  ),250)
}
function queuePlaylist(p)
{
  p.tracks.forEach(addToQueue);
  toast(`Добавлено: ${p.tracks.length}`)
}
const CHAT_EMOJIS=["😀","😃","😄","😁","😆","😅","😂","🤣","😊","🙂","🙃","😉","😍","🥰","😘","😎","🤩","🥳","😏","🤔","😴","😭","😡","🤯","👍","👎","👏","🙌","🔥","❤️","💜","💚","🎵","🎶","🎧","✨","💯","🚀","🤝"];
function initEmojiPicker()
{
  const picker=$("emojiPicker");
  if(!picker)return;
  picker.innerHTML=CHAT_EMOJIS.map(e=>`<button class="emoji-item" type="button" data-emoji="${e}">${e}</button>`).join("");
  picker.querySelectorAll(".emoji-item").forEach(btn=>btn.onclick=()=>{
    const input=$("chatInput");
    const emoji=btn.dataset.emoji||"";
    const start=input.selectionStart??input.value.length;
    const end=input.selectionEnd??input.value.length;
    input.value=input.value.slice(0,start)+emoji+input.value.slice(end);
    input.focus();
    input.selectionStart=input.selectionEnd=start+emoji.length;
  });
}
function toggleEmojiPicker()
{
  const picker=$("emojiPicker");
  if(!picker)return;
  picker.hidden=!picker.hidden;
}

function renderChat()
{
  const c=$("chatMessages");
  c.innerHTML="";
  chatMessages.forEach(m=>
  {
    if(m.system)
    {
      const d=document.createElement("div");
      d.className="system-message";
      d.textContent=m.text;
      c.appendChild(d);
      return
    }
    const d=document.createElement("div");
    d.className="message";
    d.innerHTML=`<span class="message-avatar">${esc(initials(m.name))}</span><div class="message-body"><div class="message-head"><b>${esc(m.name||"Гость")}</b><time>${new Date(m.time||Date.now()).toLocaleTimeString("ru-RU",{hour:"2-digit",minute:"2-digit"})}</time></div><p>${esc(m.text)}</p></div>`;
    c.appendChild(d)
  }
  );
  $("chatCount").textContent=chatMessages.length;
  const p=$("chatPreview");
  p.innerHTML=chatMessages.slice(-4).map(m=>m.system?`<div class="chat-line">${esc(m.text)}</div>`:`<div class="chat-line"><b>${esc(m.name)}:</b> ${esc(m.text)}</div>`).join("");
  c.scrollTop=c.scrollHeight
}
$("chatForm").onsubmit=e=>
{
  e.preventDefault();
  const text=$("chatInput").value.trim();
  if(!text)return;
  if(!name())
  {
    openName();
    return
  }
  send(
  {
    type:"chat_message",text
  }
  );
  $("chatInput").value=""
}
;
function renderParticipants()
{
  const c=$("participants");
  c.innerHTML=participants.map(p=>{
    const canKick=isOwner && p.id && p.id!==selfParticipantId;
    return `<div class="participant" data-participant-id="${esc(p.id||"")}"><span class="p-avatar" style="background:${esc(p.color||"#555")}">${esc(initials(p.name))}</span><span class="p-name">${esc(p.name||"Гость")}${p.is_owner?" · владелец":""}</span><small>${p.is_playing?"♫ слушает":"online"}</small>${canKick?`<span class="participant-actions"><button class="participant-kick" type="button" title="Удалить из комнаты" aria-label="Удалить ${esc(p.name)} из комнаты">×</button></span>`:""}</div>`;
  }).join("")||'<div class="empty">Участников пока нет.</div>';

  c.querySelectorAll(".participant-kick").forEach(button=>{
    button.addEventListener("click",()=>{
      const row=button.closest(".participant");
      const id=row?.dataset.participantId;
      const person=participants.find(p=>p.id===id);
      if(!id||!person)return;
      if(confirm(`Удалить ${person.name||"участника"} из комнаты?`))send({type:"kick_participant",participant_id:id});
    });
  });

  $("participantCount").textContent=participants.length;
  $("participantCountSide").textContent=participants.length;
  const owner=participants.find(p=>p.is_owner);
  $("ownerLabel").textContent=`DJ: ${owner?.name||"—"}`;
  $("roomNameTop").textContent="Комната";
}

function renderSharedMemberModal()
{
  const c=$("sharedMembersList");
  if(!c)return;
  const id=editingSharedPlaylistId;
  const playlist=sharedPlaylists.find(p=>String(p.id)===String(id));
  if(!playlist)
  {
    c.innerHTML='<div class="empty">Выберите совместный плейлист.</div>';
    return;
  }
  const selected=new Set((playlist.member_ids||[]).map(String));
  c.innerHTML=participants.map(p=>`<label class="participant"><span class="p-avatar" style="background:${esc(p.color||"#555")}">${esc(initials(p.name))}</span><span class="p-name">${esc(p.name||"Гость")}${p.is_owner?" · владелец":""}</span><input class="participant-check" type="checkbox" value="${esc(p.id)}" ${selected.has(String(p.id))?"checked":""} ${String(p.id)===String(playlist.owner_id)?"disabled":""}></label>`).join("")||'<div class="empty">В комнате никого нет.</div>';
}

function openSharedMembers(id)
{
  const p=sharedPlaylists.find(x=>String(x.id)===String(id));
  if(!p)return;
  if(String(p.owner_id)!==String(selfParticipantId) && !isOwner)
  {
    toast("Изменять участников может создатель плейлиста");
    return;
  }
  editingSharedPlaylistId=id;
  renderSharedMemberModal();
  $("sharedMembersModal").hidden=false;
}

function currentUserCanEditShared(p)
{
  return !!p && (isOwner || (p.member_ids||[]).map(String).includes(String(selfParticipantId)));
}

function renderProposals()
{
  /* reserved for server-side DJ voting UI */
}
function renderModes()
{
  ["shuffleBtn","repeatBtn","fullShuffle","fullRepeat"].forEach(id=>$(id)?.classList.remove("active"));
  $("shuffleBtn").classList.toggle("active",shuffleMode);
  $("repeatBtn").classList.toggle("active",repeatMode!=="off");
  $("fullShuffle").classList.toggle("active",shuffleMode);
  $("fullRepeat").classList.toggle("active",repeatMode!=="off");
  $("djStatus").textContent=djMode?"Включён":"Выключен";
  $("djToggle").setAttribute("aria-checked",String(djMode));
  $("djToggle").disabled=!isOwner;
  $("modalDjToggle").disabled=!isOwner;
  $("djToggle").title=isOwner?"Переключить DJ Mode":"Только владелец комнаты"
}
function renderAll()
{
  renderQueue();
  renderLibrary();
  renderHistory();
  renderPlaylists();
  renderChat();
  renderParticipants();
  renderModes();
  renderNowPlaying()
}
function togglePlay()
{
  if(!currentTrack)return;
  const a=$("audio");
  if(a.paused)a.play().catch(()=>toast("Нажми Play ещё раз после входа в комнату"));
  else a.pause()
}
function next()
{
  send(
  {
    type:"next_track"
  }
  )
}
function prev()
{
  send(
  {
    type:"prev_track"
  }
  )
}
function toggleShuffle()
{
  shuffleMode=!shuffleMode;
  renderModes();
  send(
  {
    type:"set_shuffle",enabled:shuffleMode
  }
  )
}
function repeat()
{
  const x=["off","all","one"];
  repeatMode=x[(x.indexOf(repeatMode)+1)%3];
  renderModes();
  send(
  {
    type:"set_repeat",mode:repeatMode
  }
  )
}
function toggleDJ()
{
  if(!isOwner)return;
  send(
  {
    type:"set_dj_mode",enabled:!djMode
  }
  )
}
$("audio").addEventListener("timeupdate",()=>
{
  updateProgress();
  if(!isSeeking&&!isSyncing)
  {
    const now=performance.now();
    if(now-lastServerAt>900)
    {
      lastServerTime=$("audio").currentTime;
      lastServerAt=now
    }
  }
}
);
$("audio").addEventListener("loadedmetadata",updateProgress);
$("audio").addEventListener("play",()=>
{
  $("heroCover").classList.add("playing");
  $("playIcon").hidden=true;
  $("pauseIcon").hidden=false;
  $("fullPlay").textContent="Ⅱ";
  if(!isSyncing)send(
  {
    type:"play",time:$("audio").currentTime
  }
  )
}
);
$("audio").addEventListener("pause",()=>
{
  $("heroCover").classList.remove("playing");
  $("playIcon").hidden=false;
  $("pauseIcon").hidden=true;
  $("fullPlay").textContent="▶";
  if(!isSyncing)send(
  {
    type:"pause",time:$("audio").currentTime
  }
  )
}
);
$("audio").addEventListener("ended",()=>send(
{
  type:"track_ended",expected_index:localCurrentIndex
}
));
let miniObserver=null;
function setupMiniObserver()
{
  if(!("IntersectionObserver" in window))return;
  miniObserver=new IntersectionObserver(entries=>
  {
    const show=!entries[0].isIntersecting&&!!currentTrack;
    $("miniPlayer").hidden=!show
  }
  ,
  {
    threshold:.18
  }
  );
  miniObserver.observe($("nowPlayingCard"))
}
function openFull()
{
  if(!currentTrack)return;
  $("fullscreenPlayer").hidden=false;
  document.body.classList.add("fullscreen-open");
  document.documentElement.classList.add("fullscreen-open");
  document.body.style.overflow="hidden";
  $("fullPlay").textContent=$("audio").paused?"▶":"Ⅱ";
  updateLike();
  syncVolumeUI();
}
function closeFull()
{
  $("fullscreenPlayer").hidden=true;
  document.body.classList.remove("fullscreen-open");
  document.documentElement.classList.remove("fullscreen-open");
  document.body.style.overflow="";
}

function syncVolumeUI()
{
  const value=Number($("audio").volume)||0;
  $("volumeSlider").value=String(value);
  $("fullVolumeSlider").value=String(value);

  const muted=value===0;
  ["muteBtn","fullMute"].forEach(id=>
  {
    const button=$(id);
    if(!button)return;
    button.textContent=muted?"◕":"◖";
    button.setAttribute("aria-label",muted?"Включить звук":"Выключить звук");
  });
}
function openName()
{
  $("nameInput").value=name();
  $("nameModal").hidden=false;
  setTimeout(()=>$("nameInput").focus(),40)
}
function saveName()
{
  const n=$("nameInput").value.trim();
  if(!n)return toast("Имя не может быть пустым");
  localStorage.setItem(NAME_KEY,n.slice(0,24));
  $("userNameLabel").textContent=n;
  $("userAvatar").innerHTML=getAvatar()?`<img src="${esc(getAvatar())}" alt="">`:esc(initials(n));
  $("userBtn").setAttribute("aria-label",`Изменить имя: ${n}`);
  $("editNameSide").textContent=n;
  $("nameModal").hidden=true;
  send(
  {
    type:"hello",token:clientToken,name:n.slice(0,24),avatar:getAvatar()
  }
  );
  toast(`Привет, ${n}!`)
}
function roomLink()
{
  return`${location.origin}${location.pathname}?room=${roomId}`
}
async function copyRoom()
{
  try
  {
    await navigator.clipboard.writeText(roomLink());
    toast("Ссылка приглашения скопирована")
  }
  catch
  {
    prompt("Скопируй ссылку",roomLink())
  }
}
function showRoom()
{
  const p=$("roomModal");
  $("inviteRoomId").textContent=roomId;
  renderParticipants();
  p.hidden=false
}
function leaveRoom()
{
  if(intentionalLeave)return;
  if(!confirm("Выйти из этой комнаты?"))return;
  intentionalLeave=true;
  send({type:"leave_room"});
  setTimeout(()=>{
    try{ws?.close();}catch{}
    status("disconnected","Вы вышли");
    $("roomModal").hidden=true;
  },120);
}

function saveSharedMembers()
{
  const p=sharedPlaylists.find(x=>String(x.id)===String(editingSharedPlaylistId));
  if(!p)return;
  const ids=[...$("sharedMembersList").querySelectorAll("input.participant-check:checked")].map(x=>x.value);
  if(!ids.includes(String(p.owner_id)))ids.push(String(p.owner_id));
  send({type:"shared_playlist_update_members",playlist_id:p.id,member_ids:ids});
  $("sharedMembersModal").hidden=true;
}

function switchView(v)
{
  document.querySelectorAll(".view").forEach(x=>x.classList.toggle("active",x.id===v+"View"));
  document.querySelectorAll(".nav-item").forEach(x=>x.classList.toggle("active",x.dataset.view===v));
  if(v==="library")renderLibrary();
  if(v==="history")renderHistory();
  if(v==="playlists")renderPlaylists();
  if(v==="chat")renderChat();
  window.scrollTo(
  {
    top:0,behavior:"smooth"
  }
  )
}
function bind()
{
  document.querySelectorAll(".nav-item").forEach(b=>b.onclick=()=>switchView(b.dataset.view));
  document.querySelectorAll("[data-view-link]").forEach(b=>b.onclick=()=>switchView(b.dataset.viewLink));
  $("roomButton").onclick=showRoom;
  $("leaveRoomBtn").onclick=leaveRoom;
  $("modalLeaveRoomBtn").onclick=leaveRoom;
  $("newSharedPlaylistBtn").onclick=()=>openPlaylistModal(null,true);
  $("saveSharedMembersBtn").onclick=saveSharedMembers;
  $("emojiBtn").onclick=toggleEmojiPicker;
  initEmojiPicker();
  $("roomInfoBtn").onclick=showRoom;
  $("copyRoomBtn").onclick=copyRoom;
  $("copyInviteBtn").onclick=copyRoom;
  $("userBtn").onclick=openName;
  $("editNameSide").onclick=openName;
  $("saveNameBtn").onclick=saveName;
  $("newPlaylistBtn").onclick=()=>openPlaylistModal();
  $("pickerNewPlaylist").onclick=()=>
  {
    $("playlistPicker").hidden=true;
    openPlaylistModal();
  };
  $("libraryQueueBtn").onclick=addAllLibrary;
  $("likeCurrentBtn").onclick=()=>currentTrack&&toggleLibrary(currentTrack);
  $("addCurrentPlaylistBtn").onclick=()=>currentTrack&&openPlaylistPicker(currentTrack);
  $("fullLike").onclick=()=>currentTrack&&toggleLibrary(currentTrack);
  $("fullPlaylist").onclick=()=>currentTrack&&openPlaylistPicker(currentTrack);
  $("playPauseBtn").onclick=togglePlay;
  $("nextBtn").onclick=next;
  $("prevBtn").onclick=prev;
  $("miniNext").onclick=next;
  $("miniPlay").onclick=togglePlay;
  $("miniExpand").onclick=openFull;
  $("fullscreenBtn").onclick=openFull;
  $("openFullscreenBtn").onclick=openFull;
  $("fullscreenClose").onclick=closeFull;
  $("fullNext").onclick=next;
  $("fullPrev").onclick=prev;
  $("fullPlay").onclick=togglePlay;
  $("shuffleBtn").onclick=toggleShuffle;
  $("repeatBtn").onclick=repeat;
  $("fullShuffle").onclick=toggleShuffle;
  $("fullRepeat").onclick=repeat;
  $("djToggle").onclick=toggleDJ;
  $("modalDjToggle").onclick=toggleDJ;
  $("shuffleQueueBtn").onclick=()=>send(
  {
    type:"set_shuffle",enabled:true
  }
  );
  $("clearHistoryBtn").onclick=()=>
  {
    localStorage.removeItem(HISTORY_KEY);
    renderHistory();
    toast("История очищена")
  }
  ;
  const setVolume=value=>
  {
    const volume=Math.max(0,Math.min(1,Number(value)||0));
    audio.volume=volume;
    if(volume>0)
    {
      localStorage.setItem(VOLUME_KEY,String(volume));
      localStorage.setItem(MUTED_KEY,"0");
    }
    else
    {
      localStorage.setItem(MUTED_KEY,"1");
    }
    syncVolumeUI();
  };

  $("volumeSlider").oninput=e=>setVolume(e.target.value);
  $("fullVolumeSlider").oninput=e=>setVolume(e.target.value);

  const toggleMute=()=>
  {
    if(audio.volume>0)
    {
      localStorage.setItem(VOLUME_KEY,String(audio.volume));
      audio.volume=0;
      localStorage.setItem(MUTED_KEY,"1");
    }
    else
    {
      const saved=Number(localStorage.getItem(VOLUME_KEY));
      audio.volume=Math.max(.05,Math.min(1,Number.isFinite(saved)&&saved>0?saved:1));
      localStorage.setItem(MUTED_KEY,"0");
    }
    syncVolumeUI();
  };

  $("muteBtn").onclick=toggleMute;
  $("fullMute").onclick=toggleMute;
  $("fullscreenPlayer").addEventListener("click",e=>
  {
    if(e.target===$("fullscreenPlayer")||e.target===$("fullscreenBg"))closeFull();
  });

  document.querySelectorAll("[data-close]").forEach(b=>b.onclick=()=>$(b.dataset.close).hidden=true);
  document.querySelectorAll(".modal-backdrop").forEach(b=>b.addEventListener("click",e=>
  {
    if(e.target===b)b.hidden=true
  }
  ));
  setupSeek($("progressContainer"));
  setupSeek($("fullProgressContainer"));
  document.addEventListener("keydown",e=>
  {
    if(e.key==="Escape")
    {
      closeFull();
      document.querySelectorAll(".modal-backdrop").forEach(x=>x.hidden=true)
    }
    if(e.target.matches("input,textarea"))return;
    if(e.code==="Space")
    {
      e.preventDefault();
      togglePlay()
    }
    if(e.key==="ArrowRight"&&!e.target.closest(".progress-container"))next();
    if(e.key==="ArrowLeft"&&!e.target.closest(".progress-container"))prev();
    if(e.key.toLowerCase()==="m")$("muteBtn").click()
  }
  );
  let touch=
  {
    x:0,y:0
  }
  ;
  $("fullscreenPlayer").addEventListener("touchstart",e=>
  {
    if(e.touches.length===1)
    {
      touch.x=e.touches[0].clientX;
      touch.y=e.touches[0].clientY
    }
  }
  ,
  {
    passive:true
  }
  );
  $("fullscreenPlayer").addEventListener("touchend",e=>
  {
    if(!touch.x)return;
    const dx=e.changedTouches[0].clientX-touch.x,dy=e.changedTouches[0].clientY-touch.y;
    touch=
    {
      x:0,y:0
    }
    ;
    if(Math.abs(dy)>Math.abs(dx)&&dy>70)closeFull();
    else if(Math.abs(dx)>70)
    {
      dx<0?next():prev()
    }
  }
  )
}
function setupMobileNavigation()
{
  const content=$(".content");
  if(!content)return;
  let sx=0,sy=0,tracking=false;
  const views=[...document.querySelectorAll(".nav-item")].map(x=>x.dataset.view);
  content.addEventListener("touchstart",e=>{
    if(window.innerWidth>780||e.touches.length!==1)return;
    if(e.target.closest("input,textarea,button,.track-actions,.progress-container,.side-nav"))return;
    sx=e.touches[0].clientX;
    sy=e.touches[0].clientY;
    tracking=true;
  },{passive:true});
  content.addEventListener("touchend",e=>{
    if(!tracking)return;
    tracking=false;
    const dx=e.changedTouches[0].clientX-sx;
    const dy=e.changedTouches[0].clientY-sy;
    if(Math.abs(dx)<65||Math.abs(dx)<=Math.abs(dy)*1.2)return;
    const active=document.querySelector(".nav-item.active")?.dataset.view;
    const current=views.indexOf(active);
    if(current<0)return;
    const nextIndex=dx<0?Math.min(views.length-1,current+1):Math.max(0,current-1);
    if(nextIndex!==current)switchView(views[nextIndex]);
  },{passive:true});

  const nav=$(".side-nav");
  nav?.addEventListener("wheel",e=>{
    if(window.innerWidth<=780 && Math.abs(e.deltaY)>Math.abs(e.deltaX))nav.scrollLeft+=e.deltaY;
  },{passive:true});
}


/* ========================================================================
   Sync Music v5 — collaborative, mobile and visual enhancements
   ======================================================================== */

function getAvatar() {
  return localStorage.getItem(AVATAR_KEY) || "";
}

function avatarMarkup(person, className = "avatar") {
  const src = person?.avatar || "";
  if (src) {
    return `<span class="${className} avatar-image"><img src="${esc(src)}" alt=""></span>`;
  }
  return `<span class="${className}">${esc(initials(person?.name || "G"))}</span>`;
}

function readImageAsDataUrl(file, maxSize = 512, quality = 0.82) {
  return new Promise((resolve, reject) => {
    if (!file || !file.type.startsWith("image/")) {
      reject(new Error("Это не изображение"));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error("Не удалось прочитать файл"));
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.onerror = () => reject(new Error("Не удалось обработать изображение"));
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function renderProfilePreview() {
  const box = $("profilePreview");
  if (!box) return;
  const avatar = getAvatar();
  box.innerHTML = avatar ? `<img src="${esc(avatar)}" alt="">` : esc(initials(name()));
}

function applyTheme(theme) {
  const value = theme === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = value;
  localStorage.setItem(THEME_KEY, value);
  const btn = $("themeToggle");
  if (btn) btn.textContent = `Тема: ${value === "light" ? "светлая" : "тёмная"}`;
}

function toggleTheme() {
  applyTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light");
}

function renderRoomHistory() {
  const c = $("roomHistory");
  if (!c) return;
  if (!roomHistory.length) {
    c.innerHTML = '<div class="empty"><strong>История комнаты пуста</strong>Здесь появятся действия участников.</div>';
    return;
  }
  c.innerHTML = roomHistory.slice().reverse().map(item => {
    const t = item.track;
    const time = new Date(item.time || Date.now()).toLocaleTimeString("ru-RU", {hour:"2-digit", minute:"2-digit"});
    const text = item.action === "play" ? "включил" : item.action === "add" ? "добавил в очередь" : item.action === "remove" ? "удалил из очереди" : item.action === "clear" ? "очистил очередь" : item.action;
    return `<div class="room-history-item">
      <div class="history-avatar">${esc(initials(item.actor || "G"))}</div>
      <div class="room-history-copy"><strong>${esc(item.actor || "Гость")}</strong> <span>${esc(text)}</span>${t ? `<div class="history-track"><img src="${esc(t.cover || "")}" alt=""><span>${esc(t.title || "Трек")}<small>${esc(t.artist || "")} · ${formatTime(t.duration || 0)}</small></span></div>` : ""}</div>
      <time>${time}</time>
    </div>`;
  }).join("");
}

function enhanceMessageRendering() {
  const old = handleMessage;
  handleMessage = function (m) {
    if (m.type === "room_history") {
      roomHistory = m.history || [];
      renderRoomHistory();
      return;
    }
    if (m.type === "reaction_message") {
      const target = chatMessages.find(x => x.id === m.message_id);
      if (target) {
        target.reactions = target.reactions || {};
        target.reactions[m.reaction] = (target.reactions[m.reaction] || 0) + 1;
        renderChat();
      }
      return;
    }
    old(m);
  };
}

enhanceMessageRendering();

function isQueueSelected(index) {
  return selectedQueue.has(Number(index));
}

function renderQueueV5() {
  const c = $("queue");
  const preview = $("queuePreview");
  $("queueCount").textContent = localQueue.length;
  if (!localQueue.length) {
    c.innerHTML = '<div class="empty"><strong>Очередь пока пуста</strong>Ищите музыку сверху и добавляйте её в комнату.</div>';
    preview.innerHTML = '<div class="empty">Добавьте первый трек через поиск.</div>';
    selectedQueue.clear();
    return;
  }
  selectedQueue.forEach(i => { if (i >= localQueue.length) selectedQueue.delete(i); });
  c.innerHTML = `<div class="queue-bulkbar"><label><input id="queueMasterCheck" type="checkbox" ${selectedQueue.size === localQueue.length ? "checked" : ""}> <span>Выбрано: ${selectedQueue.size}</span></label><div><button id="queueBulkDelete" class="btn btn-danger btn-small" type="button" ${selectedQueue.size ? "" : "disabled"}>Удалить</button><button id="queueBulkClearSelection" class="btn btn-ghost btn-small" type="button" ${selectedQueue.size ? "" : "disabled"}>Снять выбор</button></div></div>`;
  localQueue.forEach((track, index) => {
    const row = trackElement(track, index, true, false);
    const check = document.createElement("label");
    check.className = "queue-select";
    check.innerHTML = `<input type="checkbox" ${isQueueSelected(index) ? "checked" : ""} aria-label="Выбрать ${esc(track.title)}">`;
    check.querySelector("input").addEventListener("click", e => e.stopPropagation());
    check.querySelector("input").addEventListener("change", e => {
      if (e.target.checked) selectedQueue.add(index); else selectedQueue.delete(index);
      renderQueueV5();
    });
    row.insertBefore(check, row.firstChild);
    c.appendChild(row);
  });
  preview.innerHTML = "";
  localQueue.forEach((track,index) => {
    if (index !== localCurrentIndex && preview.children.length < 4) preview.appendChild(trackElement(track,index,true,true));
  });
  $("queueMasterCheck").onchange = e => {
    if (e.target.checked) localQueue.forEach((_,i) => selectedQueue.add(i)); else selectedQueue.clear();
    renderQueueV5();
  };
  $("queueBulkClearSelection").onclick = () => { selectedQueue.clear(); renderQueueV5(); };
  $("queueBulkDelete").onclick = () => {
    if (!selectedQueue.size) return;
    const indices = [...selectedQueue].sort((a,b)=>b-a);
    if (!confirm(`Удалить ${indices.length} треков из очереди?`)) return;
    send({type:"remove_many_from_queue", indices});
    selectedQueue.clear();
  };
}
renderQueue = renderQueueV5;

function playlistArtV5(p) {
  if (p.cover) return [p.cover];
  return p.tracks?.slice(0,4).map(t=>t.cover).filter(Boolean) || [];
}

function currentSharedRole(p) {
  if (!p) return "viewer";
  if (String(p.owner_id) === String(selfParticipantId) || isOwner) return String(p.owner_id) === String(selfParticipantId) ? "owner" : "editor";
  return p.roles?.[selfParticipantId] || ((p.member_ids||[]).map(String).includes(String(selfParticipantId)) ? "editor" : "viewer");
}
currentUserCanEditShared = function(p) { return ["owner","editor"].includes(currentSharedRole(p)); };

function renderPlaylistsV5() {
  const c = $("playlistGrid");
  const local = getPlaylists();
  const all = [...sharedPlaylists.map(p=>({...p,is_shared:true})), ...local.map(p=>({...p,is_shared:false}))];
  if (!all.length) {
    c.innerHTML='<div class="empty"><strong>Плейлистов ещё нет</strong>Создайте личный или совместный плейлист.</div>';
    return;
  }
  c.innerHTML = "";
  all.forEach(p => {
    const d = document.createElement("article");
    d.className = `playlist-card${p.is_shared ? " shared" : ""}`;
    const arts = playlistArtV5(p);
    const role = p.is_shared ? currentSharedRole(p) : "owner";
    const roleText = role === "owner" ? "Владелец" : role === "editor" ? "Редактор" : "Слушатель";
    d.innerHTML = `<div class="playlist-art">${arts.length ? arts.slice(0,4).map(u=>`<img src="${esc(u)}" alt="" loading="lazy">`).join("") : "<span></span>"}</div><h3>${esc(p.name)}</h3><p>${p.tracks.length} треков${p.description?` · ${esc(p.description)}`:""}${p.is_shared?` <span class="shared-badge">● Совместный · ${roleText}</span>`:""}</p><div class="playlist-buttons"><button class="btn btn-primary open-pl">Открыть</button>${p.is_shared?`<button class="btn btn-secondary playlist-share-btn">Поделиться</button>${String(p.owner_id)===String(selfParticipantId)||isOwner?`<button class="btn btn-secondary playlist-members-btn">Участники</button>`:""}`:`<button class="btn btn-secondary edit-pl">⋯</button>`}</div>`;
    d.querySelector(".open-pl").onclick = () => p.is_shared ? openSharedPlaylist(p.id) : openPlaylist(p.id);
    d.querySelector(".edit-pl")?.addEventListener("click",()=>openPlaylistModal(p.id));
    d.querySelector(".playlist-members-btn")?.addEventListener("click",()=>openSharedMembers(p.id));
    d.querySelector(".playlist-share-btn")?.addEventListener("click",()=>sharePlaylist(p));
    c.appendChild(d);
  });
}
renderPlaylists = renderPlaylistsV5;

let v5PlaylistCover = "";
let editingSharedPlaylistFormId = null;
function updatePlaylistCoverPreview() {
  const box=$("playlistCoverPreview");
  if (!box) return;
  box.innerHTML = v5PlaylistCover ? `<img src="${esc(v5PlaylistCover)}" alt="">` : '<span>♪</span>';
}

const originalOpenPlaylistModal = openPlaylistModal;
openPlaylistModal = function(id=null, shared=false) {
  editingSharedPlaylistFormId = shared && id ? String(id) : null;
  originalOpenPlaylistModal(id, shared);
  const p = id ? (shared ? sharedPlaylists.find(x=>String(x.id)===String(id)) : getPlaylists().find(x=>String(x.id)===String(id))) : null;
  if (shared && p) {
    $("playlistModalTitle").textContent = "Изменить совместный плейлист";
    $("playlistNameInput").value = p.name || "";
    $("playlistDescInput").value = p.description || "";
  }
  v5PlaylistCover = p?.cover || "";
  updatePlaylistCoverPreview();
};

function savePlaylistV5() {
  const n=$("playlistNameInput").value.trim();
  if(!n) return toast("Введите название");
  const desc=$("playlistDescInput").value.trim();

  if (creatingSharedPlaylist) {
    const id=crypto.randomUUID();
    send({type:"shared_playlist_create",id,name:n,description:desc,cover:v5PlaylistCover,member_ids:[selfParticipantId]});
    $("playlistModal").hidden=true;
    creatingSharedPlaylist=false;
    editingSharedPlaylistId=id;
    editingSharedPlaylistFormId=id;
    toast("Совместный плейлист создан");
    setTimeout(()=>{
      if(sharedPlaylists.some(p=>String(p.id)===String(id))) openSharedMembers(id);
    },700);
    return;
  }

  if (editingSharedPlaylistFormId) {
    const p=sharedPlaylists.find(x=>String(x.id)===String(editingSharedPlaylistFormId));
    if (!p) return toast("Совместный плейлист не найден");
    send({type:"shared_playlist_update",playlist_id:p.id,name:n,description:desc,cover:v5PlaylistCover});
    $("playlistModal").hidden=true;
    editingSharedPlaylistFormId=null;
    toast("Совместный плейлист обновлён");
    return;
  }

  let ps=getPlaylists();
  if(editingPlaylistId) {
    const p=ps.find(x=>String(x.id)===String(editingPlaylistId));
    if(p){p.name=n;p.description=desc;p.cover=v5PlaylistCover;}
  } else {
    ps.unshift({id:crypto.randomUUID(),name:n,description:desc,cover:v5PlaylistCover,created_at:new Date().toISOString(),tracks:pendingPlaylistTrack?[{...pendingPlaylistTrack}]:[]});
    pendingPlaylistTrack=null;
  }
  savePlaylists(ps);
  $("playlistModal").hidden=true;
  renderPlaylists();
  toast("Плейлист сохранён");
}
$("savePlaylistBtn").onclick=savePlaylistV5;

function openSharedPlaylistV5(id) {
  const p=sharedPlaylists.find(x=>String(x.id)===String(id));
  if(!p)return;
  const d=$("playlistDetail"); d.hidden=false;
  const arts=playlistArtV5(p); const role=currentSharedRole(p); const canEdit=["owner","editor"].includes(role);
  d.innerHTML=`<div class="playlist-detail-head"><div class="playlist-art playlist-detail-art">${arts.length?arts.slice(0,4).map(u=>`<img src="${esc(u)}" alt="">`).join(""):"<span>♪</span>"}</div><div><span class="eyebrow">SHARED PLAYLIST · ${esc(role)}</span><h2>${esc(p.name)}</h2><p>${esc(p.description||"")} · ${p.tracks.length} треков · ${(p.member_ids||[]).length} участников</p><div class="modal-actions"><button class="btn btn-primary" id="plPlay">▶ Играть</button><button class="btn btn-secondary" id="plShuffle">⤨ Перемешать</button><button class="btn btn-secondary" id="plQueue">＋ В очередь</button><button class="btn btn-secondary" id="plShare">↗ Поделиться</button>${String(p.owner_id)===String(selfParticipantId)||isOwner?`<button class="btn btn-secondary" id="plMembers">Участники</button>`:""}${String(p.owner_id)===String(selfParticipantId)||isOwner?`<button class="btn btn-secondary" id="plEditShared">Изменить</button>`:""}</div></div></div><div id="plTracks" class="track-list playlist-track-list"></div>`;
  const tc=$("plTracks");
  p.tracks.forEach((t,i)=>{
    const r=trackElement(t,i,false,false); r.classList.add("playlist-track");
    if(canEdit){
      const remove=document.createElement("button"); remove.textContent="×"; remove.className="remove-track"; remove.title="Удалить"; remove.onclick=()=>send({type:"shared_playlist_remove_track",playlist_id:p.id,track_id:String(t.id)}); r.querySelector(".track-actions").appendChild(remove);
      r.draggable=true; enablePlaylistDrag(r,i,p.id,true);
    }
    tc.appendChild(r);
  });
  $("plPlay").onclick=()=>playPlaylist(p,false); $("plShuffle").onclick=()=>playPlaylist(p,true); $("plQueue").onclick=()=>queuePlaylist(p); $("plShare").onclick=()=>sharePlaylist(p); $("plMembers")?.addEventListener("click",()=>openSharedMembers(p.id)); $("plEditShared")?.addEventListener("click",()=>openPlaylistModal(p.id,true));
}
openSharedPlaylist = openSharedPlaylistV5;

function openPlaylistV5(id) {
  const p=getPlaylists().find(x=>String(x.id)===String(id)); if(!p)return;
  const d=$("playlistDetail"); d.hidden=false; const arts=playlistArtV5(p);
  d.innerHTML=`<div class="playlist-detail-head"><div class="playlist-art playlist-detail-art">${arts.length?arts.slice(0,4).map(u=>`<img src="${esc(u)}" alt="">`).join(""):"<span>♪</span>"}</div><div><span class="eyebrow">PLAYLIST</span><h2>${esc(p.name)}</h2><p>${esc(p.description||"")} · ${p.tracks.length} треков</p><div class="modal-actions"><button class="btn btn-primary" id="plPlay">▶ Играть</button><button class="btn btn-secondary" id="plShuffle">⤨ Перемешать</button><button class="btn btn-secondary" id="plQueue">＋ В очередь</button><button class="btn btn-secondary" id="plEdit">Изменить</button><button class="btn btn-secondary" id="plDelete">Удалить</button></div></div></div><div id="plTracks" class="track-list playlist-track-list"></div>`;
  const tc=$("plTracks");
  p.tracks.forEach((t,i)=>{ const r=trackElement(t,i,false,false); r.draggable=true; enablePlaylistDrag(r,i,p.id,false); const rm=document.createElement("button"); rm.textContent="×"; rm.className="remove-track"; rm.title="Удалить"; rm.onclick=()=>{p.tracks.splice(i,1);savePlaylists(getPlaylists());openPlaylistV5(id);renderPlaylists();}; r.querySelector(".track-actions").appendChild(rm); tc.appendChild(r); });
  $("plPlay").onclick=()=>playPlaylist(p,false); $("plShuffle").onclick=()=>playPlaylist(p,true); $("plQueue").onclick=()=>queuePlaylist(p); $("plEdit").onclick=()=>openPlaylistModal(id); $("plDelete").onclick=()=>{if(confirm("Удалить плейлист?")){savePlaylists(getPlaylists().filter(x=>String(x.id)!==String(id)));d.hidden=true;renderPlaylists();}};
}
openPlaylist = openPlaylistV5;

function enablePlaylistDrag(el,index,playlistId,shared) {
  el.addEventListener("dragstart",e=>{e.dataTransfer?.setData("text/plain",String(index)); el.classList.add("dragging");});
  el.addEventListener("dragover",e=>{e.preventDefault();el.classList.add("drag-over");});
  el.addEventListener("dragleave",()=>el.classList.remove("drag-over"));
  el.addEventListener("drop",e=>{e.preventDefault();el.classList.remove("drag-over");const from=Number(e.dataTransfer?.getData("text/plain"));const to=index;if(!Number.isInteger(from)||from===to)return;if(shared)send({type:"shared_playlist_reorder",playlist_id:playlistId,from,to});else{const ps=getPlaylists();const p=ps.find(x=>String(x.id)===String(playlistId));if(!p)return;const t=p.tracks.splice(from,1)[0];p.tracks.splice(to,0,t);savePlaylists(ps);openPlaylistV5(playlistId);renderPlaylists();}});
  el.addEventListener("dragend",()=>el.classList.remove("dragging","drag-over"));
}

async function sharePlaylist(p) {
  const link=`${location.origin}${location.pathname}?room=${encodeURIComponent(roomId)}&playlist=${encodeURIComponent(p.id)}`;
  try { await navigator.clipboard.writeText(link); toast("Ссылка на плейлист скопирована"); } catch { prompt("Скопируй ссылку",link); }
}

function renderParticipantsV5() {
  const c=$("participants");
  c.innerHTML=participants.map(p=>{
    const canManage=isOwner && p.id && p.id!==selfParticipantId;
    return `<div class="participant" data-participant-id="${esc(p.id||"")}">${avatarMarkup(p,"p-avatar")}<span class="p-name"><b>${esc(p.name||"Гость")}</b>${p.is_owner?` <span class="role-chip owner">владелец</span>`:""}</span><small>${p.is_playing?"♫ слушает":"online"}</small>${canManage?`<span class="participant-actions"><button class="participant-action transfer" type="button" title="Передать владельца">♛</button><button class="participant-kick" type="button" title="Удалить из комнаты">×</button></span>`:""}</div>`;
  }).join("")||'<div class="empty">Участников пока нет.</div>';
  c.querySelectorAll(".participant-kick").forEach(b=>b.onclick=()=>{const id=b.closest(".participant")?.dataset.participantId;const person=participants.find(x=>x.id===id);if(id&&person&&confirm(`Удалить ${person.name} из комнаты?`))send({type:"kick_participant",participant_id:id});});
  c.querySelectorAll(".participant-action.transfer").forEach(b=>b.onclick=()=>{const id=b.closest(".participant")?.dataset.participantId;const person=participants.find(x=>x.id===id);if(id&&person&&confirm(`Передать ${person.name} права владельца?`))send({type:"transfer_owner",participant_id:id});});
  $("participantCount").textContent=participants.length; $("participantCountSide").textContent=participants.length; const owner=participants.find(p=>p.is_owner); $("ownerLabel").textContent=`Владелец: ${owner?.name||"—"}`;
  $("ownerHint").textContent=isOwner?"Ты владелец комнаты. Можно передать права или удалить участника.":`Владелец: ${owner?.name||"—"}`;
}
renderParticipants = renderParticipantsV5;

function renderSharedMemberModalV5() {
  const c=$("sharedMembersList"); if(!c)return; const p=sharedPlaylists.find(x=>String(x.id)===String(editingSharedPlaylistId)); if(!p){c.innerHTML='<div class="empty">Плейлист не найден.</div>';return;}
  const selected=new Set((p.member_ids||[]).map(String));
  c.innerHTML=participants.map(person=>{const id=String(person.id);const role=p.roles?.[id] || (id===String(p.owner_id)?"owner":"viewer");const disabled=id===String(p.owner_id);return `<div class="participant role-row">${avatarMarkup(person,"p-avatar")}<span class="p-name"><b>${esc(person.name)}</b>${person.is_owner?" · владелец":""}</span><select class="role-select" data-id="${esc(id)}" ${disabled?"disabled":""}><option value="editor" ${role==="editor"?"selected":""}>Редактор</option><option value="viewer" ${role==="viewer"?"selected":""}>Слушатель</option></select><input class="participant-check" type="checkbox" data-id="${esc(id)}" ${selected.has(id)?"checked":""} ${disabled?"disabled":""}></div>`;}).join("");
}
renderSharedMemberModal = renderSharedMemberModalV5;

function saveSharedMembersV5() {
  const p=sharedPlaylists.find(x=>String(x.id)===String(editingSharedPlaylistId)); if(!p)return;
  const ids=[];const roles={};
  $("sharedMembersList").querySelectorAll(".role-row").forEach(row=>{const check=row.querySelector(".participant-check");const select=row.querySelector(".role-select");if(check?.checked){ids.push(check.dataset.id);roles[check.dataset.id]=select?.value||"editor";}});
  ids.push(String(p.owner_id));roles[String(p.owner_id)]="owner";
  send({type:"shared_playlist_update_members",playlist_id:p.id,member_ids:[...new Set(ids)],roles});
  $("sharedMembersModal").hidden=true;
}
saveSharedMembers = saveSharedMembersV5;

function renderChatV5() {
  const c=$("chatMessages"); c.innerHTML="";
  chatMessages.forEach(m=>{
    if(m.system){const d=document.createElement("div");d.className="system-message";d.textContent=m.text;c.appendChild(d);return;}
    const reply=m.reply_to?`<div class="message-reply">↩ ${esc(m.reply_to.name||"")}: ${esc(m.reply_to.text||"").slice(0,80)}</div>`:"";
    const reactions=m.reactions?Object.entries(m.reactions).map(([emoji,count])=>`<button class="reaction-chip" data-message="${esc(m.id||"")}" data-reaction="${esc(emoji)}">${emoji} ${count}</button>`).join(""):"";
    const d=document.createElement("div");d.className="message";d.dataset.messageId=m.id||"";
    d.innerHTML=`${avatarMarkup(m,"message-avatar")}<div class="message-body"><div class="message-head"><b>${esc(m.name||"Гость")}</b><time>${new Date(m.time||Date.now()).toLocaleTimeString("ru-RU",{hour:"2-digit",minute:"2-digit"})}</time><button class="message-reply-btn" type="button" title="Ответить">↩</button><button class="message-react-btn" type="button" title="Реакция">☺</button></div>${reply}<p>${esc(m.text)}</p><div class="message-reactions">${reactions}</div></div>`;
    d.querySelector(".message-reply-btn").onclick=()=>{replyingTo=m;renderReplyBar();$("chatInput").focus();};
    d.querySelector(".message-react-btn").onclick=()=>send({type:"chat_reaction",message_id:m.id,reaction:"❤️"});
    d.querySelectorAll(".reaction-chip").forEach(b=>b.onclick=()=>send({type:"chat_reaction",message_id:b.dataset.message,reaction:b.dataset.reaction}));
    c.appendChild(d);
  });
  $("chatCount").textContent=chatMessages.length;
  $("chatPreview").innerHTML=chatMessages.slice(-4).map(m=>m.system?`<div class="chat-line">${esc(m.text)}</div>`:`<div class="chat-line"><b>${esc(m.name)}:</b> ${esc(m.text)}</div>`).join("");
  c.scrollTop=c.scrollHeight;
}
renderChat=renderChatV5;

function renderReplyBar() {
  let bar=$("replyBar");
  if(!bar)return;
  if(!replyingTo){bar.hidden=true;bar.innerHTML="";return;}
  bar.hidden=false;bar.innerHTML=`<span>Ответ ${esc(replyingTo.name)}: ${esc(replyingTo.text).slice(0,90)}</span><button type="button" id="cancelReply">×</button>`;
  $("cancelReply").onclick=()=>{replyingTo=null;renderReplyBar();};
}

function sendChatV5(e) {
  e.preventDefault(); const input=$("chatInput"); const text=input.value.trim(); if(!text)return; if(!name()){openName();return;}
  send({type:"chat_message",text,reply_to:replyingTo?{id:replyingTo.id,name:replyingTo.name,text:replyingTo.text}:null}); input.value="";replyingTo=null;renderReplyBar();$("emojiPicker").hidden=true;
}
$("chatForm").onsubmit=sendChatV5;

function addProfileAvatarEvents() {
  $("profilePhotoInput")?.addEventListener("change", async e=>{const file=e.target.files?.[0];if(!file)return;try{const data=await readImageAsDataUrl(file,256,.82);localStorage.setItem(AVATAR_KEY,data);renderProfilePreview();$("userAvatar").innerHTML=`<img src="${esc(data)}" alt="">`;send({type:"profile_update",avatar:data,name:name()});toast("Фото профиля обновлено");}catch(err){toast(err.message||"Не удалось загрузить фото");}});
  $("playlistCoverInput")?.addEventListener("change", async e=>{const file=e.target.files?.[0];if(!file)return;try{v5PlaylistCover=await readImageAsDataUrl(file,512,.82);updatePlaylistCoverPreview();}catch(err){toast(err.message||"Не удалось загрузить фото");}});
}

function addRoomHistoryUI() {
  $("clearRoomHistoryBtn")?.addEventListener("click",()=>{if(!isOwner)return toast("Очистить историю может владелец");if(confirm("Очистить историю комнаты?"))send({type:"clear_room_history"});});
}

function addV5Bindings() {
  $("clearQueueBtn")?.addEventListener("click",()=>{if(!localQueue.length)return;if(confirm("Удалить все треки из очереди, кроме текущего?"))send({type:"clear_queue"});});
  $("selectAllQueueBtn")?.addEventListener("click",()=>{if(selectedQueue.size===localQueue.length)selectedQueue.clear();else localQueue.forEach((_,i)=>selectedQueue.add(i));renderQueueV5();});
  $("themeToggle")?.addEventListener("click",toggleTheme);
  addProfileAvatarEvents(); addRoomHistoryUI(); renderProfilePreview(); renderRoomHistory();
}

const oldSaveName = saveName;
saveName = function() {
  oldSaveName();
  renderProfilePreview();
  const avatar=getAvatar();
  $("userAvatar").innerHTML=avatar?`<img src="${esc(avatar)}" alt="">`:esc(initials(name()));
  send({type:"profile_update",name:name(),avatar});
};

function patchHelloAvatar() {
  const original = connect;
  // connect() already uses send(); send now carries the local avatar.
  return original;
}


/* Touch-friendly queue reordering: the handle starts a real drag gesture without hijacking page scroll. */
function enableQueueTouchDragV5(el,index) {
  const handle = el.querySelector(".drag-handle");
  if (!handle) return;
  let active=false, startY=0, target=index;
  const move=(e)=>{
    if(!active || e.touches.length!==1)return;
    const y=e.touches[0].clientY;
    const row=document.elementFromPoint(e.touches[0].clientX,y)?.closest(".queue-track");
    if(row){
      const n=Number(row.dataset.index);
      if(Number.isInteger(n)){target=n;document.querySelectorAll(".queue-track.touch-over").forEach(x=>x.classList.remove("touch-over"));if(n!==index)row.classList.add("touch-over");}
    }
    e.preventDefault();
  };
  const end=()=>{
    if(!active)return;
    active=false;
    document.removeEventListener("touchmove",move,{passive:false});
    document.removeEventListener("touchend",end);
    el.classList.remove("touch-dragging");
    document.querySelectorAll(".queue-track.touch-over").forEach(x=>x.classList.remove("touch-over"));
    if(target!==index)send({type:"reorder_queue",from:index,to:target});
    target=index;
  };
  handle.addEventListener("touchstart",e=>{
    if(e.touches.length!==1)return;
    active=true;startY=e.touches[0].clientY;target=index;el.classList.add("touch-dragging");
    e.stopPropagation();
  },{passive:true});
  handle.addEventListener("touchend",end,{passive:true});
  handle.addEventListener("touchcancel",end,{passive:true});
  handle.addEventListener("touchmove",e=>{if(active)e.preventDefault();},{passive:false});
}


enableSwipe = function(el,index) {
  let sx=0,sy=0,moved=false;
  el.addEventListener("touchstart",e=>{
    if(e.touches.length!==1 || e.target.closest("button,.drag-handle")) return;
    sx=e.touches[0].clientX; sy=e.touches[0].clientY; moved=false;
  },{passive:true});
  el.addEventListener("touchmove",e=>{
    if(!sx || e.touches.length!==1)return;
    const dx=e.touches[0].clientX-sx, dy=e.touches[0].clientY-sy;
    if(Math.abs(dx)>12 && Math.abs(dx)>Math.abs(dy)) moved=true;
  },{passive:true});
  el.addEventListener("touchend",e=>{
    if(!sx)return;
    const dx=e.changedTouches[0].clientX-sx,dy=e.changedTouches[0].clientY-sy;
    sx=sy=0;
    if(moved && dx < -65 && Math.abs(dx)>Math.abs(dy)) {
      if(confirm("Удалить этот трек из очереди?")) removeQueueItem(index);
    }
  },{passive:true});
};

const originalTrackElementV5 = trackElement;
trackElement = function(t,i,full=true,compact=false) {
  const el=originalTrackElementV5(t,i,full,compact);
  if(full && el.classList.contains("queue-track")) {
    const handle=el.querySelector(".drag-handle");
    if(handle) {
      // The original row swipe handler remains available for deletion; the handle gets priority for reorder.
      enableQueueTouchDragV5(el,i);
    }
  }
  return el;
};

function init()
{
  ["roomIdDisplay","roomIdSide"].forEach(id=>$(id).textContent=roomId);
  const n=name();
  $("userNameLabel").textContent=n||"Гость";
  $("userAvatar").innerHTML=getAvatar()?`<img src="${esc(getAvatar())}" alt="">`:esc(initials(n));
  $("editNameSide").textContent=n||"Моё имя";
  audio.volume=localStorage.getItem(MUTED_KEY)==="1"?0:+(localStorage.getItem(VOLUME_KEY)||1);
  $("volumeSlider").value=audio.volume;
  $("fullVolumeSlider").value=audio.volume;
  bind();
  addV5Bindings();
  applyTheme(localStorage.getItem(THEME_KEY)||"dark");
  syncVolumeUI();
  renderAll();
  setupMiniObserver();
  setupMobileNavigation();
  connect();
  if(!n)setTimeout(openName,700);
  const sharedPlaylistFromUrl=new URLSearchParams(location.search).get("playlist");
  if(sharedPlaylistFromUrl)setTimeout(()=>openSharedPlaylist(sharedPlaylistFromUrl),900);
}
init();


/* ========================================================================
   Sync Music v6 — final interaction fixes
   ======================================================================== */

function updateRoomNameUI(nameValue) {
  const value = String(nameValue || "Комната").trim() || "Комната";
  ["roomNameTop", "roomNameSide"].forEach(id => {
    const node = $(id);
    if (node) node.textContent = value;
  });
  const roomTitle = $("inviteRoomId");
  if (roomTitle) roomTitle.textContent = `${value} · ${roomId}`;
}

const handleMessageV6 = handleMessage;
handleMessage = function(m) {
  if (m.type === "full_state" && m.room_name) {
    updateRoomNameUI(m.room_name);
  }
  if (m.type === "room_renamed") {
    updateRoomNameUI(m.name);
    toast(`Название комнаты: ${m.name}`);
    return;
  }
  if (m.type === "reaction_update") {
    const target = chatMessages.find(x => String(x.id) === String(m.message_id));
    if (target) {
      target.reactions = m.reactions || {};
      renderChat();
    }
    return;
  }
  if (m.type === "reaction_self") {
    const target = chatMessages.find(x => String(x.id) === String(m.message_id));
    if (target) {
      target.my_reaction = m.active ? m.reaction : "";
      renderChat();
    }
    return;
  }
  handleMessageV6(m);
};

/* Shuffle/repeat labels and visual state are explicit, so it is obvious when active. */
function renderModesV6() {
  const shuffle = $("shuffleBtn");
  const repeatButton = $("repeatBtn");
  const fullShuffle = $("fullShuffle");
  const fullRepeat = $("fullRepeat");

  [shuffle, repeatButton, fullShuffle, fullRepeat].forEach(b => b?.classList.remove("active"));

  if (shuffle) {
    shuffle.classList.toggle("active", shuffleMode);
    shuffle.textContent = shuffleMode ? "⤨ Вкл" : "⤨";
    shuffle.title = shuffleMode ? "Перемешивание включено" : "Включить перемешивание";
    shuffle.setAttribute("aria-pressed", String(shuffleMode));
  }

  const repeatLabels = { off: "↻", all: "↻ Все", one: "↻ 1" };
  if (repeatButton) {
    repeatButton.classList.toggle("active", repeatMode !== "off");
    repeatButton.textContent = repeatLabels[repeatMode] || "↻";
    repeatButton.title = repeatMode === "off" ? "Повтор выключен" : repeatMode === "all" ? "Повтор всей очереди" : "Повтор текущего трека";
    repeatButton.setAttribute("aria-pressed", String(repeatMode !== "off"));
  }
  if (fullShuffle) {
    fullShuffle.classList.toggle("active", shuffleMode);
    fullShuffle.textContent = shuffleMode ? "⤨ Перемешивание: вкл" : "⤨ Перемешивание: выкл";
    fullShuffle.setAttribute("aria-pressed", String(shuffleMode));
  }
  if (fullRepeat) {
    fullRepeat.classList.toggle("active", repeatMode !== "off");
    fullRepeat.textContent = repeatMode === "off" ? "↻ Повтор: выкл" : repeatMode === "all" ? "↻ Повтор: все" : "↻ Повтор: трек";
    fullRepeat.setAttribute("aria-pressed", String(repeatMode !== "off"));
  }

  const dj = $("djStatus");
  if (dj) dj.textContent = djMode ? "Включён" : "Выключен";
  $("djToggle")?.setAttribute("aria-checked", String(djMode));
  if ($("djToggle")) $("djToggle").disabled = !isOwner;
  if ($("modalDjToggle")) $("modalDjToggle").disabled = !isOwner;
  if ($("djToggle")) $("djToggle").title = isOwner ? "Переключить DJ Mode" : "Только владелец комнаты";
}
renderModes = renderModesV6;

function toggleShuffleV6() {
  if (djMode && !isOwner) {
    toast("DJ Mode: менять режим может только владелец");
    return;
  }
  const nextValue = !shuffleMode;
  shuffleMode = nextValue;
  renderModesV6();
  send({ type: "set_shuffle", enabled: nextValue });
  toast(nextValue ? "⤨ Перемешивание включено" : "⤨ Перемешивание выключено");
}
toggleShuffle = toggleShuffleV6;

function repeatV6() {
  if (djMode && !isOwner) {
    toast("DJ Mode: менять режим может только владелец");
    return;
  }
  const modes = ["off", "all", "one"];
  repeatMode = modes[(modes.indexOf(repeatMode) + 1) % modes.length];
  renderModesV6();
  send({ type: "set_repeat", mode: repeatMode });
  toast(repeatMode === "off" ? "↻ Повтор выключен" : repeatMode === "all" ? "↻ Повтор очереди" : "↻ Повтор трека");
}
repeat = repeatV6;

/* Queue page without checkboxes/selection. */
function renderQueueV6() {
  const c = $("queue");
  const preview = $("queuePreview");
  if (!c) return;
  $("queueCount").textContent = localQueue.length;
  selectedQueue.clear();

  if (!localQueue.length) {
    c.innerHTML = '<div class="empty"><strong>Очередь пока пуста</strong>Ищите музыку сверху и добавляйте её в комнату.</div>';
    if (preview) preview.innerHTML = '<div class="empty">Добавьте первый трек через поиск.</div>';
    return;
  }

  c.innerHTML = "";
  localQueue.forEach((track, index) => c.appendChild(trackElement(track, index, true, false)));

  if (preview) {
    preview.innerHTML = "";
    localQueue.forEach((track, index) => {
      if (index !== localCurrentIndex && preview.children.length < 4) {
        preview.appendChild(trackElement(track, index, true, true));
      }
    });
  }
}
renderQueue = renderQueueV6;

/* Put duration directly into the metadata block beside the track information. */
const trackElementV6Base = trackElement;
trackElement = function(t, i, full = true, compact = false) {
  const el = trackElementV6Base(t, i, full, compact);
  const meta = el.querySelector(".track-meta");
  const info = el.querySelector(".track-info");
  if (meta && info) {
    const duration = meta.textContent.trim();
    info.dataset.duration = duration;
    meta.remove();
  }
  return el;
};

/* Playlist/other lists still get their duration beside the title as well. */

function renameRoomV6() {
  if (!isOwner) {
    toast("Переименовать комнату может только владелец");
    return;
  }
  const current = $("roomNameTop")?.textContent?.trim() || "Комната";
  const value = prompt("Новое название комнаты", current);
  if (value === null) return;
  const trimmed = value.trim().slice(0, 60);
  if (!trimmed) {
    toast("Название не может быть пустым");
    return;
  }
  send({ type: "rename_room", name: trimmed });
}

/* Reply stays functional, but the old large replyBar is gone. */
function setReplyV6(message) {
  replyingTo = message || null;
  const input = $("chatInput");
  if (input) {
    input.placeholder = replyingTo ? `Ответить ${replyingTo.name || "участнику"}…` : "Написать сообщение…";
    input.focus();
  }
}
function renderReplyBar() {
  const bar = $("replyBar");
  if (bar) {
    bar.hidden = true;
    bar.innerHTML = "";
  }
  const input = $("chatInput");
  if (input) input.placeholder = replyingTo ? `Ответить ${replyingTo.name || "участнику"}…` : "Написать сообщение…";
}

function renderChatV6() {
  const c = $("chatMessages");
  if (!c) return;
  c.innerHTML = "";
  chatMessages.forEach(m => {
    if (m.system) {
      const d = document.createElement("div");
      d.className = "system-message";
      d.textContent = m.text;
      c.appendChild(d);
      return;
    }

    const d = document.createElement("div");
    d.className = "message";
    d.dataset.messageId = m.id || "";
    const reply = m.reply_to ? `<div class="message-reply">↩ ${esc(m.reply_to.name || "")}: ${esc(m.reply_to.text || "").slice(0, 80)}</div>` : "";
    const reactionEntries = Object.entries(m.reactions || {});
    const reactions = reactionEntries.map(([emoji, count]) => {
      const mine = m.my_reaction === emoji ? " mine" : "";
      return `<button class="reaction-chip${mine}" type="button" data-message="${esc(m.id || "")}" data-reaction="${esc(emoji)}">${emoji} ${count}</button>`;
    }).join("");

    d.innerHTML = `${avatarMarkup(m,"message-avatar")}<div class="message-body"><div class="message-head"><b>${esc(m.name || "Гость")}</b><time>${new Date(m.time || Date.now()).toLocaleTimeString("ru-RU", {hour:"2-digit", minute:"2-digit"})}</time><button class="message-reply-btn" type="button" title="Ответить" aria-label="Ответить">↩</button><button class="message-react-btn" type="button" title="Добавить реакцию" aria-label="Добавить реакцию">☺</button></div>${reply}<p>${esc(m.text)}</p><div class="message-reactions">${reactions}</div></div>`;

    d.querySelector(".message-reply-btn").onclick = () => setReplyV6(m);
    d.querySelector(".message-react-btn").onclick = () => openReactionPickerV6(m.id, d.querySelector(".message-react-btn"));
    d.querySelectorAll(".reaction-chip").forEach(button => {
      button.onclick = () => send({ type: "chat_reaction", message_id: button.dataset.message, reaction: button.dataset.reaction });
    });
    c.appendChild(d);
  });

  $("chatCount").textContent = chatMessages.filter(x => !x.system).length;
  $("chatPreview").innerHTML = chatMessages.slice(-4).map(m => m.system ? `<div class="chat-line">${esc(m.text)}</div>` : `<div class="chat-line"><b>${esc(m.name)}:</b> ${esc(m.text)}</div>`).join("");
  c.scrollTop = c.scrollHeight;
}
renderChat = renderChatV6;

const REACTION_CHOICES_V6 = ["❤️","🔥","😂","👍","👎","👏","🎵","🤣","😍","😢","😡","🤯","🎉","✨","💯"];
function openReactionPickerV6(messageId, anchor) {
  document.querySelector(".message-reaction-popover")?.remove();
  const pop = document.createElement("div");
  pop.className = "message-reaction-popover emoji-picker";
  pop.innerHTML = REACTION_CHOICES_V6.map(e => `<button type="button" class="emoji-item" data-reaction="${e}">${e}</button>`).join("");
  document.body.appendChild(pop);
  const rect = anchor.getBoundingClientRect();
  pop.style.position = "fixed";
  pop.style.zIndex = "1000";
  pop.style.left = `${Math.min(Math.max(8, rect.left - 150), window.innerWidth - 328)}px`;
  pop.style.top = `${Math.min(window.innerHeight - 220, rect.bottom + 6)}px`;
  pop.querySelectorAll("[data-reaction]").forEach(button => {
    button.onclick = () => {
      send({ type: "chat_reaction", message_id: messageId, reaction: button.dataset.reaction });
      pop.remove();
    };
  });
  setTimeout(() => document.addEventListener("click", function close(e) {
    if (!pop.contains(e.target) && e.target !== anchor) {
      pop.remove();
      document.removeEventListener("click", close);
    }
  }), 0);
}

function sendChatV6(e) {
  e.preventDefault();
  const input = $("chatInput");
  const text = input.value.trim();
  if (!text) return;
  if (!name()) {
    openName();
    return;
  }
  send({
    type: "chat_message",
    text,
    reply_to: replyingTo ? { id: replyingTo.id, name: replyingTo.name, text: replyingTo.text } : null
  });
  input.value = "";
  replyingTo = null;
  renderReplyBar();
  $("emojiPicker").hidden = true;
}
$("chatForm").onsubmit = sendChatV6;

/* Bind fixes after the legacy bindings have run. */
function applyV6Bindings() {
  $("renameRoomBtn")?.addEventListener("click", renameRoomV6);
  $("themeToggle")?.remove();
  $("selectAllQueueBtn")?.remove();
  $("queueMasterCheck")?.remove();
  $("queueBulkDelete")?.remove();
  $("queueBulkClearSelection")?.remove();

  if ($("shuffleBtn")) $("shuffleBtn").onclick = toggleShuffleV6;
  if ($("repeatBtn")) $("repeatBtn").onclick = repeatV6;
  if ($("fullShuffle")) $("fullShuffle").onclick = toggleShuffleV6;
  if ($("fullRepeat")) $("fullRepeat").onclick = repeatV6;

  if ($("shuffleQueueBtn")) {
    $("shuffleQueueBtn").onclick = () => toggleShuffleV6();
    $("shuffleQueueBtn").textContent = shuffleMode ? "⤨ Перемешивание: вкл" : "⤨ Перемешивание";
  }
  renderModesV6();
  renderQueueV6();
  renderChatV6();
  updateRoomNameUI($("roomNameTop")?.textContent || "Комната");
}

/* Run after init() so every legacy handler is replaced by the final one. */
setTimeout(applyV6Bindings, 0);
