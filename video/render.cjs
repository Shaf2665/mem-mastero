// Render deterministic vector frames straight to FFmpeg; no frame directory to clean.
const fs=require('node:fs');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const ROOT=path.resolve(__dirname,'..');
const OUT=path.join(ROOT,'brag-output','v2');
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
  const cues=JSON.parse(fs.readFileSync(path.join(__dirname,'captions.json'),'utf8')).cues;
  const browser=await chromium.launch({executablePath:chromiumPath(),headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1920,height:1080},deviceScaleFactor:1});
    page.on('pageerror',e=>{throw e});
    await page.goto(pathToFileURL(path.join(__dirname,'scene.html')).href);
    await page.evaluate(()=>document.fonts.ready);
    await page.evaluate(cues=>window.setCaptions(cues),cues);
    const frame=async(t,poster=false)=>Buffer.from(await page.evaluate(({t,poster})=>{if(poster)window.renderPoster();else window.render(t);return document.querySelector('canvas').toDataURL('image/jpeg',.94).split(',')[1]},{t,poster}),'base64');
    if(mode==='poster'){
      fs.writeFileSync(path.join(ROOT,'site','demo-poster.jpg'),await frame(0,true));
      console.log('Poster written.');
    }else if(mode==='stills'){
      const dir=path.join(OUT,'stills');fs.mkdirSync(dir,{recursive:true});
      const times=await page.evaluate(()=>window.SCENES.slice(0,-1).map((t,i)=>Math.min(t+2,window.SCENES[i+1]-.2)));
      for(let i=0;i<times.length;i++)fs.writeFileSync(path.join(dir,`scene-${i}.jpg`),await frame(times[i]));
      console.log(`Wrote ${times.length} review stills to ${dir}`);
    }else{
      const target=path.join(OUT,'demo-render.mp4');
      const args=['-hide_banner','-y','-f','image2pipe','-framerate','30','-vcodec','mjpeg','-i','pipe:0','-i',path.join(__dirname,'narration.mp3'),'-i',path.join(__dirname,'music.mp3'),'-filter_complex','[1:a]atempo=1.08,highpass=f=65,loudnorm=I=-16:TP=-2:LRA=7,adelay=650:all=1,apad[voice];[voice][2:a]amix=inputs=2:duration=longest:normalize=0,alimiter=limit=0.95:level=0,afade=t=out:st=63.2:d=1.8[a]','-map','0:v','-map','[a]','-c:v','libx264','-preset','medium','-crf','19','-pix_fmt','yuv420p','-c:a','aac','-b:a','160k','-ar','48000','-t','65','-movflags','+faststart',target];
      const encoder=spawn(ffmpeg,args,{stdio:['pipe','ignore','pipe'],windowsHide:true});
      let errors='';encoder.stderr.on('data',b=>{errors=(errors+b.toString()).slice(-10000)});
      encoder.stdin.on('error',()=>{});
      const done=new Promise((resolve,reject)=>{encoder.on('error',reject);encoder.on('close',code=>code===0?resolve():reject(new Error(`FFmpeg exited ${code}: ${errors}`)))});
      // Attach a handler immediately so a failed encoder cannot become an unhandled rejection.
      done.catch(()=>{});
      for(let i=0;i<1950;i++){
        if(encoder.exitCode!==null)throw new Error(errors);
        if(!encoder.stdin.write(await frame(i/30)))await Promise.race([once(encoder.stdin,'drain'),done.then(()=>{throw new Error('Encoder stopped before the last frame.')})]);
        if(i%150===0)console.log(`Rendered ${i}/1950 frames`);
      }
      encoder.stdin.end();await done;
      fs.copyFileSync(target,path.join(ROOT,'site','demo.mp4'));
      fs.writeFileSync(path.join(ROOT,'site','demo.vtt'),'WEBVTT\n\n'+cues.map((q,i)=>`${i+1}\n${vttTime(q.start)} --> ${vttTime(q.end)}\n${q.text}\n`).join('\n'));
      console.log('Completed 65-second demo and WebVTT captions.');
    }
  }finally{await browser.close()}
}
main().catch(e=>{console.error(e);process.exitCode=1});
