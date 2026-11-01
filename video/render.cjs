// Render deterministic vector frames straight to FFmpeg; no frame directory to clean.
const fs=require('node:fs');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const ROOT=path.resolve(__dirname,'..');
const OUT=path.join(ROOT,'brag-output','v3');
function dependency(name){try{return require(name)}catch{return require(path.join(ROOT,'brag-output','work','node_modules',name))}}
const {chromium}=dependency('playwright-core');
const ffmpeg=process.env.FFMPEG_PATH||dependency('ffmpeg-static');
function chromiumPath(){
  if(process.env.CHROMIUM_PATH)return process.env.CHROMIUM_PATH;
  const base=path.join(process.env.LOCALAPPDATA||'', 'ms-playwright');
  if(fs.existsSync(base))for(const name of fs.readdirSync(base).filter(n=>n.startsWith('chromium_headless_shell-')).sort((a,b)=>Number(b.split('-').pop())-Number(a.split('-').pop()))){const p=path.join(base,name,'chrome-headless-shell-win64','chrome-headless-shell.exe');if(fs.existsSync(p))return p}
  throw new Error('Set CHROMIUM_PATH to an installed Chromium executable.');
}
function vttTime(t){const ms=Math.round(t*1000);return `${String(Math.floor(ms/3600000)).padStart(2,'0')}:${String(Math.floor(ms/60000)%60).padStart(2,'0')}:${String(Math.floor(ms/1000)%60).padStart(2,'0')}.${String(ms%1000).padStart(3,'0')}`}
async function main(){
  const mode=process.argv[2]||'stills';
  if(!['stills','poster','video'].includes(mode))throw new Error('Mode must be stills, poster, or video.');
  fs.mkdirSync(OUT,{recursive:true});
  const metadata=JSON.parse(fs.readFileSync(path.join(__dirname,'captions.json'),'utf8'));
  const cues=metadata.cues;
  const playbackRate=metadata.playbackRate??1;
  const leadSeconds=metadata.leadSeconds??.65;
  if(!Number.isFinite(playbackRate)||playbackRate<.5||playbackRate>2)throw new Error('playbackRate must be between 0.5 and 2.');
  if(!Number.isFinite(leadSeconds)||leadSeconds<0)throw new Error('leadSeconds must be nonnegative.');
  const browser=await chromium.launch({executablePath:chromiumPath(),headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1920,height:1080},deviceScaleFactor:1});
    page.on('pageerror',e=>{throw e});
    await page.goto(pathToFileURL(path.join(__dirname,'scene.html')).href);
    await page.evaluate(()=>document.fonts.ready);
    await page.evaluate(meta=>{if(typeof window.setTimeline==='function')window.setTimeline(meta)},metadata);
    const timeline=await page.evaluate(()=>({duration:window.DURATION,scenes:window.SCENES}));
    const duration=metadata.duration??timeline.duration;
    if(!Number.isFinite(duration)||duration<=0||leadSeconds>=duration)throw new Error('A positive duration longer than the narration lead is required.');
    const sceneStarts=metadata.sceneStarts??timeline.scenes;
    if(!Array.isArray(sceneStarts)||!sceneStarts.length||sceneStarts.some((t,i)=>!Number.isFinite(t)||t<0||t>duration||(i>0&&t<=sceneStarts[i-1])))throw new Error('Scene times must increase within the video duration.');
    await page.evaluate(cues=>window.setCaptions(cues),cues);
    const frame=async(t,poster=false)=>Buffer.from(await page.evaluate(({t,poster})=>{if(poster)window.renderPoster();else window.render(t);return document.querySelector('canvas').toDataURL('image/jpeg',.94).split(',')[1]},{t,poster}),'base64');
    if(mode==='poster'){
      fs.writeFileSync(path.join(ROOT,'site','demo-poster.jpg'),await frame(0,true));
      console.log('Poster written.');
    }else if(mode==='stills'){
      const dir=path.join(OUT,'stills');fs.mkdirSync(dir,{recursive:true});
      const starts=sceneStarts.filter(t=>t<duration);
      const times=starts.map((t,i)=>Math.min(t+2,t+((starts[i+1]??duration)-t)*.8));
      for(let i=0;i<times.length;i++)fs.writeFileSync(path.join(dir,`scene-${i}.jpg`),await frame(times[i]));
      console.log(`Wrote ${times.length} review stills to ${dir}`);
    }else{
      const target=path.join(OUT,'demo-render.mp4');
      const fadeSeconds=Math.min(1.8,duration);
      const audio=`[1:a]atempo=${playbackRate},highpass=f=65,loudnorm=I=-16:TP=-2:LRA=7,adelay=${Math.round(leadSeconds*1000)}:all=1,apad,asplit=2[voice][duck];[2:a]apad[bed];[bed][duck]sidechaincompress=threshold=0.08:ratio=2:attack=20:release=400[quiet];[voice][quiet]amix=inputs=2:duration=longest:normalize=0,alimiter=limit=0.95:level=0,afade=t=out:st=${duration-fadeSeconds}:d=${fadeSeconds}[a]`;
      const args=['-hide_banner','-y','-f','image2pipe','-framerate','30','-vcodec','mjpeg','-i','pipe:0','-i',path.join(__dirname,'narration.mp3'),'-i',path.join(__dirname,'music.mp3'),'-filter_complex',audio,'-map','0:v','-map','[a]','-c:v','libx264','-preset','medium','-crf','19','-pix_fmt','yuv420p','-c:a','aac','-b:a','160k','-ar','48000','-t',String(duration),'-movflags','+faststart',target];
      const encoder=spawn(ffmpeg,args,{stdio:['pipe','ignore','pipe'],windowsHide:true});
      let errors='';encoder.stderr.on('data',b=>{errors=(errors+b.toString()).slice(-10000)});
      encoder.stdin.on('error',()=>{});
      const done=new Promise((resolve,reject)=>{encoder.on('error',reject);encoder.on('close',code=>code===0?resolve():reject(new Error(`FFmpeg exited ${code}: ${errors}`)))});
      // Attach a handler immediately so a failed encoder cannot become an unhandled rejection.
      done.catch(()=>{});
      const totalFrames=Math.ceil(duration*30);
      for(let i=0;i<totalFrames;i++){
        if(encoder.exitCode!==null)throw new Error(errors);
        if(!encoder.stdin.write(await frame(i/30)))await Promise.race([once(encoder.stdin,'drain'),done.then(()=>{throw new Error('Encoder stopped before the last frame.')})]);
        if(i%150===0)console.log(`Rendered ${i}/${totalFrames} frames`);
      }
      encoder.stdin.end();await done;
      fs.copyFileSync(target,path.join(ROOT,'site','demo.mp4'));
      fs.writeFileSync(path.join(ROOT,'site','demo.vtt'),'WEBVTT\n\n'+cues.map((q,i)=>`${i+1}\n${vttTime(q.start)} --> ${vttTime(q.end)}\n${q.text}\n`).join('\n'));
      console.log(`Completed ${duration}-second demo and WebVTT captions.`);
    }
  }finally{await browser.close()}
}
main().catch(e=>{console.error(e);process.exitCode=1});
