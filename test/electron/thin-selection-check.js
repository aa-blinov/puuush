/**
 * Тонкое выделение не должно публиковать весь экран.
 *
 * Раньше и на mouseup, и на Enter стояла проверка «меньше 4 пикселей», и
 * протяжка 2 на 500 считалась кликом: человек тянул полоску, чтобы выхватить
 * кусок текста, а улетал весь экран вместе с соседними окнами и перепиской.
 * Различие теперь по смещению мыши, а не по размеру рамки.
 *
 *     npm run test:electron
 */
const path=require('path');
const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');
app.on('window-all-closed', ()=>{});
const W=1400,H=880;

app.whenReady().then(async () => {
  const SRC='/home/ubuntu/pet/puuush/src';
  const frame = nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==').resize({width:W,height:H});
  const cases = [
    ['настоящий клик без смещения',  [[400,200],[400,200],[400,200]],                    {x:0,y:0,width:W,height:H}],
    ['тонкая рамка 2x500',           [[400,200],[402,400],[402,700]],                    {x:400,y:200,width:2,height:500}],
    ['тонкая рамка 500x2',           [[400,200],[700,202],[1100,202]],                  {x:400,y:200,width:700,height:2}],
    ['обычное выделение',            [[100,100],[400,300],[600,500]],                    null],
    ['рамка впритык к краю',         [[1350,830],[1400,880],[1400,880]],                 {x:1350,y:830,width:50,height:50}],
  ];
  let i=0, bad=0;
  const next=async()=>{
    if (i>=cases.length){ console.log('  провалено:',bad); app.exit(bad?1:0); return; }
    const [label, pts, want] = cases[i++];
    let got=null, done=false;
    const h=(_e,v)=>{ if(done) return; done=true; ipcMain.removeListener('puuush:region',h); got=v;
      const ok = want ? (got && got.width===want.width && got.height===want.height) : !!got;
      if(!ok) bad++;
      console.log('  '+(ok?'ОК   ':'ПРОВАЛ')+' '+label.padEnd(28)+' -> '+JSON.stringify(got&&{w:got.width,h:got.height}));
      w.destroy(); next(); };
    ipcMain.on('puuush:region',h);
    const w=new BrowserWindow({width:W,height:H,show:false,frame:false,transparent:true,
      webPreferences:{preload:path.join(SRC,'preload-overlay.js'),contextIsolation:true}});
    w.loadFile(path.join(SRC,'overlay.html'));
    w.once('ready-to-show',()=>{
      w.webContents.send('puuush:frame',{dataUrl:frame.toDataURL(),width:W,height:H});
      setTimeout(async()=>{
        await w.webContents.executeJavaScript(`(function(){
          const img=document.getElementById('shot');const P=${JSON.stringify(pts)};
          const n=(t)=>({mouseDown:'mousedown',mouseMove:'mousemove',mouseUp:'mouseup'})[t];
          const go=(t,p)=>(t==='mouseDown'?img:window).dispatchEvent(new MouseEvent(n(t),{clientX:p[0],clientY:p[1],button:0,bubbles:true,cancelable:true}));
          go('mouseDown',P[0]); go('mouseMove',P[1]||P[0]); go('mouseMove',P[P.length-1]);
          go('mouseUp',P[P.length-1]);
        })()`,true);
        if (want) setTimeout(async()=>{ if(!done){ w.webContents.executeJavaScript("window.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))",true); } },150);
        else setTimeout(async()=>{ if(!done){ w.webContents.executeJavaScript("window.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))",true); } },150);
        setTimeout(()=>{ if(!done){ ipcMain.removeListener('puuush:region',h); w.destroy(); console.log('  ПРОВАЛ '+label+': ответа не было'); bad++; next(); } },2500);
      },500);
    });
  };
  next();
});
